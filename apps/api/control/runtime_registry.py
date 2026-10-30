"""Runtime setup precedes agent registration; availability is always checked server-side."""

import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from .db import get_db
from .models import RuntimeConfiguration, Agent, now
from .schemas import Input, Runtime
from .runtime import executable, ADAPTERS, RuntimeRequest, redact
from .gateway import settings
from .services import identity, require_human, audit, commit
from .llm_profiles import signature, resolve, allowed

router = APIRouter(tags=["runtime setup"])
RUNTIMES = ("codex", "claude", "gemini", "api")


def fingerprint(row):
    credentials = {
        k: v
        for k, v in os.environ.items()
        if v
        and not k.startswith(("CONTROL_", "ARTIFACT_S3_"))
        and (
            k.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD"))
            or k
            in {
                "LLM_API_BASE",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "AWS_SECRET_ACCESS_KEY",
                "AZURE_API_BASE",
                "AZURE_API_VERSION",
            }
        )
    }
    return hashlib.sha256(
        json.dumps(
            {
                "runtime": row.runtime,
                "model": row.probe_model,
                "llm_profile": signature(row.probe_model),
                "version": row.version,
                "executable": executable(row.runtime)
                if row.runtime != "api"
                else "api",
                "environment": credentials,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


def availability(db, runtime):
    row = db.get(RuntimeConfiguration, runtime)
    installed = runtime == "api" or bool(executable(runtime))
    available = bool(
        row
        and row.enabled
        and installed
        and row.status == "passed"
        and row.verified_hash == fingerprint(row)
    )
    reason = "Ready" if available else "Set up and verify this adapter in Setup first"
    if row:
        if not row.enabled:
            reason = "Runtime adapter is disabled in Setup"
        elif not installed:
            reason = "Runtime executable is no longer available on this machine"
        elif row.status == "running":
            reason = "Runtime verification is running"
        elif row.status == "passed" and not available:
            reason = "Runtime configuration changed; verify again in Setup"
        elif row.result.get("message"):
            reason = row.result["message"]
    return {
        "runtime": runtime,
        "available": available,
        "installed": installed,
        "enabled": bool(row and row.enabled),
        "version": row.version if row else 0,
        "probe_model": row.probe_model if row else "",
        "status": "available" if available else row.status if row else "not_configured",
        "reason": reason,
        "result": row.result if row else {},
    }


def ensure_available(db, runtime):
    state = availability(db, runtime)
    if not state["available"]:
        raise HTTPException(
            409,
            {
                "message": state["reason"],
                "runtime": runtime,
                "action": "Open Setup → Runtime adapters",
            },
        )


class RuntimeSetup(Input):
    version: int = Field(ge=0)
    enabled: bool
    probe_model: str = Field(default="", max_length=150)


class RuntimeEngine:
    def __init__(self, factory):
        self.factory = factory

    def run(self, runtime, version, expected_hash):
        try:
            with self.factory() as db:
                row = db.get(RuntimeConfiguration, runtime)
                if row.version != version or row.status != "running":
                    return
                model = row.probe_model
            token = "RELAY_OK_" + uuid4().hex[:16]
            workspace = (
                Path(os.getenv("WORKSPACE_ROOT", "./workspaces")).resolve()
                / "runtime-checks"
                / uuid4().hex
            )
            workspace.mkdir(parents=True)

            def check():
                with self.factory() as db:
                    current = db.get(RuntimeConfiguration, runtime)
                    if (
                        not current.enabled
                        or current.version != version
                        or current.status != "running"
                    ):
                        raise RuntimeError("Runtime setup changed or was disabled")

            result = ADAPTERS[runtime].run(
                RuntimeRequest(
                    "This is a connectivity/authentication/model readiness check. Do not use tools or read files. Reply exactly with: "
                    + token,
                    workspace,
                    model,
                    purpose="diagnostic",
                    timeout_seconds=30,
                ),
                lambda *_: None,
                check,
            )
            check()
            verified = result.content.strip() == token
            with self.factory() as db:
                row = db.scalar(
                    select(RuntimeConfiguration)
                    .where(RuntimeConfiguration.runtime == runtime)
                    .with_for_update()
                )
                if row.version != version or row.status != "running":
                    return
                verified = verified and fingerprint(row) == expected_hash
                row.status = "passed" if verified else "failed"
                row.verified_hash = expected_hash if verified else None
                row.result = {
                    "message": "Provider verified; adapter available for agent registration"
                    if verified
                    else "Verification failed or configuration changed; retry Setup test",
                    "tested_at": now().isoformat(),
                    "model": model,
                }
                audit(
                    db,
                    "system:runtime-setup",
                    "runtime.verified" if verified else "runtime.verification_failed",
                    {"runtime": runtime, "version": version, "result": row.result},
                )
                db.commit()
        except Exception as error:
            with self.factory() as db:
                row = db.scalar(
                    select(RuntimeConfiguration)
                    .where(RuntimeConfiguration.runtime == runtime)
                    .with_for_update()
                )
                if row.version != version or row.status != "running":
                    return
                row.status, row.verified_hash = "failed", None
                row.result = {
                    "message": redact(str(error))[:500]
                    if isinstance(error, (RuntimeError, ValueError, TimeoutError))
                    else "Provider verification failed; check login/API key, endpoint and model access",
                    "tested_at": now().isoformat(),
                }
                audit(
                    db,
                    "system:runtime-setup",
                    "runtime.verification_failed",
                    {"runtime": runtime, "result": row.result},
                )
                db.commit()

    def recover(self):
        with self.factory() as db:
            for row in db.scalars(
                select(RuntimeConfiguration).where(
                    RuntimeConfiguration.status == "running"
                )
            ):
                row.status = "interrupted"
                row.result = {"message": "Application restarted; verify adapter again"}
                audit(
                    db,
                    "system:runtime-setup",
                    "runtime.verification_interrupted",
                    {"runtime": row.runtime},
                )
            db.commit()


@router.get("/api/runtime-adapters")
def adapters(db: Session = Depends(get_db), actor=Depends(identity)):
    return [availability(db, runtime) for runtime in RUNTIMES]


@router.put("/api/runtime-adapters/{runtime}")
def configure(
    runtime: Runtime,
    body: RuntimeSetup,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    row = db.scalar(
        select(RuntimeConfiguration)
        .where(RuntimeConfiguration.runtime == runtime)
        .with_for_update()
    )
    if (row.version if row else 0) != body.version:
        raise HTTPException(409, "Runtime settings changed; refresh")
    if not row:
        row = RuntimeConfiguration(runtime=runtime, version=0)
        db.add(row)
    row.enabled, row.probe_model = body.enabled, body.probe_model
    row.version += 1
    row.status = "unverified" if row.enabled else "disabled"
    row.verified_hash = None
    affected = db.scalars(select(Agent.id).where(Agent.runtime == runtime)).all()
    row.result = {
        "message": "Saved; verify adapter before use"
        if row.enabled
        else "Disabled; linked agents cannot execute"
    }
    audit(
        db,
        actor,
        "runtime.configured",
        {
            "runtime": runtime,
            "enabled": row.enabled,
            "version": row.version,
            "probe_model": row.probe_model,
            "affected_agents": affected,
        },
    )
    commit(db)
    return availability(db, runtime)


@router.post("/api/runtime-adapters/{runtime}/verify", status_code=202)
def verify(
    runtime: Runtime,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    row = db.scalar(
        select(RuntimeConfiguration)
        .where(RuntimeConfiguration.runtime == runtime)
        .with_for_update()
    )
    if not row or not row.enabled:
        raise HTTPException(409, "Set up and enable this adapter first")
    if row.status == "running":
        raise HTTPException(409, "Adapter verification already running")
    if not row.probe_model or row.probe_model == "configure-before-execution":
        raise HTTPException(422, "Set a real verification model first")
    if runtime != "api" and not executable(runtime):
        raise HTTPException(409, "Install this CLI on the machine first")
    if not settings()["enabled"]:
        raise HTTPException(409, "Execution disabled")
    if not allowed(row.probe_model, settings()["allowed_models"]):
        raise HTTPException(403, "Model outside allowlist")
    try:
        resolve(row.probe_model, runtime)
    except ValueError as error:
        raise HTTPException(422, str(error))
    row.status = "running"
    row.verified_hash = None
    row.result = {"message": "Verifying provider access…"}
    audit(
        db,
        actor,
        "runtime.verification_requested",
        {"runtime": runtime, "model": row.probe_model, "version": row.version},
    )
    commit(db)
    background.add_task(
        RuntimeEngine(sessionmaker(bind=db.get_bind(), expire_on_commit=False)).run,
        runtime,
        row.version,
        fingerprint(row),
    )
    return {"status": "running"}
