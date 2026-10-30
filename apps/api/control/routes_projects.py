from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_db
from .models import (
    Project,
    Memory,
)
from .schemas import (
    ProjectCreate,
    MemoryCreate,
)

from fastapi import APIRouter
from .services import identity, get, audit, commit, flush

router = APIRouter(tags=["projects"])


@router.get("/api/projects")
def projects(db: Session = Depends(get_db), actor=Depends(identity)):
    return db.scalars(select(Project).order_by(Project.name)).all()


@router.post("/api/projects", status_code=201)
def create_project(
    body: ProjectCreate, db: Session = Depends(get_db), actor=Depends(identity)
):
    row = Project(**body.model_dump())
    db.add(row)
    flush(db)
    audit(db, actor, "project.created", {"project_id": row.id, "name": row.name})
    commit(db)
    return row


@router.get("/api/projects/{project_id}/memory")
def memories(project_id: str, db: Session = Depends(get_db), actor=Depends(identity)):
    get(db, Project, project_id)
    return db.scalars(
        select(Memory).where(Memory.project_id == project_id).limit(200)
    ).all()


@router.post("/api/projects/{project_id}/memory", status_code=201)
def add_memory(
    project_id: str,
    body: MemoryCreate,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    get(db, Project, project_id)
    row = Memory(project_id=project_id, content=body.content)
    db.add(row)
    audit(
        db, actor, "memory.created", {"project_id": project_id, "content": body.content}
    )
    commit(db)
    return row
