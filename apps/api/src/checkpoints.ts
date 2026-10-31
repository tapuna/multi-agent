import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  writesSortKey,
  type Checkpoint,
  type CheckpointTuple,
  type CheckpointListOptions,
  type ChannelVersions,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { transaction } from "./db.js";
import { hash, stable } from "./config.js";
export class FirebirdSaver extends BaseCheckpointSaver {
  private ns(config: RunnableConfig) {
    return "nodejs:" + (config.configurable?.checkpoint_ns || "");
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return transaction(async (tx) => {
      const c = config.configurable || {},
        rows = await tx.all(
          "graph_checkpoints",
          "THREAD_ID=? AND NAMESPACE=?" +
            (c.checkpoint_id ? " AND CHECKPOINT_ID=?" : ""),
          [
            c.thread_id,
            this.ns(config),
            ...(c.checkpoint_id ? [c.checkpoint_id] : []),
          ],
          "CHECKPOINT_ID DESC",
          1,
        );
      const r = rows[0];
      if (!r) return;
      const data = r.data,
        checkpoint = (await this.serde.loadsTyped(
          data.type,
          Buffer.from(data.payload, "base64"),
        )) as Checkpoint;
      const writes = (
        await tx.all(
          "graph_writes",
          "THREAD_ID=? AND NAMESPACE=? AND CHECKPOINT_ID=?",
          [c.thread_id, this.ns(config), r.checkpoint_id],
        )
      ).sort((a, b) =>
        compareWritesSortKeys(
          writesSortKey(a.data.task_path || "", a.task_id, a.position),
          writesSortKey(b.data.task_path || "", b.task_id, b.position),
        ),
      );
      return {
        config: {
          configurable: {
            thread_id: c.thread_id,
            checkpoint_ns: c.checkpoint_ns || "",
            checkpoint_id: r.checkpoint_id,
          },
        },
        checkpoint,
        metadata: r.metadata_data as any,
        parentConfig: r.parent_id
          ? {
              configurable: {
                thread_id: c.thread_id,
                checkpoint_ns: c.checkpoint_ns || "",
                checkpoint_id: r.parent_id,
              },
            }
          : undefined,
        pendingWrites: await Promise.all(
          writes.map(
            async (w) =>
              [
                w.task_id,
                w.channel,
                await this.serde.loadsTyped(
                  w.data.type,
                  Buffer.from(w.data.payload, "base64"),
                ),
              ] as [string, string, unknown],
          ),
        ),
      };
    });
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}) {
    const ids = await transaction((tx) =>
      tx.all(
        "graph_checkpoints",
        "THREAD_ID=? AND NAMESPACE=?" +
          (options.before?.configurable?.checkpoint_id
            ? " AND CHECKPOINT_ID<?"
            : ""),
        [
          config.configurable?.thread_id,
          this.ns(config),
          ...(options.before?.configurable?.checkpoint_id
            ? [options.before.configurable.checkpoint_id]
            : []),
        ],
        "CHECKPOINT_ID DESC",
        options.limit || 100,
      ),
    );
    for (const r of ids) {
      const tuple = await this.getTuple({
        ...config,
        configurable: {
          ...config.configurable,
          checkpoint_id: r.checkpoint_id,
        },
      });
      if (
        tuple &&
        (!options.filter ||
          Object.entries(options.filter).every(
            ([k, v]) => (tuple.metadata as any)?.[k] === v,
          ))
      )
        yield tuple;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: any,
    _versions: ChannelVersions,
  ) {
    const c = config.configurable || {},
      [type, payload] = await this.serde.dumpsTyped(checkpoint);
    await transaction(async (tx) => {
      const prev = (
        await tx.all(
          "graph_checkpoints",
          "THREAD_ID=? AND NAMESPACE=? AND CHECKPOINT_ID=?",
          [c.thread_id, this.ns(config), checkpoint.id],
        )
      )[0];
      const data = {
        thread_id: c.thread_id,
        namespace: this.ns(config),
        checkpoint_id: checkpoint.id,
        parent_id: c.checkpoint_id || null,
        data: { type, payload: Buffer.from(payload).toString("base64") },
        metadata_data: metadata,
      };
      if (prev) await tx.update("graph_checkpoints", prev.id, data);
      else await tx.insert("graph_checkpoints", data);
    });
    return {
      configurable: {
        thread_id: c.thread_id,
        checkpoint_ns: c.checkpoint_ns || "",
        checkpoint_id: checkpoint.id,
      },
    };
  }
  async putWrites(
    config: RunnableConfig,
    writes: [string, unknown][],
    taskId: string,
    taskPath = "",
  ) {
    const c = config.configurable || {};
    await transaction(async (tx) => {
      for (let i = 0; i < writes.length; i++) {
        const [channel, value] = writes[i],
          position = WRITES_IDX_MAP[channel] ?? i,
          identity_hash = hash(
            stable([
              c.thread_id,
              this.ns(config),
              c.checkpoint_id,
              taskId,
              position,
            ]),
          );
        const prev = (
          await tx.all("graph_writes", "IDENTITY_HASH=?", [identity_hash])
        )[0];
        if (prev && position >= 0) continue;
        const [type, payload] = await this.serde.dumpsTyped(value),
          data = {
            identity_hash,
            thread_id: c.thread_id,
            namespace: this.ns(config),
            checkpoint_id: c.checkpoint_id,
            task_id: taskId,
            position,
            channel,
            data: {
              type,
              payload: Buffer.from(payload).toString("base64"),
              task_path: taskPath,
            },
          };
        if (prev) await tx.update("graph_writes", prev.id, data);
        else await tx.insert("graph_writes", data);
      }
    });
  }
  async deleteThread(_threadId: string): Promise<void> {
    throw new Error(
      "Checkpoint deletion requires a separately reviewed maintenance operation",
    );
  }
}
