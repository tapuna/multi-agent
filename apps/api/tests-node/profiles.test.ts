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
import { CLIAdapter } from "../src/runtime.js";

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

test("Disabled execution is visible as a preflight blocker without starting a runtime", () => {
  const saved = { ...process.env };
  try {
    process.env.LLM_PROFILES_JSON = JSON.stringify([
      { id: "code", runtime: "codex" },
    ]);
    process.env.AGENT_EXECUTION_ENABLED = "0";
    process.env.CONTROL_ALLOWED_MODELS = "";
    const checks = profileChecks(profiles()[0], true);
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].detail, /AGENT_EXECUTION_ENABLED=1/);
    assert.match(checks[0].detail, /No CLI\/API request has started/);
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
    assert.equal(rows[0].can_test, false);
    assert.ok(rows[0].test_blockers.length);
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
