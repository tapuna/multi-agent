import os
from pathlib import Path
from uuid import uuid4
from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_db
from .models import (
    Task,
    Agent,
    AgentSession,
)
from .schemas import (
    AgentCreate,
    SessionCreate,
    SessionUpdate,
)
from .context import snapshot
from .runtime import ADAPTERS, RuntimeRequest

from fastapi import APIRouter
from .services import identity, require_human, get, audit, commit, flush
from .agent_skills import resolve_skills
from .schemas import Input
from pydantic import Field
from .runtime_registry import ensure_available
from . import runtime_registry
from fastapi.encoders import jsonable_encoder
from .llm_profiles import resolve
from .profile_readiness import catalog

router = APIRouter(tags=["agents"])


@router.get("/api/llm-profiles")
def llm_profiles(db: Session = Depends(get_db), actor=Depends(identity)):
    try:
        return catalog(db)
    except ValueError as error:
        raise HTTPException(422, str(error))


class AgentSkillsUpdate(Input):
    version: int = Field(ge=1)
    skill_refs: list[str] = Field(max_length=10)


@router.get("/api/agents/{agent_id}/skills")
def skills(agent_id: str, db: Session = Depends(get_db), actor=Depends(identity)):
    agent = get(db, Agent, agent_id)
    return {"skill_refs": agent.skill_refs or [], "version": agent.skills_version}


@router.put("/api/agents/{agent_id}/skills")
def configure_skills(
    agent_id: str,
    body: AgentSkillsUpdate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    agent = db.scalar(select(Agent).where(Agent.id == agent_id).with_for_update())
    if not agent:
        raise HTTPException(404, "Agent not found")
    if agent.skills_version != body.version:
        raise HTTPException(409, "Agent skills changed; reload before saving")
    selected = resolve_skills(body.skill_refs)
    before = agent.skill_refs or []
    agent.skill_refs = body.skill_refs
    agent.skills_version += 1
    audit(
        db,
        actor,
        "agent.skills_configured",
        {
            "agent_id": agent.id,
            "before": before,
            "after": body.skill_refs,
            "version": agent.skills_version,
            "packages": [
                {k: s[k] for k in ("name", "version", "sha256")} for s in selected
            ],
        },
    )
    commit(db)
    return {"skill_refs": agent.skill_refs, "version": agent.skills_version}


@router.get("/api/agents")
def agents(db: Session = Depends(get_db), actor=Depends(identity)):
    return [
        {
            **jsonable_encoder(a),
            "runtime_available": runtime_registry.availability(db, a.runtime, a.model)[
                "available"
            ],
            "runtime_warning": runtime_registry.availability(db, a.runtime, a.model)[
                "reason"
            ],
        }
        for a in db.scalars(select(Agent).order_by(Agent.name))
    ]


@router.post("/api/agents", status_code=201)
def create_agent(
    body: AgentCreate, db: Session = Depends(get_db), actor=Depends(identity)
):
    require_human(actor)
    ensure_available(db, body.runtime, body.model)
    try:
        resolve(body.model, body.runtime)
    except ValueError as error:
        raise HTTPException(422, str(error))
    row = Agent(**body.model_dump())
    db.add(row)
    flush(db)
    audit(db, actor, "agent.registered", {"agent_id": row.id, **body.model_dump()})
    commit(db)
    return row


@router.patch("/api/agents/{agent_id}")
def edit_agent(
    agent_id: str,
    body: AgentCreate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    row = get(db, Agent, agent_id)
    ensure_available(db, body.runtime, body.model)
    try:
        resolve(body.model, body.runtime)
    except ValueError as error:
        raise HTTPException(422, str(error))
    before = {key: getattr(row, key) for key in type(body).model_fields}
    for key, value in body.model_dump().items():
        setattr(row, key, value)
    audit(
        db,
        actor,
        "agent.updated",
        {"agent_id": row.id, "before": before, "after": body.model_dump()},
    )
    commit(db)
    return row


@router.post("/api/tasks/{task_id}/sessions", status_code=201)
def prepare_session(
    task_id: str,
    body: SessionCreate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    task = get(db, Task, task_id)
    agent = get(db, Agent, body.agent_id)
    ensure_available(db, agent.runtime, agent.model)
    if not agent.enabled:
        raise HTTPException(409, "Agent disabled")
    root = Path(os.getenv("WORKSPACE_ROOT", "./workspaces")).resolve()
    workspace = root / task.id / str(uuid4())
    workspace.mkdir(parents=True, exist_ok=False)
    row = AgentSession(
        task_id=task_id,
        agent_id=agent.id,
        workspace_path=str(workspace),
        context_snapshot=snapshot(task.project_id, task_id, agent.role),
    )
    row.context_snapshot = {
        **row.context_snapshot,
        "skills": resolve_skills(agent.skill_refs or []),
    }
    db.add(row)
    db.flush()
    audit(
        db,
        actor,
        "session.prepared",
        {
            "session_id": row.id,
            "workspace": str(workspace),
            "context": row.context_snapshot,
        },
        task_id,
    )
    commit(db)
    return row


@router.patch("/api/sessions/{session_id}")
def bind_provider_session(
    session_id: str,
    body: SessionUpdate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    row = db.scalar(
        select(AgentSession).where(AgentSession.id == session_id).with_for_update()
    )
    if not row:
        raise HTTPException(404, "Session not found")
    if row.provider_session_id and row.provider_session_id != body.provider_session_id:
        raise HTTPException(409, "Provider session ID is immutable once bound")
    row.provider_session_id = body.provider_session_id
    audit(
        db,
        actor,
        "session.provider_bound",
        {"session_id": row.id, "provider_session_id": row.provider_session_id},
        row.task_id,
    )
    commit(db)
    return row


@router.get("/api/sessions/{session_id}/resume")
def resume_session(
    session_id: str, db: Session = Depends(get_db), actor=Depends(identity)
):
    row = get(db, AgentSession, session_id)
    agent = get(db, Agent, row.agent_id)
    task = get(db, Task, row.task_id)
    if not row.provider_session_id:
        raise HTTPException(409, "Provider session has not been bound")
    request = RuntimeRequest(
        task.description or task.title,
        Path(row.workspace_path),
        agent.model,
        row.provider_session_id,
    )
    return {
        "session_id": row.id,
        "provider_session_id": row.provider_session_id,
        "workspace": row.workspace_path,
        "command": ADAPTERS[agent.runtime].command(request),
        "execution_enabled": False,
    }
