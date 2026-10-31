from typing import Literal
from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import Field
from sqlalchemy import select, func
from sqlalchemy.orm import Session, sessionmaker
from .db import get_db
from .schemas import Input
from .models import AgentConversation, AgentMessage, Agent, Project
from .services import identity, require_human, get, audit, commit, flush
from .runtime import executable
from .gateway import settings
from .agent_chat import ChatEngine, knowledge, binding
from .runtime_registry import ensure_available
from .llm_profiles import resolve, signature, allowed, describe

router = APIRouter(tags=["agent conversations"])


class MessageCreate(Input):
    content: str = Field(default="", max_length=20000)
    kind: Literal["chat", "context_summary"] = "chat"


def conversation_for(db, project_id, agent_id, lock=False):
    query = select(AgentConversation).where(
        AgentConversation.project_id == project_id,
        AgentConversation.agent_id == agent_id,
    )
    return db.scalar(query.with_for_update() if lock else query)


@router.get("/api/projects/{project_id}/agents/{agent_id}/chat")
def state(
    project_id: str,
    agent_id: str,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    get(db, Project, project_id)
    get(db, Agent, agent_id)
    conversation = conversation_for(db, project_id, agent_id)
    messages = []
    total = 0
    if conversation:
        total = db.scalar(
            select(func.count())
            .select_from(AgentMessage)
            .where(AgentMessage.conversation_id == conversation.id)
        )
        messages = db.scalars(
            select(AgentMessage)
            .where(AgentMessage.conversation_id == conversation.id)
            .order_by(AgentMessage.sequence.desc())
            .limit(100)
        ).all()[::-1]
    return {
        "conversation": conversation,
        "total_messages": total,
        "messages": [
            {
                **jsonable_encoder(m, exclude={"context_snapshot"}),
                "inventory": m.context_snapshot.get("inventory"),
                "request_id": m.context_snapshot.get("request_id"),
                "history_truncated": m.context_snapshot.get("history_truncated", False),
            }
            for m in messages
        ],
    }


@router.get("/api/projects/{project_id}/agents/{agent_id}/knowledge")
def inventory(
    project_id: str,
    agent_id: str,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    try:
        context = knowledge(db, get(db, Project, project_id), get(db, Agent, agent_id))
    except ValueError as error:
        raise HTTPException(422, str(error))
    return {
        "inventory": context["inventory"],
        "sources": [
            {key: value for key, value in s.items() if key != "content"}
            for s in context["sources"]
        ],
    }


@router.get(
    "/api/projects/{project_id}/agents/{agent_id}/chat/messages/{message_id}/context"
)
def message_context(
    project_id: str,
    agent_id: str,
    message_id: str,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    message = get(db, AgentMessage, message_id)
    conversation = get(db, AgentConversation, message.conversation_id)
    if conversation.project_id != project_id or conversation.agent_id != agent_id:
        raise HTTPException(404, "Message not found in this agent/project conversation")
    return message.context_snapshot


@router.post(
    "/api/projects/{project_id}/agents/{agent_id}/chat/messages", status_code=202
)
def send(
    project_id: str,
    agent_id: str,
    body: MessageCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    project = db.scalar(
        select(Project).where(Project.id == project_id).with_for_update()
    )
    if not project:
        raise HTTPException(404, "Project not found")
    agent = get(db, Agent, agent_id)
    ensure_available(db, agent.runtime, agent.model)
    try:
        resolve(agent.model, agent.runtime)
    except ValueError as error:
        raise HTTPException(422, str(error))
    config = settings()
    if not config["enabled"] or not agent.enabled:
        raise HTTPException(409, "Agent execution is disabled")
    if not allowed(agent.model, config["allowed_models"]):
        raise HTTPException(403, "Agent model is outside the server allowlist")
    if agent.model == "configure-before-execution":
        raise HTTPException(422, "Configure a real model for this agent first")
    if agent.runtime != "api" and not executable(agent.runtime):
        raise HTTPException(
            409,
            f"{agent.runtime} CLI is not installed; configure this agent's runtime first",
        )
    if body.kind == "chat" and not body.content.strip():
        raise HTTPException(422, "Enter a message")
    conversation = conversation_for(db, project_id, agent_id, lock=True)
    if conversation and conversation.status == "running":
        raise HTTPException(
            409, "This agent already has a pending request in this project"
        )
    try:
        context = knowledge(db, project, agent)
    except ValueError as error:
        raise HTTPException(422, str(error))
    if not conversation:
        conversation = AgentConversation(project_id=project_id, agent_id=agent_id)
        db.add(conversation)
        flush(db)
    fingerprint = binding(agent, context)
    if conversation.binding_hash != fingerprint:
        if conversation.provider_session_id:
            audit(
                db,
                actor,
                "agent.chat.session_reset",
                {
                    "conversation_id": conversation.id,
                    "reason": "Agent configuration or company policy changed",
                },
            )
        conversation.provider_session_id = None
        conversation.binding_hash = fingerprint
    sequence = (
        db.scalar(
            select(func.max(AgentMessage.sequence)).where(
                AgentMessage.conversation_id == conversation.id
            )
        )
        or 0
    ) + 1
    message = AgentMessage(
        conversation_id=conversation.id,
        sequence=sequence,
        role="user",
        kind=body.kind,
        content=body.content or "สรุปบริบทและความรู้ที่คุณมี พร้อมสิ่งที่ยังไม่รู้และแหล่งข้อมูลอ้างอิง",
        state="running",
        context_snapshot={
            "knowledge": context,
            "agent": {
                **{
                    key: getattr(agent, key)
                    for key in ("id", "name", "role", "runtime", "model")
                },
                "llm_config_hash": signature(agent.model),
                "llm_profile": describe(agent.model),
            },
        },
    )
    db.add(message)
    flush(db)
    conversation.status, conversation.active_message_id, conversation.error = (
        "running",
        message.id,
        None,
    )
    audit(
        db,
        actor,
        "agent.context_summary.requested"
        if body.kind == "context_summary"
        else "agent.chat.requested",
        {
            "conversation_id": conversation.id,
            "project_id": project_id,
            "agent_id": agent_id,
            "message_id": message.id,
            "inventory": context["inventory"],
        },
    )
    commit(db)
    background.add_task(
        ChatEngine(sessionmaker(bind=db.get_bind(), expire_on_commit=False)).run,
        conversation.id,
        message.id,
    )
    return {
        "conversation_id": conversation.id,
        "message_id": message.id,
        "status": "running",
    }


@router.post("/api/projects/{project_id}/agents/{agent_id}/chat/cancel")
def cancel(
    project_id: str,
    agent_id: str,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    conversation = conversation_for(db, project_id, agent_id, lock=True)
    if not conversation or conversation.status != "running":
        raise HTTPException(409, "No active conversation request")
    if conversation.active_message_id:
        db.get(AgentMessage, conversation.active_message_id).state = "cancelled"
    (
        conversation.status,
        conversation.active_message_id,
        conversation.provider_session_id,
    ) = "idle", None, None
    conversation.error = None
    audit(
        db,
        actor,
        "agent.chat.cancelled",
        {
            "conversation_id": conversation.id,
            "project_id": project_id,
            "agent_id": agent_id,
        },
    )
    commit(db)
    return {"status": "cancelled"}
