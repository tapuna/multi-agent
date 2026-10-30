"""Persisted workflow definitions; task > project > built-in default resolution."""

from copy import deepcopy
from hashlib import sha256
import json
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from .models import Agent, WorkflowTemplate
from .services import get
from .workflow_schemas import StepInput, TemplateStep
from .workflows import validate_dag


def stage(key, kind, deps=(), role=""):
    return dict(
        key=key,
        kind=kind,
        depends_on=list(deps),
        role=role or kind,
        agent_id=None,
        instructions="Implement the requested scope and return complete files."
        if kind == "implement"
        else "Supply an actionable plan or evidence-based review.",
    )


BUILTINS = [
    dict(
        id="builtin-standard",
        name="Plan → Implement → Review",
        steps=[
            stage("plan", "plan"),
            stage("implement", "implement", ["plan"]),
            stage("review", "review", ["implement"]),
        ],
    ),
    dict(
        id="builtin-direct",
        name="Implement → Review",
        steps=[
            stage("implement", "implement"),
            stage("review", "review", ["implement"]),
        ],
    ),
    dict(
        id="builtin-parallel",
        name="Frontend + Backend → Review",
        steps=[
            stage("frontend", "implement", role="frontend"),
            stage("backend", "implement", role="backend"),
            stage("review", "review", ["frontend", "backend"]),
        ],
    ),
]
for item in BUILTINS:
    item.update(
        version=1, description="Built-in workflow; clone to customize.", builtin=True
    )


def definition(db, project_id, template_id):
    for item in BUILTINS:
        if item["id"] == template_id:
            return deepcopy(item)
    row = get(db, WorkflowTemplate, template_id)
    if row.project_id != project_id:
        raise HTTPException(422, "Workflow must belong to this project")
    return {**jsonable_encoder(row), "builtin": False}


def validate_definition(db, steps):
    try:
        validate_dag(steps)
    except ValueError as error:
        raise HTTPException(422, str(error))
    for step in steps:
        if step.agent_id:
            get(db, Agent, step.agent_id)


def effective(db, project, task=None, requested=None):
    if requested:
        selected, source = requested, "request"
    elif task and task.workflow_template_id:
        selected, source = task.workflow_template_id, "task"
    elif project.default_workflow_id:
        selected, source = project.default_workflow_id, "project"
    else:
        selected, source = "builtin-standard", "system"
    return definition(db, project.id, selected), source


def suggest_agent(agents, spec):
    aliases = {
        "plan": ["plan", "architect"],
        "implement": ["engineer", "builder", "implement", "developer"],
        "review": ["review"],
        "test": ["test", "qa"],
    }
    terms = aliases.get(spec.role or spec.kind, [spec.role])
    for agent in agents:
        if any(term.lower() in f"{agent.role} {agent.name}".lower() for term in terms):
            return agent.id
    return agents[0].id if len(agents) == 1 else None


def resolve_run(db, project, task, body):
    if body.steps is not None:
        if body.workflow_template_id or body.agent_overrides:
            raise HTTPException(
                422, "Use either ad-hoc steps or a template with agent overrides"
            )
        validate_definition(db, body.steps)
        return body.steps, {
            "source": "ad_hoc",
            "steps": [s.model_dump() for s in body.steps],
        }
    template, source = effective(db, project, task, body.workflow_template_id)
    if (body.expected_workflow_id and body.expected_workflow_id != template["id"]) or (
        body.expected_workflow_version
        and body.expected_workflow_version != template["version"]
    ):
        raise HTTPException(409, "Effective workflow changed; reload before starting")
    specs = [TemplateStep(**s) for s in template["steps"]]
    if set(body.agent_overrides) - {s.key for s in specs}:
        raise HTTPException(422, "Unknown step in agent overrides")
    agents = db.scalars(
        select(Agent).where(Agent.enabled == True).order_by(Agent.name, Agent.id)
    ).all()  # noqa: E712
    steps = []
    for spec in specs:
        agent_id = (
            body.agent_overrides.get(spec.key)
            or spec.agent_id
            or suggest_agent(agents, spec)
        )
        if not agent_id:
            raise HTTPException(422, f"Select an agent for workflow step {spec.key}")
        steps.append(
            StepInput(**{**spec.model_dump(exclude={"role"}), "agent_id": agent_id})
        )
    validate_definition(db, steps)
    digest = sha256(
        json.dumps(template, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    return steps, {
        "source": source,
        "template": template,
        "sha256": digest,
        "steps": [s.model_dump() for s in steps],
    }
