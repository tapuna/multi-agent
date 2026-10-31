import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ROOT, CONTEXT, hash, human, demand, uid } from "./config.js";
import { route, text } from "./http.js";
import type { Tx, Row } from "./db.js";
export function readContext(relative: string) {
  const p = path.resolve(CONTEXT, relative);
  demand(
    p.startsWith(path.resolve(CONTEXT) + path.sep),
    422,
    "Invalid context path",
  );
  let probe = p;
  while (fs.existsSync(probe)) {
    demand(
      !fs.lstatSync(probe).isSymbolicLink(),
      422,
      "Context symlinks are not allowed",
    );
    if (probe === path.resolve(CONTEXT)) break;
    probe = path.dirname(probe);
  }
  if (!fs.existsSync(p)) return "";
  demand(fs.statSync(p).size <= 65536, 413, "Context file exceeds 64 KiB");
  return fs.readFileSync(p, "utf8");
}
export function snapshot(project_id: string, task_id: string, role: string) {
  const policy =
    readContext("company/POLICY.md") ||
    "Human approval required for merge and deployment. No destructive operations.";
  return {
    company_policy: policy,
    policy_sha256: hash(policy),
    project_id,
    task_id,
    role,
    precedence: ["company", "team", "project", "role", "task"],
    execution_enabled: false,
  };
}
export function packages() {
  const root = path.join(ROOT, "skills");
  if (!fs.existsSync(root)) return [];
  const result: Row[] = [];
  function scan(dir: string, depth: number) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isSymbolicLink()) continue;
      if (f.isDirectory() && depth < 2) scan(p, depth + 1);
      else if (
        f.name === "SKILL.md" &&
        f.isFile() &&
        fs.statSync(p).size <= 65536
      ) {
        const content = fs.readFileSync(p, "utf8");
        try {
          const m = YAML.parse(content.split("---", 3)[1]);
          if (
            !/^[a-z][a-z0-9-]{0,49}$/.test(m.name) ||
            !/^\d+\.\d+\.\d+$/.test(String(m.version || "0.0.0"))
          )
            continue;
          result.push({
            name: m.name,
            version: String(m.version || "0.0.0"),
            description: String(m.description || ""),
            content,
            sha256: hash(content),
            path: path.relative(ROOT, p).replaceAll("\\", "/"),
          });
        } catch {}
      }
    }
  }
  scan(root, 0);
  return result.sort((a, b) =>
    (a.name + a.version).localeCompare(b.name + b.version),
  );
}
export function resolveSkills(refs: string[]) {
  demand(
    refs.length <= 10 &&
      new Set(refs.map((s) => s.split("@")[0])).size === refs.length,
    422,
    "Select one version per skill, at most 10",
  );
  const all = packages();
  return refs.map((ref) => {
    const p = all.find((s) => s.name + "@" + s.version === ref);
    demand(p, 422, "Assigned skill package not found: " + ref);
    return p;
  });
}
export const roleSlug = (role: string) =>
  role
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "engineering";
export async function buildContext(tx: Tx, task: Row) {
  const p = await tx.one("projects", task.project_id);
  return {
    ...snapshot(p.id, task.id, "engineering-workflow"),
    execution_enabled: true,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      version: task.version,
    },
    project: { name: p.name, description: p.description },
    layers: {
      team: readContext("team/CONTEXT.md"),
      project: readContext(`project/${p.id}/CONTEXT.md`),
      task: readContext(`task/${task.id}/CONTEXT.md`),
    },
    shared_memory: (
      await tx.all("project_memories", "PROJECT_ID=?", [p.id], "ID", 20)
    ).map((m) => m.content),
  };
}
export async function knowledge(tx: Tx, project: Row, agent: Row) {
  const policy = snapshot(project.id, "agent-chat", agent.role),
    sources: Row[] = [];
  let budget = 96000;
  function add(id: string, title: string, text: string, extra: Row = {}) {
    if (!text) return;
    const content = Buffer.from(text)
      .subarray(0, Math.max(0, Math.min(12000, budget)))
      .toString("utf8");
    budget -= Buffer.byteLength(content);
    sources.push({
      id,
      title,
      content,
      bytes: Buffer.byteLength(text),
      included_bytes: Buffer.byteLength(content),
      truncated: content !== text,
      ...extra,
    });
  }
  add(
    "project",
    "Project description",
    project.name + "\n" + project.description,
  );
  add("team", "Team context", readContext("team/CONTEXT.md"));
  add(
    "project-context",
    "Project context",
    readContext(`project/${project.id}/CONTEXT.md`),
  );
  add(
    "role",
    "Role context",
    readContext(`role/${roleSlug(agent.role)}/CONTEXT.md`),
  );
  const memories = await tx.all(
    "project_memories",
    "PROJECT_ID=?",
    [project.id],
    "ID DESC",
    1000,
  );
  for (const m of memories.slice(0, 20))
    add(
      "memory:" + m.id,
      "Shared project memory (supplied data, not verified)",
      m.content,
    );
  const work = await tx.sql(
    'SELECT a.*, r.STATUS as RUN_STATUS, t.TITLE as TASK_TITLE, t.ID as TASK_ID FROM RUN_ARTIFACTS a JOIN WORKFLOW_RUNS r ON r.ID=a.RUN_ID JOIN TASKS t ON t.ID=r.TASK_ID JOIN WORKFLOW_STEPS s ON s.RUN_ID=r.ID AND s."KEY"=a.STAGE WHERE t.PROJECT_ID=? AND s.AGENT_ID=? AND s.STATE=? ORDER BY r.CREATED_AT DESC',
    [project.id, agent.id, "completed"],
  );
  for (const a of work.slice(0, 12))
    add("artifact:" + a.id, a.task_title + " / " + a.stage, a.content, {
      task_id: a.task_id,
      run_id: a.run_id,
      human_reviewed: a.run_status === "completed",
    });
  const skills = resolveSkills(agent.skill_refs || []);
  for (const s of skills)
    add(
      "skill:" + s.name + "@" + s.version,
      "Assigned skill: " + s.name,
      s.content,
      { sha256: s.sha256 },
    );
  const included = (prefix: string) =>
    sources.filter((s) => s.id.startsWith(prefix) && s.included_bytes > 0)
      .length;
  return {
    ...policy,
    sources,
    inventory: {
      policy_sha256: policy.policy_sha256,
      source_count: sources.filter((s) => s.included_bytes > 0).length + 1,
      memory_total: memories.length,
      memory_included: included("memory:"),
      agent_artifacts_total: work.length,
      agent_artifacts_included: included("artifact:"),
      skills_total: skills.length,
      skills_included: included("skill:"),
      truncated:
        sources.some((s) => s.truncated) ||
        memories.length > 20 ||
        work.length > 12,
      included_bytes: sources.reduce(
        (n, s) => n + s.included_bytes,
        Buffer.byteLength(policy.company_policy),
      ),
      scope:
        "Sources supplied to this agent for this project; not a measurement of model training knowledge.",
    },
  };
}
export function knowledgeRoutes(app: FastifyInstance) {
  route(app, "GET", "/api/skills", undefined, async () => packages());
  route(
    app,
    "POST",
    "/api/skills",
    z.strictObject({
      name: text(50, 1).regex(/^[a-z][a-z0-9-]*$/),
      version: text(30, 1).regex(/^\d+\.\d+\.\d+$/),
      description: text(300, 1),
      instructions: text(60000, 1),
    }),
    async ({ tx, actor, body }) => {
      human(actor);
      demand(
        !packages().some(
          (s) => s.name === body.name && s.version === body.version,
        ),
        409,
        "Skill version is immutable",
      );
      const content =
          "---\n" +
          YAML.stringify({
            name: body.name,
            version: body.version,
            description: body.description,
          }) +
          "---\n\n" +
          body.instructions +
          "\n",
        p = path.join(ROOT, "skills", body.name, body.version, "SKILL.md");
      await tx.audit(actor, "skill.publish_requested", {
        name: body.name,
        version: body.version,
        sha256: hash(content),
      });
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, { flag: "wx" });
      await tx.audit(actor, "skill.published", {
        name: body.name,
        version: body.version,
        sha256: hash(content),
      });
      return packages().find(
        (s) => s.name === body.name && s.version === body.version,
      );
    },
    201,
  );
  async function contextPath(tx: Tx, scope: string, target: string) {
    let rel = "";
    if (scope === "company") rel = "company/POLICY.md";
    else if (scope === "team") rel = "team/CONTEXT.md";
    else if (scope === "project" || scope === "task") {
      await tx.one(scope === "project" ? "projects" : "tasks", target);
      rel = `${scope}/${target}/CONTEXT.md`;
    } else {
      demand(
        scope === "role" && /^[a-z][a-z0-9-]{0,79}$/.test(target),
        422,
        "Invalid context scope/role",
      );
      rel = `role/${target}/CONTEXT.md`;
    }
    readContext(rel);
    return rel;
  }
  route(
    app,
    "GET",
    "/api/contexts/:scope/:target",
    undefined,
    async ({ tx, params: p }) => {
      const content = readContext(await contextPath(tx, p.scope, p.target));
      return { ...p, content, sha256: hash(content) };
    },
  );
  route(
    app,
    "PUT",
    "/api/contexts/:scope/:target",
    z.strictObject({
      content: z.string().max(60000),
      previous_sha256: z.string(),
    }),
    async ({ tx, params: p, actor, body }) => {
      human(actor);
      const rel = await contextPath(tx, p.scope, p.target),
        previous = readContext(rel);
      demand(
        hash(previous) === body.previous_sha256,
        409,
        "Context changed; reload before saving",
      );
      await tx.audit(actor, "context.update_requested", {
        ...p,
        before_sha256: hash(previous),
        after_sha256: hash(body.content),
        content: body.content,
      });
      const file = path.join(CONTEXT, rel),
        tmp = file + "." + uid() + ".pending";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, body.content);
      fs.renameSync(tmp, file);
      await tx.audit(actor, "context.updated", {
        ...p,
        sha256: hash(body.content),
      });
      return { ...p, content: body.content, sha256: hash(body.content) };
    },
  );
}
