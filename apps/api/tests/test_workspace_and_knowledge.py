import hashlib
from unittest.mock import Mock
import pytest
from control.workspaces import safe_path, write_files, git, prepare_source
from control import routes_knowledge
from control.storage import archive_artifact


@pytest.mark.parametrize(
    "path",
    [
        "../escape.py",
        "/absolute.py",
        "C:/escape.py",
        "folder\\escape.py",
        ".git/config",
        ".env",
        "private.pem",
        "CON.txt",
        "a/../../escape",
        "a/file:stream",
    ],
)
def test_workspace_rejects_escapes_and_sensitive_paths(tmp_path, path):
    with pytest.raises(ValueError):
        safe_path(tmp_path, path)


def test_all_generated_paths_validate_before_any_write(tmp_path):
    with pytest.raises(ValueError):
        write_files(
            tmp_path,
            [
                {"path": "ok.py", "content": "safe"},
                {"path": "../bad.py", "content": "unsafe"},
            ],
        )
    assert not (tmp_path / "ok.py").exists()


def test_detached_worktree_keeps_repository_unchanged(tmp_path):
    repo = tmp_path / "repository"
    repo.mkdir()
    git(["init", str(repo)])
    (repo / "source.py").write_text("original")
    git(["-C", str(repo), "add", "source.py"])
    git(
        [
            "-C",
            str(repo),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "initial",
        ]
    )
    workspace = tmp_path / "run"
    workspace.mkdir()
    prepared = prepare_source(str(repo), workspace)
    assert prepared["kind"] == "git-worktree"
    write_files(
        workspace / "source", [{"path": "source.py", "content": "isolated change"}]
    )
    assert (repo / "source.py").read_text() == "original"
    assert git(["-C", str(repo), "status", "--porcelain"]) == ""


def test_skill_versions_are_standard_immutable_packages_and_audited(
    client, tmp_path, monkeypatch
):
    monkeypatch.setattr(routes_knowledge, "ROOT", tmp_path)
    body = {
        "name": "code-review",
        "version": "1.0.0",
        "description": "Review changes",
        "instructions": "Check correctness and report evidence.",
    }
    result = client.post("/api/skills", json=body)
    assert result.status_code == 201, result.text
    file = tmp_path / "skills/code-review/1.0.0/SKILL.md"
    assert file.is_file() and file.read_text().startswith("---\n")
    assert (
        result.json()["sha256"] == hashlib.sha256(file.read_text().encode()).hexdigest()
    )
    assert client.post("/api/skills", json=body).status_code == 409
    assert len(client.get("/api/skills").json()) == 1
    assert any(
        e["action"] == "skill.published" for e in client.get("/api/audit").json()
    )


def test_context_updates_require_human_and_matching_version(
    client, project, tmp_path, monkeypatch
):
    monkeypatch.setattr(routes_knowledge, "CONTEXT_ROOT", tmp_path)
    path = f"/api/contexts/project/{project['id']}"
    before = client.get(path).json()
    result = client.put(
        path,
        json={"content": "Project instructions", "previous_sha256": before["sha256"]},
    )
    assert result.status_code == 200
    assert (
        client.put(
            path, json={"content": "stale edit", "previous_sha256": before["sha256"]}
        ).status_code
        == 409
    )
    client.headers.pop("X-Human-Key")
    client.headers["X-API-Key"] = "test-agent"
    assert (
        client.put(
            path,
            json={"content": "override", "previous_sha256": result.json()["sha256"]},
        ).status_code
        == 403
    )
    assert client.get(path).json()["content"] == "Project instructions"


def test_s3_adapter_checksums_and_uses_private_objects(monkeypatch):
    monkeypatch.setenv("ARTIFACT_S3_BUCKET", "private-artifacts")
    monkeypatch.setenv("ARTIFACT_S3_ENDPOINT", "http://127.0.0.1:9000")
    import boto3

    client = Mock()
    monkeypatch.setattr(boto3, "client", lambda *a, **kw: client)
    content = '{"summary":"artifact"}'
    artifact = Mock(
        id="artifact-id",
        run_id="run-id",
        content=content,
        sha256=hashlib.sha256(content.encode()).hexdigest(),
    )
    result = archive_artifact(artifact)
    assert result["key"] == "runs/run-id/artifact-id.json"
    params = client.put_object.call_args.kwargs
    assert (
        params["Metadata"]["sha256"] == artifact.sha256
        and params["Body"] == content.encode()
    )
    assert "ACL" not in params
