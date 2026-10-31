import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Tx, Row } from "./db.js";
import { demand, human } from "./config.js";
import { route, text, id } from "./http.js";
export const stepSchema = z.strictObject({
  key: text(40, 1).regex(/^[a-z][a-z0-9_]*$/),
  kind: z.enum(["plan", "implement", "review", "test"]),
  role: text(100).default(""),
  agent_id: id.nullable().optional(),
  instructions: text(10000).default(""),
  depends_on: z.array(text(40, 1)).max(12).default([]),
});
export function validateDag(steps: Row[]) {
  demand(
    steps.length > 0 && steps.length <= 12,
    422,
    "Workflow needs 1..12 steps",
  );
  const keys = steps.map((s) => s.key);
  demand(
    new Set(keys).size === keys.length && !keys.includes("human_review"),
    422,
    "Step keys must be unique; human_review is reserved",
  );
  demand(
    steps.every((s) => s.depends_on.every((d: string) => keys.includes(d))),
    422,
    "Unknown workflow dependency",
  );
  const result: string[] = [];
  while (result.length < keys.length) {
    const ready = steps.filter(
      (s) =>
        !result.includes(s.key) &&
        s.depends_on.every((d: string) => result.includes(d)),
    );
    demand(ready.length, 422, "Workflow dependencies contain a cycle");
    result.push(...ready.map((s) => s.key));
  }
  return result;
}
const stage = (
  key: string,
  kind: string,
  depends_on: string[] = [],
  role = kind,
) => ({
  key,
  kind,
  role,
  depends_on,
  agent_id: null,
  instructions:
    kind === "implement"
      ? "Implement the requested scope and return complete files."
      : "Supply an actionable plan or evidence-based review.",
});
export const BUILTINS = [
  {
    id: "builtin-standard",
    name: "Plan → Implement → Review",
    steps: [
      stage("plan", "plan"),
      stage("implement", "implement", ["plan"]),
      stage("review", "review", ["implement"]),
    ],
  },
  {
    id: "builtin-direct",
    name: "Implement → Review",
    steps: [
      stage("implement", "implement"),
      stage("review", "review", ["implement"]),
    ],
  },
  {
    id: "builtin-parallel",
    name: "Frontend + Backend → Review",
    steps: [
      stage("frontend", "implement", [], "frontend"),
      stage("backend", "implement", [], "backend"),
      stage("review", "review", ["frontend", "backend"]),
    ],
  },
].map((t) => ({
  ...t,
  version: 1,
  builtin: true,
  description: "Built-in workflow; clone to customize.",
}));
export async function definition(
  tx: Tx,
  project: string,
  id: string,
): Promise<Row> {
  const b = BUILTINS.find((t) => t.id === id);
  if (b) return structuredClone(b);
  const t = await tx.one("workflow_templates", id);
  demand(t.project_id === project, 422, "Workflow must belong to this project");
  return { ...t, builtin: false };
}
export async function effective(
  tx: Tx,
  project: Row,
  task?: Row,
  requested?: string,
) {
  const selected =
    requested ||
    task?.workflow_template_id ||
    project.default_workflow_id ||
    "builtin-standard";
  return {
    template: await definition(tx, project.id, selected),
    source: requested
      ? "request"
      : task?.workflow_template_id
        ? "task"
        : project.default_workflow_id
          ? "project"
          : "system",
  };
}
export async function resolveRun(tx: Tx, project: Row, task: Row, body: Row) {
  if (body.steps) {
    demand(
      !body.workflow_template_id &&
        !Object.keys(body.agent_overrides || {}).length,
      422,
      "Use ad hoc steps or a template, not both",
    );
    validateDag(body.steps);
    return {
      steps: body.steps,
      workflow: { source: "ad_hoc", steps: body.steps },
    };
  }
  const { template, source } = await effective(
    tx,
    project,
    task,
    body.workflow_template_id,
  );
  demand(
    (!body.expected_workflow_id || body.expected_workflow_id === template.id) &&
      (!body.expected_workflow_version ||
        body.expected_workflow_version === template.version),
    409,
    "Effective workflow changed; reload",
  );
  const agents = await tx.all("agents", "ENABLED=?", [true], "NAME,ID");
  const aliases: Record<string, string[]> = {
    plan: ["plan", "architect"],
    implement: ["engineer", "builder", "implement", "developer"],
    review: ["review"],
    test: ["test", "qa"],
  };
  const overrides = body.agent_overrides || {};
  demand(
    Object.keys(overrides).every((k) =>
      template.steps.some((s: Row) => s.key === k),
    ),
    422,
    "Unknown step override",
  );
  const steps = template.steps.map((s: Row) => {
    const terms = aliases[s.role || s.kind] || [s.role];
    const agent =
      overrides[s.key] ||
      s.agent_id ||
      agents.find((a) =>
        terms.some((t) => (a.role + " " + a.name).toLowerCase().includes(t)),
      )?.id ||
      (agents.length === 1 ? agents[0].id : null);
    demand(agent, 422, "Select an agent for workflow step " + s.key);
    return { ...s, agent_id: agent };
  });
  validateDag(steps);
  return { steps, workflow: { template, source, steps } };
}
export function templateRoutes(app: FastifyInstance) {
  const create = z.strictObject({
    name: text(100, 1),
    description: text(10000).default(""),
    steps: z.array(stepSchema).min(1).max(12),
  });
  async function validate(tx: Tx, steps: Row[]) {
    validateDag(steps);
    for (const s of steps) if (s.agent_id) await tx.one("agents", s.agent_id);
  }
  route(
    app,
    "GET",
    "/api/projects/:project_id/workflow-templates",
    undefined,
    async ({ tx, params: p }) => {
      const proj = await tx.one("projects", p.project_id);
      return {
        templates: [
          ...BUILTINS,
          ...(await tx.all(
            "workflow_templates",
            "PROJECT_ID=?",
            [proj.id],
            "NAME,ID",
          )),
        ],
        default_workflow_id: proj.default_workflow_id,
        version: proj.workflow_config_version,
      };
    },
  );
  route(
    app,
    "POST",
    "/api/projects/:project_id/workflow-templates",
    create,
    async ({ tx, params: p, body, actor }) => {
      human(actor);
      await tx.one("projects", p.project_id);
      await validate(tx, body.steps);
      const r = await tx.insert("workflow_templates", {
        project_id: p.project_id,
        ...body,
      });
      await tx.audit(actor, "workflow_template.created", r);
      return r;
    },
    201,
  );
  route(
    app,
    "PUT",
    "/api/projects/:project_id/workflow-templates/:template_id",
    create.extend({ version: z.number().int().min(1) }),
    async ({ tx, params: p, body, actor }) => {
      human(actor);
      const t = await tx.one("workflow_templates", p.template_id, true);
      demand(t.project_id === p.project_id, 404, "Project template not found");
      demand(t.version === body.version, 409, "Workflow changed; reload");
      await validate(tx, body.steps);
      const r = await tx.update("workflow_templates", t.id, {
        ...body,
        version: t.version + 1,
      });
      await tx.audit(actor, "workflow_template.updated", {
        before: t,
        after: r,
      });
      return r;
    },
  );
  route(
    app,
    "PATCH",
    "/api/projects/:project_id/default-workflow",
    z.strictObject({
      version: z.number().int().min(1),
      workflow_template_id: id.nullable().default(null),
    }),
    async ({ tx, params: p, body, actor }) => {
      human(actor);
      const proj = await tx.one("projects", p.project_id, true);
      demand(
        proj.workflow_config_version === body.version,
        409,
        "Project workflow settings changed; reload",
      );
      if (body.workflow_template_id)
        await definition(tx, proj.id, body.workflow_template_id);
      const r = await tx.update("projects", proj.id, {
        default_workflow_id: body.workflow_template_id,
        workflow_config_version: proj.workflow_config_version + 1,
      });
      await tx.audit(actor, "project.default_workflow_changed", {
        project_id: proj.id,
        before: proj.default_workflow_id,
        after: body.workflow_template_id,
      });
      return r;
    },
  );
  route(
    app,
    "GET",
    "/api/tasks/:task_id/workflow-config",
    undefined,
    async ({ tx, params: p }) => {
      const t = await tx.one("tasks", p.task_id),
        e = await effective(tx, await tx.one("projects", t.project_id), t);
      return {
        selected_id: t.workflow_template_id,
        effective: e.template,
        source: e.source,
      };
    },
  );
}
