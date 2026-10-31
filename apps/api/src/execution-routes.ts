import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { zipSync, strToU8 } from "fflate";
import { route, text, id, identity } from "./http.js";
import { transaction, type Row } from "./db.js";
import { ROOT, WORK, human, demand, uid, executionEnabled } from "./config.js";
import {
  ensureReady,
  signature,
  describe,
  executable,
  runtimes,
  profiles,
} from "./profiles.js";
import {
  buildContext,
  resolveSkills,
  readContext,
  roleSlug,
  snapshot,
} from "./knowledge.js";
import { validateDag, resolveRun, stepSchema } from "./templates.js";
import {
  prepareSource,
  files,
  safePath,
  git,
  disabledFilters,
} from "./workspaces.js";
import { blockers, transition } from "./board.js";
import { execute, emit, checkRun, manifest, materialize } from "./workflows.js";
import { archiveArtifact } from "./storage.js";
function publicRun(r: Row) {
  return {
    ...r,
    context_snapshot: {
      source: r.context_snapshot.source || {},
      policy_sha256: r.context_snapshot.policy_sha256,
    },
    agents: Object.fromEntries(
      Object.entries(r.agents as Record<string, Row>).map(([k, a]) => {
        const { skills, role_context, ...p } = a;
        return [k, p];
      }),
    ),
  };
}
export function executionRoutes(app: FastifyInstance) {
  route(app, "GET", "/api/execution/config", undefined, async () => ({
    enabled: executionEnabled(),
    allowed_models: (process.env.CONTROL_ALLOWED_MODELS || "")
      .split(",")
      .filter(Boolean),
    max_output_tokens: 4096,
    capabilities: [
      "text_completion",
      "workspace_files",
      "artifacts",
      "checkpoints",
    ],
    cli_execution: true,
    runtimes: runtimes.map((runtime) => ({
      runtime,
      installed: !!executable(runtime),
      note:
        runtime === "api"
          ? "Configure a profile in LLM_PROFILES_JSON"
          : "Authenticate with the provider CLI before running",
    })),
    artifact_storage: process.env.ARTIFACT_S3_BUCKET
      ? "s3+firebird"
      : "firebird+filesystem",
    provider_credentials_configured: profiles().some(
      (p) => !p.api_key_env || !!process.env[p.api_key_env],
    ),
  }));
  route(
    app,
    "PATCH",
    "/api/projects/:project_id/repository",
    z.strictObject({ repository_path: text(1000).nullable().default(null) }),
    async ({ tx, actor, params: p, body }) => {
      human(actor);
      const project = await tx.one("projects", p.project_id, true);
      let repo = body.repository_path;
      if (repo) {
        demand(
          path.isAbsolute(repo) && fs.existsSync(repo),
          422,
          "Repository must be an existing absolute path",
        );
        demand(
          (await git(["rev-parse", "--is-inside-work-tree"], repo)) === "true",
          422,
          "Not a Git repository",
        );
        repo = path.resolve(repo);
      }
      const r = await tx.update("projects", project.id, {
        repository_path: repo,
      });
      await tx.audit(actor, "project.repository_configured", {
        project_id: project.id,
        before: project.repository_path,
        after: repo,
      });
      return r;
    },
  );
  const runSchema = z.strictObject({
    version: z.number().int().min(1),
    steps: z
      .array(stepSchema.omit({ role: true }).extend({ agent_id: id }))
      .min(1)
      .max(12)
      .nullable()
      .optional(),
    workflow_template_id: id.nullable().optional(),
    agent_overrides: z.record(text(40, 1), id).default({}),
    expected_workflow_id: id.nullable().optional(),
    expected_workflow_version: z.number().int().min(1).nullable().optional(),
  });
  route(
    app,
    "POST",
    "/api/tasks/:task_id/workflows",
    runSchema,
    async ({ tx, actor, params: p, body, defer }) => {
      human(actor);
      demand(executionEnabled(), 409, "Execution disabled");
      const task = await tx.one("tasks", p.task_id, true);
      demand(
        task.version === body.version,
        409,
        "Refresh task before starting",
      );
      demand(
        ["backlog", "todo", "in_progress"].includes(task.status),
        409,
        "Reopen task before starting",
      );
      demand(
        !(await tx.all("workflow_runs", "ACTIVE_TASK_ID=?", [task.id])).length,
        409,
        "Task already has an active workflow",
      );
      demand(
        !(await blockers(tx, task.id)).length,
        409,
        "Complete blocking dependencies first",
      );
      const project = await tx.one("projects", task.project_id, true),
        resolved = await resolveRun(tx, project, task, body),
        chosen: Row = {};
      const order = validateDag(resolved.steps);
      for (const s of resolved.steps) {
        const a = await tx.one("agents", s.agent_id);
        demand(a.enabled, 409, "Assigned agent is disabled");
        await ensureReady(tx, a.runtime, a.model);
        chosen[s.key] = {
          id: a.id,
          name: a.name,
          role: a.role,
          runtime: a.runtime,
          model: a.model,
          llm_config_hash: signature(a.model),
          llm_profile: describe(a.model),
          skills: resolveSkills(a.skill_refs),
          skills_version: a.skills_version,
          role_context: readContext(`role/${roleSlug(a.role)}/CONTEXT.md`),
        };
      }
      const runId = uid(),
        root = path.join(WORK, task.id, runId);
      fs.mkdirSync(root, { recursive: true });
      const source = await prepareSource(project.repository_path, root),
        context = {
          ...(await buildContext(tx, task)),
          workflow: resolved.workflow,
          source: { ...source, repository_path: project.repository_path },
          agent_skills: Object.fromEntries(
            Object.values(chosen).map((a: any) => [a.id, a.skills]),
          ),
        };
      demand(
        Buffer.byteLength(JSON.stringify({ context, agents: chosen })) <=
          400000,
        413,
        "Context exceeds run budget",
      );
      if (task.status === "backlog")
        await transition(tx, task, "todo", actor, "Workflow scheduled");
      if (task.status === "todo")
        await transition(tx, task, "in_progress", actor, "Workflow started");
      const run = await tx.insert("workflow_runs", {
        id: runId,
        task_id: task.id,
        active_task_id: task.id,
        task_version: task.version,
        agents: chosen,
        context_snapshot: context,
        workspace_path: root,
      });
      for (const s of resolved.steps) {
        const workspace = path.join(root, "agents", s.key);
        fs.mkdirSync(workspace, { recursive: true });
        for (const skill of chosen[s.key].skills) {
          const folder = path.join(workspace, ".agents", "skills", skill.name);
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, "SKILL.md"), skill.content);
        }
        const session = await tx.insert("agent_sessions", {
          task_id: task.id,
          agent_id: s.agent_id,
          workspace_path: workspace,
          context_snapshot: {
            ...context,
            agent_skills: undefined,
            role: chosen[s.key].role,
            role_context: chosen[s.key].role_context,
            skills: chosen[s.key].skills,
          },
        });
        await tx.insert("workflow_steps", {
          run_id: runId,
          key: s.key,
          kind: s.kind,
          agent_id: s.agent_id,
          session_id: session.id,
          instructions: s.instructions || "",
          depends_on: s.depends_on,
        });
        await emit(
          tx,
          run,
          "agent.queued",
          {
            agent_id: s.agent_id,
            agent_name: chosen[s.key].name,
            session_id: session.id,
          },
          s.key,
          actor,
        );
      }
      await emit(
        tx,
        run,
        "workflow.queued",
        { topological_order: order, source },
        null,
        actor,
      );
      defer(() => execute(runId));
      return publicRun(run);
    },
    202,
  );
  route(app, "GET", "/api/workflows", undefined, async ({ tx, query }) => {
    let runs = await tx.all(
      "workflow_runs",
      query.task_id ? "TASK_ID=?" : "",
      query.task_id ? [query.task_id] : [],
      "CREATED_AT DESC",
      100,
    );
    if (query.project_id) {
      const tasks = await tx.all("tasks", "PROJECT_ID=?", [query.project_id]);
      runs = runs.filter((r) => tasks.some((t) => t.id === r.task_id));
    }
    return Promise.all(
      runs.map(async (r) => ({
        ...publicRun(r),
        active_steps: (
          await tx.all("workflow_steps", "RUN_ID=? AND STATE=?", [
            r.id,
            "running",
          ])
        ).map((s) => ({ key: s.key, agent_name: r.agents[s.key].name })),
      })),
    );
  });
  route(
    app,
    "GET",
    "/api/workflows/:run_id",
    undefined,
    async ({ tx, params: p }) => {
      const run = await tx.one("workflow_runs", p.run_id),
        steps = await tx.all("workflow_steps", "RUN_ID=?", [run.id]),
        rank = validateDag(steps);
      steps.sort((a, b) => rank.indexOf(a.key) - rank.indexOf(b.key));
      return {
        run: publicRun(run),
        steps: await Promise.all(
          steps.map(async (s) => {
            const { runtime_state, ...rest } = s;
            return {
              ...rest,
              provider_session_id: (
                await tx.one("agent_sessions", s.session_id)
              ).provider_session_id,
              generated_files: runtime_state.files || [],
            };
          }),
        ),
        events: (
          await tx.all("run_events", "RUN_ID=?", [run.id], "SEQUENCE DESC", 250)
        ).reverse(),
        artifacts: await tx.all("run_artifacts", "RUN_ID=?", [run.id], "STAGE"),
        checkpoints: (
          await tx.all(
            "graph_checkpoints",
            "THREAD_ID=?",
            [run.id],
            "CHECKPOINT_ID DESC",
            100,
          )
        ).map((c) => c.checkpoint_id),
      };
    },
  );
  route(
    app,
    "GET",
    "/api/workflows/:run_id/context",
    undefined,
    async ({ tx, params: p }) =>
      (await tx.one("workflow_runs", p.run_id)).context_snapshot,
  );
  route(
    app,
    "GET",
    "/api/workflows/:run_id/events",
    undefined,
    async ({ tx, params: p, query }) => {
      await tx.one("workflow_runs", p.run_id);
      return tx.all(
        "run_events",
        "RUN_ID=? AND SEQUENCE>?",
        [p.run_id, Number(query.after) || 0],
        "SEQUENCE",
        500,
      );
    },
  );
  route(
    app,
    "POST",
    "/api/workflows/:run_id/resume",
    z.strictObject({}),
    async ({ tx, actor, params: p, defer }) => {
      human(actor);
      let r = await tx.one("workflow_runs", p.run_id, true);
      demand(
        ["failed", "interrupted"].includes(r.status),
        409,
        "Only failed or interrupted workflows can resume",
      );
      await checkRun(tx, { ...r, status: "queued" });
      r = await tx.update("workflow_runs", r.id, { status: "queued" });
      await emit(tx, r, "workflow.resumed", {}, null, actor);
      defer(() => execute(r.id));
      return publicRun(r);
    },
    202,
  );
  route(
    app,
    "POST",
    "/api/workflows/:run_id/decision",
    z.strictObject({ approved: z.boolean(), digest: text(64, 64) }),
    async ({ tx, actor, params: p, body, defer }) => {
      human(actor);
      const r = await tx.one("workflow_runs", p.run_id, true);
      demand(
        r.status === "awaiting_approval",
        409,
        "Workflow is not waiting for review",
      );
      await checkRun(tx, r);
      demand(
        body.digest === r.result_digest &&
          (await manifest(tx, r)) === body.digest,
        409,
        "Artifact digest changed",
      );
      await materialize(tx, r, true);
      const decision = { ...body, actor },
        updated = await tx.update("workflow_runs", r.id, {
          decision,
          status: "queued",
        });
      await emit(tx, r, "approval.workflow_review", decision, null, actor);
      defer(() => execute(r.id));
      return publicRun(updated);
    },
    202,
  );
  route(
    app,
    "POST",
    "/api/workflows/:run_id/cancel",
    z.strictObject({}),
    async ({ tx, actor, params: p }) => {
      human(actor);
      const r = await tx.one("workflow_runs", p.run_id, true);
      demand(
        !["completed", "rejected", "cancelled"].includes(r.status),
        409,
        "Workflow already finished",
      );
      for (const step of await tx.all("workflow_steps", "RUN_ID=?", [r.id]))
        if (step.state !== "completed") {
          await tx.update("workflow_steps", step.id, { state: "cancelled" });
          await tx.update("agent_sessions", step.session_id, {
            state: "cancelled",
          });
        }
      const task = await tx.one("tasks", r.task_id, true);
      if (task.version === r.task_version && task.status === "in_progress")
        await transition(tx, task, "todo", actor, "Workflow cancelled");
      const updated = await tx.update("workflow_runs", r.id, {
        status: "cancelled",
        active_task_id: null,
      });
      await emit(tx, r, "workflow.cancelled", {}, null, actor);
      return publicRun(updated);
    },
  );
  route(
    app,
    "GET",
    "/api/workflows/:run_id/files",
    undefined,
    async ({ tx, params: p, query }) => {
      const r = await tx.one("workflow_runs", p.run_id),
        root = path.join(r.workspace_path, "source");
      if (!query.path) return files(root);
      const file = safePath(root, query.path);
      demand(
        fs.existsSync(file) && fs.statSync(file).isFile(),
        404,
        "File not found",
      );
      demand(
        fs.statSync(file).size <= 262144,
        413,
        "File exceeds preview limit",
      );
      const data = fs.readFileSync(file);
      demand(!data.includes(0), 422, "Unsupported binary file");
      return { path: query.path, content: data.toString("utf8") };
    },
  );
  route(
    app,
    "POST",
    "/api/workflows/:run_id/archive",
    z.strictObject({}),
    async ({ tx, actor, params: p, defer }) => {
      human(actor);
      demand(
        process.env.ARTIFACT_S3_BUCKET,
        409,
        "S3 artifact storage is not configured",
      );
      const run = await tx.one("workflow_runs", p.run_id);
      await emit(tx, run, "artifact.archive_requested", {}, null, actor);
      defer(async () => {
        const artifacts = await transaction((tx) =>
          tx.all("run_artifacts", "RUN_ID=?", [run.id]),
        );
        for (const a of artifacts)
          try {
            const result = await archiveArtifact(a);
            await transaction((tx) =>
              emit(tx, run, "artifact.archived", result!),
            );
          } catch {
            await transaction((tx) =>
              emit(tx, run, "artifact.archive_failed", { artifact_id: a.id }),
            );
          }
      });
      return { status: "queued" };
    },
    202,
  );
  route(
    app,
    "POST",
    "/api/workflows/:run_id/merge",
    z.strictObject({
      digest: text(64, 64),
      expected_revision: text(64, 40).regex(/^[0-9a-f]+$/),
      message: text(200, 1).default("Integrate reviewed agent workflow"),
    }),
    async ({ tx, actor, params: p, body }) => {
      human(actor);
      const run = await tx.one("workflow_runs", p.run_id, true),
        previous = (
          await tx.all("run_events", "RUN_ID=? AND KIND=?", [
            run.id,
            "workflow.merged",
          ])
        )[0];
      if (previous) return previous.payload;
      const task = await tx.one("tasks", run.task_id, true),
        source = run.context_snapshot.source,
        repo = source?.repository_path;
      demand(
        run.status === "completed" && run.decision?.approved,
        409,
        "Approve workflow before merging",
      );
      demand(
        task.version === run.task_version + 1 &&
          body.digest === run.result_digest &&
          (await manifest(tx, run)) === body.digest,
        409,
        "Task or artifact version changed",
      );
      demand(
        snapshot(task.project_id, task.id, "merge-policy").policy_sha256 ===
          run.context_snapshot.policy_sha256,
        409,
        "Company policy changed; fresh review required",
      );
      demand(
        repo &&
          (source.kind || source.mode) === "git-worktree" &&
          source.revision === body.expected_revision,
        409,
        "No Git worktree or unexpected base revision",
      );
      await materialize(tx, run, true);
      demand(
        (await git(["rev-parse", "HEAD"], repo)) === body.expected_revision &&
          !(await git(["status", "--porcelain"], repo)),
        409,
        "Repository changed or has local changes; create a fresh run",
      );
      const workspace = path.join(run.workspace_path, "source"),
        artifacts = await tx.all("run_artifacts", "RUN_ID=?", [run.id]),
        generated = [
          ...new Set<string>(
            artifacts.flatMap((a) =>
              JSON.parse(a.content).files.map((f: Row) => f.path),
            ),
          ),
        ].sort();
      demand(generated.length, 409, "No generated file changes");
      for (const file of generated) safePath(workspace, file);
      const options = [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Relay Operator",
        "-c",
        "user.email=operator@localhost",
        ...(await disabledFilters(repo)),
      ];
      await git([...options, "add", "--", ...generated], workspace);
      const staged = (await git(["diff", "--cached", "--name-only"], workspace))
        .split("\n")
        .filter(Boolean);
      demand(
        staged.every((f) => generated.includes(f)),
        409,
        "Unreviewed staged files are present",
      );
      if (staged.length)
        await git([...options, "commit", "-m", body.message], workspace);
      const revision = await git(["rev-parse", "HEAD"], workspace);
      const changed = (
        await git(
          ["diff", "--name-only", body.expected_revision, revision],
          workspace,
        )
      )
        .split("\n")
        .filter(Boolean);
      demand(
        changed.every((f) => generated.includes(f)),
        409,
        "Unreviewed committed files are present",
      );
      await tx.insert("approvals", {
        task_id: task.id,
        task_version: task.version,
        kind: "merge",
        actor,
      });
      await emit(
        tx,
        run,
        "approval.merge",
        {
          digest: body.digest,
          base_revision: body.expected_revision,
          commit: revision,
        },
        null,
        actor,
      );
      await git([...options, "merge", "--ff-only", revision], repo);
      const result = {
        commit: revision,
        repository: repo,
        digest: body.digest,
      };
      await emit(tx, run, "workflow.merged", result, null, actor);
      return result;
    },
  );
  app.get<{ Params: { run_id: string } }>(
    "/api/workflows/:run_id/export",
    async (req, reply) => {
      identity(req);
      const archive = await transaction(async (tx) => {
        const r = await tx.one("workflow_runs", req.params.run_id),
          artifacts = await tx.all("run_artifacts", "RUN_ID=?", [r.id]),
          entries: Record<string, Uint8Array> = {};
        for (const a of artifacts) {
          demand(
            /^[a-z][a-z0-9_]*\.json$/.test(a.name),
            409,
            "Invalid artifact name",
          );
          entries["artifacts/" + a.name] = strToU8(a.content);
          for (const f of JSON.parse(a.content).files) {
            safePath(path.join(r.workspace_path, "source"), f.path);
            entries[a.stage + "/" + f.path] = strToU8(f.content);
          }
        }
        return Buffer.from(zipSync(entries));
      });
      return reply
        .header("Content-Type", "application/zip")
        .header(
          "Content-Disposition",
          `attachment; filename="workflow-${req.params.run_id}.zip"`,
        )
        .send(archive);
    },
  );
}
