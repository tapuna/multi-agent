"""Environment-owned array of named LLM connections; credentials never enter public metadata."""

import hashlib
import json
import os
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from .schemas import Runtime


class Profile(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,49}$")
    label: str = Field(default="", max_length=100)
    runtime: Runtime = "api"
    model: str = Field(min_length=1, max_length=150)
    enabled: bool = True
    api_base: str | None = None
    api_key_env: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]{0,99}$")

    @model_validator(mode="after")
    def check(self):
        if self.api_key_env and self.api_key_env.startswith(
            ("CONTROL_", "DATABASE_", "ARTIFACT_")
        ):
            raise ValueError("Reserved credential environment variable")
        if self.model.startswith("profile:"):
            raise ValueError("Recursive profile reference")
        if self.runtime != "api" and (self.api_base or self.api_key_env):
            raise ValueError("CLI profiles use native CLI authentication")
        if self.api_base:
            url = urlsplit(self.api_base)
            if (
                url.scheme not in {"http", "https"}
                or not url.netloc
                or url.username
                or url.password
                or url.query
                or url.fragment
            ):
                raise ValueError(
                    "Endpoint must be an HTTP(S) URL without credentials/query/fragment"
                )
        return self


def profiles():
    raw = os.getenv("LLM_PROFILES_JSON", "").strip()
    if not raw:
        return []
    try:
        if len(raw.encode()) > 131072:
            raise ValueError()
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) > 100:
            raise ValueError()
        result = [Profile.model_validate(value) for value in values]
        if len({p.id for p in result}) != len(result):
            raise ValueError()
        return result
    except (ValueError, TypeError, ValidationError):
        raise ValueError(
            "Invalid LLM_PROFILES_JSON: expected an array (max 100) with unique id, runtime, model, enabled, optional api_base and api_key_env; inline keys are not allowed"
        ) from None


def resolve(model, runtime=None):
    if not model.startswith("profile:"):
        return {"model": model, "profile": None}
    selected = next(
        (p for p in profiles() if p.id == model.removeprefix("profile:")), None
    )
    if not selected:
        raise ValueError("LLM profile not found; select a configured profile")
    if not selected.enabled:
        raise ValueError("LLM profile is disabled")
    if runtime and selected.runtime != runtime:
        raise ValueError("LLM profile does not match this runtime")
    if selected.api_key_env and not os.getenv(selected.api_key_env):
        raise ValueError(
            "Missing credential environment variable: " + selected.api_key_env
        )
    return {"model": selected.model, "profile": selected}


def signature(model):
    try:
        resolved = resolve(model)
        p = resolved["profile"]
        data = {
            "model": resolved["model"],
            "profile": p.model_dump() if p else None,
            "credential": os.getenv(p.api_key_env, "") if p and p.api_key_env else "",
            "legacy_endpoint": os.getenv("LLM_API_BASE", "") if not p else "",
            "legacy_key": os.getenv("LLM_API_KEY", "") if not p else "",
        }
    except ValueError as error:
        data = {"error": str(error)}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def public_catalog():
    return [
        {
            "id": p.id,
            "reference": "profile:" + p.id,
            "label": p.label or p.id,
            "runtime": p.runtime,
            "model": p.model,
            "enabled": p.enabled,
            "api_base": p.api_base,
            "credential_configured": not p.api_key_env
            or bool(os.getenv(p.api_key_env)),
            "uses_native_auth": p.runtime != "api" or not p.api_key_env,
        }
        for p in profiles()
    ]


def describe(model):
    try:
        connection = resolve(model)
    except ValueError as error:
        return {"reference": model, "error": str(error)}
    p = connection["profile"]
    return {
        "reference": model,
        "model": connection["model"],
        "profile_id": p.id if p else None,
        "runtime": p.runtime if p else None,
        "api_base": p.api_base if p else None,
    }


def allowed(model, allowed_models):
    try:
        actual = resolve(model)["model"]
        return not allowed_models or model in allowed_models or actual in allowed_models
    except ValueError:
        return False
