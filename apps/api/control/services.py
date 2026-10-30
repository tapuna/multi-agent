import os
import secrets
from fastapi import Header, HTTPException
from sqlalchemy.exc import IntegrityError, DBAPIError
from .models import (
    AuditEvent,
)


def identity(
    x_api_key: str = Header(default=""), x_human_key: str = Header(default="")
):
    human = os.getenv("CONTROL_HUMAN_KEY", "")
    agent = os.getenv("CONTROL_API_KEY", "")
    if human and secrets.compare_digest(x_human_key, human):
        return "human:operator"
    if agent and secrets.compare_digest(x_api_key, agent):
        return "service:agent"
    raise HTTPException(401, "Valid API credentials required")


def require_human(actor):
    if not actor.startswith("human:"):
        raise HTTPException(403, "Human approval required")


def get(session, model, key):
    row = session.get(model, key)
    if not row:
        raise HTTPException(404, f"{model.__name__} not found")
    return row


def audit(db, actor, action, payload, task_id=None):
    db.add(AuditEvent(actor=actor, action=action, payload=payload, task_id=task_id))


def is_integrity_conflict(exc):
    # firebird-driver reports integrity violations using its DatabaseError class.
    return (
        isinstance(exc, IntegrityError)
        or str(getattr(exc.orig, "sqlstate", "")).startswith("23")
        or getattr(exc.orig, "sqlcode", None) in {-803, -530, -625}
    )


def is_lock_conflict(exc):
    original = getattr(exc, "orig", exc)
    return (
        str(getattr(original, "sqlstate", "")) == "40001"
        or getattr(original, "sqlcode", None) == -913
    )


def commit(db):
    try:
        db.commit()
    except DBAPIError as exc:
        db.rollback()
        if not is_integrity_conflict(exc):
            raise
        raise HTTPException(
            409, "Concurrent update or duplicate record; refresh and retry"
        )


def flush(db):
    try:
        db.flush()
    except DBAPIError as exc:
        db.rollback()
        if not is_integrity_conflict(exc):
            raise
        raise HTTPException(409, "Duplicate record or concurrent write")
