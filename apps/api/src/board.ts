import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { route, text, id } from "./http.js";
import { human, demand } from "./config.js";
import type { Tx, Row } from "./db.js";
import { definition } from "./templates.js";
export async function blockers(tx: Tx, task: string) {
  return tx.sql(
    "SELECT t.ID FROM TASKS t JOIN DEPENDENCIES d ON d.DEPENDS_ON_ID=t.ID WHERE d.TASK_ID=? AND t.STATUS<>?",
    [task, "done"],
  );
}
export async function transition(
  tx: Tx,
  task: Row,
  status: string,
  actor: string,
  reason: string,
) {
  const before = task.status;
  Object.assign(
    task,
    await tx.update("tasks", task.id, { status, version: task.version + 1 }),
  );
  await tx.audit(
    actor,
    "task.updated",
    {
      before: { status: before },
      after: { status },
      version: task.version,
      reason,
    },
    task.id,
  );
}
export function boardRoutes(app: FastifyInstance) {
  route(app, "GET", "/api/projects", undefined, async ({ tx }) =>
    tx.all("projects", "", [], "NAME"),
  );
  route(
    app,
    "POST",
    "/api/projects",
    z.strictObject({
      name: text(100, 1),
      key: text(10, 2).regex(/^[A-Z][A-Z0-9]{1,9}$/),
      description: text(10000).default(""),
    }),
    async ({ tx, actor, body }) => {
      const r = await tx.insert("projects", body);
      await tx.audit(actor, "project.created", {
        project_id: r.id,
        name: r.name,
      });
      return r;
    },
    201,
  );
  route(
    app,
    "GET",
    "/api/projects/:project_id/memory",
    undefined,
    async ({ tx, params: p }) => {
      await tx.one("projects", p.project_id);
      return tx.all(
        "project_memories",
        "PROJECT_ID=?",
        [p.project_id],
        "ID",
        200,
      );
    },
  );
  route(
    app,
    "POST",
    "/api/projects/:project_id/memory",
    z.strictObject({ content: text(20000, 1) }),
    async ({ tx, actor, body, params: p }) => {
      await tx.one("projects", p.project_id);
      const r = await tx.insert("project_memories", {
        project_id: p.project_id,
        ...body,
      });
      await tx.audit(actor, "memory.created", {
        project_id: p.project_id,
        ...body,
      });
      return r;
    },
    201,
  );
  route(app, "GET", "/api/tasks", undefined, async ({ tx, query }) => {
    await tx.one("projects", query.project_id);
    return tx.all(
      "tasks",
      "PROJECT_ID=?",
      [query.project_id],
      "NUMBER",
      Math.min(Number(query.limit) || 500, 1000),
    );
  });
  route(
    app,
    "POST",
    "/api/tasks",
    z.strictObject({
      project_id: id,
      title: text(200, 1),
      description: text(50000).default(""),
      priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
      assignee_id: id.nullable().optional(),
      sprint: text(80).nullable().optional(),
    }),
    async ({ tx, actor, body }) => {
      await tx.one("projects", body.project_id, true);
      if (body.assignee_id) await tx.one("agents", body.assignee_id);
      const n =
        (
          await tx.sql(
            "SELECT max(NUMBER) as N FROM TASKS WHERE PROJECT_ID=?",
            [body.project_id],
          )
        )[0].n || 0;
      const r = await tx.insert("tasks", { ...body, number: n + 1 });
      await tx.audit(actor, "task.created", body, r.id);
      return r;
    },
    201,
  );
  route(
    app,
    "GET",
    "/api/tasks/:task_id",
    undefined,
    async ({ tx, params: p }) => ({
      task: await tx.one("tasks", p.task_id),
      dependencies: (
        await tx.all("dependencies", "TASK_ID=?", [p.task_id])
      ).map((d) => d.depends_on_id),
      events: await tx.all(
        "audit_events",
        "TASK_ID=?",
        [p.task_id],
        "CREATED_AT DESC",
        200,
      ),
      sessions: await tx.all("agent_sessions", "TASK_ID=?", [p.task_id]),
      approvals: await tx.all("approvals", "TASK_ID=?", [p.task_id]),
    }),
  );
  route(
    app,
    "PATCH",
    "/api/tasks/:task_id",
    z.strictObject({
      version: z.number().int().min(1),
      workflow_template_id: id.nullable().optional(),
      title: text(200, 1).optional(),
      description: text(50000).optional(),
      status: z
        .enum(["backlog", "todo", "in_progress", "review", "done"])
        .optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      assignee_id: id.nullable().optional(),
      sprint: text(80).nullable().optional(),
    }),
    async ({ tx, actor, body, params: p }) => {
      const r = await tx.one("tasks", p.task_id, true);
      demand(
        r.version === body.version,
        409,
        "Task changed; refresh before saving",
      );
      demand(
        !(await tx.all("workflow_runs", "ACTIVE_TASK_ID=?", [r.id])).length,
        409,
        "Cancel the active workflow before editing this task",
      );
      const { version, ...changes } = body;
      if (changes.workflow_template_id !== undefined) {
        human(actor);
        if (changes.workflow_template_id)
          await definition(tx, r.project_id, changes.workflow_template_id);
      }
      if (changes.assignee_id) await tx.one("agents", changes.assignee_id);
      const transitions: Record<string, string[]> = {
          backlog: ["todo"],
          todo: ["backlog", "in_progress"],
          in_progress: ["todo", "review"],
          review: ["in_progress", "done"],
          done: ["todo"],
        },
        target = changes.status || r.status;
      if (target !== r.status) {
        demand(
          transitions[r.status].includes(target),
          409,
          "Invalid status transition",
        );
        if (["in_progress", "done"].includes(target))
          demand(
            !(await blockers(tx, r.id)).length,
            409,
            "Complete blocking dependencies first",
          );
        if (target === "done") {
          human(actor);
          await tx.insert("approvals", {
            task_id: r.id,
            task_version: r.version,
            kind: "complete",
            actor,
          });
          await tx.audit(
            actor,
            "approval.complete",
            { version: r.version },
            r.id,
          );
        }
      }
      const before = Object.fromEntries(
        Object.keys(changes).map((k) => [k, r[k]]),
      );
      const out = await tx.update("tasks", r.id, {
        ...changes,
        version: version + 1,
      });
      await tx.audit(
        actor,
        "task.updated",
        { before, after: changes, version: version + 1 },
        r.id,
      );
      return out;
    },
  );
  route(
    app,
    "POST",
    "/api/tasks/:task_id/dependencies",
    z.strictObject({ depends_on_id: id }),
    async ({ tx, actor, body, params: p }) => {
      const task = await tx.one("tasks", p.task_id);
      await tx.one("projects", task.project_id, true);
      const other = await tx.one("tasks", body.depends_on_id);
      demand(
        task.project_id === other.project_id,
        422,
        "Dependencies must share a project",
      );
      demand(
        ["backlog", "todo"].includes(task.status),
        409,
        "Reopen task before changing dependencies",
      );
      demand(
        !(await tx.all("workflow_runs", "ACTIVE_TASK_ID=?", [task.id])).length,
        409,
        "Cancel active workflow first",
      );
      const edges = await tx.all("dependencies"),
        pending = [other.id],
        seen = new Set();
      while (pending.length) {
        const current = pending.pop();
        demand(current !== task.id, 409, "Dependency would create a cycle");
        if (!seen.has(current)) {
          seen.add(current);
          pending.push(
            ...edges
              .filter((e) => e.task_id === current)
              .map((e) => e.depends_on_id),
          );
        }
      }
      await tx.insert("dependencies", {
        task_id: task.id,
        depends_on_id: other.id,
      });
      await tx.update("tasks", task.id, { version: task.version + 1 });
      await tx.audit(actor, "dependency.added", body, task.id);
      return body;
    },
    201,
  );
  route(
    app,
    "POST",
    "/api/tasks/:task_id/approvals",
    z.strictObject({
      kind: z.enum(["merge", "deploy", "complete"]),
      version: z.number().int().min(1),
    }),
    async ({ tx, actor, body, params: p }) => {
      human(actor);
      const t = await tx.one("tasks", p.task_id, true);
      demand(
        t.version === body.version,
        409,
        "Approval targets a stale task version",
      );
      const r = await tx.insert("approvals", {
        task_id: t.id,
        task_version: t.version,
        kind: body.kind,
        actor,
      });
      await tx.audit(actor, "approval." + body.kind, body, t.id);
      return r;
    },
    201,
  );
  route(app, "GET", "/api/audit", undefined, async ({ tx, query }) =>
    tx.all(
      "audit_events",
      query.task_id ? "TASK_ID=?" : "",
      query.task_id ? [query.task_id] : [],
      "CREATED_AT DESC",
      200,
    ),
  );
}
