"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Columns3,
  FileCode2,
  FolderGit2,
  GitBranch,
  LayoutDashboard,
  List,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import {
  WorkflowPanel,
  ExecutionCenter,
  RuntimeSettings,
  RunBadge,
  useProjectRuns,
} from "../components/execution";
import { WorkflowDesigner } from "../components/workflow-config";
import { SkillRegistry, ContextEditor } from "../components/knowledge";
import { AgentChat } from "../components/agent-chat";
import { AgentSkills } from "../components/agent-skills";
import { useRuntimeAdapters } from "../components/runtime-adapters";
import { useLLMProfiles } from "../components/llm-profiles";
import {
  AgentReadiness,
  useAgentDiagnostics,
} from "../components/agent-diagnostics";

type Project = { id: string; name: string; key: string; description: string };
type Agent = {
  id: string;
  name: string;
  role: string;
  runtime: string;
  model: string;
  enabled: boolean;
  skill_refs: string[];
};
type Task = {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  sprint: string | null;
  version: number;
  updated_at: string;
};
type Event = {
  id: string;
  task_id: string | null;
  actor: string;
  action: string;
  payload: Record<string, unknown>;
  created_at: string;
};
type Session = {
  id: string;
  agent_id: string;
  provider_session_id: string | null;
  workspace_path: string;
  state: string;
};
type Detail = {
  task: Task;
  dependencies: string[];
  events: Event[];
  sessions: Session[];
  approvals: {
    id: string;
    kind: string;
    actor: string;
    task_version: number;
  }[];
};
const statuses = [
  { id: "backlog", name: "Backlog" },
  { id: "todo", name: "To do" },
  { id: "in_progress", name: "In progress" },
  { id: "review", name: "In review" },
  { id: "done", name: "Done" },
];
const navigation = [
  { name: "Task board", icon: Columns3 },
  { name: "Agent studio", icon: Bot },
  { name: "Context hub", icon: Boxes },
  { name: "Skill registry", icon: BookOpen },
  { name: "Workspaces", icon: FolderGit2 },
  { name: "Orchestration", icon: Workflow },
  { name: "Execution monitor", icon: Activity },
  { name: "Audit trail", icon: ShieldCheck },
];
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Check the submitted fields and try again.",
    );
  return data;
}
function shortTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Home() {
  const [page, setPage] = useState("Task board");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [databaseLabel, setDatabaseLabel] = useState("Connecting…");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("all");
  const [view, setView] = useState("board");
  const [modal, setModal] = useState<"project" | "task" | "agent" | null>(null);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [chatAgentId, setChatAgentId] = useState("");
  const [skillAgentId, setSkillAgentId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [memories, setMemories] = useState<{ id: string; content: string }[]>(
    [],
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const project = projects.find((p) => p.id === projectId);
  const projectRuns = useProjectRuns(projectId);
  const runtimeAdapters = useRuntimeAdapters();
  const llmProfiles = useLLMProfiles();
  const [agentRuntime, setAgentRuntime] = useState("");
  const readiness = useAgentDiagnostics(page === "Agent studio");
  function agentReady(a: Agent) {
    return (
      runtimeAdapters.some((r) => r.runtime === a.runtime && r.available) &&
      (!llmProfiles.length ||
        llmProfiles.some((p) => p.reference === a.model && p.available))
    );
  }
  const unavailableAgents = agents.filter((a) => !agentReady(a));
  const load = useCallback(async () => {
    try {
      const [ps, as, system] = await Promise.all([
        api<Project[]>("projects"),
        api<Agent[]>("agents"),
        api<{ database: string; database_mode: string }>("system"),
      ]);
      setDatabaseLabel(
        system.database === "firebird"
          ? `Firebird ${system.database_mode === "embedded" ? "Embedded" : "Server"}`
          : system.database,
      );
      setProjects(ps);
      setAgents(as);
      setProjectId((current) => current || ps[0]?.id || "");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const loadTasks = useCallback(async () => {
    if (!projectId) return;
    try {
      setTasks(await api<Task[]>(`tasks?project_id=${projectId}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);
  const hasActiveWorkflow = projectRuns.some(
    (r) => !["completed", "cancelled", "rejected"].includes(r.status),
  );
  useEffect(() => {
    if (!projectId) return;
    void loadTasks();
    if (!hasActiveWorkflow) return;
    const timer = setInterval(() => void loadTasks(), 3000);
    return () => clearInterval(timer);
  }, [projectId, hasActiveWorkflow, loadTasks]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setTasks([]);
    void loadTasks();
  }, [loadTasks]);
  useEffect(() => {
    if (page === "Audit trail")
      api<Event[]>("audit")
        .then(setEvents)
        .catch((e) => setError(e.message));
    if (page === "Context hub" && projectId)
      api<{ id: string; content: string }[]>(`projects/${projectId}/memory`)
        .then(setMemories)
        .catch((e) => setError(e.message));
  }, [page, projectId]);
  useEffect(() => {
    if (!modal && !detail) return;
    const previous = document.activeElement as HTMLElement;
    const el = dialogRef.current;
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(null);
        setDetail(null);
      }
      if (e.key === "Tab" && el) {
        const focusable = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button,input,select,textarea,[tabindex="0"]',
          ),
        ).filter((x) => !x.hasAttribute("disabled"));
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [modal, detail?.task.id]);
  async function openTask(task: Task) {
    setFormError("");
    setNotice("");
    try {
      setDetail(await api<Detail>(`tasks/${task.id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function openModal(kind: "project" | "task" | "agent") {
    setAgentRuntime("");
    setEditingAgent(null);
    setModal(kind);
    setDetail(null);
    setFormError("");
    setNotice("");
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setFormError("");
    try {
      if (modal === "project") {
        const p = await api<Project>("projects", "POST", {
          name: f.get("name"),
          key: String(f.get("key")).toUpperCase(),
          description: f.get("description"),
        });
        await load();
        setProjectId(p.id);
      }
      if (modal === "task") {
        await api("tasks", "POST", {
          project_id: projectId,
          title: f.get("title"),
          description: f.get("description"),
          priority: f.get("priority"),
          assignee_id: f.get("assignee_id") || null,
          sprint: f.get("sprint") || null,
        });
        await loadTasks();
      }
      if (modal === "agent") {
        if (
          !runtimeAdapters.some(
            (r) => r.runtime === f.get("runtime") && r.available,
          )
        )
          throw new Error(
            "Select an available runtime adapter. Set up and verify it in Configuration first.",
          );
        if (
          llmProfiles.length &&
          !llmProfiles.some(
            (p) => p.reference === f.get("model") && p.available,
          )
        )
          throw new Error(
            "Test this LLM profile in Setup before configuring the agent.",
          );
        await api(
          editingAgent ? `agents/${editingAgent.id}` : "agents",
          editingAgent ? "PATCH" : "POST",
          {
            name: f.get("name"),
            role: f.get("role"),
            runtime: f.get("runtime"),
            model: f.get("model"),
          },
        );
        await load();
      }
      setModal(null);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setFormError("");
    setNotice("");
    try {
      await api(`tasks/${detail.task.id}`, "PATCH", {
        version: detail.task.version,
        title: f.get("title"),
        description: f.get("description"),
        status: f.get("status"),
        priority: f.get("priority"),
        assignee_id: f.get("assignee_id") || null,
        sprint: f.get("sprint") || null,
      });
      await openTask(detail.task);
      await loadTasks();
      setNotice("Task saved. Audit event recorded.");
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function detailAction(path: string, body: unknown, message: string) {
    if (!detail) return;
    setBusy(true);
    setFormError("");
    try {
      await api(path, "POST", body);
      await openTask(detail.task);
      await loadTasks();
      setNotice(message);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = tasks.filter(
    (t) =>
      `${project?.key}-${t.number} ${t.title} ${t.sprint || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (priority === "all" || t.priority === priority),
  );
  const active = tasks.filter((t) => t.status === "in_progress").length;
  const completed = tasks.filter((t) => t.status === "done").length;
  const reviewed = tasks.filter((t) => t.status === "review").length;
  const agentName = (id: string | null) =>
    agents.find((a) => a.id === id)?.name || "Unassigned";
  const title = page === "Task board" ? "Engineering, in motion." : page;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Workflow size={21} />
          </div>
          <span className="brand-text">
            relay<span style={{ color: "#88917f" }}> /</span>
          </span>
        </div>
        <div className="org">
          <div
            className="avatar"
            style={{ background: "#34352c", color: "#d1d6b2" }}
          >
            EC
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 11 }}>Engineering</p>
            <small>Control center</small>
          </div>
          <ChevronDown size={13} />
        </div>
        <p className="section-label">Workspace</p>
        <nav aria-label="Main navigation">
          {navigation.map((n) => (
            <button
              key={n.name}
              className={`nav ${page === n.name ? "active" : ""}`}
              onClick={() => {
                setPage(n.name);
                setError("");
              }}
              title={n.name}
            >
              <n.icon size={16} />
              <span>{n.name}</span>
              {n.name === "Task board" && (
                <span style={{ marginLeft: "auto", fontSize: 10 }}>
                  {tasks.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="system">
            <p>
              <span className="dot" />
              Local engineering workspace
            </p>
            <p style={{ marginTop: 8, color: "#6f7a8b", fontSize: 10 }}>
              Human oversight enabled
            </p>
          </div>
          <button className="nav" onClick={() => setPage("Setup")}>
            <Settings2 size={16} />
            <span>Configuration</span>
          </button>
          <button className="nav" onClick={() => setPage("Guide")}>
            <CircleHelp size={16} />
            <span>Quick guide</span>
          </button>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "18px 12px 0",
              borderTop: "1px solid #292d35",
              marginTop: 15,
            }}
          >
            <div
              className="avatar"
              style={{ background: "#403a32", color: "#e9caaa" }}
            >
              OP
            </div>
            <div>
              <p style={{ fontSize: 11 }}>Local operator</p>
              <small>Human administrator</small>
            </div>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            Workspace <ChevronRight size={13} />
            <select
              aria-label="Current project"
              className="project-select"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setDetail(null);
              }}
            >
              {!projects.length && <option value="">No projects yet</option>}
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronRight size={13} />
            <span>{page}</span>
          </div>
          <div className="top-right">
            <span>
              <span className="dot" />
              {error ? "Connection issue" : databaseLabel}
            </span>
            <button
              className="icon-button"
              aria-label="Create project"
              title="Create project"
              onClick={() => openModal("project")}
            >
              <Plus size={17} />
            </button>
          </div>
        </header>
        <div className="content">
          {unavailableAgents.length > 0 && (
            <div className="error" role="alert" style={{ marginBottom: 16 }}>
              Agent runtime/LLM unavailable:{" "}
              {unavailableAgents.map((a) => a.name).join(", ")}. These agents
              cannot execute. Open Configuration to test their LLM profiles and
              adapters.
            </div>
          )}
          <div className="eyebrow">Multi-agent engineering platform</div>
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p className="subtitle">
                {page === "Task board"
                  ? "One shared plan. Every agent aligned. Every action accounted for."
                  : page === "Agent studio"
                    ? "Specialized roles. Configurable models. Persistent task sessions."
                    : page === "Audit trail"
                      ? "A durable record of every decision and task change."
                      : "Your engineering workspace, connected."}
              </p>
            </div>
            <button
              className="primary"
              onClick={() =>
                openModal(
                  page === "Agent studio"
                    ? "agent"
                    : projectId
                      ? "task"
                      : "project",
                )
              }
            >
              <Plus size={15} />
              {page === "Agent studio"
                ? "Register agent"
                : projectId
                  ? "Create task"
                  : "Create project"}
            </button>
          </div>
          {error && (
            <div role="alert" className="banner">
              {error}{" "}
              <button
                onClick={() => {
                  void load();
                  void loadTasks();
                }}
                style={{ textDecoration: "underline", marginLeft: 10 }}
              >
                Retry connection
              </button>
            </div>
          )}
          {page === "Task board" && (
            <>
              <div className="stats">
                {[
                  {
                    label: "Total tasks",
                    value: tasks.length,
                    note: "Your single source of truth",
                    icon: LayoutDashboard,
                  },
                  {
                    label: "In progress",
                    value: active,
                    note: "Work moving forward",
                    icon: Zap,
                  },
                  {
                    label: "Awaiting review",
                    value: reviewed,
                    note: "Ready for human oversight",
                    icon: GitBranch,
                  },
                  {
                    label: "Completed",
                    value: completed,
                    note: tasks.length
                      ? `${Math.round((completed / tasks.length) * 100)}% of project tasks`
                      : "Start with your first task",
                    icon: Check,
                  },
                ].map((s) => (
                  <div key={s.label} className="stat">
                    <div className="stat-top">
                      {s.label}
                      <s.icon size={15} />
                    </div>
                    <p className="stat-value">
                      {s.value}
                      <span
                        style={{
                          color: "#515d4a",
                          fontSize: 12,
                          marginLeft: 8,
                        }}
                      >
                        {s.label === "Completed" ? "↗" : ""}
                      </span>
                    </p>
                    <p className="stat-note">{s.note}</p>
                  </div>
                ))}
              </div>
              <div className="toolbar">
                <div className="tabs">
                  <button
                    className={`tab ${view === "board" ? "selected" : ""}`}
                    onClick={() => setView("board")}
                  >
                    <Columns3 size={14} />
                    Board
                  </button>
                  <button
                    className={`tab ${view === "list" ? "selected" : ""}`}
                    onClick={() => setView("list")}
                  >
                    <List size={14} />
                    List
                  </button>
                  <span
                    className="tab"
                    style={{ fontSize: 10, color: "#667180" }}
                  >
                    {project?.key || "PROJECT"} / ALL TASKS
                  </span>
                </div>
                <div className="filters">
                  <div className="search">
                    <Search size={13} />
                    <input
                      aria-label="Search tasks"
                      placeholder="Search tasks or sprint…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="Filter by priority"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  >
                    <option value="all">All priorities</option>
                    {["urgent", "high", "medium", "low"].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                  <button
                    className="secondary"
                    title="Create project"
                    onClick={() => openModal("project")}
                  >
                    <Plus size={13} />
                    Project
                  </button>
                </div>
              </div>
              {loading ? (
                <p className="empty">Connecting to your workspace…</p>
              ) : !projects.length ? (
                <div className="welcome">
                  <Sparkles
                    size={28}
                    style={{ margin: "auto", color: "var(--lime)" }}
                  />
                  <h2 style={{ marginTop: 20 }}>
                    Make room for your next big idea.
                  </h2>
                  <p>
                    Create a project to start organizing tasks and collaborating
                    with agents.
                  </p>
                  <button
                    className="primary"
                    onClick={() => openModal("project")}
                  >
                    <Plus size={14} />
                    Create your first project
                  </button>
                </div>
              ) : view === "board" ? (
                <div className="board">
                  {statuses.map((s) => (
                    <section
                      key={s.id}
                      className={`column ${s.id}`}
                      aria-label={s.name}
                    >
                      <div className="column-head">
                        <span className="status-dot" />
                        {s.name}
                        <span className="count">
                          {filtered.filter((t) => t.status === s.id).length}
                        </span>
                        <button
                          title="Create a backlog task"
                          aria-label={`Create task from ${s.name}`}
                          onClick={() => openModal("task")}
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                      {filtered
                        .filter((t) => t.status === s.id)
                        .map((t) => (
                          <button
                            key={t.id}
                            className="card"
                            onClick={() => void openTask(t)}
                          >
                            <div className="card-id">
                              <span>
                                {project?.key}-
                                {String(t.number).padStart(3, "0")}
                              </span>
                              <span>···</span>
                            </div>
                            <p className="card-title">{t.title}</p>
                            <span className={`tag ${t.priority}`}>
                              <span>≋</span>
                              {t.priority}
                            </span>
                            {t.sprint && (
                              <span className="tag" style={{ marginLeft: 5 }}>
                                {t.sprint}
                              </span>
                            )}
                            <div className="card-footer">
                              <span className="agent-mini">
                                <span className="agent-icon">
                                  <Bot size={12} />
                                </span>
                                {agentName(t.assignee_id)}
                              </span>
                              <ArrowUpRight size={12} />
                            </div>
                            <RunBadge
                              run={projectRuns.find((r) => r.task_id === t.id)}
                            />
                          </button>
                        ))}
                      {!filtered.some((t) => t.status === s.id) && (
                        <p className="empty">
                          {search || priority !== "all"
                            ? "No matching tasks"
                            : "No tasks here yet"}
                        </p>
                      )}
                      <button
                        className="add-task"
                        onClick={() => openModal("task")}
                      >
                        <Plus size={12} />
                        Add task
                      </button>
                    </section>
                  ))}
                </div>
              ) : (
                <table className="list-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Status</th>
                      <th>Priority</th>
                      <th>Assigned to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <button
                            style={{ textAlign: "left" }}
                            onClick={() => void openTask(t)}
                          >
                            <small>
                              {project?.key}-{t.number}
                            </small>{" "}
                            &nbsp; {t.title}
                          </button>
                        </td>
                        <td>{statuses.find((s) => s.id === t.status)?.name}</td>
                        <td>{t.priority}</td>
                        <td>{agentName(t.assignee_id)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="footer-note">
                <span>
                  <ShieldCheck
                    size={11}
                    style={{ display: "inline", marginRight: 6 }}
                  />
                  All changes are recorded in your audit trail.
                </span>
                <span>Human approval required for merge & deployment</span>
              </div>
            </>
          )}
          {page === "Agent studio" && (
            <>
              {agents.find((a) => a.id === skillAgentId) && (
                <AgentSkills
                  agent={agents.find((a) => a.id === skillAgentId)!}
                  onClose={() => setSkillAgentId("")}
                  onChange={() => void load()}
                />
              )}
              {projectId && agents.find((a) => a.id === chatAgentId) && (
                <AgentChat
                  projectId={projectId}
                  agent={agents.find((a) => a.id === chatAgentId)!}
                  onClose={() => setChatAgentId("")}
                />
              )}
              <div className="panel-grid">
                {agents.map((a) => (
                  <article className="panel-card" key={a.id}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <div
                        className="agent-icon"
                        style={{ width: 36, height: 36 }}
                      >
                        <Bot size={21} />
                      </div>
                      <span className="tag">{a.runtime}</span>
                    </div>
                    <h3>{a.name}</h3>
                    {!agentReady(a) && (
                      <p className="error" role="status">
                        {llmProfiles.find((p) => p.reference === a.model)
                          ?.reason ||
                          (llmProfiles.length
                            ? "Choose and test this agent's LLM profile in Setup"
                            : runtimeAdapters.find(
                                (r) => r.runtime === a.runtime,
                              )?.reason || "Runtime registry unavailable")}
                      </p>
                    )}
                    <p>{a.role}</p>
                    <p className="code" style={{ marginTop: 15 }}>
                      {llmProfiles.find((p) => p.reference === a.model)
                        ?.label || a.model}
                    </p>
                    {a.model.startsWith("profile:") && (
                      <small>
                        {llmProfiles.find((p) => p.reference === a.model)
                          ?.model || "LLM profile not found"}
                      </small>
                    )}
                    {a.model.startsWith("profile:") &&
                      !llmProfiles.some(
                        (p) => p.reference === a.model && p.available,
                      ) && (
                        <p className="error" role="status">
                          LLM profile not ready. Test this profile in Setup
                          first.
                        </p>
                      )}
                    <p style={{ marginTop: 14, fontSize: 10 }}>
                      {a.enabled ? "Agent enabled" : "Agent disabled"} ·{" "}
                      {agentReady(a)
                        ? "Runtime available"
                        : "Runtime unavailable"}
                    </p>
                    <button
                      className="secondary"
                      style={{ marginTop: 12 }}
                      onClick={() => {
                        openModal("agent");
                        setEditingAgent(a);
                        setAgentRuntime(a.runtime);
                      }}
                    >
                      Edit configuration
                    </button>
                    <button
                      className="secondary"
                      style={{ marginTop: 12, marginLeft: 8 }}
                      onClick={() => {
                        setSkillAgentId(a.id);
                        setChatAgentId("");
                      }}
                    >
                      <BookOpen size={14} />
                      Skills · {a.skill_refs?.length || 0}
                    </button>
                    <button
                      className="primary"
                      style={{ marginTop: 12, marginLeft: 8 }}
                      disabled={!projectId}
                      onClick={() => {
                        setChatAgentId(a.id);
                        setSkillAgentId("");
                      }}
                    >
                      <MessageSquare size={14} />
                      Chat & context
                    </button>
                    <AgentReadiness
                      agentName={a.name}
                      row={readiness.rows.find((row) => row.agent.id === a.id)}
                      pending={readiness.pending.includes(a.id)}
                      error={readiness.error}
                      onTest={() => void readiness.test(a.id)}
                    />
                  </article>
                ))}
              </div>
              {!agents.length && (
                <div className="welcome">
                  <Bot size={30} style={{ margin: "auto" }} />
                  <h2 style={{ marginTop: 20 }}>Your team starts here.</h2>
                  <p>
                    Register a role, runtime, and model, then assign it to a
                    task.
                  </p>
                  <button
                    className="primary"
                    onClick={() => openModal("agent")}
                  >
                    Register agent
                  </button>
                </div>
              )}
              <div className="banner">
                Runtime interfaces support Codex CLI, Claude Code, Gemini CLI
                and API agents. Configure a real model and provider
                authentication before starting a workflow.
              </div>
            </>
          )}
          {page === "Audit trail" && (
            <div style={{ marginTop: 30 }}>
              {events.length ? (
                events.map((e) => (
                  <div key={e.id} className="event">
                    <p>
                      {e.action}{" "}
                      <span style={{ color: "#78816f" }}>· {e.actor}</span>
                    </p>
                    <small>
                      {shortTime(e.created_at)} ·{" "}
                      {e.task_id?.slice(0, 8) || "Workspace"}
                    </small>
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ color: "#98a68a", cursor: "pointer" }}>
                        Event payload
                      </summary>
                      <pre className="code">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </details>
                  </div>
                ))
              ) : (
                <p className="empty">
                  No recorded events yet. Create a project or task to begin.
                </p>
              )}
            </div>
          )}
          {page === "Context hub" && (
            <>
              <ContextEditor projectId={projectId} tasks={tasks} />
              <div className="panel-grid">
                {["Company", "Team", "Project", "Role", "Task"].map(
                  (layer, i) => (
                    <article className="panel-card" key={layer}>
                      <small>0{i + 1} / CONTEXT LAYER</small>
                      <h3>{layer}</h3>
                      <p>
                        {i === 0
                          ? "Mandatory policy envelope. Lower-level instructions cannot replace it."
                          : "Directory scaffold ready for versioned context packages."}
                      </p>
                      <span className="tag" style={{ marginTop: 14 }}>
                        {i === 0 ? "Protected policy" : "Scaffold"}
                      </span>
                    </article>
                  ),
                )}
              </div>
              <section className="detail-section">
                <h3>Project shared memory</h3>
                {memories.map((m) => (
                  <p
                    key={m.id}
                    className="panel-card"
                    style={{ marginBottom: 8 }}
                  >
                    {m.content}
                  </p>
                ))}
                {projectId ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const form = e.currentTarget;
                      const content = new FormData(form).get("content");
                      setBusy(true);
                      try {
                        await api(`projects/${projectId}/memory`, "POST", {
                          content,
                        });
                        setMemories(await api(`projects/${projectId}/memory`));
                        form.reset();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <label htmlFor="memory">
                      Add durable project knowledge
                    </label>
                    <textarea
                      id="memory"
                      name="content"
                      required
                      maxLength={20000}
                    />
                    <button
                      className="primary"
                      style={{ marginTop: 12 }}
                      disabled={busy}
                    >
                      Save memory
                    </button>
                  </form>
                ) : (
                  <p className="empty">
                    Create a project to add shared memory.
                  </p>
                )}
              </section>
            </>
          )}
          {page === "Skill registry" && <SkillRegistry />}
          {page === "Orchestration" && (
            <WorkflowDesigner projectId={projectId} agents={agents} />
          )}
          {["Orchestration", "Execution monitor", "Workspaces"].includes(
            page,
          ) && (
            <ExecutionCenter
              projectId={projectId}
              workspace={page === "Workspaces"}
            />
          )}
          {page === "Setup" && <RuntimeSettings projectId={projectId} />}
          {["Guide"].includes(page) && (
            <div className="panel-grid">
              <article className="panel-card">
                <Terminal size={25} style={{ color: "var(--lime)" }} />
                <h3>
                  {page === "Workspaces"
                    ? "Task-isolated workspaces"
                    : page === "Orchestration"
                      ? "Orchestration foundation"
                      : page === "Execution monitor"
                        ? "Execution is not enabled"
                        : page === "Setup"
                          ? "Local configuration"
                          : "From plan to reviewed work"}
                </h3>
                <p>
                  {page === "Workspaces"
                    ? "Open a task and prepare a session to allocate a unique workspace directory. Git worktree provisioning and a file explorer follow in Phase 2."
                    : page === "Orchestration"
                      ? "LangGraph and LiteLLM dependencies are included. Execution graphs, parallel runs, handoffs and checkpoints follow in Phase 2."
                      : page === "Execution monitor"
                        ? "Follow agent activity, runtime events and artifacts in Execution monitor."
                        : page === "Setup"
                          ? "Firebird Embedded stores project data locally without a database service or Docker. API credentials stay on the application server. This local UI has operator authority; production requires identity and RBAC."
                          : "Create a project, configure agents and authentication, then open a task and press Start workflow. Follow the agents and handoffs in Execution monitor. Review generated files before approving completion. Independent stages can run in parallel and interrupted runs resume from Firebird checkpoints."}
                </p>
              </article>
              <article className="panel-card">
                <ShieldCheck size={25} style={{ color: "var(--lime)" }} />
                <h3>Human control, by design</h3>
                <p>
                  Task completion requires human credentials. Merge and
                  deployment approvals are tied to an exact task version.
                  Generated changes stay in an isolated workspace for human
                  integration.
                </p>
              </article>
            </div>
          )}
        </div>
      </main>
      {(modal || detail) && (
        <div
          className="modal-bg"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setModal(null);
              setDetail(null);
            }
          }}
        >
          <div
            className="modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            tabIndex={-1}
          >
            <div className="modal-head">
              <div>
                <small>
                  {detail
                    ? `${project?.key}-${String(detail.task.number).padStart(3, "0")} · VERSION ${detail.task.version}`
                    : "WORKSPACE"}
                </small>
                <h2 id="dialog-title" style={{ marginTop: 7 }}>
                  {detail
                    ? "Task details"
                    : modal === "project"
                      ? "Create a project"
                      : modal === "agent"
                        ? editingAgent
                          ? "Edit agent"
                          : "Register an agent"
                        : "Create a task"}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close dialog"
                onClick={() => {
                  setModal(null);
                  setDetail(null);
                }}
              >
                <X size={20} />
              </button>
            </div>
            {modal && (
              <form onSubmit={submit}>
                {modal === "project" ? (
                  <>
                    <label htmlFor="name">Project name</label>
                    <input
                      id="name"
                      name="name"
                      required
                      maxLength={100}
                      placeholder="e.g. Platform engineering"
                    />
                    <label htmlFor="key">Project key</label>
                    <input
                      id="key"
                      name="key"
                      required
                      minLength={2}
                      maxLength={10}
                      pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                      placeholder="PLAT"
                    />
                    <label htmlFor="description">Description</label>
                    <textarea
                      id="description"
                      name="description"
                      maxLength={10000}
                      placeholder="What are we building?"
                    />
                  </>
                ) : modal === "agent" ? (
                  <>
                    <label htmlFor="name">Agent name</label>
                    <input
                      id="name"
                      name="name"
                      required
                      maxLength={100}
                      placeholder="e.g. Platform engineer"
                      defaultValue={editingAgent?.name}
                    />
                    <label htmlFor="role">Role</label>
                    <input
                      id="role"
                      name="role"
                      required
                      maxLength={100}
                      placeholder="e.g. Backend engineering"
                      defaultValue={editingAgent?.role}
                    />
                    <label htmlFor="runtime">Runtime adapter</label>
                    <select
                      id="runtime"
                      name="runtime"
                      required
                      defaultValue={editingAgent?.runtime || ""}
                      onChange={(e) => setAgentRuntime(e.target.value)}
                    >
                      <option value="" disabled>
                        Select an available adapter
                      </option>
                      {runtimeAdapters.map((r) => (
                        <option
                          key={r.runtime}
                          value={r.runtime}
                          disabled={!r.available}
                        >
                          {r.runtime.toUpperCase()} ·{" "}
                          {r.available ? "Available" : r.reason}
                        </option>
                      ))}
                    </select>
                    <small>
                      Only adapters enabled and verified in Configuration can be
                      selected. Existing unavailable bindings must be fixed
                      before saving.
                    </small>
                    <label htmlFor="model">
                      {llmProfiles.length
                        ? "LLM profile"
                        : "Provider model identifier"}
                    </label>
                    {llmProfiles.length > 0 ? (
                      <select
                        key={agentRuntime}
                        id="model"
                        name="model"
                        required
                        defaultValue={editingAgent?.model || ""}
                      >
                        <option value="" disabled>
                          Select LLM profile
                        </option>
                        {editingAgent?.model &&
                          !llmProfiles.some(
                            (p) => p.reference === editingAgent.model,
                          ) && (
                            <option value={editingAgent.model} disabled>
                              {editingAgent.model} · select configured profile
                            </option>
                          )}
                        {llmProfiles
                          .filter(
                            (p) =>
                              p.runtime ===
                              (agentRuntime || editingAgent?.runtime),
                          )
                          .map((p) => (
                            <option
                              key={p.id}
                              value={p.reference}
                              disabled={!p.available}
                            >
                              {p.label} · {p.model}
                              {!p.available ? ` · ${p.reason}` : " · Ready"}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <input
                        id="model"
                        name="model"
                        required
                        maxLength={150}
                        placeholder="Enter your configured model ID"
                        defaultValue={editingAgent?.model}
                      />
                    )}
                  </>
                ) : (
                  <TaskFields agents={agents} />
                )}
                {formError && (
                  <p className="error" role="alert">
                    {formError}
                  </p>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button className="primary" disabled={busy}>
                    {busy ? (
                      <Loader2 className="animate-spin" size={14} />
                    ) : (
                      <Plus size={14} />
                    )}{" "}
                    {modal === "project"
                      ? "Create project"
                      : modal === "agent"
                        ? editingAgent
                          ? "Save agent"
                          : "Register agent"
                        : "Create task"}
                  </button>
                </div>
              </form>
            )}
            {detail && (
              <>
                <form onSubmit={saveTask} key={detail.task.version}>
                  <TaskFields task={detail.task} agents={agents} />
                  <label htmlFor="status">Status</label>
                  <select
                    id="status"
                    name="status"
                    defaultValue={detail.task.status}
                  >
                    {statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <p className="subtitle">
                    Move one stage at a time. Returning work to To do reopens
                    it.
                  </p>
                  {formError && (
                    <p className="error" role="alert">
                      {formError}
                    </p>
                  )}
                  {notice && (
                    <p className="success" role="status">
                      {notice}
                    </p>
                  )}
                  <div className="form-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void openTask(detail.task)}
                    >
                      Refresh
                    </button>
                    <button className="primary" disabled={busy}>
                      <Check size={14} />
                      Save changes
                    </button>
                  </div>
                </form>
                <WorkflowPanel
                  taskId={detail.task.id}
                  projectId={projectId}
                  version={detail.task.version}
                  agents={agents.map((a) => ({
                    ...a,
                    runtime_available: agentReady(a),
                  }))}
                  onChange={() => {
                    void openTask(detail.task);
                    void loadTasks();
                  }}
                />
                <section className="detail-section">
                  <h3>Dependencies</h3>
                  {detail.dependencies.map((id) => (
                    <p key={id} className="subtitle">
                      {tasks.find((t) => t.id === id)?.title || id}
                    </p>
                  ))}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const id = new FormData(e.currentTarget).get(
                        "dependency",
                      );
                      if (id)
                        void detailAction(
                          `tasks/${detail.task.id}/dependencies`,
                          { depends_on_id: id },
                          "Dependency added.",
                        );
                    }}
                  >
                    <label htmlFor="dependency">Blocked by</label>
                    <select
                      id="dependency"
                      name="dependency"
                      required
                      defaultValue=""
                    >
                      <option value="" disabled>
                        Select a task
                      </option>
                      {tasks
                        .filter(
                          (t) =>
                            t.id !== detail.task.id &&
                            !detail.dependencies.includes(t.id),
                        )
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {project?.key}-{t.number} · {t.title}
                          </option>
                        ))}
                    </select>
                    <button
                      className="secondary"
                      disabled={busy}
                      style={{ marginTop: 10 }}
                    >
                      <Plus size={13} />
                      Add dependency
                    </button>
                  </form>
                </section>
                <section className="detail-section">
                  <h3>Agent sessions</h3>
                  {detail.sessions.map((s) => (
                    <div
                      key={s.id}
                      className="panel-card"
                      style={{ padding: 12, marginBottom: 8 }}
                    >
                      <p style={{ fontSize: 11 }}>
                        {agentName(s.agent_id)} · {s.state}
                      </p>
                      <p className="code" style={{ marginTop: 8 }}>
                        {s.workspace_path}
                      </p>
                      <small>
                        {s.provider_session_id
                          ? `Provider: ${s.provider_session_id}`
                          : s.state === "prepared"
                            ? "Provider session not bound · Awaiting execution"
                            : "No provider session ID · API conversation persisted in workflow"}
                      </small>
                    </div>
                  ))}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const agentId = new FormData(e.currentTarget).get(
                        "agent_id",
                      );
                      if (agentId)
                        void detailAction(
                          `tasks/${detail.task.id}/sessions`,
                          { agent_id: agentId },
                          "Session prepared in an isolated workspace.",
                        );
                    }}
                  >
                    <label htmlFor="session-agent">
                      Prepare a task-scoped session
                    </label>
                    <select
                      id="session-agent"
                      name="agent_id"
                      required
                      defaultValue=""
                    >
                      <option value="" disabled>
                        Select an agent
                      </option>
                      {agents.map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.name} · {a.runtime}
                        </option>
                      ))}
                    </select>
                    <button
                      className="secondary"
                      style={{ marginTop: 10 }}
                      disabled={busy || !agents.length}
                    >
                      <Terminal size={13} />
                      Prepare session
                    </button>
                  </form>
                </section>
                <section className="detail-section">
                  <h3>Human approvals</h3>
                  <p className="subtitle">
                    Record an approval for version {detail.task.version}. No
                    merge or deployment is executed.
                  </p>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    {["merge", "deploy"].map((kind) => (
                      <button
                        key={kind}
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void detailAction(
                            `tasks/${detail.task.id}/approvals`,
                            { kind, version: detail.task.version },
                            `${kind} approval recorded.`,
                          )
                        }
                      >
                        <ShieldCheck size={13} />
                        Approve {kind}
                      </button>
                    ))}
                  </div>
                  {detail.approvals.map((a) => (
                    <p key={a.id} className="subtitle">
                      ✓ {a.kind} · v{a.task_version} · {a.actor}
                    </p>
                  ))}
                </section>
                <section className="detail-section">
                  <h3>Activity & audit</h3>
                  {detail.events.map((e) => (
                    <div key={e.id} className="event">
                      <p>{e.action}</p>
                      <small>
                        {e.actor} · {shortTime(e.created_at)}
                      </small>
                    </div>
                  ))}
                </section>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function TaskFields({ task, agents }: { task?: Task; agents: Agent[] }) {
  return (
    <>
      <label htmlFor="title">Task title</label>
      <input
        id="title"
        name="title"
        required
        maxLength={200}
        defaultValue={task?.title}
        placeholder="What needs to be done?"
      />
      <label htmlFor="description">Description & acceptance criteria</label>
      <textarea
        id="description"
        name="description"
        defaultValue={task?.description}
        maxLength={50000}
        placeholder="Describe the expected outcome…"
      />
      <div className="form-row">
        <div>
          <label htmlFor="priority">Priority</label>
          <select
            id="priority"
            name="priority"
            defaultValue={task?.priority || "medium"}
          >
            {["low", "medium", "high", "urgent"].map((p) => (
              <option value={p} key={p}>
                {p[0].toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="assignee">Assigned agent</label>
          <select
            id="assignee"
            name="assignee_id"
            defaultValue={task?.assignee_id || ""}
          >
            <option value="">Unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor="sprint">Sprint</label>
      <input
        id="sprint"
        name="sprint"
        maxLength={80}
        defaultValue={task?.sprint || ""}
        placeholder="e.g. Sprint 01"
      />
    </>
  );
}
