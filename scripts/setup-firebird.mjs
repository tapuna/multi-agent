import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url))),
  target = path.resolve(
    process.env.FIREBIRD_RUNTIME_DIR ||
      path.join(root, ".data/firebird-runtime"),
  );
const library =
  process.platform === "win32" ? "fbclient.dll" : "lib/libfbclient.so";
if (fs.existsSync(path.join(target, library))) {
  console.log("Firebird Embedded runtime already available.");
  process.exit(0);
}
if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform))
  throw new Error(
    "Automatic setup supports Windows/Linux x64. Supply FIREBIRD_CLIENT_LIBRARY on other platforms.",
  );
const platform =
  process.platform === "win32" ? "windows-x64.zip" : "linux-x64.tar.gz";
const checksum =
  process.platform === "win32"
    ? "01e844fce4d5f53272a76205dbc3a1ba4b782ab8e8eadcd808cdbccd9ce13b72"
    : "ab6a15a0258f38b022be496bb5e038c14e8628ce9acd0f9a06288a3baedd917b";
const filename = "Firebird-5.0.4.1812-0-" + platform,
  url =
    "https://github.com/FirebirdSQL/firebird/releases/download/v5.0.4/" +
    filename;
console.log(
  "Downloading pinned Firebird Embedded 5.0.4 binaries (no service installation).",
);
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!response.ok)
  throw new Error("Firebird download failed: " + response.status);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== checksum)
  throw new Error("Firebird archive checksum mismatch");
const stage = path.join(root, ".data", "firebird-setup-" + randomUUID());
fs.mkdirSync(stage, { recursive: true });
function safe(base, entry) {
  const p = path.resolve(base, entry);
  if (p !== path.resolve(base) && !p.startsWith(path.resolve(base) + path.sep))
    throw new Error("Archive path escapes extraction directory");
  return p;
}
if (process.platform === "win32") {
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (name.endsWith("/")) continue;
    const p = safe(stage, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(stage, target, {
    recursive: true,
    errorOnExist: false,
    force: false,
  });
} else {
  const archive = path.join(stage, filename);
  fs.writeFileSync(archive, bytes);
  for (const name of execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
  })
    .trim()
    .split("\n"))
    safe(stage, name);
  execFileSync("tar", ["-xzf", archive, "-C", stage]);
  const build = path.join(
    stage,
    filename.replace(".tar.gz", ""),
    "buildroot.tar.gz",
  );
  for (const name of execFileSync("tar", ["-tzf", build], { encoding: "utf8" })
    .trim()
    .split("\n"))
    safe(stage, name);
  execFileSync("tar", ["-xzf", build, "-C", stage]);
  const distribution = path.join(stage, "opt", "firebird");
  if (!fs.existsSync(distribution))
    throw new Error("Unexpected Firebird archive layout");
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(distribution, target, {
    recursive: true,
    errorOnExist: false,
    force: false,
  });
}
if (!fs.existsSync(path.join(target, library)))
  throw new Error("Firebird library missing after extraction");
fs.appendFileSync(
  path.join(target, "firebird.conf"),
  "\n# Relay local embedded engine only\nProviders = Engine13\nRemoteAccess = false\n",
);
console.log(
  "Firebird runtime ready at " + target + "; database files were not modified.",
);
