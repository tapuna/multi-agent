"""Opt-in local sample data. Idempotent by project key; never runs on startup."""

from sqlalchemy import select
from .db import SessionLocal
from .models import Project, Agent, Task
from .services import audit


def seed():
    with SessionLocal() as db:
        if db.scalar(select(Project).where(Project.key == "RELAY")):
            print("Example project already exists; no changes made.")
            return
        project = Project(
            name="Control Center",
            key="RELAY",
            description="Build the next generation engineering workspace.",
        )
        db.add(project)
        agents = [
            Agent(
                name=name,
                role=role,
                runtime=runtime,
                model="configure-before-execution",
            )
            for name, role, runtime in [
                ("Architect", "System design", "claude"),
                ("Builder", "Software engineering", "codex"),
                ("Reviewer", "Quality engineering", "gemini"),
            ]
        ]
        db.add_all(agents)
        db.flush()
        audit(
            db,
            "system:seed",
            "project.created",
            {"project_id": project.id, "source": "opt-in sample data"},
        )
        for a in agents:
            audit(
                db,
                "system:seed",
                "agent.registered",
                {"agent_id": a.id, "source": "opt-in sample data"},
            )
        examples = [
            ("Design the runtime adapter contract", "backlog", "high", 0),
            ("Define project memory boundaries", "backlog", "medium", 0),
            ("Build task dependency validation", "todo", "high", 1),
            ("Package engineering skill templates", "todo", "low", 1),
            ("Implement the Kanban task API", "in_progress", "high", 1),
            ("Connect the board to persisted tasks", "in_progress", "medium", 1),
            ("Review company policy enforcement", "review", "high", 2),
            ("Review immutable audit events", "review", "medium", 2),
        ]
        for number, (title, status, priority, assignee) in enumerate(examples, 1):
            task = Task(
                project_id=project.id,
                number=number,
                title=title,
                description="Sample planning data. Replace with your own acceptance criteria before execution.",
                status=status,
                priority=priority,
                assignee_id=agents[assignee].id,
                sprint="Sprint 01",
            )
            db.add(task)
            db.flush()
            audit(
                db,
                "system:seed",
                "task.created",
                {"title": title, "status": status, "source": "opt-in sample data"},
                task.id,
            )
        db.commit()
        print("Created example project with 8 persisted tasks and 3 registered agents.")


if __name__ == "__main__":
    seed()
