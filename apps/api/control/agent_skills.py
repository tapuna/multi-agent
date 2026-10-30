"""Only explicitly assigned packages enter an agent's execution context."""

from fastapi import HTTPException
from .routes_knowledge import packages


def resolve_skills(refs):
    if len(set(refs)) != len(refs):
        raise HTTPException(422, "Duplicate skill references")
    available = {f"{s['name']}@{s['version']}": s for s in packages()}
    missing = [ref for ref in refs if ref not in available]
    if missing:
        raise HTTPException(
            422,
            {
                "message": "Assigned skill versions are missing; update this agent's skills",
                "missing": missing,
            },
        )
    selected = [available[ref] for ref in refs]
    if len({s["name"] for s in selected}) != len(selected):
        raise HTTPException(422, "Assign only one version of each skill to an agent")
    return [
        {key: s[key] for key in ("name", "version", "content", "sha256")}
        for s in selected
    ]
