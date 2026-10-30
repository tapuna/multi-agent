"""Standard versioned skill packages and reviewed context files."""

import hashlib
import re
from threading import RLock
import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy.orm import Session
from .db import get_db
from .database_config import ROOT
from .context import ROOT as CONTEXT_ROOT
from .models import Project, Task
from .schemas import Input
from .services import identity, require_human, get, audit, commit

router = APIRouter(tags=["knowledge"])
lock = RLock()


class SkillInput(Input):
    name: str = Field(pattern=r"^[a-z][a-z0-9-]{0,49}$")
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$", max_length=30)
    description: str = Field(min_length=1, max_length=300)
    instructions: str = Field(min_length=1, max_length=60000)


class ContextInput(Input):
    content: str = Field(max_length=60000)
    previous_sha256: str


def digest(content):
    return hashlib.sha256(content.encode()).hexdigest()


def packages():
    root = (ROOT / "skills").resolve()
    result = []
    for file in [*root.glob("*/SKILL.md"), *root.glob("*/*/SKILL.md")]:
        if not file.resolve().is_relative_to(root) or file.stat().st_size > 65536:
            continue
        content = file.read_text(encoding="utf-8")
        try:
            metadata = yaml.safe_load(content.split("---", 2)[1])
        except (ValueError, IndexError, yaml.YAMLError):
            continue
        if not isinstance(metadata, dict):
            continue
        name = str(metadata.get("name", file.parent.name))
        version = str(metadata.get("version", "0.0.0"))
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,49}", name) or not re.fullmatch(
            r"\d+\.\d+\.\d+", version
        ):
            continue
        result.append(
            {
                "name": name,
                "description": str(metadata.get("description", "")),
                "version": version,
                "sha256": digest(content),
                "path": file.relative_to(ROOT).as_posix(),
                "content": content,
            }
        )
    return sorted(result, key=lambda item: (item["name"], item["version"]))


@router.get("/api/skills")
def list_skills(actor=Depends(identity)):
    return packages()


@router.post("/api/skills", status_code=201)
def publish(body: SkillInput, db: Session = Depends(get_db), actor=Depends(identity)):
    require_human(actor)
    with lock:
        if any(
            s["name"] == body.name and s["version"] == body.version for s in packages()
        ):
            raise HTTPException(409, "This skill version already exists")
        root = (ROOT / "skills").resolve()
        path = root / body.name / body.version / "SKILL.md"
        if not path.resolve().is_relative_to(root):
            raise HTTPException(422, "Invalid skill path")
        content = (
            "---\n"
            + yaml.safe_dump(
                body.model_dump(exclude={"instructions"}),
                sort_keys=False,
                allow_unicode=True,
            )
            + "---\n\n"
            + body.instructions
            + "\n"
        )
        audit(
            db,
            actor,
            "skill.publish_requested",
            {"name": body.name, "version": body.version, "sha256": digest(content)},
        )
        commit(db)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("x", encoding="utf-8", newline="\n") as file:
                file.write(content)
        except FileExistsError:
            raise HTTPException(409, "Skill version is immutable")
        audit(
            db,
            actor,
            "skill.published",
            {"name": body.name, "version": body.version, "sha256": digest(content)},
        )
        commit(db)
    return next(
        s for s in packages() if s["name"] == body.name and s["version"] == body.version
    )


def context_path(scope, target, db):
    root = CONTEXT_ROOT.resolve()
    if scope == "company":
        path = root / "company" / "POLICY.md"
    elif scope == "team":
        path = root / "team" / "CONTEXT.md"
    elif scope == "project":
        get(db, Project, target)
        path = root / "project" / target / "CONTEXT.md"
    elif scope == "task":
        get(db, Task, target)
        path = root / "task" / target / "CONTEXT.md"
    elif scope == "role":
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,79}", target):
            raise HTTPException(422, "Use a lowercase role slug")
        path = root / "role" / target / "CONTEXT.md"
    else:
        raise HTTPException(422, "Unknown context scope")
    if not path.resolve().is_relative_to(root):
        raise HTTPException(422, "Invalid context path")
    return path


@router.get("/api/contexts/{scope}/{target}")
def read_context(
    scope: str, target: str, db: Session = Depends(get_db), actor=Depends(identity)
):
    path = context_path(scope, target, db)
    content = path.read_text(encoding="utf-8") if path.is_file() else ""
    return {
        "scope": scope,
        "target": target,
        "content": content,
        "sha256": digest(content),
    }


@router.put("/api/contexts/{scope}/{target}")
def update_context(
    scope: str,
    target: str,
    body: ContextInput,
    db: Session = Depends(get_db),
    actor=Depends(identity),
):
    require_human(actor)
    with lock:
        path = context_path(scope, target, db)
        previous = path.read_text(encoding="utf-8") if path.is_file() else ""
        if digest(previous) != body.previous_sha256:
            raise HTTPException(409, "Context changed; reload before saving")
        audit(
            db,
            actor,
            "context.update_requested",
            {
                "scope": scope,
                "target": target,
                "before_sha256": digest(previous),
                "after_sha256": digest(body.content),
                "content": body.content,
            },
        )
        commit(db)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".pending")
        temporary.write_text(body.content, encoding="utf-8", newline="\n")
        temporary.replace(path)
        audit(
            db,
            actor,
            "context.updated",
            {"scope": scope, "target": target, "sha256": digest(body.content)},
        )
        commit(db)
    return {
        "scope": scope,
        "target": target,
        "content": body.content,
        "sha256": digest(body.content),
    }
