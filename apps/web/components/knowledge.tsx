"use client";
import { useEffect, useState, type FormEvent } from "react";
import { BookOpen, Plus, Save, RefreshCw } from "lucide-react";
import { api } from "../lib/api";

type Skill = {
  name: string;
  version: string;
  description: string;
  sha256: string;
  path: string;
  content: string;
};
export function SkillRegistry() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function load() {
    setSkills(await api<Skill[]>("skills"));
  }
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, []);
  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      await api("skills", "POST", {
        name: f.get("name"),
        version: f.get("version"),
        description: f.get("description"),
        instructions: f.get("instructions"),
      });
      await load();
      setPublishing(false);
      setMessage(
        "Immutable skill version published. Assign it to individual agents in Agent Studio → Skills.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div style={{ marginTop: 25 }}>
        <button
          className="secondary"
          onClick={() => setPublishing(!publishing)}
        >
          <Plus size={13} />
          Publish skill version
        </button>
      </div>
      {message && (
        <p className="subtitle" role="status">
          {message}
        </p>
      )}
      {publishing && (
        <form
          className="panel-card"
          style={{ marginTop: 20 }}
          onSubmit={publish}
        >
          <h3>Publish a standard SKILL.md package</h3>
          <div className="form-row">
            <div>
              <label htmlFor="skill-name">Name</label>
              <input
                id="skill-name"
                name="name"
                pattern="[a-z][a-z0-9-]{0,49}"
                required
                placeholder="code-review"
              />
            </div>
            <div>
              <label htmlFor="skill-version">Version</label>
              <input
                id="skill-version"
                name="version"
                pattern="[0-9]+\.[0-9]+\.[0-9]+"
                required
                placeholder="1.0.0"
              />
            </div>
          </div>
          <label htmlFor="skill-description">Description</label>
          <input
            id="skill-description"
            name="description"
            required
            maxLength={300}
          />
          <label htmlFor="skill-instructions">Instructions</label>
          <textarea
            id="skill-instructions"
            name="instructions"
            required
            maxLength={60000}
          />
          <button className="primary" style={{ marginTop: 15 }} disabled={busy}>
            Publish version
          </button>
        </form>
      )}
      <div className="panel-grid">
        {skills.map((s) => (
          <article className="panel-card" key={`${s.name}@${s.version}`}>
            <BookOpen size={24} />
            <h3>{s.name}</h3>
            <p>{s.description}</p>
            <p style={{ margin: "12px 0" }}>
              <span className="tag">v{s.version}</span>
            </p>
            <small className="code">{s.path}</small>
            <details style={{ marginTop: 15 }}>
              <summary style={{ cursor: "pointer" }}>View package</summary>
              <pre className="artifact-text">{s.content}</pre>
            </details>
            <small style={{ overflowWrap: "anywhere" }}>
              SHA-256: {s.sha256}
            </small>
          </article>
        ))}
      </div>
    </>
  );
}

export function ContextEditor({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: { id: string; title: string }[];
}) {
  const [scope, setScope] = useState("project");
  const [role, setRole] = useState("engineering");
  const [taskId, setTaskId] = useState("");
  const [content, setContent] = useState("");
  const [sha, setSha] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const target =
    scope === "project"
      ? projectId
      : scope === "task"
        ? taskId || tasks[0]?.id || ""
        : scope === "role"
          ? role
          : "default";
  async function load() {
    if (!target) return;
    try {
      const result = await api<{ content: string; sha256: string }>(
        `contexts/${scope}/${encodeURIComponent(target)}`,
      );
      setContent(result.content);
      setSha(result.sha256);
      setMessage("");
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  useEffect(() => {
    setSha("");
    setContent("");
    if (scope !== "role") void load();
  }, [scope, target]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ content: string; sha256: string }>(
        `contexts/${scope}/${encodeURIComponent(target)}`,
        "PUT",
        { content, previous_sha256: sha },
      );
      setContent(result.content);
      setSha(result.sha256);
      setMessage(
        "Context saved and audited. New runs snapshot this version. A company-policy change requires existing runs to be reviewed again.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel-card" style={{ marginTop: 25 }} onSubmit={save}>
      <h3>Versioned context editor</h3>
      <p>
        Company policy has highest precedence. Each workflow keeps an immutable
        snapshot of the selected context and skills.
      </p>
      <label htmlFor="context-scope">Context scope</label>
      <select
        id="context-scope"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
      >
        {["company", "team", "project", "role", "task"].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      {scope === "task" && (
        <>
          <label htmlFor="context-task">Task</label>
          <select
            id="context-task"
            value={taskId || tasks[0]?.id || ""}
            onChange={(e) => setTaskId(e.target.value)}
          >
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </>
      )}
      {scope === "role" && (
        <>
          <label htmlFor="role-slug">Role slug</label>
          <input
            id="role-slug"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            pattern="[a-z][a-z0-9-]{0,79}"
          />
        </>
      )}
      <div className="run-actions">
        <button type="button" className="secondary" onClick={() => void load()}>
          <RefreshCw size={13} />
          Load / refresh
        </button>
      </div>
      <label htmlFor="context-content">Instructions</label>
      <textarea
        id="context-content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        maxLength={60000}
        style={{ minHeight: 220 }}
      />
      <button
        className="primary"
        style={{ marginTop: 15 }}
        disabled={busy || !target || !sha}
      >
        <Save size={13} />
        Save context
      </button>
      {message && (
        <p className="subtitle" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
