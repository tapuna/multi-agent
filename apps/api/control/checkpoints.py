"""LangGraph checkpointer using the same Firebird database as the task system."""

import base64
import hashlib
from threading import RLock
from sqlalchemy import select
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    CheckpointTuple,
    WRITES_IDX_MAP,
    get_checkpoint_metadata,
)
from .models import GraphCheckpoint, GraphWrite, WorkflowRun
from .services import audit


class FirebirdSaver(BaseCheckpointSaver):
    def __init__(self, factory):
        super().__init__()
        self.factory = factory
        self.lock = RLock()

    def encode(self, value):
        kind, content = self.serde.dumps_typed(value)
        return {"type": kind, "value": base64.b64encode(content).decode()}

    def decode(self, value):
        return self.serde.loads_typed((value["type"], base64.b64decode(value["value"])))

    @staticmethod
    def config(thread_id, namespace, checkpoint_id):
        return {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_ns": namespace,
                "checkpoint_id": checkpoint_id,
            }
        }

    def get_tuple(self, config):
        values = config["configurable"]
        with self.factory() as db:
            query = select(GraphCheckpoint).where(
                GraphCheckpoint.thread_id == values["thread_id"],
                GraphCheckpoint.namespace == values.get("checkpoint_ns", ""),
            )
            if values.get("checkpoint_id"):
                query = query.where(
                    GraphCheckpoint.checkpoint_id == values["checkpoint_id"]
                )
            row = db.scalar(
                query.order_by(GraphCheckpoint.checkpoint_id.desc()).limit(1)
            )
            if row is None:
                return None
            writes = db.scalars(
                select(GraphWrite)
                .where(
                    GraphWrite.thread_id == row.thread_id,
                    GraphWrite.namespace == row.namespace,
                    GraphWrite.checkpoint_id == row.checkpoint_id,
                )
                .order_by(GraphWrite.position)
            ).all()
            return CheckpointTuple(
                self.config(row.thread_id, row.namespace, row.checkpoint_id),
                self.decode(row.data),
                self.decode(row.metadata_data),
                self.config(row.thread_id, row.namespace, row.parent_id)
                if row.parent_id
                else None,
                [(w.task_id, w.channel, self.decode(w.data)) for w in writes],
            )

    def put(self, config, checkpoint, metadata, new_versions):
        values = config["configurable"]
        with self.lock, self.factory() as db:
            row = db.scalar(
                select(GraphCheckpoint.id).where(
                    GraphCheckpoint.thread_id == values["thread_id"],
                    GraphCheckpoint.namespace == values.get("checkpoint_ns", ""),
                    GraphCheckpoint.checkpoint_id == checkpoint["id"],
                )
            )
            if row is None:
                db.add(
                    GraphCheckpoint(
                        thread_id=values["thread_id"],
                        namespace=values.get("checkpoint_ns", ""),
                        checkpoint_id=checkpoint["id"],
                        parent_id=values.get("checkpoint_id"),
                        data=self.encode(checkpoint),
                        metadata_data=self.encode(
                            get_checkpoint_metadata(config, metadata)
                        ),
                    )
                )
                run = db.get(WorkflowRun, values["thread_id"])
                audit(
                    db,
                    "system:langgraph",
                    "workflow.checkpoint",
                    {"run_id": run.id, "checkpoint_id": checkpoint["id"]},
                    run.task_id,
                )
                db.commit()
        return self.config(
            values["thread_id"], values.get("checkpoint_ns", ""), checkpoint["id"]
        )

    def put_writes(self, config, writes, task_id, task_path=""):
        values = config["configurable"]
        with self.lock, self.factory() as db:
            for index, (channel, value) in enumerate(writes):
                position = WRITES_IDX_MAP.get(channel, index)
                digest = hashlib.sha256(
                    repr(
                        (
                            values["thread_id"],
                            values.get("checkpoint_ns", ""),
                            values["checkpoint_id"],
                            task_id,
                            position,
                        )
                    ).encode()
                ).hexdigest()
                row = db.scalar(
                    select(GraphWrite).where(GraphWrite.identity_hash == digest)
                )
                if row is not None:
                    if position < 0:
                        row.data = self.encode(value)
                else:
                    db.add(
                        GraphWrite(
                            identity_hash=digest,
                            thread_id=values["thread_id"],
                            namespace=values.get("checkpoint_ns", ""),
                            checkpoint_id=values["checkpoint_id"],
                            task_id=task_id,
                            position=position,
                            channel=channel,
                            data=self.encode(value),
                        )
                    )
            db.commit()

    def list(self, config, *, filter=None, before=None, limit=None):
        with self.factory() as db:
            query = select(GraphCheckpoint).order_by(
                GraphCheckpoint.checkpoint_id.desc()
            )
            if config:
                query = query.where(
                    GraphCheckpoint.thread_id == config["configurable"]["thread_id"]
                )
            if before:
                query = query.where(
                    GraphCheckpoint.checkpoint_id
                    < before["configurable"]["checkpoint_id"]
                )
            rows = db.scalars(query.limit(limit or 100)).all()
            configs = [
                self.config(r.thread_id, r.namespace, r.checkpoint_id)
                for r in rows
                if not filter
                or all(
                    self.decode(r.metadata_data).get(k) == v for k, v in filter.items()
                )
            ]
        for value in configs:
            yield self.get_tuple(value)
