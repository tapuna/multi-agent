"""Freeze company constraints separately from lower-trust engineering context."""

from sqlalchemy import select
from .context import ROOT, snapshot
from .models import Memory, Project


def read_context(relative: str) -> str:
    root = ROOT.resolve()
    path = root / relative
    if not path.resolve().is_relative_to(root):
        raise ValueError("Context path escapes configured root")
    if not path.is_file():
        return ""
    if path.stat().st_size > 65536:
        raise ValueError("Context file exceeds 64 KiB")
    return path.read_text(encoding="utf-8")


def build_context(db, task):
    project = db.get(Project, task.project_id)
    envelope = snapshot(task.project_id, task.id, "engineering-workflow")
    envelope["execution_enabled"] = True
    envelope["capabilities"] = [
        "text_completion",
        "bounded_workspace_files",
        "append_artifact",
    ]
    envelope["prohibited"] = [
        "shell",
        "base_repository_write",
        "merge",
        "deploy",
        "network_tools",
    ]
    envelope["task"] = {
        "id": task.id,
        "version": task.version,
        "title": task.title,
        "description": task.description,
    }
    envelope["project"] = {"name": project.name, "description": project.description}
    envelope["layers"] = {
        "team": read_context("team/CONTEXT.md"),
        "project": read_context(f"project/{project.id}/CONTEXT.md"),
        "task": read_context(f"task/{task.id}/CONTEXT.md"),
    }
    envelope["shared_memory"] = db.scalars(
        select(Memory.content)
        .where(Memory.project_id == project.id)
        .order_by(Memory.id)
        .limit(20)
    ).all()
    return envelope
