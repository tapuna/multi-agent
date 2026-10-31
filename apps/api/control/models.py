from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import (
    String,
    Text,
    ForeignKey,
    Integer,
    DateTime,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from pgvector.sqlalchemy import Vector
from .types import JSONDocument as JSON


def uid():
    return str(uuid4())


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    key: Mapped[str] = mapped_column(String(10), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    repository_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    default_workflow_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    workflow_config_version: Mapped[int] = mapped_column(Integer, default=1)


class WorkflowTemplate(Base):
    __tablename__ = "workflow_templates"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    steps: Mapped[list] = mapped_column(JSON)


class Agent(Base):
    __tablename__ = "agents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(100))
    runtime: Mapped[str] = mapped_column(String(30))
    model: Mapped[str] = mapped_column(String(150))
    enabled: Mapped[bool] = mapped_column(default=True)
    skill_refs: Mapped[list] = mapped_column(JSON, default=list)
    skills_version: Mapped[int] = mapped_column(Integer, default=1)


class AgentConversation(Base):
    __tablename__ = "agent_conversations"
    __table_args__ = (UniqueConstraint("project_id", "agent_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    provider_session_id: Mapped[str | None] = mapped_column(String(250), nullable=True)
    binding_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="idle")
    active_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AgentDiagnostic(Base):
    __tablename__ = "agent_diagnostics"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    active_agent_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, unique=True
    )
    status: Mapped[str] = mapped_column(String(30))
    config_hash: Mapped[str] = mapped_column(String(64))
    config_snapshot: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class RuntimeConfiguration(Base):
    __tablename__ = "runtime_configurations"
    runtime: Mapped[str] = mapped_column(String(30), primary_key=True)
    enabled: Mapped[bool] = mapped_column(default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    probe_model: Mapped[str] = mapped_column(String(150), default="")
    status: Mapped[str] = mapped_column(String(30), default="unverified")
    verified_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result: Mapped[dict] = mapped_column(JSON, default=dict)


class LLMReadiness(Base):
    __tablename__ = "llm_readiness"
    profile_id: Mapped[str] = mapped_column(String(50), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(30))
    config_hash: Mapped[str] = mapped_column(String(64))
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    result: Mapped[dict] = mapped_column(JSON, default=dict)


class AgentMessage(Base):
    __tablename__ = "agent_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("agent_conversations.id"), index=True
    )
    sequence: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(20))
    kind: Mapped[str] = mapped_column(String(30), default="chat")
    content: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(30), default="completed")
    context_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    __table_args__ = (UniqueConstraint("conversation_id", "sequence"),)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (UniqueConstraint("project_id", "number"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(30), default="backlog", index=True)
    priority: Mapped[str] = mapped_column(String(20), default="medium")
    assignee_id: Mapped[str | None] = mapped_column(
        ForeignKey("agents.id"), nullable=True
    )
    sprint: Mapped[str | None] = mapped_column(String(80), nullable=True)
    workflow_template_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now
    )


class Dependency(Base):
    __tablename__ = "dependencies"
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), primary_key=True)
    depends_on_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), primary_key=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    task_id: Mapped[str | None] = mapped_column(
        ForeignKey("tasks.id"), nullable=True, index=True
    )
    actor: Mapped[str] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(100))
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AgentSession(Base):
    __tablename__ = "agent_sessions"
    __table_args__ = (UniqueConstraint("agent_id", "provider_session_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"))
    provider_session_id: Mapped[str | None] = mapped_column(String(250), nullable=True)
    workspace_path: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(30), default="prepared")
    context_snapshot: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Memory(Base):
    __tablename__ = "project_memories"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list | None] = mapped_column(
        Vector(1536).with_variant(JSON(), "firebird", "firebird.firebird"),
        nullable=True,
    )


class Approval(Base):
    __tablename__ = "approvals"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    task_version: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20))
    actor: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class WorkflowRun(Base):
    __tablename__ = "workflow_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    # Nullable unique reservation: only one unfinished workflow can own a task.
    active_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("tasks.id"), unique=True, nullable=True
    )
    task_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(30), default="queued", index=True)
    agents: Mapped[dict] = mapped_column(JSON)
    context_snapshot: Mapped[dict] = mapped_column(JSON)
    workspace_path: Mapped[str] = mapped_column(Text)
    decision: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    result_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now
    )


class RunEvent(Base):
    __tablename__ = "run_events"
    sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id"), index=True)
    kind: Mapped[str] = mapped_column(String(80))
    stage: Mapped[str | None] = mapped_column(String(30), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class RunArtifact(Base):
    __tablename__ = "run_artifacts"
    __table_args__ = (UniqueConstraint("run_id", "stage"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    run_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id"), index=True)
    stage: Mapped[str] = mapped_column(String(30))
    name: Mapped[str] = mapped_column(String(100))
    content: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    provider_response_id: Mapped[str | None] = mapped_column(String(250), nullable=True)
    usage: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class WorkflowStep(Base):
    __tablename__ = "workflow_steps"
    __table_args__ = (UniqueConstraint("run_id", "key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    run_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id"), index=True)
    key: Mapped[str] = mapped_column(String(40))
    kind: Mapped[str] = mapped_column(String(20))
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"))
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id"))
    instructions: Mapped[str] = mapped_column(Text)
    depends_on: Mapped[list] = mapped_column(JSON)
    state: Mapped[str] = mapped_column(String(30), default="queued")
    runtime_state: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class GraphCheckpoint(Base):
    __tablename__ = "graph_checkpoints"
    __table_args__ = (UniqueConstraint("thread_id", "namespace", "checkpoint_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    thread_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id"), index=True)
    namespace: Mapped[str] = mapped_column(String(200), default="")
    checkpoint_id: Mapped[str] = mapped_column(String(64))
    parent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    data: Mapped[dict] = mapped_column(JSON)
    metadata_data: Mapped[dict] = mapped_column(JSON)


class GraphWrite(Base):
    __tablename__ = "graph_writes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    identity_hash: Mapped[str] = mapped_column(String(64), unique=True)
    thread_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id"), index=True)
    namespace: Mapped[str] = mapped_column(String(200))
    checkpoint_id: Mapped[str] = mapped_column(String(64))
    task_id: Mapped[str] = mapped_column(String(100))
    position: Mapped[int] = mapped_column(Integer)
    channel: Mapped[str] = mapped_column(String(200))
    data: Mapped[dict] = mapped_column(JSON)
