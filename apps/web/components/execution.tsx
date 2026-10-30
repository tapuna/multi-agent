"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Play,
  Square,
  RotateCcw,
  Check,
  X,
  Download,
  ChevronRight,
  Bot,
  FileCode2,
  GitBranch,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import { api } from "../lib/api";
import { RuntimeAdapterSetup } from "./runtime-adapters";
import { type WorkflowCatalog, suggestedAgent } from "./workflow-config";

type Agent = {
  id: string;
  name: string;
  role: string;
  runtime: string;
  model: string;
  enabled: boolean;
  runtime_available?: boolean;
};
type Step = {
  id: string;
  key: string;
  kind: string;
  agent_id: string;
  session_id: string;
  state: string;
  depends_on: string[];
  started_at: string | null;
  ended_at: string | null;
  provider_session_id?: string | null;
};
export type Run = {
  id: string;
  task_id: string;
  task_version: number;
  status: string;
  error: string | null;
  result_digest: string | null;
  workspace_path: string;
  agents: Record<string, Agent>;
  created_at: string;
  active_steps?: { key: string; agent_name: string }[];
  context_snapshot?: {
    source?: {
      kind: string;
      revision: string;
      repository_path?: string | null;
    };
  };
};
type Artifact = {
  id: string;
  stage: string;
  name: string;
  content: string;
  sha256: string;
  usage: Record<string, number>;
};
type Detail = {
  run: Run;
  steps: Step[];
  events: {
    sequence: number;
    kind: string;
    stage: string | null;
    payload: Record<string, unknown>;
    created_at: string;
  }[];
  artifacts: Artifact[];
  checkpoints: string[];
};
type Config = {
  enabled: boolean;
  allowed_models: string[];
  provider_credentials_configured: boolean;
  runtimes: { runtime: string; installed: boolean; note: string }[];
};
const terminal = new Set(["completed", "rejected", "cancelled"]);
const labels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting human review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  rejected: "Needs revision",
};

export function useProjectRuns(projectId: string) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    let alive = true;
    setRuns([]);
    async function load() {
      try {
        const data = await api<Run[]>(`workflows?project_id=${projectId}`);
        if (alive) setRuns(data);
      } catch {
        /* Main board connection errors are shown separately. */
      }
    }
    if (projectId) void load();
    const timer = setInterval(() => {
      if (projectId) void load();
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId]);
  return runs;
}

export function RunBadge({ run }: { run?: Run }) {
  return run ? (
    <span className={`run-badge ${run.status}`}>
      {labels[run.status] || run.status}
      {run.active_steps?.length
        ? ` · ${run.active_steps.map((s) => s.agent_name).join(", ")}`
        : ""}
    </span>
  ) : null;
}

export function WorkflowPanel({
  taskId,
  projectId,
  version,
  agents,
  onChange,
}: {
  taskId: string;
  projectId: string;
  version: number;
  agents: Agent[];
  onChange: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState("");
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [choice, setChoice] = useState("");
  const [taskVersion, setTaskVersion] = useState(version);
  useEffect(() => setTaskVersion(version), [version]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const usable = agents.filter(
    (a) => a.enabled && a.runtime_available !== false,
  );
  async function load() {
    const data = await api<Run[]>(`workflows?task_id=${taskId}`);
    setRuns(data);
    setSelected((current) => current || data[0]?.id || "");
  }
  useEffect(() => {
    setSelected("");
    setRuns([]);
    setCatalog(null);
    setChoice("");
    setError("");
    let alive = true;
    Promise.all([
      api<WorkflowCatalog>(`projects/${projectId}/workflow-templates`),
      api<{ selected_id: string | null }>(`tasks/${taskId}/workflow-config`),
    ])
      .then(([data, config]) => {
        if (alive) {
          setCatalog(data);
          setChoice(config.selected_id || "");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    api<Config>("execution/config")
      .then((data) => {
        if (alive) setConfig(data);
      })
      .catch((e) => setError(e.message));
    api<Run[]>(`workflows?task_id=${taskId}`)
      .then((data) => {
        if (alive) {
          setRuns(data);
          setSelected(data[0]?.id || "");
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [taskId, projectId]);
  const active = runs.some((r) => !terminal.has(r.status));
  const effectiveId =
    choice || catalog?.default_workflow_id || "builtin-standard";
  const template = catalog?.templates.find((t) => t.id === effectiveId);
  const definitions = template?.steps || [];
  async function chooseWorkflow(id: string) {
    setBusy(true);
    setError("");
    try {
      const task = await api<{ version: number }>(`tasks/${taskId}`, "PATCH", {
        version: taskVersion,
        workflow_template_id: id || null,
      });
      setChoice(id);
      setTaskVersion(task.version);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<Run>(`tasks/${taskId}/workflows`, "POST", {
        version: taskVersion,
        expected_workflow_id: template?.id,
        expected_workflow_version: template?.version,
        agent_overrides: Object.fromEntries(
          definitions.map((d) => [d.key, form.get(d.key)]),
        ),
      });
      setSelected(result.id);
      await load();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="detail-section">
      <h3>
        <Play size={13} style={{ display: "inline", marginRight: 6 }} />
        Agent workflow
      </h3>
      <p className="subtitle">
        Choose the agents before starting. Independent steps can run together.
        Completion waits for your review.
      </p>
      {!active && (
        <form onSubmit={start}>
          <label htmlFor="workflow-preset">Workflow</label>
          <select
            id="workflow-preset"
            value={choice}
            disabled={busy || !catalog}
            onChange={(e) => void chooseWorkflow(e.target.value)}
          >
            <option value="">
              Use default ·{" "}
              {catalog?.templates.find(
                (t) =>
                  t.id === (catalog.default_workflow_id || "builtin-standard"),
              )?.name || "Plan → Implement → Review"}
            </option>
            {catalog?.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · v{t.version}
              </option>
            ))}
          </select>
          <p className="subtitle">
            Effective: {template?.name || "Loading…"} ·{" "}
            {choice
              ? "task selection"
              : catalog?.default_workflow_id
                ? "project default"
                : "system default"}
            . Changes are saved for this task. Configure templates in
            Orchestration.
          </p>
          {definitions.map((d) => (
            <div key={`${effectiveId}-${template?.version}-${d.key}`}>
              <label htmlFor={`workflow-${d.key}`}>
                {d.key}{" "}
                {d.depends_on.length
                  ? `· after ${d.depends_on.join(", ")}`
                  : "· starts first"}
              </label>
              <select
                name={d.key}
                id={`workflow-${d.key}`}
                required
                defaultValue={suggestedAgent(usable, d)}
              >
                <option value="" disabled>
                  Select an agent
                </option>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.runtime} · {a.model}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <p className="subtitle">
            Skills come from each selected agent's configuration in Agent Studio
            and are frozen separately for this run.
          </p>
          {!usable.length && (
            <p className="subtitle">Register an agent in Agent studio first.</p>
          )}
          {config && !config.provider_credentials_configured && (
            <p className="subtitle">
              For API agents, configure credentials or a local endpoint. For CLI
              agents, sign in to their CLI first. See Configuration.
            </p>
          )}
          <button
            className="primary"
            disabled={
              busy || !template || !usable.length || config?.enabled === false
            }
            style={{ marginTop: 16 }}
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            Start workflow
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {runs.length > 0 && (
        <>
          <label htmlFor="task-run">Workflow history</label>
          <select
            id="task-run"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {runs.map((r) => (
              <option value={r.id} key={r.id}>
                {labels[r.status]} · {r.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </>
      )}
      {selected && (
        <RunView
          runId={selected}
          onChange={() => {
            void load();
            onChange();
          }}
        />
      )}
    </section>
  );
}

export function RunView({
  runId,
  onChange,
  workspace = false,
}: {
  runId: string;
  onChange?: () => void;
  workspace?: boolean;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [artifactId, setArtifactId] = useState("");
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;
  useEffect(() => {
    let alive = true;
    let previousStatus = "";
    setData(null);
    setArtifactId("");
    setError("");
    async function load() {
      try {
        const result = await api<Detail>(`workflows/${runId}`);
        if (alive) {
          setData(result);
          if (result.run.status !== previousStatus) {
            previousStatus = result.run.status;
            changeHandler.current?.();
          }
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runId]);
  async function action(name: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(`workflows/${runId}/${name}`, "POST", body);
      setData(await api<Detail>(`workflows/${runId}`));
      onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <p className="subtitle">{error || "Loading workflow…"}</p>;
  const run = data.run;
  const selected =
    data.artifacts.find((a) => a.id === artifactId) || data.artifacts[0];
  let output: {
    summary: string;
    files: { path: string; content: string }[];
  } | null = null;
  try {
    if (selected) output = JSON.parse(selected.content);
  } catch {
    /* Show raw content below. */
  }
  return (
    <div className="run-view">
      <div className="run-header">
        <RunBadge run={run} />
        <small>
          {run.id.slice(0, 8)} · v{run.task_version} · {data.checkpoints.length}{" "}
          checkpoints
        </small>
      </div>
      <div className="run-steps">
        {data.steps.map((s) => (
          <div className={`run-step ${s.state}`} key={s.id}>
            <span className="agent-icon">
              <Bot size={14} />
            </span>
            <div style={{ flex: 1 }}>
              <p>
                {s.key} <small>· {run.agents[s.key]?.name}</small>
              </p>
              <small>
                {s.state}
                {s.started_at
                  ? ` · started ${new Date(s.started_at).toLocaleTimeString()}`
                  : ""}
              </small>
              <p>
                <small>
                  Session {s.session_id.slice(0, 8)}
                  {s.provider_session_id
                    ? ` · provider ${s.provider_session_id}`
                    : " · persisted API conversation"}
                </small>
              </p>
            </div>
            {s.state === "completed" ? (
              <Check size={14} />
            ) : s.state === "running" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ChevronRight size={14} />
            )}
          </div>
        ))}
      </div>
      {run.error && (
        <p className="error" role="alert">
          {run.error}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="run-actions">
        {run.status === "completed" &&
          run.context_snapshot?.source?.kind === "git-worktree" &&
          !data.events.some((e) => e.kind === "workflow.merged") && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action("merge", {
                  digest: run.result_digest,
                  expected_revision: run.context_snapshot?.source?.revision,
                  message: `Integrate reviewed workflow ${run.id.slice(0, 8)}`,
                })
              }
            >
              <GitBranch size={13} />
              Merge reviewed changes locally
            </button>
          )}
        {["failed", "interrupted"].includes(run.status) && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void action("resume")}
          >
            <RotateCcw size={13} />
            Resume checkpoint
          </button>
        )}
        {!terminal.has(run.status) && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void action("cancel")}
          >
            <Square size={12} />
            Cancel workflow
          </button>
        )}
        {data.artifacts.length > 0 && (
          <a className="secondary" href={`/api/workflows/${runId}/export`}>
            <Download size={13} />
            Download ZIP
          </a>
        )}
      </div>
      {run.status === "awaiting_approval" && (
        <div className="approval-box">
          <ShieldCheck size={17} />
          <p>
            Review the generated files and agent findings. Approval completes
            this task; merging and deployment remain separate human actions.
          </p>
          <small>Artifact digest: {run.result_digest}</small>
          <div className="run-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void action("decision", {
                  approved: true,
                  digest: run.result_digest,
                })
              }
            >
              <Check size={13} />
              Approve & complete task
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action("decision", {
                  approved: false,
                  digest: run.result_digest,
                })
              }
            >
              <X size={13} />
              Needs revision
            </button>
          </div>
        </div>
      )}
      {selected && (
        <section className="detail-section">
          <h3>Agent artifacts</h3>
          <select
            aria-label="Select agent artifact"
            value={selected.id}
            onChange={(e) => setArtifactId(e.target.value)}
          >
            {data.artifacts.map((a) => (
              <option value={a.id} key={a.id}>
                {a.stage} · {a.name}
              </option>
            ))}
          </select>
          <pre className="artifact-text">
            {output?.summary || selected.content}
          </pre>
          {output?.files.map((file) => (
            <details className="artifact-file" key={file.path}>
              <summary>
                <FileCode2 size={13} /> {file.path}
              </summary>
              <pre className="code">{file.content}</pre>
            </details>
          ))}
          <small>SHA-256: {selected.sha256}</small>
        </section>
      )}
      {workspace && <WorkspaceBrowser runId={runId} />}
      <section className="detail-section">
        <h3>Live execution events</h3>
        <div className="event-stream">
          {data.events.slice(-80).map((event) => (
            <div className="execution-event" key={event.sequence}>
              <span>{new Date(event.created_at).toLocaleTimeString()}</span>
              <div>
                <p>
                  {event.kind}
                  {event.stage ? ` · ${event.stage}` : ""}
                </p>
                <small>
                  {String(
                    event.payload.agent_name ||
                      event.payload.message ||
                      event.payload.summary ||
                      event.payload.type ||
                      "",
                  )}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ExecutionCenter({
  projectId,
  workspace = false,
}: {
  projectId: string;
  workspace?: boolean;
}) {
  const runs = useProjectRuns(projectId);
  const [selected, setSelected] = useState("");
  const selection = runs.some((r) => r.id === selected)
    ? selected
    : runs[0]?.id;
  return (
    <div style={{ marginTop: 25 }}>
      <div className="execution-stats">
        {[
          ["Queued", runs.filter((r) => r.status === "queued").length],
          ["Running", runs.filter((r) => r.status === "running").length],
          [
            "Awaiting review",
            runs.filter((r) => r.status === "awaiting_approval").length,
          ],
          ["Completed", runs.filter((r) => r.status === "completed").length],
        ].map(([name, count]) => (
          <div className="stat" key={name}>
            <small>{name}</small>
            <p className="stat-value">{count}</p>
          </div>
        ))}
      </div>
      {!runs.length ? (
        <div className="welcome">
          <GitBranch size={28} style={{ margin: "auto" }} />
          <h2 style={{ marginTop: 15 }}>Ready for your first workflow</h2>
          <p>
            Open a task, choose its agents, and press Start workflow.
            Workspaces, events and artifacts will appear here.
          </p>
        </div>
      ) : (
        <div className="execution-layout">
          <div className="run-list">
            {runs.map((run) => (
              <button
                className={`run-list-item ${selection === run.id ? "selected" : ""}`}
                key={run.id}
                onClick={() => setSelected(run.id)}
              >
                <RunBadge run={run} />
                <p>
                  {run.id.slice(0, 8)} · task {run.task_id.slice(0, 8)}
                </p>
                <small>{new Date(run.created_at).toLocaleString()}</small>
              </button>
            ))}
          </div>
          <div className="execution-detail">
            {selection && <RunView runId={selection} workspace={workspace} />}
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkspaceBrowser({ runId }: { runId: string }) {
  const [listing, setListing] = useState<{ path: string; size: number }[]>([]);
  const [selected, setSelected] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api<{ path: string; size: number }[]>(`workflows/${runId}/files`)
      .then((data) => {
        if (alive) setListing(data);
      })
      .catch((e) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [runId]);
  async function open(path: string) {
    try {
      setSelected(
        await api(`workflows/${runId}/files?path=${encodeURIComponent(path)}`),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="detail-section">
      <h3>Isolated workspace files</h3>
      {error && <p className="error">{error}</p>}
      <div className="file-list">
        {listing.map((file) => (
          <button key={file.path} onClick={() => void open(file.path)}>
            <FileCode2 size={13} />
            {file.path}
            <small>{file.size} B</small>
          </button>
        ))}
      </div>
      {!listing.length && (
        <p className="subtitle">
          No source files yet. Implemented files appear after agent handoff.
        </p>
      )}
      {selected && (
        <>
          <p className="subtitle">{selected.path}</p>
          <pre className="artifact-text">{selected.content}</pre>
        </>
      )}
    </section>
  );
}

export function RuntimeSettings({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Config>("execution/config")
      .then(setConfig)
      .catch((e) => setMessage(e.message));
  }, []);
  async function repository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`projects/${projectId}/repository`, "PATCH", {
        repository_path:
          new FormData(event.currentTarget).get("repository_path") || null,
      });
      setMessage("Repository saved. New workflows use detached Git worktrees.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <RuntimeAdapterSetup />
      <div className="panel-card" style={{ marginTop: 20 }}>
        <h3>Provider configuration</h3>
        <p>
          CLI agents use their own login. API agents use server environment
          credentials; keys are never sent to the browser. For an
          OpenAI-compatible local endpoint, set LLM_API_BASE and LLM_API_KEY.
          Register the matching provider/model ID in Agent studio.
        </p>
        <pre
          className="code"
          style={{ marginTop: 15 }}
        >{`# .env (restart the app after editing)\n# OPENAI_API_KEY=... or ANTHROPIC_API_KEY=...\n# LLM_API_BASE=http://127.0.0.1:11434/v1\n# LLM_API_KEY=local\nAGENT_EXECUTION_ENABLED=1\n# Optional: CONTROL_ALLOWED_MODELS=provider/model`}</pre>
        <p style={{ marginTop: 12 }}>
          API credentials/endpoint:{" "}
          {config?.provider_credentials_configured
            ? "configured"
            : "not detected"}{" "}
          · Execution: {config?.enabled ? "enabled" : "disabled"}
        </p>
        <p style={{ marginTop: 10 }}>
          For Codex CLI, run <code>codex login</code> in your terminal before
          starting a workflow.
        </p>
      </div>
      {projectId && (
        <form
          className="panel-card"
          style={{ marginTop: 20 }}
          onSubmit={repository}
        >
          <h3>Project repository</h3>
          <p>
            Optional local Git repository. Each workflow creates a detached
            worktree. Without a repository, generated files are kept in an
            isolated directory.
          </p>
          <label htmlFor="repository-path">Absolute repository path</label>
          <input
            id="repository-path"
            name="repository_path"
            placeholder="D:\Projects\my-app"
          />
          <button className="primary" style={{ marginTop: 15 }} disabled={busy}>
            Save repository
          </button>
        </form>
      )}
      {message && (
        <p className="subtitle" role="status">
          {message}
        </p>
      )}
    </>
  );
}
