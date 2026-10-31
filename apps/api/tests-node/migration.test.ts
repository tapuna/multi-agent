import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

test("Node migration: Firebird persistence, profile gate, LangGraph approval and chat", async () => {
  const root = fs.mkdtempSync(
    path.join(path.resolve("../../.data"), "node-validation-"),
  );
  process.env.CONTROL_DATA_DIR = root;
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.DATABASE_URL = "";
  process.env.CONTROL_HUMAN_KEY = "local-test-human";
  process.env.CONTROL_API_KEY = "local-test-agent";
  process.env.AGENT_EXECUTION_ENABLED = "1";
  process.env.FIREBIRD_CLIENT_LIBRARY =
    process.env.FIREBIRD_CLIENT_LIBRARY ||
    path.resolve(
      "../../.data/firebird-runtime",
      process.platform === "win32" ? "fbclient.dll" : "lib/libfbclient.so",
    );
  process.env.FIREBIRD_LOCK = path.resolve("../../.data/firebird-lock");
  process.env.TEST_PROVIDER_KEY = "local-contract-only";
  process.env.FIREBIRD_LOCK_TIMEOUT_SECONDS = "1";
  process.env.CONTROL_ALLOWED_MODELS = "";
  process.env.ARTIFACT_S3_BUCKET = "";
  let calls = 0;
  const provider = http.createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      calls++;
      const data = JSON.parse(body),
        prompt = data.messages.at(-1).content,
        token = prompt.match(/RELAY_OK_[a-f0-9]+/)?.[0];
      const content =
        token ||
        (prompt.includes("Return ONLY")
          ? JSON.stringify({
              summary: "Local contract output",
              files: prompt.includes('"kind":"implement"')
                ? [{ path: "hello.txt", content: "สวัสดี Node.js" }]
                : [],
            })
          : "Context summary from supplied sources [project].");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "local-response",
          choices: [{ message: { role: "assistant", content } }],
          usage: { total_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address() as any;
  process.env.LLM_PROFILES_JSON = JSON.stringify([
    {
      id: "main",
      runtime: "api",
      model: "openai/unit",
      api_base: `http://127.0.0.1:${address.port}/v1`,
      api_key_env: "TEST_PROVIDER_KEY",
    },
    {
      id: "other",
      runtime: "api",
      model: "openai/other",
      api_base: `http://127.0.0.1:${address.port}/v1`,
      api_key_env: "TEST_PROVIDER_KEY",
    },
  ]);
  const { migrate, transaction } = await import("../src/db.js"),
    { buildApp } = await import("../src/app.js");
  await migrate();
  const app = buildApp();
  const request = async (
    method: string,
    url: string,
    body?: unknown,
    service = false,
  ) => {
    const response = await app.inject({
      method: method as any,
      url,
      headers: service
        ? { "x-api-key": "local-test-agent" }
        : { "x-human-key": "local-test-human" },
      ...(body === undefined ? {} : { payload: body as any }),
    });
    return { status: response.statusCode, data: response.json() };
  };
  const wait = async (url: string, done: (v: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const r = await request("GET", url);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      if (done(r.data)) return r.data;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Timed out " + url);
  };
  try {
    assert.equal((await app.inject("/api/projects")).statusCode, 401);
    const project = await request("POST", "/api/projects", {
      name: "Node migration QA",
      key: "NODEQA",
      description: "ภาษาไทย",
    });
    assert.equal(project.status, 201, JSON.stringify(project.data));
    const a = {
      name: "Builder",
      role: "Engineer",
      runtime: "api",
      model: "profile:main",
    };
    assert.equal((await request("POST", "/api/agents", a)).status, 409);
    assert.equal(
      (await request("POST", "/api/llm-profiles/main/verify", {})).status,
      202,
    );
    await wait("/api/llm-profiles", (v) => v[0].available);
    assert.equal(
      (await request("POST", "/api/agents", { ...a, model: "profile:other" }))
        .status,
      409,
    );
    const agent = await request("POST", "/api/agents", a);
    assert.equal(agent.status, 201, JSON.stringify(agent.data));
    const task = await request("POST", "/api/tasks", {
      project_id: project.data.id,
      title: "Test Node workflow",
    });
    assert.equal(task.status, 201, JSON.stringify(task.data));
    const run = await request("POST", `/api/tasks/${task.data.id}/workflows`, {
      version: 1,
      steps: [
        {
          key: "build",
          kind: "implement",
          agent_id: agent.data.id,
          depends_on: [],
          instructions: "",
        },
      ],
    });
    assert.equal(run.status, 202, JSON.stringify(run.data));
    const detail = await wait("/api/workflows/" + run.data.id, (v) =>
      ["awaiting_approval", "failed"].includes(v.run.status),
    );
    assert.equal(
      detail.run.status,
      "awaiting_approval",
      JSON.stringify(detail),
    );
    assert.ok(detail.checkpoints.length);
    assert.equal(
      fs.readFileSync(
        path.join(detail.run.workspace_path, "source", "hello.txt"),
        "utf8",
      ),
      "สวัสดี Node.js",
    );
    assert.equal(
      (await request("GET", "/api/tasks/" + task.data.id)).data.task.status,
      "review",
    );
    assert.equal(
      (
        await request(
          "POST",
          `/api/workflows/${run.data.id}/decision`,
          { approved: true, digest: detail.run.result_digest },
          true,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request("POST", `/api/workflows/${run.data.id}/decision`, {
          approved: true,
          digest: detail.run.result_digest,
        })
      ).status,
      202,
    );
    const finished = await wait("/api/workflows/" + run.data.id, (v) =>
      ["completed", "failed"].includes(v.run.status),
    );
    assert.equal(finished.run.status, "completed", JSON.stringify(finished));
    const chat = `/api/projects/${project.data.id}/agents/${agent.data.id}/chat`;
    assert.equal(
      (await request("POST", chat + "/messages", { kind: "context_summary" }))
        .status,
      202,
    );
    const conversation = await wait(
      chat,
      (v) =>
        v.messages.some((m: any) => m.role === "assistant") ||
        !!v.conversation?.error,
    );
    assert.equal(
      conversation.conversation.error,
      null,
      JSON.stringify(conversation),
    );
    assert.equal(conversation.messages.length, 2);
    let release!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((r) => (locked = r));
    const lockHeld = new Promise<void>((r) => (release = r));
    const holder = transaction(async (tx) => {
      await tx.one("projects", project.data.id, true);
      locked();
      await lockHeld;
    });
    await lockReady;
    try {
      const conflict = await request(
        "PATCH",
        `/api/projects/${project.data.id}/repository`,
        { repository_path: null },
      );
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.code, "database_busy");
    } finally {
      release();
      await holder;
    }
    await assert.rejects(
      transaction(async (tx) => {
        const audit = (await tx.all("audit_events"))[0];
        await tx.update("audit_events", audit.id, { action: "tamper" });
      }),
      /append-only/,
    );
    await migrate();
    assert.equal((await request("GET", "/api/projects")).data.length, 1);
    assert.equal(calls, 3, "No provider replay on approval or migration");
    console.log(
      "Validated fresh database, Unicode, immutable audit, profile isolation, durable workflow approval/resume and chat; 3 local provider calls.",
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
