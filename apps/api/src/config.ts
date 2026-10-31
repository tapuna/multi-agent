import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";

export const ROOT = path.resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
config({ path: path.join(ROOT, ".env"), quiet: true });
export const DATA = path.resolve(
  process.env.CONTROL_DATA_DIR || path.join(ROOT, ".data"),
);
export const WORK = path.resolve(
  process.env.WORKSPACE_ROOT || path.join(ROOT, "workspaces"),
);
export const CONTEXT = path.resolve(
  process.env.CONTEXT_ROOT || path.join(ROOT, "contexts"),
);
fs.mkdirSync(DATA, { recursive: true });
process.env.FIREBIRD_LOCK ||= path.join(DATA, "firebird-lock");
fs.mkdirSync(process.env.FIREBIRD_LOCK, { recursive: true });
export const uid = randomUUID;
export const now = () => new Date().toISOString();
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + stable(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export function demand(ok: unknown, code: number, message: string): asserts ok {
  if (!ok) throw new HttpError(code, message);
}
export const human = (actor: string) =>
  demand(actor.startsWith("human:"), 403, "Human approval required");
export const executionEnabled = () =>
  ["1", "true", "yes"].includes(
    (process.env.AGENT_EXECUTION_ENABLED || "").toLowerCase(),
  );
