"""An LLM profile must pass its own provider test before agent configuration."""

import hashlib
import json
import os
import time
from pathlib import Path
from uuid import uuid4
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from .db import get_db
from .models import LLMReadiness, now
from .llm_profiles import (
    profiles,
    public_catalog,
    signature,
    allowed,
    describe,
)
from .runtime import executable, ADAPTERS, RuntimeRequest, redact
from .gateway import settings
from .services import identity, require_human, audit, commit

router = APIRouter(tags=["LLM profile readiness"])


def find(reference):
    return next((p for p in profiles() if reference == "profile:" + p.id), None)


def fingerprint(profile):
    native = (
        {
            k: v
            for k, v in os.environ.items()
            if v
            and not k.startswith(("CONTROL_", "ARTIFACT_"))
            and k.endswith(("_API_KEY", "_TOKEN"))
        }
        if not profile.api_key_env
        else {}
    )
    return hashlib.sha256(
        json.dumps(
            {
                "profile": signature("profile:" + profile.id),
                "native_auth": native,
                "executable": executable(profile.runtime)
                if profile.runtime != "api"
                else "api",
                "allowlist": settings()["allowed_models"],
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


def availability(db, reference, runtime=None):
    profile = find(reference)
    if not profile:
        return {
            "available": False,
            "status": "missing",
            "reason": "Choose an LLM profile from LLM_PROFILES_JSON and test it in Setup",
        }
    row = db.get(LLMReadiness, profile.id)
    installed = profile.runtime == "api" or bool(executable(profile.runtime))
    status = row.status if row else "not_tested"
    reason = (
        row.result.get("message", "")
        if row
        else "Test this LLM profile in Setup before configuring an agent"
    )
    ready = False
    if runtime and profile.runtime != runtime:
        status, reason = "runtime_mismatch", "LLM profile does not match this runtime"
    elif not profile.enabled:
        status, reason = "disabled", "LLM profile is disabled in LLM_PROFILES_JSON"
    elif not installed:
        status, reason = (
            "runtime_missing",
            "Runtime executable not found on this machine",
        )
    elif profile.api_key_env and not os.getenv(profile.api_key_env):
        status, reason = (
            "missing_credentials",
            "Credential environment variable is missing: " + profile.api_key_env,
        )
    elif not allowed(reference, settings()["allowed_models"]):
        status, reason = "not_allowed", "Model is outside the server allowlist"
    elif row and row.config_hash != fingerprint(profile):
        status, reason = (
            "stale",
            "Profile configuration changed; test this LLM again in Setup",
        )
    elif row and row.status == "passed":
        ready = True
        reason = "This LLM profile passed its provider test"
    return {
        "available": ready,
        "status": status,
        "reason": reason,
        "installed": installed,
        "version": row.version if row else 0,
        "tested_at": row.tested_at.isoformat() if row and row.tested_at else None,
        "latency_ms": row.latency_ms if row else None,
    }


def catalog(db):
    return [
        {**item, **availability(db, item["reference"], item["runtime"])}
        for item in public_catalog()
    ]


class ProfileEngine:
    def __init__(self, factory):
        self.factory = factory

    def run(self, profile_id, version, expected_hash):
        started = time.monotonic()
        try:
            reference = "profile:" + profile_id
            profile = find(reference)
            if not profile:
                raise ValueError("Profile was removed")
            with self.factory() as db:
                row = db.get(LLMReadiness, profile_id)
                if row.version != version or row.status != "running":
                    return
            token = "RELAY_OK_" + uuid4().hex[:16]
            workspace = (
                Path(os.getenv("WORKSPACE_ROOT", "./workspaces")).resolve()
                / "llm-checks"
                / profile_id
                / uuid4().hex
            )
            workspace.mkdir(parents=True)

            def check():
                current = find(reference)
                if (
                    not current
                    or not current.enabled
                    or fingerprint(current) != expected_hash
                ):
                    raise ValueError(
                        "Profile configuration changed during testing; test again"
                    )
                with self.factory() as db:
                    state = db.get(LLMReadiness, profile_id)
                    if state.version != version or state.status != "running":
                        raise ValueError("Profile test interrupted")

            check()
            response = ADAPTERS[profile.runtime].run(
                RuntimeRequest(
                    "This is a connectivity/authentication/model readiness check. Do not use tools or read project files. Reply exactly with: "
                    + token,
                    workspace,
                    reference,
                    purpose="diagnostic",
                    timeout_seconds=30,
                ),
                lambda *_: None,
                check,
            )
            check()
            verified = response.content.strip() == token
            with self.factory() as db:
                row = db.scalar(
                    select(LLMReadiness)
                    .where(LLMReadiness.profile_id == profile_id)
                    .with_for_update()
                )
                if row.version != version or row.status != "running":
                    return
                row.status = "passed" if verified else "failed"
                row.tested_at = now()
                row.latency_ms = int((time.monotonic() - started) * 1000)
                row.result = {
                    "message": "Provider returned the expected fresh response"
                    if verified
                    else "Provider response did not match the verification token; profile not ready",
                    "connection": describe(reference),
                }
                audit(
                    db,
                    "system:llm-setup",
                    "llm.profile." + row.status,
                    {
                        "profile_id": profile_id,
                        "version": version,
                        "connection": describe(reference),
                        "latency_ms": row.latency_ms,
                    },
                )
                db.commit()
        except Exception as error:
            with self.factory() as db:
                row = db.scalar(
                    select(LLMReadiness)
                    .where(LLMReadiness.profile_id == profile_id)
                    .with_for_update()
                )
                if not row or row.version != version or row.status != "running":
                    return
                message = (
                    redact(str(error))[:500]
                    if isinstance(error, (ValueError, RuntimeError, TimeoutError))
                    else "Provider test failed; check credentials, endpoint, CLI login and model access"
                )
                current = find("profile:" + profile_id)
                secret = (
                    os.getenv(current.api_key_env, "")
                    if current and current.api_key_env
                    else ""
                )
                if secret:
                    message = message.replace(secret, "[REDACTED]")
                row.status = "failed"
                row.tested_at = now()
                row.latency_ms = int((time.monotonic() - started) * 1000)
                row.result = {"message": message}
                audit(
                    db,
                    "system:llm-setup",
                    "llm.profile.failed",
                    {"profile_id": profile_id, "message": message},
                )
                db.commit()

    def recover(self):
        with self.factory() as db:
            for row in db.scalars(
                select(LLMReadiness).where(LLMReadiness.status == "running")
            ):
                row.status = "interrupted"
                row.result = {
                    "message": "Application restarted; test this profile again"
                }
                audit(
                    db,
                    "system:llm-setup",
                    "llm.profile.interrupted",
                    {"profile_id": row.profile_id},
                )
            for row in db.scalars(
                select(LLMReadiness).where(LLMReadiness.status == "passed")
            ):
                current = find("profile:" + row.profile_id)
                if (
                    not current
                    or not current.enabled
                    or row.config_hash != fingerprint(current)
                ):
                    row.status = "stale"
                    row.result = {
                        "message": "Profile changed, was disabled or removed; test again before use"
                    }
                    audit(
                        db,
                        "system:llm-setup",
                        "llm.profile.invalidated",
                        {"profile_id": row.profile_id},
                    )
            db.commit()


@router.post("/api/llm-profiles/{profile_id}/verify", status_code=202)
def verify(
    profile_id: str,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    profile = find("profile:" + profile_id)
    if not profile:
        raise HTTPException(404, "Profile not found in LLM_PROFILES_JSON")
    state = availability(db, "profile:" + profile_id, profile.runtime)
    if state["status"] in {
        "disabled",
        "runtime_missing",
        "missing_credentials",
        "not_allowed",
    }:
        raise HTTPException(409, state["reason"])
    if not settings()["enabled"]:
        raise HTTPException(409, "Execution disabled")
    row = db.scalar(
        select(LLMReadiness)
        .where(LLMReadiness.profile_id == profile_id)
        .with_for_update()
    )
    if row and row.status == "running":
        raise HTTPException(409, "This profile is already being tested")
    if not row:
        row = LLMReadiness(profile_id=profile_id, version=0)
        db.add(row)
    row.version += 1
    row.status = "running"
    row.config_hash = fingerprint(profile)
    row.result = {"message": "Testing this LLM profile…"}
    row.latency_ms = None
    audit(
        db,
        actor,
        "llm.profile.test_requested",
        {
            "profile_id": profile_id,
            "connection": describe("profile:" + profile_id),
            "version": row.version,
        },
    )
    commit(db)
    background.add_task(
        ProfileEngine(sessionmaker(bind=db.get_bind(), expire_on_commit=False)).run,
        profile_id,
        row.version,
        row.config_hash,
    )
    return {"status": "running", "profile_id": profile_id}
