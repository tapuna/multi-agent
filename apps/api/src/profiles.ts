import { z } from "zod";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { hash, stable, demand, executionEnabled } from "./config.js";
import type { Tx } from "./db.js";
export const runtimes = ["codex", "claude", "gemini", "api"] as const;
const ProfileSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  label: z.string().max(100).default(""),
  runtime: z.enum(runtimes).default("api"),
  model: z.string().trim().max(150).default(""),
  enabled: z.boolean().default(true),
  api_base: z.string().nullable().optional(),
  api_key_env: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
    .nullable()
    .optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
export function profiles(): Profile[] {
  const raw = process.env.LLM_PROFILES_JSON?.trim();
  if (!raw) return [];
  try {
    demand(Buffer.byteLength(raw) <= 131072, 422, "");
    const list = z.array(ProfileSchema).max(100).parse(JSON.parse(raw));
    demand(new Set(list.map((p) => p.id)).size === list.length, 422, "");
    for (const p of list) {
      demand(
        p.runtime !== "api" || !!p.model,
        422,
        "API profiles require a model",
      );
      demand(!p.model.startsWith("profile:"), 422, "");
      demand(
        !p.api_key_env ||
          !/^(CONTROL_|DATABASE_|ARTIFACT_)/.test(p.api_key_env),
        422,
        "",
      );
      demand(p.runtime === "api" || (!p.api_base && !p.api_key_env), 422, "");
      if (p.api_base) {
        const u = new URL(p.api_base);
        demand(
          ["http:", "https:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash,
          422,
          "",
        );
      }
    }
    return list;
  } catch {
    throw new Error(
      "Invalid LLM_PROFILES_JSON: use unique profile IDs and a supported runtime; API profiles require model, CLI profiles may omit it; inline credentials are not allowed",
    );
  }
}
export function resolve(reference: string, runtime?: string) {
  const p = reference.startsWith("profile:")
    ? profiles().find((p) => "profile:" + p.id === reference)
    : null;
  if (reference.startsWith("profile:")) {
    demand(p, 422, "LLM profile not found");
    demand(p.enabled, 409, "LLM profile disabled");
    demand(
      !runtime || runtime === p.runtime,
      422,
      "LLM profile runtime mismatch",
    );
    demand(
      !p.api_key_env || process.env[p.api_key_env],
      409,
      "Missing credential environment variable: " + p.api_key_env,
    );
  }
  return { model: p ? p.model : reference, profile: p };
}
export function executable(runtime: string) {
  if (runtime === "api") return "api";
  const configured = process.env[runtime.toUpperCase() + "_BIN"];
  if (configured && fs.existsSync(configured)) return configured;
  try {
    return (
      execFileSync(
        process.platform === "win32" ? "where.exe" : "which",
        [runtime],
        { encoding: "utf8", windowsHide: true, timeout: 3000 },
      )
        .split(/\r?\n/)
        .find((p) => p.trim() && !p.endsWith(".ps1"))
        ?.trim() || null
    );
  } catch {
    return null;
  }
}
export function signature(reference: string) {
  try {
    const c = resolve(reference);
    const p = c.profile;
    return hash(
      stable({
        model: c.model,
        profile: p,
        credential: p?.api_key_env ? process.env[p.api_key_env] : "",
        legacy: p ? null : [process.env.LLM_API_BASE, process.env.LLM_API_KEY],
      }),
    );
  } catch {
    return hash("invalid:" + reference);
  }
}
export function fingerprint(p: Profile) {
  return hash(
    stable({
      signature: signature("profile:" + p.id),
      executable: executable(p.runtime),
      allowlist: process.env.CONTROL_ALLOWED_MODELS || "",
      native: p.api_key_env
        ? {}
        : Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) =>
                !/^(CONTROL_|ARTIFACT_|DATABASE_)/.test(k) &&
                /(_API_KEY|_TOKEN)$/.test(k),
            ),
          ),
    }),
  );
}
export function describe(ref: string) {
  try {
    const { model, profile: p } = resolve(ref);
    return {
      reference: ref,
      model,
      model_selection: p && !p.model ? "provider_default" : "explicit",
      profile_id: p?.id || null,
      runtime: p?.runtime || null,
      api_base: p?.api_base || null,
    };
  } catch (e) {
    return { reference: ref, error: (e as Error).message };
  }
}
export function allowed(ref: string) {
  try {
    const list = (process.env.CONTROL_ALLOWED_MODELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return (
      !list.length || list.includes(ref) || list.includes(resolve(ref).model)
    );
  } catch {
    return false;
  }
}
export async function readiness(tx: Tx, ref: string, runtime?: string) {
  const p = profiles().find((p) => "profile:" + p.id === ref);
  if (!p)
    return {
      available: false,
      status: "missing",
      reason:
        "Choose an LLM profile from LLM_PROFILES_JSON and test it in Setup",
      version: 0,
    };
  const r = (await tx.all("llm_readiness", "PROFILE_ID=?", [p.id]))[0];
  let status = r?.status || "not_tested",
    reason =
      r?.result?.message ||
      "Test this LLM profile in Setup before configuring an agent",
    available = false;
  const installed = !!executable(p.runtime);
  if (runtime && p.runtime !== runtime) {
    status = "runtime_mismatch";
    reason = "Profile does not match this runtime";
  } else if (!p.enabled) {
    status = "disabled";
    reason = "LLM profile is disabled in LLM_PROFILES_JSON";
  } else if (!installed) {
    status = "runtime_missing";
    reason = "Runtime executable not found";
  } else if (p.api_key_env && !process.env[p.api_key_env]) {
    status = "missing_credentials";
    reason = "Missing credential variable: " + p.api_key_env;
  } else if (!allowed(ref)) {
    status = "not_allowed";
    reason = "Model is outside the server allowlist";
  } else if (r && r.config_hash !== fingerprint(p)) {
    status = "stale";
    reason = "Profile configuration changed; test again in Setup";
  } else if (r?.status === "passed") {
    available = true;
    reason = "This LLM profile passed its provider test";
  }
  return {
    available,
    status,
    reason,
    installed,
    version: r?.version || 0,
    tested_at: r?.tested_at || null,
    latency_ms: r?.latency_ms ?? null,
  };
}
export async function ensureReady(tx: Tx, runtime: string, model: string) {
  const state = await readiness(tx, model, runtime);
  demand(state.available, 409, state.reason);
  demand(allowed(model), 403, "Model is outside the server allowlist");
}
export async function catalog(tx: Tx) {
  return Promise.all(
    profiles().map(async (p) => {
      const state = await readiness(tx, "profile:" + p.id, p.runtime);
      const checks = profileChecks(p, !!state.installed);
      const result = (await tx.all("llm_readiness", "PROFILE_ID=?", [p.id]))[0]
        ?.result;
      return {
        id: p.id,
        reference: "profile:" + p.id,
        label: p.label || p.id,
        runtime: p.runtime,
        model: p.model || "CLI default",
        model_selection: p.model ? "explicit" : "provider_default",
        enabled: p.enabled,
        api_base: p.api_base || null,
        credential_configured: !p.api_key_env || !!process.env[p.api_key_env],
        uses_native_auth: p.runtime !== "api" || !p.api_key_env,
        ...state,
        execution_enabled: executionEnabled(),
        can_test: checks.every((c) => c.ok) && state.status !== "running",
        test_checks: checks,
        test_blockers: checks.filter((c) => !c.ok).map((c) => c.detail),
        test_result: result
          ? {
              message: redact(String(result.message || "")),
              logs: Array.isArray(result.logs)
                ? result.logs.slice(-40).map((l: any) => ({
                    at: String(l.at || ""),
                    kind: String(l.kind || "info"),
                    message: profileLog(String(l.message || "")),
                  }))
                : [],
            }
          : null,
      };
    }),
  );
}
export function profileChecks(p: Profile, installed: boolean) {
  return [
    {
      name: "Profile enabled",
      ok: p.enabled,
      detail: p.enabled
        ? "Profile is enabled."
        : "Enable this profile in LLM_PROFILES_JSON and restart.",
    },
    {
      name: "Runtime installed",
      ok: installed,
      detail: installed
        ? "Runtime executable is available."
        : "Install the CLI or configure its executable path, then restart.",
    },
    {
      name: "Credential variable",
      ok: !p.api_key_env || !!process.env[p.api_key_env],
      detail:
        !p.api_key_env || process.env[p.api_key_env]
          ? "Credential reference is configured, or the runtime uses native login."
          : "Set the credential environment variable referenced by api_key_env and restart.",
    },
    {
      name: "Model allowlist",
      ok: allowed("profile:" + p.id),
      detail: allowed("profile:" + p.id)
        ? "Profile/model is allowed."
        : "Add this profile/model to CONTROL_ALLOWED_MODELS or choose an allowed profile.",
    },
  ];
}
export function profileLog(text: string) {
  return redact(text)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/RELAY_OK_[a-f0-9]+/g, "[verification token]")
    .slice(0, 1000);
}
export function redact(text: string) {
  for (const [key, value] of Object.entries(process.env))
    if (value && value.length > 6 && /(KEY|TOKEN|PASSWORD|SECRET)/i.test(key))
      text = text.split(value).join("[REDACTED]");
  for (const p of profiles())
    if (p.api_key_env && process.env[p.api_key_env])
      text = text.split(process.env[p.api_key_env]!).join("[REDACTED]");
  return text.slice(0, 4000);
}
