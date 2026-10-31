import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { config } from "dotenv";
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
process.chdir(root);
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("Use Node.js 22 or newer (x64).");
config({ path: path.join(root, ".env"), quiet: true });
const production = process.argv.includes("--production"),
  seed = process.argv.includes("--seed");
process.env.CONTROL_API_KEY ||= randomBytes(32).toString("hex");
process.env.CONTROL_HUMAN_KEY ||= randomBytes(32).toString("hex");
process.env.CONTROL_DATA_DIR ||= path.join(root, ".data");
process.env.WORKSPACE_ROOT ||= path.join(root, "workspaces");
process.env.API_INTERNAL_URL ||= "http://127.0.0.1:8000";
fs.mkdirSync(process.env.CONTROL_DATA_DIR, { recursive: true });
const children = [];
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  for (const c of children)
    if (c.exitCode === null) {
      if (process.platform === "win32" && c.pid) {
        try {
          execFileSync("taskkill.exe", ["/PID", String(c.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5000,
          });
        } catch {}
      } else c.kill("SIGTERM");
    }
};
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, stop);
function start(args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.once("error", (e) => {
    console.error(e.message);
    stop();
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    if (!closing) {
      process.exitCode = code || 0;
      stop();
    }
  });
  return child;
}
if (seed) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/src/seed.ts"],
    { cwd: root, env: process.env, stdio: "inherit", windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code ? reject(new Error("Seed failed")) : resolve(),
    );
  });
}
if (production && !fs.existsSync("apps/api/dist/server.js"))
  throw new Error("Run npm run build first.");
start(
  production
    ? ["apps/api/dist/server.js"]
    : ["--import", "tsx", "apps/api/src/server.ts"],
);
let ready = false;
for (let i = 0; i < 100; i++) {
  if (closing) break;
  try {
    const response = await fetch("http://127.0.0.1:8000/health", {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
if (!ready) {
  stop();
  throw new Error(
    "API did not become ready. Check Firebird runtime and port 8000.",
  );
}
console.log("UI: http://127.0.0.1:3000 · API: http://127.0.0.1:8000/health");
start([
  "node_modules/next/dist/bin/next",
  production ? "start" : "dev",
  "apps/web",
  "--hostname",
  "127.0.0.1",
  "--port",
  "3000",
]);
