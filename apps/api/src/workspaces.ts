import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { demand, hash } from "./config.js";
const exec = promisify(execFile);
const blocked =
  /^(?:\.git|\.gitmodules|\.gitattributes|\.env(?:\..*)?|\.agents|\.codex|\.aws|node_modules|\.venv|\.next|\.data|__pycache__)$/i;
export function safePath(root: string, relative: string, writing = false) {
  demand(
    relative &&
      !path.isAbsolute(relative) &&
      !relative.includes("\\") &&
      !relative.includes(":") &&
      !relative.includes("\0"),
    422,
    "Invalid workspace path",
  );
  const parts = relative.split("/");
  demand(
    parts.every(
      (p) =>
        p &&
        p !== "." &&
        p !== ".." &&
        !blocked.test(p) &&
        !/[<>"|?*]/.test(p) &&
        !/[. ]$/.test(p) &&
        !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(p),
    ),
    422,
    "Protected workspace path",
  );
  const base = path.resolve(root),
    dest = path.resolve(base, ...parts);
  demand(dest.startsWith(base + path.sep), 422, "Path escapes workspace");
  let probe = base;
  for (const part of parts) {
    probe = path.join(probe, part);
    if (fs.existsSync(probe)) {
      demand(
        !fs.lstatSync(probe).isSymbolicLink(),
        422,
        "Symlinks are not permitted",
      );
      demand(
        fs.realpathSync(probe).startsWith(fs.realpathSync(base) + path.sep),
        422,
        "Path escapes workspace",
      );
    }
  }
  return dest;
}
export async function git(args: string[], cwd?: string) {
  const r = await exec(
    "git",
    [
      "-c",
      "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.file.allow=never",
      ...args,
    ],
    {
      cwd,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  return r.stdout.trim();
}
export async function disabledFilters(repo: string) {
  let config = "";
  try {
    config = await git(
      [
        "config",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process|required)$",
      ],
      repo,
    );
  } catch {}
  const names = new Set(
    config
      .split("\n")
      .map((s) => s.split(/\s/)[0])
      .filter(Boolean),
  );
  const args: string[] = [];
  for (const name of names) {
    demand(
      /^filter\.[a-zA-Z0-9_.-]+\.(clean|smudge|process|required)$/.test(name),
      422,
      "Unsupported Git filter name",
    );
    args.push("-c", name + "=" + (name.endsWith(".required") ? "false" : ""));
  }
  return args;
}
export async function prepareSource(repository: string | null, root: string) {
  const source = path.join(root, "source");
  if (!repository) {
    fs.mkdirSync(source, { recursive: true });
    return { kind: "directory", revision: null };
  }
  const repo = path.resolve(repository);
  demand(
    (await git(["rev-parse", "--is-inside-work-tree"], repo)) === "true",
    422,
    "Repository must be a Git worktree",
  );
  demand(
    !(await git(["status", "--porcelain"], repo)),
    409,
    "Repository must be clean before creating a workspace",
  );
  const revision = await git(["rev-parse", "HEAD"], repo);
  await git(
    [
      ...(await disabledFilters(repo)),
      "worktree",
      "add",
      "--detach",
      source,
      revision,
    ],
    repo,
  );
  return { kind: "git-worktree", revision, repository_path: repo };
}
export function files(root: string, limit = 300) {
  const result: any[] = [];
  if (!fs.existsSync(root)) return result;
  const visit = (dir: string, prefix = "") => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (result.length >= limit) return;
      if (blocked.test(f.name) || f.isSymbolicLink()) continue;
      const rel = prefix + f.name,
        p = path.join(dir, f.name);
      if (f.isDirectory()) visit(p, rel + "/");
      else if (f.isFile()) {
        const s = fs.statSync(p);
        result.push({
          path: rel,
          size: s.size,
          sha256:
            s.size <= 262144 ? hash(fs.readFileSync(p).toString("utf8")) : null,
        });
      }
    }
  };
  visit(root);
  return result;
}
export function readFileContext(root: string) {
  let budget = 96000;
  return files(root)
    .filter((f) => f.size < 32000)
    .flatMap((f) => {
      if (budget <= 0) return [];
      const b = fs.readFileSync(safePath(root, f.path));
      if (b.includes(0)) return [];
      const content = b.toString("utf8").slice(0, Math.min(budget, 16000));
      budget -= Buffer.byteLength(content);
      return [{ path: f.path, content }];
    });
}
export function writeFiles(
  root: string,
  outputs: { path: string; content: string }[],
) {
  demand(outputs.length <= 100, 422, "Too many generated files");
  let bytes = 0;
  const destinations = outputs.map((f) => {
    bytes += Buffer.byteLength(f.content);
    demand(bytes <= 1048576, 413, "Generated files exceed 1 MiB");
    return { f, dest: safePath(root, f.path, true) };
  });
  for (const { f, dest } of destinations) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content, "utf8");
  }
  return outputs.map((f) => ({
    path: f.path,
    sha256: hash(f.content),
    size: Buffer.byteLength(f.content),
  }));
}
