from typing import Literal
from pydantic import BaseModel, Field, ConfigDict

Status = Literal["backlog", "todo", "in_progress", "review", "done"]
Priority = Literal["low", "medium", "high", "urgent"]
Runtime = Literal["codex", "claude", "gemini", "api"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProjectCreate(Input):
    name: str = Field(min_length=1, max_length=100)
    key: str = Field(pattern=r"^[A-Z][A-Z0-9]{1,9}$")
    description: str = Field(default="", max_length=10000)


class TaskCreate(Input):
    project_id: str
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=50000)
    priority: Priority = "medium"
    assignee_id: str | None = None
    sprint: str | None = Field(default=None, max_length=80)


class TaskUpdate(Input):
    version: int = Field(ge=1)
    workflow_template_id: str | None = Field(default=None, max_length=36)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=50000)
    status: Status | None = None
    priority: Priority | None = None
    assignee_id: str | None = None
    sprint: str | None = Field(default=None, max_length=80)


class AgentCreate(Input):
    name: str = Field(min_length=1, max_length=100)
    role: str = Field(min_length=1, max_length=100)
    runtime: Runtime
    model: str = Field(min_length=1, max_length=150)


class DependencyCreate(Input):
    depends_on_id: str


class SessionCreate(Input):
    agent_id: str


class SessionUpdate(Input):
    provider_session_id: str = Field(min_length=1, max_length=250)


class ApprovalCreate(Input):
    kind: Literal["merge", "deploy", "complete"]
    version: int = Field(ge=1)


class MemoryCreate(Input):
    content: str = Field(min_length=1, max_length=20000)
