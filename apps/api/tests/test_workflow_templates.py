from test_workflows import provider, steps  # noqa: F401


def create_template(client, project, specs=None):
    if specs is None:
        specs = steps(client)[1:]
        specs[0]["depends_on"] = []
    result = client.post(
        f"/api/projects/{project['id']}/workflow-templates",
        json={"name": "Bug fix", "description": "Skip planning", "steps": specs},
    )
    assert result.status_code == 201, result.text
    return result.json()


def test_task_project_system_precedence_and_persistence(client, project, task):
    url = f"/api/tasks/{task['id']}/workflow-config"
    config = client.get(url).json()
    assert config["source"] == "system"
    assert config["effective"]["id"] == "builtin-standard"
    template = create_template(client, project)
    default_url = f"/api/projects/{project['id']}/default-workflow"
    assert (
        client.patch(
            default_url, json={"version": 1, "workflow_template_id": template["id"]}
        ).status_code
        == 200
    )
    assert client.get(url).json()["effective"]["id"] == template["id"]
    changed = client.patch(
        f"/api/tasks/{task['id']}",
        json={"version": 1, "workflow_template_id": "builtin-parallel"},
    )
    assert changed.status_code == 200, changed.text
    assert client.get(url).json()["source"] == "task"
    assert client.get(url).json()["effective"]["id"] == "builtin-parallel"
    assert (
        client.patch(
            f"/api/tasks/{task['id']}",
            json={"version": 2, "workflow_template_id": None},
        ).status_code
        == 200
    )
    assert client.get(url).json()["effective"]["id"] == template["id"]
    assert (
        client.patch(
            default_url, json={"version": 2, "workflow_template_id": None}
        ).status_code
        == 200
    )
    assert client.get(url).json()["source"] == "system"
    assert (
        client.patch(
            default_url, json={"version": 1, "workflow_template_id": None}
        ).status_code
        == 409
    )


def test_actual_execution_uses_default_and_pins_definition(
    client, project, task, provider
):
    template = create_template(client, project)
    url = f"/api/projects/{project['id']}/workflow-templates/{template['id']}"
    client.patch(
        f"/api/projects/{project['id']}/default-workflow",
        json={"version": 1, "workflow_template_id": template["id"]},
    )
    result = client.post(f"/api/tasks/{task['id']}/workflows", json={"version": 1})
    assert result.status_code == 202, result.text
    run_id = result.json()["id"]
    assert [key for key, _ in provider.calls] == ["implement", "review"]
    snapshot_url = f"/api/workflows/{run_id}/context"
    before = client.get(snapshot_url).json()["workflow"]
    assert before["source"] == "project" and before["template"]["version"] == 1
    body = {
        "version": 1,
        "name": "Changed name",
        "description": "new version",
        "steps": template["steps"],
    }
    updated = client.put(url, json=body)
    assert updated.status_code == 200, updated.text
    assert updated.json()["version"] == 2
    assert client.get(snapshot_url).json()["workflow"] == before
    assert client.put(url, json=body).status_code == 409
    assert (
        client.patch(
            f"/api/tasks/{task['id']}",
            json={"version": 3, "workflow_template_id": "builtin-standard"},
        ).status_code
        == 409
    )
    assert (
        client.get(f"/api/workflows/{run_id}").json()["run"]["status"]
        == "awaiting_approval"
    )


def test_omitted_workflow_runs_system_default_and_keeps_human_gate(
    client, task, provider
):
    steps(client)
    result = client.post(f"/api/tasks/{task['id']}/workflows", json={"version": 1})
    assert result.status_code == 202, result.text
    assert [key for key, _ in provider.calls] == ["plan", "implement", "review"]
    detail = client.get(f"/api/workflows/{result.json()['id']}").json()
    assert detail["run"]["status"] == "awaiting_approval"
    assert (
        client.get(f"/api/workflows/{result.json()['id']}/context").json()["workflow"][
            "source"
        ]
        == "system"
    )


def test_scope_auth_and_invalid_graph_are_rejected(client, project, task):
    template = create_template(client, project)
    other = client.post("/api/projects", json={"name": "Other", "key": "OTHER"}).json()
    assert (
        client.patch(
            f"/api/projects/{other['id']}/default-workflow",
            json={"version": 1, "workflow_template_id": template["id"]},
        ).status_code
        == 422
    )
    other_template = create_template(client, other, template["steps"])
    assert (
        client.patch(
            f"/api/tasks/{task['id']}",
            json={"version": 1, "workflow_template_id": other_template["id"]},
        ).status_code
        == 422
    )
    url = f"/api/projects/{project['id']}/workflow-templates"
    assert (
        client.post(
            url,
            headers={"X-Human-Key": "", "X-API-Key": "test-agent"},
            json={"name": "Forbidden", "steps": template["steps"]},
        ).status_code
        == 403
    )
    for specs in [
        [{"key": "a", "kind": "review", "depends_on": ["missing"]}],
        [
            {"key": "a", "kind": "review", "depends_on": ["b"]},
            {"key": "b", "kind": "test", "depends_on": ["a"]},
        ],
        [{"key": "a", "kind": "review"}, {"key": "a", "kind": "test"}],
        [{"key": "human_review", "kind": "review"}],
    ]:
        assert (
            client.post(url, json={"name": "Invalid", "steps": specs}).status_code
            == 422
        )
    actions = {item["action"] for item in client.get("/api/audit").json()}
    assert "workflow_template.created" in actions


def test_task_override_and_stale_definition_guard(client, project, task, provider):
    selected = steps(client)
    agent_id = selected[0]["agent_id"]
    assert (
        client.patch(
            f"/api/tasks/{task['id']}",
            json={"version": 1, "workflow_template_id": "builtin-direct"},
        ).status_code
        == 200
    )
    url = f"/api/tasks/{task['id']}/workflows"
    assert (
        client.post(
            url, json={"version": 2, "expected_workflow_id": "builtin-standard"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            url, json={"version": 2, "agent_overrides": {"missing": agent_id}}
        ).status_code
        == 422
    )
    result = client.post(
        url,
        json={
            "version": 2,
            "agent_overrides": {"implement": agent_id, "review": agent_id},
            "expected_workflow_id": "builtin-direct",
            "expected_workflow_version": 1,
        },
    )
    assert result.status_code == 202, result.text
    assert [key for key, _ in provider.calls] == ["implement", "review"]
