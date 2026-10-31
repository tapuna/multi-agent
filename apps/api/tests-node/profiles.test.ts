import { test } from "node:test";
import assert from "node:assert/strict";
import { profiles, resolve, allowed } from "../src/profiles.js";
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
