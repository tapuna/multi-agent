from typing import Literal
from pydantic import Field
from .schemas import Input


class StepInput(Input):
    key: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    kind: Literal["plan", "implement", "review", "test"]
    agent_id: str
    instructions: str = Field(default="", max_length=10000)
    depends_on: list[str] = Field(default_factory=list, max_length=12)


class RunCreate(Input):
    version: int = Field(ge=1)
    steps: list[StepInput] | None = Field(default=None, min_length=1, max_length=12)
    workflow_template_id: str | None = Field(default=None, max_length=36)
    agent_overrides: dict[str, str] = Field(default_factory=dict, max_length=12)
    expected_workflow_id: str | None = Field(default=None, max_length=36)
    expected_workflow_version: int | None = Field(default=None, ge=1)
    skill_refs: list[str] | None = Field(default=None, max_length=10)


class TemplateStep(Input):
    key: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    kind: Literal["plan", "implement", "review", "test"]
    role: str = Field(default="", max_length=100)
    agent_id: str | None = None
    instructions: str = Field(default="", max_length=10000)
    depends_on: list[str] = Field(default_factory=list, max_length=12)


class TemplateCreate(Input):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=10000)
    steps: list[TemplateStep] = Field(min_length=1, max_length=12)


class TemplateUpdate(TemplateCreate):
    version: int = Field(ge=1)


class DefaultWorkflowUpdate(Input):
    version: int = Field(ge=1)
    workflow_template_id: str | None = Field(default=None, max_length=36)


class RunDecision(Input):
    approved: bool
    digest: str = Field(min_length=64, max_length=64)


class RepositoryUpdate(Input):
    repository_path: str | None = Field(default=None, max_length=1000)


class MergeRequest(Input):
    digest: str = Field(min_length=64, max_length=64)
    expected_revision: str = Field(pattern=r"^[0-9a-f]{40,64}$")
    message: str = Field(
        default="Integrate reviewed agent workflow", min_length=1, max_length=200
    )
