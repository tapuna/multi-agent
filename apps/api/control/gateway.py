"""Bounded text-only LiteLLM gateway. No model-controlled tools or processes."""

import os
from dataclasses import dataclass
from .llm_profiles import resolve, allowed


@dataclass(frozen=True)
class Completion:
    content: str
    response_id: str | None
    usage: dict


def settings():
    return {
        "enabled": os.getenv("AGENT_EXECUTION_ENABLED", "1") == "1",
        "allowed_models": [
            v.strip()
            for v in os.getenv("CONTROL_ALLOWED_MODELS", "").split(",")
            if v.strip()
        ],
        "max_output_tokens": 4096,
        "capabilities": [
            "text_completion",
            "workspace_files",
            "artifacts",
            "checkpoints",
        ],
        "cli_execution": True,
    }


class LiteLLMGateway:
    def complete(
        self,
        model: str,
        system: str,
        user: str,
        *,
        max_output_tokens: int = 4096,
        timeout_seconds: int = 60,
    ) -> Completion:
        config = settings()
        connection = resolve(model, "api")
        if not config["enabled"] or (not allowed(model, config["allowed_models"])):
            raise ValueError("Model execution is disabled or model is not allowed")
        # Import lazily: board startup does not initialize any LLM provider.
        import litellm

        litellm.suppress_debug_info = True
        kwargs = {}
        profile = connection["profile"]
        if profile:
            if profile.api_base:
                kwargs["api_base"] = profile.api_base
            if profile.api_key_env:
                kwargs["api_key"] = os.environ[profile.api_key_env]
        elif os.getenv("LLM_API_BASE"):
            kwargs["api_base"] = os.environ["LLM_API_BASE"]
        if not profile and os.getenv("LLM_API_KEY"):
            kwargs["api_key"] = os.environ["LLM_API_KEY"]
        response = litellm.completion(
            model=connection["model"],
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=max_output_tokens,
            timeout=timeout_seconds,
            num_retries=0,
            **kwargs,
        )
        message = response.choices[0].message
        if getattr(message, "tool_calls", None):
            raise ValueError("Tool requests are not permitted for text-only workflow")
        content = message.content
        if (
            not isinstance(content, str)
            or not content.strip()
            or len(content.encode()) > 262144
        ):
            raise ValueError("Provider returned an empty or oversized artifact")
        usage = response.usage.model_dump() if response.usage else {}
        return Completion(
            content, str(response.id)[:250] if response.id else None, usage
        )
