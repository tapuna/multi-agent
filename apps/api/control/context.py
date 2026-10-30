from pathlib import Path
import hashlib
import os
from .database_config import ROOT as PROJECT_ROOT

ROOT = Path(os.getenv("CONTEXT_ROOT", str(PROJECT_ROOT / "contexts")))


def snapshot(project_id: str, task_id: str, role: str):
    # Company constraints are a separate mandatory envelope, never an overridable merge.
    company_file = ROOT / "company" / "POLICY.md"
    policy = (
        company_file.read_text(encoding="utf-8")
        if company_file.exists()
        else "Human approval required for merge and deployment. No destructive operations."
    )
    return {
        "company_policy": policy,
        "policy_sha256": hashlib.sha256(policy.encode()).hexdigest(),
        "project_id": project_id,
        "task_id": task_id,
        "role": role,
        "precedence": ["company", "team", "project", "role", "task"],
        "execution_enabled": False,
    }
