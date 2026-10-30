"""Readiness is proven by a fresh response from the configured provider, not key presence."""

import hashlib
import json
import os
import time
from pathlib import Path
from uuid import uuid4
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from .db import get_db
from .models import Agent, AgentDiagnostic
from .services import identity, require_human, audit, commit
from .runtime import ADAPTERS, RuntimeRequest, executable, redact
from .gateway import settings
from .agent_skills import resolve_skills
from . import runtime_registry
from .llm_profiles import signature, allowed, describe

router = APIRouter(tags=["agent diagnostics"])


def configuration(agent):
    public = {
        "runtime": agent.runtime,
        "model": agent.model,
        "llm_profile": signature(agent.model),
        "llm_connection": describe(agent.model),
        "enabled": agent.enabled,
        "skill_refs": agent.skill_refs or [],
        "skills_version": agent.skills_version,
        "execution_enabled": settings()["enabled"],
        "cli_found": agent.runtime == "api" or bool(executable(agent.runtime)),
        "endpoint_configured": bool(os.getenv("LLM_API_BASE")),
    }
    private = {
        k: v
        for k, v in os.environ.items()
        if k
        in {
            "LLM_API_KEY",
            "LLM_API_BASE",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AWS_PROFILE",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AZURE_API_KEY",
            "AZURE_API_BASE",
            "CONTROL_ALLOWED_MODELS",
            "CODEX_BIN",
            "CLAUDE_BIN",
            "GEMINI_BIN",
        }
    }
    fingerprint = hashlib.sha256(
        json.dumps(
            {
                "config": public,
                "environment": private,
                "executable": executable(agent.runtime)
                if agent.runtime != "api"
                else "api",
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    return public, fingerprint


def preflight(agent, db=None):
    config, _ = configuration(agent)
    checks = [
        {
            "name": "Runtime configured, enabled and verified",
            "ok": runtime_registry.availability(db, agent.runtime)["available"]
            if db is not None
            else False,
        },
        {"name": "Agent enabled", "ok": agent.enabled},
        {"name": "Execution enabled", "ok": config["execution_enabled"]},
        {"name": "Runtime available", "ok": config["cli_found"]},
        {
            "name": "Model configured",
            "ok": bool(agent.model) and agent.model != "configure-before-execution",
        },
        {
            "name": "Model allowed",
            "ok": allowed(agent.model, settings()["allowed_models"]),
        },
    ]
    try:
        resolve_skills(agent.skill_refs or [])
        checks.append({"name": "Assigned skill versions available", "ok": True})
    except HTTPException:
        checks.append({"name": "Assigned skill versions available", "ok": False})
    return checks


def failure_hint(error):
    name = type(error).__name__.lower()
    if "authentication" in name or "permission" in name:
        return "Authentication failed. Check this provider's API credentials or CLI login and account permissions."
    if "ratelimit" in name or "quota" in name:
        return "Provider quota/rate limit reached. Check billing/quota and retry later."
    if "timeout" in name or isinstance(error, TimeoutError):
        return "Provider timed out. Check network, local endpoint and provider responsiveness, then retry."
    if "connection" in name or "serviceunavailable" in name:
        return "Could not reach provider. Check endpoint, network and whether the local model server is running."
    if "notfound" in name or "badrequest" in name:
        return "Provider rejected this model/request. Verify the exact model ID, endpoint and model access."
    return "Provider request failed. Check provider login, model ID and endpoint."


class DiagnosticEngine:
    def __init__(self, factory):
        self.factory = factory

    def run(self, test_id):
        started = time.monotonic()
        logs = []
        try:
            with self.factory() as db:
                test = db.get(AgentDiagnostic, test_id)
                if test.status != "running":
                    return
                agent = db.get(Agent, test.agent_id)
                if configuration(agent)[1] != test.config_hash:
                    raise ValueError(
                        "Agent configuration changed before test execution; run a new test."
                    )
                config = test.config_snapshot
                checks = preflight(agent, db)
                if not all(c["ok"] for c in checks):
                    raise ValueError("Preflight changed; refresh and retry.")
            workspace = (
                Path(os.getenv("WORKSPACE_ROOT", "./workspaces")).resolve()
                / "diagnostics"
                / test_id
            )
            workspace.mkdir(parents=True, exist_ok=False)
            nonce = "RELAY_OK_" + uuid4().hex[:16]

            def event(kind, payload):
                if kind == "runtime.log" and len(logs) < 6:
                    logs.append(redact(str(payload.get("message", "")))[:400])

            def check():
                with self.factory() as db:
                    if db.get(AgentDiagnostic, test_id).status != "running":
                        raise RuntimeError("Diagnostic was interrupted")

            result = ADAPTERS[config["runtime"]].run(
                RuntimeRequest(
                    "This is a connectivity/authentication/model readiness check. Do not use tools, read files, write files, or run commands. Reply with exactly the following token and nothing else: "
                    + nonce,
                    workspace,
                    config["model"],
                    purpose="diagnostic",
                    timeout_seconds=30,
                ),
                event,
                check,
            )
            verified = result.content.strip() == nonce
            with self.factory() as db:
                test = db.scalar(
                    select(AgentDiagnostic)
                    .where(AgentDiagnostic.id == test_id)
                    .with_for_update()
                )
                if test.status != "running":
                    return
                current_hash = configuration(db.get(Agent, test.agent_id))[1]
                test.status = "passed" if verified else "failed"
                test.active_agent_id = None
                test.latency_ms = int((time.monotonic() - started) * 1000)
                test.result = {
                    "checks": checks,
                    "response_verified": verified,
                    "message": "Configured provider returned the expected fresh response."
                    if verified
                    else "Provider responded, but did not return the expected verification token. This test does not confirm readiness.",
                    "hint": ""
                    if verified
                    else "Check model response format or try again.",
                    "config_changed_during_test": current_hash != test.config_hash,
                    "usage": result.usage or {},
                    "provider_session_id": result.provider_session_id,
                    "response_id": result.response_id,
                }
                audit(
                    db,
                    "system:diagnostics",
                    "agent.diagnostic." + test.status,
                    {
                        "test_id": test.id,
                        "agent_id": test.agent_id,
                        "latency_ms": test.latency_ms,
                        "response_verified": verified,
                    },
                )
                db.commit()
        except Exception as error:
            with self.factory() as db:
                test = db.scalar(
                    select(AgentDiagnostic)
                    .where(AgentDiagnostic.id == test_id)
                    .with_for_update()
                )
                if test.status != "running":
                    return
                test.status, test.active_agent_id = "failed", None
                test.latency_ms = int((time.monotonic() - started) * 1000)
                test.result = {
                    "response_verified": False,
                    "message": redact(str(error))[:500]
                    if isinstance(error, (ValueError, RuntimeError, TimeoutError))
                    else failure_hint(error),
                    "hint": failure_hint(error),
                    "logs": logs,
                }
                audit(
                    db,
                    "system:diagnostics",
                    "agent.diagnostic.failed",
                    {
                        "test_id": test.id,
                        "agent_id": test.agent_id,
                        "result": test.result,
                    },
                )
                db.commit()

    def recover(self):
        with self.factory() as db:
            for test in db.scalars(
                select(AgentDiagnostic).where(AgentDiagnostic.status == "running")
            ):
                test.status, test.active_agent_id = "interrupted", None
                test.result = {
                    "response_verified": False,
                    "message": "Application restarted. Run this test again; no automatic provider retry.",
                }
                audit(
                    db,
                    "system:diagnostics",
                    "agent.diagnostic.interrupted",
                    {"test_id": test.id, "agent_id": test.agent_id},
                )
            db.commit()


@router.get("/api/agent-diagnostics")
def diagnostics(db: Session = Depends(get_db), actor=Depends(identity)):
    agents = db.scalars(
        select(Agent).order_by(Agent.runtime, Agent.name, Agent.id)
    ).all()
    latest = {}
    for agent in agents:
        row = db.scalar(
            select(AgentDiagnostic)
            .where(AgentDiagnostic.agent_id == agent.id)
            .order_by(AgentDiagnostic.created_at.desc(), AgentDiagnostic.id.desc())
            .limit(1)
        )
        if row:
            latest[agent.id] = row
    return [
        {
            "agent": {
                "id": agent.id,
                "name": agent.name,
                "runtime": agent.runtime,
                "model": agent.model,
            },
            "checks": preflight(agent, db),
            "latest": {
                **jsonable_encoder(
                    latest[agent.id], exclude={"config_hash", "active_agent_id"}
                ),
                "stale": latest[agent.id].config_hash != configuration(agent)[1]
                or not runtime_registry.availability(db, agent.runtime)["available"],
            }
            if agent.id in latest
            else None,
        }
        for agent in agents
    ]


@router.post("/api/agents/{agent_id}/diagnostics", status_code=202)
def start_test(
    agent_id: str,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    agent = db.scalar(select(Agent).where(Agent.id == agent_id).with_for_update())
    if not agent:
        raise HTTPException(404, "Agent not found")
    if db.scalar(
        select(AgentDiagnostic.id).where(AgentDiagnostic.active_agent_id == agent_id)
    ):
        raise HTTPException(409, "This agent already has a running diagnostic")
    checks = preflight(agent, db)
    config, fingerprint = configuration(agent)
    ready = all(c["ok"] for c in checks)
    test = AgentDiagnostic(
        agent_id=agent.id,
        active_agent_id=agent.id if ready else None,
        status="running" if ready else "blocked",
        config_hash=fingerprint,
        config_snapshot=config,
        result={
            "checks": checks,
            "response_verified": False,
            "message": "Provider test running."
            if ready
            else "Fix the failed preflight checks before testing the provider.",
        },
    )
    db.add(test)
    db.flush()
    audit(
        db,
        actor,
        "agent.diagnostic.requested",
        {"test_id": test.id, "agent_id": agent.id, "config": config, "checks": checks},
    )
    commit(db)
    if ready:
        background.add_task(
            DiagnosticEngine(
                sessionmaker(bind=db.get_bind(), expire_on_commit=False)
            ).run,
            test.id,
        )
    return {"id": test.id, "status": test.status}
