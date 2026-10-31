import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { route, text, id } from "./http.js";
import { transaction, type Tx, type Row } from "./db.js";
import { WORK, human, demand, hash, stable, uid, now } from "./config.js";
import {
  profiles,
  runtimes,
  readiness,
  catalog,
  ensureReady,
  fingerprint,
  signature,
  describe,
  executable,
  redact,
  profileLog,
} from "./profiles.js";
import { ADAPTERS } from "./runtime.js";
import { snapshot, resolveSkills } from "./knowledge.js";
async function testProfile(
  profileId: string,
  version: number,
  expected: string,
) {
  const started = Date.now(),
    ref = "profile:" + profileId;
  const logs: { at: string; kind: string; message: string }[] = [];
  let lastPersist = 0;
  const log = async (kind: string, message: string, flush = false) => {
    logs.push({ at: now(), kind, message: profileLog(message) });
    if (logs.length > 40) logs.shift();
    if (!flush && Date.now() - lastPersist < 1000) return;
    lastPersist = Date.now();
    await transaction(async (tx) => {
      const r = await tx.one("llm_readiness", profileId, true);
      if (r.version !== version || r.status !== "running") return;
      await tx.update("llm_readiness", profileId, {
        result: { ...r.result, logs: [...logs] },
      });
    });
  };
  try {
    const p = profiles().find((p) => p.id === profileId);
    demand(p, 409, "Profile was removed");
    const token = "RELAY_OK_" + uid().replaceAll("-", "").slice(0, 16),
      workspace = path.join(WORK, "llm-checks", profileId, uid());
    fs.mkdirSync(workspace, { recursive: true });
    await log(
      "info",
      `Preflight passed. Starting ${p.runtime.toUpperCase()} provider test (${p.model || "CLI default"}); deadline 30 seconds.`,
      true,
    );
    const check = () =>
      transaction(async (tx) => {
        const r = await tx.one("llm_readiness", profileId),
          p = profiles().find((p) => p.id === profileId);
        demand(
          p?.enabled &&
            fingerprint(p) === expected &&
            r.version === version &&
            r.status === "running",
          409,
          "Profile configuration changed or test interrupted",
        );
      });
    const result = await ADAPTERS[p.runtime].run(
      {
        prompt:
          "This is a connectivity/authentication/model readiness check. Do not use tools or read project files. Reply exactly with: " +
          token,
        workspace,
        model: ref,
        purpose: "diagnostic",
        timeout_seconds: 30,
      },
      async (kind, data) => {
        if (kind === "runtime.log")
          await log("stderr", String(data.message || ""));
        else if (kind === "runtime.request")
          await log(
            "info",
            "Sending the verification request to the configured API.",
          );
        else if (kind === "runtime.event")
          await log("event", "CLI event: " + String(data.type || "unknown"));
        else if (kind === "session.provider_bound")
          await log("info", "Provider session established.");
      },
      check,
    );
    await check();
    logs.push({
      at: now(),
      kind: "info",
      message:
        result.content.trim() === token
          ? "Provider returned the expected verification response."
          : "Provider returned an unexpected response; profile is not ready.",
    });
    await transaction(async (tx) => {
      const r = await tx.one("llm_readiness", profileId, true);
      if (r.version !== version || r.status !== "running") return;
      const passed = result.content.trim() === token;
      await tx.update("llm_readiness", profileId, {
        status: passed ? "passed" : "failed",
        tested_at: now(),
        latency_ms: Date.now() - started,
        result: {
          message: passed
            ? "Provider returned the expected fresh response"
            : "Provider did not return the verification token",
          connection: describe(ref),
          logs: logs.slice(-40),
        },
      });
      await tx.audit(
        "system:llm-setup",
        passed ? "llm.profile.passed" : "llm.profile.failed",
        { profile_id: profileId, version, latency_ms: Date.now() - started },
      );
    });
  } catch (e) {
    await transaction(async (tx) => {
      const r = await tx.one("llm_readiness", profileId, true);
      if (r.version !== version || r.status !== "running") return;
      const message = redact((e as Error).message);
      logs.push({ at: now(), kind: "error", message: profileLog(message) });
      await tx.update("llm_readiness", profileId, {
        status: "failed",
        tested_at: now(),
        latency_ms: Date.now() - started,
        result: { message, logs: logs.slice(-40) },
      });
      await tx.audit("system:llm-setup", "llm.profile.failed", {
        profile_id: profileId,
        message,
      });
    });
  }
}
function diagnosticHash(a: Row) {
  return hash(
    stable({
      runtime: a.runtime,
      model: a.model,
      enabled: a.enabled,
      signature: signature(a.model),
    }),
  );
}
async function preflight(tx: Tx, a: Row) {
  const s = await readiness(tx, a.model, a.runtime);
  return [
    { name: "Agent enabled", ok: a.enabled },
    { name: s.reason, ok: s.available },
    { name: "Runtime installed", ok: !!executable(a.runtime) },
  ];
}
async function testAgent(testId: string) {
  const started = Date.now();
  try {
    const state = await transaction(async (tx) => {
        const d = await tx.one("agent_diagnostics", testId),
          a = await tx.one("agents", d.agent_id);
        return { d, a };
      }),
      { d, a } = state;
    const workspace = path.join(WORK, "diagnostics", testId);
    fs.mkdirSync(workspace, { recursive: true });
    const token = "RELAY_OK_" + uid().replaceAll("-", "").slice(0, 16);
    const check = () =>
      transaction(async (tx) => {
        const current = await tx.one("agent_diagnostics", testId),
          agent = await tx.one("agents", a.id);
        demand(
          current.status === "running" &&
            diagnosticHash(agent) === d.config_hash,
          409,
          "Agent configuration changed",
        );
        await ensureReady(tx, agent.runtime, agent.model);
      });
    const result = await ADAPTERS[a.runtime].run(
      {
        prompt:
          "This is a connectivity/authentication/model readiness check. Reply exactly with: " +
          token,
        workspace,
        model: a.model,
        purpose: "diagnostic",
        timeout_seconds: 30,
      },
      () => {},
      check,
    );
    await check();
    await transaction(async (tx) => {
      const r = await tx.one("agent_diagnostics", testId, true);
      if (r.status !== "running") return;
      const passed = result.content.trim() === token;
      await tx.update("agent_diagnostics", testId, {
        status: passed ? "passed" : "failed",
        active_agent_id: null,
        latency_ms: Date.now() - started,
        result: {
          response_verified: passed,
          message: passed
            ? "Provider returned the expected fresh response"
            : "Unexpected provider response",
        },
      });
      await tx.audit(
        "system:diagnostics",
        "agent.diagnostic." + (passed ? "passed" : "failed"),
        { agent_id: a.id, test_id: testId },
      );
    });
  } catch (e) {
    await transaction(async (tx) => {
      const r = await tx.one("agent_diagnostics", testId, true);
      if (r.status !== "running") return;
      await tx.update("agent_diagnostics", testId, {
        status: "failed",
        active_agent_id: null,
        latency_ms: Date.now() - started,
        result: {
          response_verified: false,
          message: redact((e as Error).message),
        },
      });
      await tx.audit("system:diagnostics", "agent.diagnostic.failed", {
        test_id: testId,
        agent_id: r.agent_id,
      });
    });
  }
}
export function agentRoutes(app: FastifyInstance) {
  route(app, "GET", "/api/llm-profiles", undefined, async ({ tx }) =>
    catalog(tx),
  );
  route(
    app,
    "POST",
    "/api/llm-profiles/:profile_id/verify",
    z.strictObject({}),
    async ({ tx, actor, params: p, defer }) => {
      human(actor);
      const profile = profiles().find((x) => x.id === p.profile_id);
      demand(profile, 404, "Profile not found in LLM_PROFILES_JSON");
      const state = await readiness(
        tx,
        "profile:" + profile.id,
        profile.runtime,
      );
      demand(
        ![
          "disabled",
          "runtime_missing",
          "missing_credentials",
          "not_allowed",
        ].includes(state.status),
        409,
        state.reason,
      );
      let r = (await tx.all("llm_readiness", "PROFILE_ID=?", [profile.id]))[0];
      if (r) r = await tx.one("llm_readiness", profile.id, true);
      demand(
        r?.status !== "running",
        409,
        "This profile is already being tested",
      );
      const values = {
        status: "running",
        version: (r?.version || 0) + 1,
        config_hash: fingerprint(profile),
        latency_ms: null,
        result: { message: "Testing this LLM profile…" },
      };
      if (r) await tx.update("llm_readiness", profile.id, values);
      else
        await tx.insert("llm_readiness", { profile_id: profile.id, ...values });
      await tx.audit(actor, "llm.profile.test_requested", {
        profile_id: profile.id,
        version: values.version,
        connection: describe("profile:" + profile.id),
      });
      defer(() => testProfile(profile.id, values.version, values.config_hash));
      return { status: "running", profile_id: profile.id };
    },
    202,
  );
  route(app, "GET", "/api/runtime-adapters", undefined, async ({ tx }) => {
    const all = await catalog(tx);
    return runtimes.map((runtime) => {
      const matching = all.filter((p) => p.runtime === runtime),
        ready = matching.some((p) => p.available);
      return {
        runtime,
        available: ready,
        enabled: matching.some((p) => p.enabled),
        installed: !!executable(runtime),
        version: 0,
        probe_model: "",
        status: ready ? "available" : "profiles_not_ready",
        reason: ready
          ? "At least one LLM profile is ready"
          : "Test an LLM profile for this runtime in Setup first",
        result: {},
      };
    });
  });
  route(app, "GET", "/api/agents", undefined, async ({ tx }) =>
    Promise.all(
      (await tx.all("agents", "", [], "NAME")).map(async (a) => {
        const state = await readiness(tx, a.model, a.runtime);
        return {
          ...a,
          runtime_available: state.available,
          runtime_warning: state.reason,
        };
      }),
    ),
  );
  const agentSchema = z.strictObject({
    name: text(100, 1),
    role: text(100, 1),
    runtime: z.enum(runtimes),
    model: text(150, 1),
  });
  route(
    app,
    "POST",
    "/api/agents",
    agentSchema,
    async ({ tx, actor, body }) => {
      human(actor);
      await ensureReady(tx, body.runtime, body.model);
      const a = await tx.insert("agents", body);
      await tx.audit(actor, "agent.registered", { agent_id: a.id, ...body });
      return a;
    },
    201,
  );
  route(
    app,
    "PATCH",
    "/api/agents/:agent_id",
    agentSchema,
    async ({ tx, actor, body, params: p }) => {
      human(actor);
      const a = await tx.one("agents", p.agent_id, true);
      await ensureReady(tx, body.runtime, body.model);
      const r = await tx.update("agents", a.id, body);
      await tx.audit(actor, "agent.updated", {
        agent_id: a.id,
        before: {
          name: a.name,
          role: a.role,
          runtime: a.runtime,
          model: a.model,
        },
        after: body,
      });
      return r;
    },
  );
  route(
    app,
    "GET",
    "/api/agents/:agent_id/skills",
    undefined,
    async ({ tx, params: p }) => {
      const a = await tx.one("agents", p.agent_id);
      return { skill_refs: a.skill_refs, version: a.skills_version };
    },
  );
  route(
    app,
    "PUT",
    "/api/agents/:agent_id/skills",
    z.strictObject({
      version: z.number().int().min(1),
      skill_refs: z.array(text(100, 1)).max(10),
    }),
    async ({ tx, actor, params: p, body }) => {
      human(actor);
      const a = await tx.one("agents", p.agent_id, true);
      demand(
        a.skills_version === body.version,
        409,
        "Agent skills changed; reload",
      );
      const skills = resolveSkills(body.skill_refs);
      const r = await tx.update("agents", a.id, {
        skill_refs: body.skill_refs,
        skills_version: a.skills_version + 1,
      });
      await tx.audit(actor, "agent.skills_configured", {
        agent_id: a.id,
        before: a.skill_refs,
        after: body.skill_refs,
        packages: skills.map((s) => ({
          name: s.name,
          version: s.version,
          sha256: s.sha256,
        })),
      });
      return { skill_refs: r.skill_refs, version: r.skills_version };
    },
  );
  route(
    app,
    "POST",
    "/api/tasks/:task_id/sessions",
    z.strictObject({ agent_id: id }),
    async ({ tx, actor, body, params: p }) => {
      const t = await tx.one("tasks", p.task_id),
        a = await tx.one("agents", body.agent_id);
      demand(a.enabled, 409, "Agent disabled");
      await ensureReady(tx, a.runtime, a.model);
      const workspace = path.join(WORK, t.id, uid());
      fs.mkdirSync(workspace, { recursive: true });
      const row = await tx.insert("agent_sessions", {
        task_id: t.id,
        agent_id: a.id,
        workspace_path: workspace,
        context_snapshot: {
          ...snapshot(t.project_id, t.id, a.role),
          skills: resolveSkills(a.skill_refs),
        },
      });
      await tx.audit(
        actor,
        "session.prepared",
        { session_id: row.id, workspace, context: row.context_snapshot },
        t.id,
      );
      return row;
    },
    201,
  );
  route(
    app,
    "PATCH",
    "/api/sessions/:session_id",
    z.strictObject({ provider_session_id: text(250, 1) }),
    async ({ tx, params: p, actor, body }) => {
      const s = await tx.one("agent_sessions", p.session_id, true);
      demand(
        !s.provider_session_id ||
          s.provider_session_id === body.provider_session_id,
        409,
        "Provider session ID is immutable once bound",
      );
      const r = await tx.update("agent_sessions", s.id, body);
      await tx.audit(
        actor,
        "session.provider_bound",
        { session_id: s.id, ...body },
        s.task_id,
      );
      return r;
    },
  );
  route(
    app,
    "GET",
    "/api/sessions/:session_id/resume",
    undefined,
    async ({ tx, params: p }) => {
      const s = await tx.one("agent_sessions", p.session_id),
        a = await tx.one("agents", s.agent_id),
        t = await tx.one("tasks", s.task_id);
      await ensureReady(tx, a.runtime, a.model);
      demand(s.provider_session_id, 409, "Provider session has not been bound");
      return {
        session_id: s.id,
        provider_session_id: s.provider_session_id,
        workspace: s.workspace_path,
        command: ADAPTERS[a.runtime].command({
          prompt: t.description || t.title,
          model: a.model,
          workspace: s.workspace_path,
          provider_session_id: s.provider_session_id,
        }),
        execution_enabled: false,
      };
    },
  );
  route(app, "GET", "/api/agent-diagnostics", undefined, async ({ tx }) => {
    const agents = await tx.all("agents", "", [], "NAME");
    return Promise.all(
      agents.map(async (a) => {
        const d = (
            await tx.all(
              "agent_diagnostics",
              "AGENT_ID=?",
              [a.id],
              "CREATED_AT DESC,ID DESC",
              1,
            )
          )[0],
          state = await readiness(tx, a.model, a.runtime);
        return {
          agent: { id: a.id, name: a.name, runtime: a.runtime, model: a.model },
          checks: await preflight(tx, a),
          latest: d
            ? {
                ...d,
                stale: d.config_hash !== diagnosticHash(a) || !state.available,
              }
            : null,
        };
      }),
    );
  });
  route(
    app,
    "POST",
    "/api/agents/:agent_id/diagnostics",
    z.strictObject({}),
    async ({ tx, actor, params: p, defer }) => {
      human(actor);
      const a = await tx.one("agents", p.agent_id, true);
      demand(
        !(await tx.all("agent_diagnostics", "ACTIVE_AGENT_ID=?", [a.id]))
          .length,
        409,
        "Agent diagnostic already running",
      );
      const checks = await preflight(tx, a),
        ready = checks.every((c) => c.ok);
      const d = await tx.insert("agent_diagnostics", {
        agent_id: a.id,
        active_agent_id: ready ? a.id : null,
        status: ready ? "running" : "blocked",
        config_hash: diagnosticHash(a),
        config_snapshot: {
          runtime: a.runtime,
          model: a.model,
          llm_profile: describe(a.model),
        },
        result: {
          checks,
          response_verified: false,
          message: ready
            ? "Provider test running"
            : "Fix failed preflight checks before testing",
        },
      });
      await tx.audit(actor, "agent.diagnostic.requested", {
        test_id: d.id,
        agent_id: a.id,
        checks,
      });
      if (ready) defer(() => testAgent(d.id));
      return { id: d.id, status: d.status };
    },
    202,
  );
}
