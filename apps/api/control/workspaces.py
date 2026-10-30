"""Capability-limited workspace IO; no model-provided shell commands."""

import hashlib
import os
import re
import subprocess
from pathlib import Path, PureWindowsPath
from .database_config import DATA_ROOT


def safe_path(root, relative):
    root = Path(root).resolve()
    if (
        not relative
        or "\\" in relative
        or ":" in relative
        or PureWindowsPath(relative).drive
    ):
        raise ValueError("Invalid workspace path")
    parts = relative.split("/")
    forbidden = {
        ".git",
        ".relay",
        ".env",
        ".aws",
        ".ssh",
        ".codex",
        ".claude",
        ".gemini",
        "node_modules",
        "__pycache__",
        "auth.json",
        "credentials.json",
        "id_rsa",
        "id_ed25519",
    }
    for part in parts:
        if any(ord(c) < 32 or c in '<>"|?*' for c in part) or len(part.encode()) > 200:
            raise ValueError("Invalid filename characters or length")
        if (
            part in {"", ".", ".."}
            or part.lower() in forbidden
            or part.lower().startswith(".env")
            or part.lower().endswith((".pem", ".key", ".p12", ".pfx"))
            or part[-1] in ". "
            or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?", part)
        ):
            raise ValueError("Protected workspace path")
    path = root.joinpath(*parts)
    if os.name == "nt" and len(str(path)) > 240:
        raise ValueError("Output path exceeds the Windows workspace limit")
    for parent in [path, *path.parents]:
        if parent == root:
            break
        if parent.is_symlink() or (
            hasattr(parent, "is_junction") and parent.is_junction()
        ):
            raise ValueError("Linked paths are prohibited")
    if not path.resolve().is_relative_to(root):
        raise ValueError("Workspace escape rejected")
    return path


def git(args, *, timeout=30):
    hooks = DATA_ROOT / "disabled-git-hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "-c", f"core.hooksPath={hooks}", "-c", "core.fsmonitor=false", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"},
    )
    if result.returncode:
        raise ValueError("Git operation failed; check repository path and revision")
    return result.stdout.strip()


def disabled_filters(repository):
    config = git(["-C", str(repository), "config", "--null", "--list"])
    names = set()
    for entry in config.split("\0"):
        key = entry.split("\n", 1)[0]
        match = re.fullmatch(
            r"filter\.([a-zA-Z0-9_.-]+)\.(?:process|smudge|clean|required)", key
        )
        if match:
            names.add(match[1])
    return [
        value
        for name in names
        for option in ("process", "smudge", "clean", "required")
        for value in (
            "-c",
            f"filter.{name}.{option}={'false' if option == 'required' else ''}",
        )
    ]


def prepare_source(repository, workspace):
    destination = Path(workspace) / "source"
    if repository:
        revision = git(["-C", repository, "rev-parse", "HEAD"])
        git(
            [
                "-C",
                repository,
                *disabled_filters(repository),
                "worktree",
                "add",
                "--detach",
                str(destination),
                revision,
            ]
        )
        return {"kind": "git-worktree", "revision": revision}
    destination.mkdir(parents=True, exist_ok=False)
    return {"kind": "directory", "revision": None}


def files(root, limit=300):
    root = Path(root)
    result = []
    if not root.exists():
        return result
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [
            d
            for d in sorted(dirs)
            if d
            not in {".git", ".relay", "node_modules", "__pycache__", ".next", ".venv"}
            and not (Path(directory) / d).is_symlink()
            and not (
                hasattr(Path(directory) / d, "is_junction")
                and (Path(directory) / d).is_junction()
            )
        ]
        for name in sorted(names):
            relative = (Path(directory) / name).relative_to(root).as_posix()
            try:
                path = safe_path(root, relative)
            except ValueError:
                continue
            if path.is_file():
                result.append({"path": relative, "size": path.stat().st_size})
            if len(result) >= limit:
                return result
    return result


def file_context(root):
    result = []
    size = 0
    for entry in files(root, 100):
        if entry["size"] > 16000:
            continue
        path = safe_path(root, entry["path"])
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeError, OSError):
            continue
        size += len(content)
        if size > 64000:
            break
        result.append({"path": entry["path"], "content": content})
    return result


def write_files(root, outputs):
    total = sum(len(item["content"].encode()) for item in outputs)
    if len(outputs) > 30 or total > 1048576:
        raise ValueError("Generated file limit exceeded")
    validated = [(safe_path(root, item["path"]), item["content"]) for item in outputs]
    manifest = []
    for path, content in validated:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        manifest.append(
            {
                "path": path.relative_to(Path(root).resolve()).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    return manifest
