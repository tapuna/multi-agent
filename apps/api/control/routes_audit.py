from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_db
from .models import (
    AuditEvent,
)

from fastapi import APIRouter
from .services import identity

router = APIRouter(tags=["audit"])


@router.get("/api/audit")
def events(limit: int = 100, db: Session = Depends(get_db), actor=Depends(identity)):
    return db.scalars(
        select(AuditEvent)
        .order_by(AuditEvent.created_at.desc())
        .limit(max(1, min(limit, 500)))
    ).all()
