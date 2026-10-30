import io
import json
import os
import re
import zipfile
from pathlib import Path
from uuid import uuid4
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import Response
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_db
from .models import (
    Agent,
    AgentSession,
    Dependency,
    Project,
    Task,
    WorkflowRun,
    WorkflowStep,
    RunArtifact,
    RunEvent,
    GraphCheckpoint,
    Approval,
)
from .gateway import settings
from .runtime import executable, runtime_report
from .services import identity, require_human, get, audit, commit, flush
from .workflow_context import build_context, read_context
from .agent_skills import resolve_skills
from .context import snapshot
from .storage import archive_artifact
from sqlalchemy.orm import sessionmaker
from .workflow_schemas import RunCreate, RunDecision, RepositoryUpdate, MergeRequest
from .workflows import (
    WorkflowEngine,
    emit,
    validate_dag,
    transition,
    manifest,
    materialize,
)
from .workspaces import prepare_source, files, safe_path, git, disabled_filters
from .workflow_templates import resolve_run
from .runtime_registry import ensure_available
from .llm_profiles import resolve, signature, allowed, describe

router = APIRouter(tags=["execution"])


def run_payload(run):
    result = jsonable_encoder(run, exclude={"context_snapshot", "agents"})
    result["context_snapshot"] = {
        "source": run.context_snapshot.get("source", {}),
        "policy_sha256": run.context_snapshot["policy_sha256"],
    }
    result["agents"] = {
        key: {
            field: value
            for field, value in agent.items()
            if field not in {"role_context", "skills"}
        }
        for key, agent in run.agents.items()
    }
    return result


@router.get("/api/execution/config")
def config(actor=Depends(identity)):
    return {
        **settings(),
        "runtimes": runtime_report(),
        "artifact_storage": "s3+firebird"
        if os.getenv("ARTIFACT_S3_BUCKET")
        else "firebird+filesystem",
        "provider_credentials_configured": any(
            os.getenv(k)
            for k in (
                "LLM_API_KEY",
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY",
                "LLM_API_BASE",
            )
        ),
    }


@router.post("/api/workflows/{run_id}/archive", status_code=202)
def archive(
    run_id: str,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    run = get(db, WorkflowRun, run_id)
    if not os.getenv("ARTIFACT_S3_BUCKET"):
        raise HTTPException(409, "S3 artifact storage is not configured")
    emit(db, run, "artifact.archive_requested", actor=actor)
    commit(db)
    factory = sessionmaker(bind=db.get_bind(), expire_on_commit=False)

    def upload():
        with factory() as session:
            run = session.get(WorkflowRun, run_id)
            for artifact in session.scalars(
                select(RunArtifact).where(RunArtifact.run_id == run_id)
            ):
                try:
                    emit(session, run, "artifact.archived", archive_artifact(artifact))
                except Exception:
                    emit(
                        session,
                        run,
                        "artifact.archive_failed",
                        {"artifact_id": artifact.id},
                    )
            session.commit()

    background.add_task(upload)
    return {"status": "queued"}


@router.patch("/api/projects/{project_id}/repository")
def repository(
    project_id: str,
    body: RepositoryUpdate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    project = get(db, Project, project_id)
    path = None
    if body.repository_path:
        folder = Path(body.repository_path).resolve()
        try:
            path = git(["-C", str(folder), "rev-parse", "--show-toplevel"])
        except (ValueError, OSError):
            raise HTTPException(422, "Choose an existing local Git repository")
    project.repository_path = path
    audit(
        db,
        actor,
        "project.repository_configured",
        {"project_id": project.id, "repository_path": path},
    )
    commit(db)
    return project


@router.post("/api/tasks/{task_id}/workflows", status_code=202)
def start(
    task_id: str,
    body: RunCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    if not settings()["enabled"]:
        raise HTTPException(409, "Execution is disabled in server configuration")
    if body.skill_refs is not None:
        raise HTTPException(
            422,
            "Configure skills per agent in Agent Studio; workflow-level skill_refs is retired",
        )
    task = db.scalar(select(Task).where(Task.id == task_id).with_for_update())
    if not task:
        raise HTTPException(404, "Task not found")
    if task.version != body.version:
        raise HTTPException(409, "Refresh the task before starting")
    if task.status not in {"backlog", "todo", "in_progress"}:
        raise HTTPException(409, "Reopen the task before starting another workflow")
    if db.scalar(select(WorkflowRun.id).where(WorkflowRun.active_task_id == task_id)):
        raise HTTPException(409, "This task already has an active workflow")
    blocker = db.scalar(
        select(Dependency.task_id)
        .join(Task, Task.id == Dependency.depends_on_id)
        .where(Dependency.task_id == task_id, Task.status != "done")
    )
    if blocker:
        raise HTTPException(409, "Complete blocking dependencies first")
    project = db.scalar(
        select(Project).where(Project.id == task.project_id).with_for_update()
    )
    steps, workflow_snapshot = resolve_run(db, project, task, body)
    order = validate_dag(steps)
    chosen = {}
    for step in steps:
        agent = get(db, Agent, step.agent_id)
        ensure_available(db, agent.runtime)
        try:
            resolve(agent.model, agent.runtime)
        except ValueError as error:
            raise HTTPException(422, str(error))
        if not agent.enabled:
            raise HTTPException(409, "An agent is disabled")
        if agent.model == "configure-before-execution":
            raise HTTPException(422, f"Configure a real model for {agent.name} first")
        if agent.runtime != "api" and not executable(agent.runtime):
            raise HTTPException(
                409, f"{agent.runtime} is not installed; see Configuration"
            )
        if not allowed(agent.model, settings()["allowed_models"]):
            raise HTTPException(403, "Agent model is outside the server allowlist")
        chosen[step.key] = {
            "id": agent.id,
            "name": agent.name,
            "role": agent.role,
            "runtime": agent.runtime,
            "model": agent.model,
            "llm_config_hash": signature(agent.model),
            "llm_profile": describe(agent.model),
            "skills": resolve_skills(agent.skill_refs or []),
            "skills_version": agent.skills_version,
        }
    run_id = str(uuid4())
    root = (
        Path(os.getenv("WORKSPACE_ROOT", "./workspaces")).resolve() / task.id / run_id
    )
    root.mkdir(parents=True, exist_ok=False)
    project = get(db, Project, task.project_id)
    try:
        source = prepare_source(project.repository_path, root)
    except (ValueError, OSError):
        raise HTTPException(422, "Could not create the isolated source workspace")
    context = build_context(db, task)
    context["workflow"] = workflow_snapshot
    context["source"] = source
    context["source"]["repository_path"] = project.repository_path
    context["agent_skills"] = {
        agent["id"]: agent["skills"] for agent in chosen.values()
    }
    for effective in chosen.values():
        slug = (
            re.sub(r"[^a-z0-9-]+", "-", effective["role"].lower()).strip("-")[:80]
            or "engineering"
        )
        effective["role_context"] = read_context(f"role/{slug}/CONTEXT.md")
    if (
        len(
            json.dumps(
                {"context": context, "agents": chosen}, ensure_ascii=False
            ).encode()
        )
        > 400000
    ):
        raise HTTPException(413, "Selected context exceeds run budget")
    if task.status == "backlog":
        transition(db, task, "todo", actor, "Workflow scheduled")
    if task.status == "todo":
        transition(db, task, "in_progress", actor, "Workflow started")
    run = WorkflowRun(
        id=run_id,
        task_id=task.id,
        active_task_id=task.id,
        task_version=task.version,
        status="queued",
        agents=chosen,
        context_snapshot=context,
        workspace_path=str(root),
    )
    db.add(run)
    flush(db)
    for spec in steps:
        workspace = root / "agents" / spec.key
        workspace.mkdir(parents=True)
        for skill in chosen[spec.key]["skills"]:
            folder = workspace / ".agents" / "skills" / skill["name"]
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "SKILL.md").write_text(skill["content"], encoding="utf-8")
        session = AgentSession(
            task_id=task.id,
            agent_id=spec.agent_id,
            workspace_path=str(workspace),
            context_snapshot={
                **{k: v for k, v in context.items() if k != "agent_skills"},
                "skills": chosen[spec.key]["skills"],
                "role": chosen[spec.key]["role"],
                "role_context": chosen[spec.key]["role_context"],
            },
        )
        db.add(session)
        flush(db)
        db.add(
            WorkflowStep(
                run_id=run.id,
                key=spec.key,
                kind=spec.kind,
                agent_id=spec.agent_id,
                session_id=session.id,
                instructions=spec.instructions,
                depends_on=spec.depends_on,
            )
        )
        emit(
            db,
            run,
            "agent.queued",
            {
                "agent_id": spec.agent_id,
                "agent_name": chosen[spec.key]["name"],
                "session_id": session.id,
            },
            spec.key,
            actor,
        )
    emit(
        db,
        run,
        "workflow.queued",
        {"topological_order": order, "source": source},
        actor=actor,
    )
    commit(db)
    background.add_task(WorkflowEngine(db.get_bind()).execute, run.id)
    return run


@router.get("/api/workflows")
def runs(
    project_id: str | None = None,
    task_id: str | None = None,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    query = select(WorkflowRun).order_by(WorkflowRun.created_at.desc()).limit(100)
    if project_id:
        query = query.join(Task, Task.id == WorkflowRun.task_id).where(
            Task.project_id == project_id
        )
    if task_id:
        query = query.where(WorkflowRun.task_id == task_id)
    rows = db.scalars(query).all()
    active = (
        db.scalars(
            select(WorkflowStep).where(
                WorkflowStep.run_id.in_([r.id for r in rows]),
                WorkflowStep.state == "running",
            )
        ).all()
        if rows
        else []
    )
    return [
        {
            **run_payload(row),
            "active_steps": [
                {"key": s.key, "agent_name": row.agents[s.key]["name"]}
                for s in active
                if s.run_id == row.id
            ],
        }
        for row in rows
    ]


@router.get("/api/workflows/{run_id}")
def detail(run_id: str, db: Session = Depends(get_db), actor=Depends(identity)):
    run = get(db, WorkflowRun, run_id)
    steps = db.scalars(select(WorkflowStep).where(WorkflowStep.run_id == run_id)).all()
    rank = {key: index for index, key in enumerate(validate_dag(steps))}
    steps.sort(key=lambda step: rank[step.key])
    checkpoints = db.scalars(
        select(GraphCheckpoint.checkpoint_id)
        .where(GraphCheckpoint.thread_id == run_id)
        .order_by(GraphCheckpoint.checkpoint_id.desc())
        .limit(100)
    ).all()
    return {
        "run": run_payload(run),
        "steps": [
            {
                **jsonable_encoder(step, exclude={"runtime_state"}),
                "provider_session_id": db.get(
                    AgentSession, step.session_id
                ).provider_session_id,
                "generated_files": step.runtime_state.get("files", []),
            }
            for step in steps
        ],
        "events": db.scalars(
            select(RunEvent)
            .where(RunEvent.run_id == run_id)
            .order_by(RunEvent.sequence.desc())
            .limit(250)
        ).all()[::-1],
        "artifacts": db.scalars(
            select(RunArtifact)
            .where(RunArtifact.run_id == run_id)
            .order_by(RunArtifact.stage)
        ).all(),
        "checkpoints": checkpoints,
    }


@router.get("/api/workflows/{run_id}/context")
def context_snapshot(
    run_id: str, db: Session = Depends(get_db), actor=Depends(identity)
):
    return get(db, WorkflowRun, run_id).context_snapshot


@router.get("/api/workflows/{run_id}/events")
def events(
    run_id: str, after: int = 0, db: Session = Depends(get_db), actor=Depends(identity)
):
    get(db, WorkflowRun, run_id)
    return db.scalars(
        select(RunEvent)
        .where(RunEvent.run_id == run_id, RunEvent.sequence > after)
        .order_by(RunEvent.sequence)
        .limit(500)
    ).all()


@router.post("/api/workflows/{run_id}/resume", status_code=202)
def resume(
    run_id: str,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    run = db.scalar(
        select(WorkflowRun).where(WorkflowRun.id == run_id).with_for_update()
    )
    if not run:
        raise HTTPException(404, "Workflow not found")
    if run.status not in {"failed", "interrupted"}:
        raise HTTPException(409, "Only failed or interrupted workflows can resume")
    try:
        # Validate using a transient state, without committing any status change on failure.
        previous = run.status
        run.status = "queued"
        WorkflowEngine(db.get_bind()).check(db, run)
    except RuntimeError as error:
        run.status = previous
        raise HTTPException(409, str(error))
    emit(db, run, "workflow.resumed", actor=actor)
    commit(db)
    background.add_task(WorkflowEngine(db.get_bind()).execute, run.id)
    return run


@router.post("/api/workflows/{run_id}/decision", status_code=202)
def decide(
    run_id: str,
    body: RunDecision,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    run = db.scalar(
        select(WorkflowRun).where(WorkflowRun.id == run_id).with_for_update()
    )
    if not run:
        raise HTTPException(404, "Workflow not found")
    if run.status != "awaiting_approval":
        raise HTTPException(409, "Workflow is not waiting for review")
    try:
        WorkflowEngine(db.get_bind()).check(db, run)
        if body.digest != run.result_digest or manifest(db, run) != body.digest:
            raise ValueError("Artifact digest changed")
        materialize(db, run, verify=True)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(409, str(error))
    run.decision = {"approved": body.approved, "digest": body.digest, "actor": actor}
    run.status = "queued"
    emit(db, run, "approval.workflow_review", run.decision, actor=actor)
    commit(db)
    background.add_task(WorkflowEngine(db.get_bind()).execute, run.id)
    return run


@router.post("/api/workflows/{run_id}/cancel")
def cancel(run_id: str, db: Session = Depends(get_db), actor=Depends(identity)):
    require_human(actor)
    run = db.scalar(
        select(WorkflowRun).where(WorkflowRun.id == run_id).with_for_update()
    )
    if not run:
        raise HTTPException(404, "Workflow not found")
    if run.status in {"completed", "rejected", "cancelled"}:
        raise HTTPException(409, "Workflow already finished")
    run.status = "cancelled"
    run.active_task_id = None
    for step in db.scalars(
        select(WorkflowStep).where(
            WorkflowStep.run_id == run_id,
            WorkflowStep.state.in_(["queued", "running", "failed", "interrupted"]),
        )
    ):
        step.state = "cancelled"
        db.get(AgentSession, step.session_id).state = "cancelled"
    task = db.get(Task, run.task_id)
    if task.version == run.task_version and task.status == "in_progress":
        transition(db, task, "todo", actor, "Workflow cancelled")
    emit(db, run, "workflow.cancelled", actor=actor)
    commit(db)
    return run


@router.get("/api/workflows/{run_id}/files")
def workspace_files(
    run_id: str,
    path: str | None = None,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    run = get(db, WorkflowRun, run_id)
    root = Path(run.workspace_path) / "source"
    try:
        if path:
            file = safe_path(root, path)
            if not file.is_file():
                raise HTTPException(404, "File not found")
            if file.stat().st_size > 262144:
                raise HTTPException(413, "File exceeds preview limit")
            return {"path": path, "content": file.read_text(encoding="utf-8")}
        return files(root)
    except (ValueError, UnicodeError):
        raise HTTPException(422, "Protected path or unsupported text file")


@router.post("/api/workflows/{run_id}/merge")
def merge(
    run_id: str,
    body: MergeRequest,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    run = db.scalar(
        select(WorkflowRun).where(WorkflowRun.id == run_id).with_for_update()
    )
    if not run:
        raise HTTPException(404, "Workflow not found")
    previous = db.scalar(
        select(RunEvent).where(
            RunEvent.run_id == run.id, RunEvent.kind == "workflow.merged"
        )
    )
    if previous:
        return previous.payload
    source = run.context_snapshot.get("source", {})
    repository = source.get("repository_path")
    task = db.get(Task, run.task_id)
    if (
        run.status != "completed"
        or not run.decision
        or not run.decision.get("approved")
    ):
        raise HTTPException(409, "Approve this workflow before merging")
    if (
        task.version != run.task_version + 1
        or body.digest != run.result_digest
        or manifest(db, run) != body.digest
    ):
        raise HTTPException(409, "Task or artifact version changed")
    if (
        snapshot(task.project_id, task.id, "merge-policy")["policy_sha256"]
        != run.context_snapshot["policy_sha256"]
    ):
        raise HTTPException(409, "Company policy changed; a fresh review is required")
    if not repository or source.get("kind") != "git-worktree":
        raise HTTPException(409, "This run has no Git repository")
    if body.expected_revision != source["revision"]:
        raise HTTPException(409, "Unexpected base revision")
    workspace = Path(run.workspace_path) / "source"
    try:
        materialize(db, run, verify=True)
        if git(["-C", repository, "rev-parse", "HEAD"]) != body.expected_revision:
            raise ValueError(
                "Repository advanced. Create a fresh run from the new base."
            )
        if git(["-C", repository, "status", "--porcelain"]):
            raise ValueError(
                "Repository has local changes; resolve them before merging."
            )
        hooks = Path(run.workspace_path) / ".relay" / "empty-hooks"
        hooks.mkdir(parents=True, exist_ok=True)
        options = [
            "-c",
            f"core.hooksPath={hooks}",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Relay Operator",
            "-c",
            "user.email=operator@localhost",
            *disabled_filters(repository),
        ]
        generated = {
            f["path"]
            for a in db.scalars(select(RunArtifact).where(RunArtifact.run_id == run.id))
            for f in json.loads(a.content)["files"]
        }
        if not generated:
            raise ValueError("This workflow generated no file changes")
        for path in generated:
            safe_path(workspace, path)
        git(["-C", str(workspace), *options, "add", "--", *sorted(generated)])
        if git(["-C", str(workspace), "diff", "--cached", "--name-only"]):
            git(["-C", str(workspace), *options, "commit", "-m", body.message])
        revision = git(["-C", str(workspace), "rev-parse", "HEAD"])
        changed = set(
            git(
                [
                    "-C",
                    str(workspace),
                    "diff",
                    "--name-only",
                    body.expected_revision,
                    revision,
                ]
            ).splitlines()
        )
        if not changed.issubset(generated):
            raise ValueError("Unreviewed files are present in the worktree commit")
        emit(
            db,
            run,
            "approval.merge",
            {
                "digest": body.digest,
                "base_revision": body.expected_revision,
                "commit": revision,
            },
            actor=actor,
        )
        db.add(
            Approval(
                task_id=task.id, task_version=task.version, kind="merge", actor=actor
            )
        )
        commit(db)
        git(["-C", repository, *options, "merge", "--ff-only", revision])
    except ValueError as error:
        emit(db, run, "workflow.merge_failed", {"message": str(error)}, actor=actor)
        commit(db)
        raise HTTPException(409, str(error))
    result = {"commit": revision, "repository": repository, "digest": body.digest}
    emit(db, run, "workflow.merged", result, actor=actor)
    commit(db)
    return result


@router.get("/api/workflows/{run_id}/export")
def export(run_id: str, db: Session = Depends(get_db), actor=Depends(identity)):
    run = get(db, WorkflowRun, run_id)
    artifacts = db.scalars(
        select(RunArtifact).where(RunArtifact.run_id == run_id)
    ).all()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for artifact in artifacts:
            archive.writestr(f"artifacts/{artifact.name}", artifact.content)
            for file in json.loads(artifact.content)["files"]:
                try:
                    safe_path(Path(run.workspace_path) / "source", file["path"])
                except ValueError:
                    raise HTTPException(409, "Invalid artifact path")
                archive.writestr(f"{artifact.stage}/{file['path']}", file["content"])
    return Response(
        buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="workflow-{run_id}.zip"'
        },
    )
