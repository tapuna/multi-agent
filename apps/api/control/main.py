from fastapi import FastAPI, Depends
from contextlib import asynccontextmanager
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError
from sqlalchemy import select, literal
from sqlalchemy.orm import Session
from .db import get_db, engine
from .services import identity, is_lock_conflict
from . import (
    routes_projects,
    routes_tasks,
    routes_agents,
    routes_audit,
    routes_workflows,
    routes_knowledge,
    routes_workflow_templates,
    routes_agent_chat,
    agent_diagnostics,
    runtime_registry,
    profile_readiness,
)
from .workflows import WorkflowEngine
from .gateway import settings
from .agent_chat import ChatEngine
from sqlalchemy.orm import sessionmaker
from .llm_profiles import profiles


@asynccontextmanager
async def lifespan(app):
    profiles()
    if get_db not in app.dependency_overrides:
        WorkflowEngine(engine).recover()
        ChatEngine(sessionmaker(bind=engine, expire_on_commit=False)).recover()
        agent_diagnostics.DiagnosticEngine(
            sessionmaker(bind=engine, expire_on_commit=False)
        ).recover()
        runtime_registry.RuntimeEngine(
            sessionmaker(bind=engine, expire_on_commit=False)
        ).recover()
        profile_readiness.ProfileEngine(
            sessionmaker(bind=engine, expire_on_commit=False)
        ).recover()
    yield


app = FastAPI(title="Engineering Control Center", version="0.2.0", lifespan=lifespan)


@app.exception_handler(DBAPIError)
async def database_error_handler(_request, error):
    # Includes SELECT ... WITH LOCK failures before a route reaches commit().
    if is_lock_conflict(error):
        return JSONResponse(
            status_code=409,
            headers={"Retry-After": "1"},
            content={
                "code": "database_busy",
                "detail": "Another transaction holds this record. Refresh and retry shortly.",
            },
        )
    return JSONResponse(
        status_code=500, content={"detail": "Database operation failed"}
    )


# Browser requests go through the same-origin Next.js proxy. No direct browser CORS.
for routes in (
    routes_projects,
    routes_tasks,
    routes_agents,
    routes_audit,
    routes_workflows,
    routes_knowledge,
    routes_workflow_templates,
    routes_agent_chat,
    agent_diagnostics,
    runtime_registry,
    profile_readiness,
):
    app.include_router(routes.router)


@app.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(select(literal(1)))
    dialect = db.get_bind().dialect.name
    return {
        "status": "ok",
        "database": "firebird" if dialect.startswith("firebird") else dialect,
        "execution_enabled": settings()["enabled"],
    }


@app.get("/api/system")
def system_info(db: Session = Depends(get_db), actor=Depends(identity)):
    result = health(db)
    bind = db.get_bind()
    result["database_mode"] = (
        "embedded"
        if result["database"] == "firebird" and not bind.url.host
        else "server"
    )
    result["database_version"] = list(bind.dialect.server_version_info or ())
    if result["database"] == "firebird":
        result["lock_timeout_seconds"] = (
            db.connection().connection.driver_connection.main_transaction.info.lock_timeout
        )
    return result
