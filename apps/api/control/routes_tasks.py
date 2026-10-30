from fastapi import Depends, HTTPException
from sqlalchemy import select, func, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from .db import get_db
from .models import (
    Project,
    Task,
    Agent,
    Dependency,
    AuditEvent,
    AgentSession,
    Approval,
    WorkflowRun,
)
from .schemas import (
    TaskCreate,
    TaskUpdate,
    DependencyCreate,
    ApprovalCreate,
)

from fastapi import APIRouter
from .services import identity, require_human, get, audit, commit, is_integrity_conflict
from .workflow_templates import definition

router = APIRouter(tags=["tasks"])


@router.get("/api/tasks")
def tasks(
    project_id: str,
    limit: int = 500,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    get(db, Project, project_id)
    return db.scalars(
        select(Task)
        .where(Task.project_id == project_id)
        .order_by(Task.number)
        .limit(max(1, min(limit, 1000)))
    ).all()


@router.post("/api/tasks", status_code=201)
def create_task(
    body: TaskCreate, db: Session = Depends(get_db), actor=Depends(identity)
):
    # Serialize task numbering within a project; a unique key also guards concurrent inserts.
    project = db.scalar(
        select(Project).where(Project.id == body.project_id).with_for_update()
    )
    if not project:
        raise HTTPException(404, "Project not found")
    if body.assignee_id:
        get(db, Agent, body.assignee_id)
    number = (
        db.scalar(select(func.max(Task.number)).where(Task.project_id == project.id))
        or 0
    ) + 1
    row = Task(**body.model_dump(), number=number)
    db.add(row)
    try:
        db.flush()
    except DBAPIError as exc:
        db.rollback()
        if not is_integrity_conflict(exc):
            raise
        raise HTTPException(409, "Concurrent creation; retry")
    audit(db, actor, "task.created", body.model_dump(), row.id)
    commit(db)
    return row


@router.get("/api/tasks/{task_id}")
def task_detail(task_id: str, db: Session = Depends(get_db), actor=Depends(identity)):
    row = get(db, Task, task_id)
    return {
        "task": row,
        "dependencies": db.scalars(
            select(Dependency.depends_on_id).where(Dependency.task_id == task_id)
        ).all(),
        "events": db.scalars(
            select(AuditEvent)
            .where(AuditEvent.task_id == task_id)
            .order_by(AuditEvent.created_at.desc())
            .limit(200)
        ).all(),
        "sessions": db.scalars(
            select(AgentSession).where(AgentSession.task_id == task_id)
        ).all(),
        "approvals": db.scalars(
            select(Approval).where(Approval.task_id == task_id)
        ).all(),
    }


@router.patch("/api/tasks/{task_id}")
def update_task(
    task_id: str,
    body: TaskUpdate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    row = db.scalar(select(Task).where(Task.id == task_id).with_for_update())
    if not row:
        raise HTTPException(404, "Task not found")
    if row.version != body.version:
        raise HTTPException(409, "Task changed; refresh before saving")
    if db.scalar(select(WorkflowRun.id).where(WorkflowRun.active_task_id == task_id)):
        raise HTTPException(409, "Cancel the active workflow before editing this task")
    changes = body.model_dump(exclude_unset=True, exclude={"version"})
    if "workflow_template_id" in changes:
        require_human(actor)
        if changes["workflow_template_id"]:
            definition(db, row.project_id, changes["workflow_template_id"])
    if any(
        changes.get(k, "present") is None
        for k in ("title", "description", "status", "priority")
    ):
        raise HTTPException(422, "Required task fields cannot be null")
    if changes.get("assignee_id"):
        get(db, Agent, changes["assignee_id"])
    target = changes.get("status", row.status)
    transitions = {
        "backlog": {"todo"},
        "todo": {"backlog", "in_progress"},
        "in_progress": {"todo", "review"},
        "review": {"in_progress", "done"},
        "done": {"todo"},
    }
    if target != row.status:
        if target not in transitions[row.status]:
            raise HTTPException(409, "Invalid status transition")
        if target in {"in_progress", "done"}:
            blockers = db.scalars(
                select(Task)
                .join(Dependency, Task.id == Dependency.depends_on_id)
                .where(Dependency.task_id == task_id, Task.status != "done")
            ).all()
            if blockers:
                raise HTTPException(409, "Complete blocking dependencies first")
        if target == "done":
            require_human(actor)
            audit(db, actor, "approval.complete", {"version": row.version}, task_id)
            db.add(
                Approval(
                    task_id=task_id,
                    task_version=row.version,
                    kind="complete",
                    actor=actor,
                )
            )
    before = {key: getattr(row, key) for key in changes}
    result = db.execute(
        update(Task)
        .where(Task.id == task_id, Task.version == body.version)
        .values(**changes, version=body.version + 1)
    )
    if result.rowcount != 1:
        raise HTTPException(409, "Concurrent update; refresh")
    audit(
        db,
        actor,
        "task.updated",
        {"before": before, "after": changes, "version": body.version + 1},
        task_id,
    )
    commit(db)
    db.refresh(row)
    return row


@router.post("/api/tasks/{task_id}/dependencies", status_code=201)
def add_dependency(
    task_id: str,
    body: DependencyCreate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    row = get(db, Task, task_id)
    # Serialize graph mutations for the whole project to prevent concurrent cycles.
    db.scalar(select(Project).where(Project.id == row.project_id).with_for_update())
    other = get(db, Task, body.depends_on_id)
    if row.project_id != other.project_id:
        raise HTTPException(422, "Dependencies must share a project")
    if row.status not in {"backlog", "todo"}:
        raise HTTPException(409, "Reopen task before changing dependencies")
    edges = db.execute(select(Dependency)).scalars().all()
    graph: dict[str, list[str]] = {}
    for edge in edges:
        graph.setdefault(edge.task_id, []).append(edge.depends_on_id)
    pending, seen = [other.id], set()
    while pending:
        key = pending.pop()
        if key == task_id:
            raise HTTPException(409, "Dependency would create a cycle")
        if key not in seen:
            seen.add(key)
            pending.extend(graph.get(key, []))
    db.add(Dependency(task_id=task_id, depends_on_id=other.id))
    db.execute(update(Task).where(Task.id == task_id).values(version=Task.version + 1))
    audit(db, actor, "dependency.added", {"depends_on_id": other.id}, task_id)
    commit(db)
    return {"depends_on_id": other.id}


@router.post("/api/tasks/{task_id}/approvals", status_code=201)
def approve(
    task_id: str,
    body: ApprovalCreate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    task = db.scalar(select(Task).where(Task.id == task_id).with_for_update())
    if not task:
        raise HTTPException(404, "Task not found")
    if task.version != body.version:
        raise HTTPException(409, "Approval targets a stale task version")
    row = Approval(
        task_id=task_id, task_version=body.version, kind=body.kind, actor=actor
    )
    db.add(row)
    audit(db, actor, "approval." + body.kind, body.model_dump(), task_id)
    commit(db)
    return row
