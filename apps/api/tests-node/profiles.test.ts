import { test } from "node:test";
import assert from "node:assert/strict";
import {
  profiles,
  resolve,
  allowed,
  profileChecks,
  profileLog,
  catalog,
} from "../src/profiles.js";
import { CLIAdapter, APIAdapter } from "../src/runtime.js";

test("CLI profiles may omit model without changing runtime restrictions", () => {
  const saved = { ...process.env };
  try {
    for (const runtime of ["codex", "claude", "gemini"]) {
      process.env[runtime.toUpperCase() + "_BIN"] = process.execPath;
      process.env.LLM_PROFILES_JSON = JSON.stringify([
        { id: "code", runtime, enabled: true },
      ]);
      assert.equal(profiles()[0].model, "");
      assert.equal(resolve("profile:code", runtime).model, "");
      const args = new CLIAdapter(runtime).command({
        model: "profile:code",
        workspace: ".",
        prompt: "-",
        provider_session_id: "existing-session",
      });
      assert.equal(args.includes("--model"), false);
      assert.ok(args.includes("existing-session"));
      if (runtime === "codex") {
        assert.ok(args.includes("--ignore-user-config"));
        assert.ok(args.includes('sandbox_mode="read-only"'));
        assert.ok(args.includes('approval_policy="never"'));
      }
      if (runtime === "claude") assert.ok(args.includes("--tools"));
      if (runtime === "gemini") assert.ok(args.includes("plan"));
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("Explicit CLI model stays pinned and allowlist can name a default-model profile", () => {
  const saved = process.env.LLM_PROFILES_JSON,
    allow = process.env.CONTROL_ALLOWED_MODELS,
    binary = process.env.CODEX_BIN;
  try {
    process.env.CODEX_BIN = process.execPath;
    process.env.LLM_PROFILES_JSON = JSON.stringify([
      { id: "code", runtime: "codex", model: "chosen-model" },
    ]);
    let args = new CLIAdapter("codex").command({
      model: "profile:code",
      workspace: ".",
      prompt: "-",
    });
    assert.equal(args[args.indexOf("--model") + 1], "chosen-model");
    process.env.LLM_PROFILES_JSON = JSON.stringify([
      { id: "code", runtime: "codex" },
    ]);
    process.env.CONTROL_ALLOWED_MODELS = "profile:code";
    assert.equal(allowed("profile:code"), true);
    process.env.CONTROL_ALLOWED_MODELS = "other-model";
    assert.equal(allowed("profile:code"), false);
  } finally {
    if (saved === undefined) delete process.env.LLM_PROFILES_JSON;
    else process.env.LLM_PROFILES_JSON = saved;
    if (allow === undefined) delete process.env.CONTROL_ALLOWED_MODELS;
    else process.env.CONTROL_ALLOWED_MODELS = allow;
    if (binary === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = binary;
  }
});

test("API profiles still reject a missing or blank model", () => {
  const saved = process.env.LLM_PROFILES_JSON;
  try {
    for (const model of [undefined, "", "   "]) {
      process.env.LLM_PROFILES_JSON = JSON.stringify([
        { id: "api", runtime: "api", model },
      ]);
      assert.throws(() => profiles(), /API profiles require model/);
    }
  } finally {
    if (saved === undefined) delete process.env.LLM_PROFILES_JSON;
    else process.env.LLM_PROFILES_JSON = saved;
  }
});

test("Readiness checks remain available when task execution is disabled", () => {
  const saved = { ...process.env };
  try {
    process.env.LLM_PROFILES_JSON = JSON.stringify([
      { id: "code", runtime: "codex" },
    ]);
    process.env.AGENT_EXECUTION_ENABLED = "0";
    process.env.CONTROL_ALLOWED_MODELS = "";
    const checks = profileChecks(profiles()[0], true);
    assert.equal(
      checks.every((c) => c.ok),
      true,
    );
    assert.equal(
      checks.some((c) => c.name === "Execution enabled"),
      false,
    );
    process.env.AGENT_EXECUTION_ENABLED = "1";
    assert.equal(
      profileChecks(profiles()[0], true).every((c) => c.ok),
      true,
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("Public test logs redact keys, verification tokens and terminal controls", async () => {
  const saved = { ...process.env };
  try {
    const secret = "local-diagnostic-secret";
    process.env.LOG_TEST_API_KEY = secret;
    process.env.AGENT_EXECUTION_ENABLED = "0";
    process.env.CONTROL_ALLOWED_MODELS = "";
    process.env.LLM_PROFILES_JSON = JSON.stringify([
      {
        id: "main",
        runtime: "api",
        model: "openai/unit",
        api_key_env: "LOG_TEST_API_KEY",
      },
    ]);
    const message = `\u001b[31mfailed ${secret} RELAY_OK_abcdef0123456789\u001b[0m`;
    assert.equal(profileLog(message).includes(secret), false);
    assert.equal(profileLog(message).includes("\u001b"), false);
    const tx = {
      all: async () => [
        {
          status: "failed",
          version: 1,
          config_hash: "old",
          result: { message, logs: [{ at: "now", kind: "stderr", message }] },
        },
      ],
    };
    const rows = await catalog(tx as any);
    assert.equal(rows[0].can_test, true);
    assert.equal(rows[0].test_blockers.length, 0);
    assert.equal(rows[0].test_result?.logs.length, 1);
    assert.equal(JSON.stringify(rows).includes(secret), false);
    assert.equal(
      rows[0].test_result?.logs[0].message.includes("RELAY_OK_"),
      false,
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("API diagnostics bypass only the task execution flag, retaining model gates", async () => {
  const saved = { ...process.env },
    fetchBefore = globalThis.fetch;
  let calls = 0;
  try {
    process.env.AGENT_EXECUTION_ENABLED = "0";
    process.env.CONTROL_ALLOWED_MODELS = "";
    process.env.LLM_PROFILES_JSON = JSON.stringify([
      {
        id: "check",
        runtime: "api",
        model: "openai/unit",
        api_base: "http://127.0.0.1:1234/v1",
      },
    ]);
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "verification-ok" } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const adapter = new APIAdapter(),
      request = {
        model: "profile:check",
        workspace: ".",
        prompt: "verification only",
      };
    assert.equal(
      (
        await adapter.run(
          { ...request, purpose: "diagnostic" },
          () => {},
          async () => {},
        )
      ).content,
      "verification-ok",
    );
    assert.equal(calls, 1);
    await assert.rejects(
      adapter.run(
        { ...request, purpose: "workflow" },
        () => {},
        async () => {},
      ),
      /disabled/,
    );
    assert.equal(calls, 1);
    process.env.CONTROL_ALLOWED_MODELS = "another-model";
    await assert.rejects(
      adapter.run(
        { ...request, purpose: "diagnostic" },
        () => {},
        async () => {},
      ),
      /not allowed/,
    );
    assert.equal(calls, 1);
    process.env.CONTROL_ALLOWED_MODELS = "";
    process.env.LLM_PROFILES_JSON = JSON.stringify([
      { id: "check", runtime: "api", model: "openai/unit", enabled: false },
    ]);
    await assert.rejects(
      adapter.run(
        { ...request, purpose: "diagnostic" },
        () => {},
        async () => {},
      ),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetchBefore;
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
