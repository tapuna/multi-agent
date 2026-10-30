from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_db
from .models import Project, Task, WorkflowTemplate
from .services import identity, require_human, get, audit, commit
from .workflow_schemas import TemplateCreate, TemplateUpdate, DefaultWorkflowUpdate
from .workflow_templates import BUILTINS, definition, effective, validate_definition

router = APIRouter(tags=["workflow configuration"])


@router.get("/api/projects/{project_id}/workflow-templates")
def templates(project_id: str, db: Session = Depends(get_db), actor=Depends(identity)):
    project = get(db, Project, project_id)
    return {
        "templates": [
            *BUILTINS,
            *db.scalars(
                select(WorkflowTemplate)
                .where(WorkflowTemplate.project_id == project_id)
                .order_by(WorkflowTemplate.name, WorkflowTemplate.id)
            ).all(),
        ],
        "default_workflow_id": project.default_workflow_id,
        "version": project.workflow_config_version,
    }


@router.post("/api/projects/{project_id}/workflow-templates", status_code=201)
def create(
    project_id: str,
    body: TemplateCreate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    get(db, Project, project_id)
    validate_definition(db, body.steps)
    row = WorkflowTemplate(project_id=project_id, **body.model_dump())
    db.add(row)
    db.flush()
    audit(
        db,
        actor,
        "workflow_template.created",
        {
            "id": row.id,
            "project_id": project_id,
            "version": row.version,
            **body.model_dump(),
        },
    )
    commit(db)
    return row


@router.put("/api/projects/{project_id}/workflow-templates/{template_id}")
def edit(
    project_id: str,
    template_id: str,
    body: TemplateUpdate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    row = db.scalar(
        select(WorkflowTemplate)
        .where(
            WorkflowTemplate.id == template_id,
            WorkflowTemplate.project_id == project_id,
        )
        .with_for_update()
    )
    if not row:
        raise HTTPException(
            404, "Project workflow template not found; clone built-ins to edit"
        )
    if row.version != body.version:
        raise HTTPException(409, "Workflow changed; reload before saving")
    validate_definition(db, body.steps)
    before = {
        "name": row.name,
        "description": row.description,
        "steps": row.steps,
        "version": row.version,
    }
    row.name, row.description, row.steps = (
        body.name,
        body.description,
        [s.model_dump() for s in body.steps],
    )
    row.version += 1
    audit(
        db,
        actor,
        "workflow_template.updated",
        {
            "id": row.id,
            "project_id": project_id,
            "before": before,
            "after": body.model_dump(),
            "version": row.version,
        },
    )
    commit(db)
    return row


@router.patch("/api/projects/{project_id}/default-workflow")
def default(
    project_id: str,
    body: DefaultWorkflowUpdate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    project = db.scalar(
        select(Project).where(Project.id == project_id).with_for_update()
    )
    if not project:
        raise HTTPException(404, "Project not found")
    if project.workflow_config_version != body.version:
        raise HTTPException(409, "Project workflow settings changed; reload")
    if body.workflow_template_id:
        definition(db, project_id, body.workflow_template_id)
    previous = project.default_workflow_id
    project.default_workflow_id = body.workflow_template_id
    project.workflow_config_version += 1
    audit(
        db,
        actor,
        "project.default_workflow_changed",
        {
            "project_id": project_id,
            "before": previous,
            "after": project.default_workflow_id,
            "version": project.workflow_config_version,
        },
    )
    commit(db)
    return project


@router.get("/api/tasks/{task_id}/workflow-config")
def task_config(task_id: str, db: Session = Depends(get_db), actor=Depends(identity)):
    task = get(db, Task, task_id)
    template, source = effective(db, get(db, Project, task.project_id), task)
    return {
        "selected_id": task.workflow_template_id,
        "effective": template,
        "source": source,
    }
