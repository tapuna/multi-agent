import fs from "node:fs";
import path from "node:path";
import schemaData from "./schema.json" with { type: "json" };
import { Firebird } from "./firebird.js";
import { DATA, demand, now, uid } from "./config.js";
export type Row = Record<string, any>;
export const schema: Record<
  string,
  {
    columns: Record<
      string,
      { type: string; json: boolean; required: boolean; identity: boolean }
    >;
    constraints: { type: string; columns: string[] }[];
    foreign: { column: string; table: string; target: string }[];
  }
> = schemaData;
export function databasePath() {
  const url = process.env.DATABASE_URL;
  if (!url) return path.join(DATA, "control.fdb");
  if (!url.startsWith("firebird+firebird://") && !url.startsWith("firebird://"))
    throw new Error(
      "Only Firebird Embedded is configured in this Node.js build",
    );
  const match = url.match(/^firebird(?:\+firebird)?:\/\/[^/]*\/(.*?)(?:\?|$)/);
  if (!match) throw new Error("Use a local Firebird database path");
  return path.resolve(decodeURIComponent(match[1]));
}
export const q = (name: string) =>
  '"' + name.toUpperCase().replaceAll('"', '""') + '"';
export class Tx {
  constructor(public native: Firebird) {}
  async sql(sql: string, params: unknown[] = []) {
    return this.native.query(sql, params);
  }
  decode(table: string, row: Row) {
    for (const [k, c] of Object.entries(schema[table].columns))
      if (c.json && row[k] !== null && typeof row[k] === "string")
        row[k] = JSON.parse(row[k]);
    return row;
  }
  async all(
    table: string,
    where = "",
    params: unknown[] = [],
    order = "",
    limit = 1000,
  ) {
    demand(schema[table], 500, "Unknown table");
    return (
      await this.sql(
        `SELECT FIRST ${Math.max(1, Math.min(limit, 10000))} * FROM ${q(table)} ${where ? "WHERE " + where : ""} ${order ? "ORDER BY " + order : ""}`,
        params,
      )
    ).map((r) => this.decode(table, r));
  }
  async one(table: string, id: string, lock = false) {
    const primary =
      table === "llm_readiness"
        ? "profile_id"
        : table === "runtime_configurations"
          ? "runtime"
          : "id";
    const rows = await this.sql(
      `SELECT * FROM ${q(table)} WHERE ${q(primary)}=? ${lock ? "WITH LOCK" : ""}`,
      [id],
    );
    demand(rows[0], 404, table + " not found");
    return this.decode(table, rows[0]);
  }
  async insert(table: string, values: Row) {
    const defaults: Record<string, Row> = {
      projects: {
        description: "",
        repository_path: null,
        default_workflow_id: null,
        workflow_config_version: 1,
      },
      agents: { enabled: true, skill_refs: [], skills_version: 1 },
      tasks: {
        description: "",
        status: "backlog",
        priority: "medium",
        version: 1,
        assignee_id: null,
        sprint: null,
        workflow_template_id: null,
      },
      agent_conversations: {
        provider_session_id: null,
        binding_hash: null,
        status: "idle",
        active_message_id: null,
        error: null,
      },
      agent_messages: {
        kind: "chat",
        state: "completed",
        context_snapshot: {},
      },
      agent_sessions: { provider_session_id: null, state: "prepared" },
      workflow_templates: { version: 1, description: "" },
      workflow_runs: {
        status: "queued",
        decision: null,
        result_digest: null,
        error: null,
      },
      workflow_steps: {
        state: "queued",
        runtime_state: {},
        started_at: null,
        ended_at: null,
      },
      agent_diagnostics: {
        active_agent_id: null,
        result: {},
        latency_ms: null,
      },
      llm_readiness: {
        version: 0,
        latency_ms: null,
        tested_at: null,
        result: {},
      },
      project_memories: { embedding: null },
      run_events: { stage: null },
      run_artifacts: { provider_response_id: null, usage: {} },
    };
    const data = { ...defaults[table], ...values };
    const columns = schema[table].columns;
    if (columns.id && !data.id) data.id = uid();
    if (columns.created_at && !data.created_at) data.created_at = now();
    if (columns.updated_at && !data.updated_at) data.updated_at = now();
    const names = Object.keys(data);
    for (const k of names) demand(columns[k], 500, "Unknown column " + k);
    const params = names.map((k) => this.encode(table, k, data[k]));
    const result = await this.sql(
      `INSERT INTO ${q(table)} (${names.map(q).join(",")}) VALUES (${names.map(() => "?").join(",")}) RETURNING *`,
      params,
    );
    return this.decode(table, result[0]);
  }
  encode(table: string, key: string, v: any) {
    if (v === undefined || v === null) return null;
    const c = schema[table].columns[key];
    if (c.json) return JSON.stringify(v);
    if (c.type.includes("TIMESTAMP") && typeof v === "string")
      return v.replace("T", " ").replace("Z", " +00:00");
    return v;
  }
  async update(table: string, id: string, values: Row) {
    const primary =
      table === "llm_readiness"
        ? "profile_id"
        : table === "runtime_configurations"
          ? "runtime"
          : "id";
    const data = { ...values };
    if (schema[table].columns.updated_at) data.updated_at = now();
    const keys = Object.keys(data);
    for (const k of keys)
      demand(schema[table].columns[k], 500, "Unknown column");
    return this.decode(
      table,
      (
        await this.sql(
          `UPDATE ${q(table)} SET ${keys.map((k) => q(k) + "=?").join(",")} WHERE ${q(primary)}=? RETURNING *`,
          [...keys.map((k) => this.encode(table, k, data[k])), id],
        )
      )[0],
    );
  }
  async audit(
    actor: string,
    action: string,
    payload: Row,
    task_id: string | null = null,
  ) {
    return this.insert("audit_events", { actor, action, payload, task_id });
  }
}
export async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await Firebird.open(databasePath());
  await db.begin();
  try {
    const result = await work(new Tx(db));
    await db.finish();
    return result;
  } catch (e) {
    await db.finish(false);
    throw e;
  } finally {
    await db.close();
  }
}
export async function migrate() {
  const filename = databasePath();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = await Firebird.open(filename, !fs.existsSync(filename));
  await db.begin();
  const tx = new Tx(db);
  try {
    const names = (
      await tx.sql(
        "SELECT trim(rdb$relation_name) as name FROM rdb$relations WHERE rdb$system_flag=0",
      )
    ).map((r) => r.name.toLowerCase());
    if (names.includes("projects")) {
      demand(
        names.includes("llm_readiness"),
        409,
        "Existing database must be migrated through revision 0011 before Node.js adoption.",
      );
    } else {
      for (const [table, spec] of Object.entries(schema)) {
        const cols = Object.entries(spec.columns).map(
          ([k, c]) =>
            `${q(k)} ${c.type}${c.identity ? " GENERATED BY DEFAULT AS IDENTITY" : ""}${c.required ? " NOT NULL" : ""}`,
        );
        cols.push(
          ...spec.constraints.map(
            (c) => `${c.type} (${c.columns.map(q).join(",")})`,
          ),
        );
        await tx.sql(`CREATE TABLE ${q(table)} (${cols.join(",")})`);
      }
      await db.finish();
      await db.begin();
      for (const [table, spec] of Object.entries(schema))
        for (const f of spec.foreign)
          await tx.sql(
            `ALTER TABLE ${q(table)} ADD FOREIGN KEY (${q(f.column)}) REFERENCES ${q(f.table)} (${q(f.target)})`,
          );
      await tx.sql(
        "CREATE EXCEPTION audit_protected 'Audit records are append-only'",
      );
      await tx.sql(
        "CREATE TRIGGER audit_immutable FOR AUDIT_EVENTS ACTIVE BEFORE UPDATE OR DELETE POSITION 0 AS BEGIN EXCEPTION audit_protected; END",
      );
    }
    if (!names.includes("node_migrations")) {
      await tx.sql(
        "CREATE TABLE node_migrations (id VARCHAR(50) NOT NULL PRIMARY KEY, applied_at TIMESTAMP WITH TIME ZONE NOT NULL)",
      );
      await db.finish();
      await db.begin();
    }
    await tx.sql(
      "UPDATE OR INSERT INTO node_migrations (id,applied_at) VALUES ('node-0001',CURRENT_TIMESTAMP) MATCHING (id)",
    );
    await db.finish();
  } catch (e) {
    await db.finish(false);
    throw e;
  } finally {
    await db.close();
  }
}
