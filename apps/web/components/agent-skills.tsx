"use client";
import { useEffect, useRef, useState } from "react";
import { BookOpen, Save, X } from "lucide-react";
import { api } from "../lib/api";

type Skill = {
  name: string;
  version: string;
  description: string;
  content: string;
};
type Selection = { version: number; skill_refs: string[] };

export function AgentSkills({
  agent,
  onClose,
  onChange,
}: {
  agent: { id: string; name: string };
  onClose: () => void;
  onChange: () => void;
}) {
  const [available, setAvailable] = useState<Skill[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    let alive = true;
    setSelection(null);
    setError("");
    setNotice("");
    Promise.all([
      api<Skill[]>("skills"),
      api<Selection>(`agents/${agent.id}/skills`),
    ])
      .then(([skills, chosen]) => {
        if (alive) {
          setAvailable(skills);
          setSelection(chosen);
          setRefs(chosen.skill_refs);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [agent.id]);
  function choose(name: string, ref: string) {
    setRefs((current) => [
      ...current.filter((r) => r.split("@")[0] !== name),
      ...(ref ? [ref] : []),
    ]);
    setNotice("");
  }
  async function save() {
    if (!selection) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<Selection>(`agents/${agent.id}/skills`, "PUT", {
        version: selection.version,
        skill_refs: refs,
      });
      setSelection(result);
      setRefs(result.skill_refs);
      setNotice(
        "Agent skills saved. New workflow runs and conversations use this configuration; previous snapshots stay unchanged.",
      );
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const names = Array.from(new Set(available.map((s) => s.name)));
  const missing = refs.filter(
    (r) => !available.some((s) => `${s.name}@${s.version}` === r),
  );
  return (
    <section
      ref={panelRef}
      className="panel-card"
      style={{ margin: "24px 0" }}
      aria-label={`Skills for ${agent.name}`}
    >
      <div className="chat-heading">
        <div>
          <h2>
            <BookOpen size={20} /> Skills · {agent.name}
          </h2>
          <p className="subtitle">
            Assign up to 10 skills, with one pinned version per package. Only
            this agent receives these packages in new runs and chat context.
          </p>
        </div>
        <button
          className="secondary"
          onClick={onClose}
          aria-label="Close agent skills"
        >
          <X size={15} />
        </button>
      </div>
      <p className="subtitle">
        Skill Registry is the shared package library. Publishing a package does
        not assign it to agents. No selection means no assigned skills; company
        policy still applies.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="subtitle">
          {notice}
        </p>
      )}
      {missing.map((ref) => (
        <div key={ref} className="error">
          Unavailable: {ref}{" "}
          <button
            className="secondary"
            onClick={() => setRefs(refs.filter((r) => r !== ref))}
          >
            Remove missing assignment
          </button>
        </div>
      ))}
      {!selection ? (
        <p>Loading agent skills…</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {names.map((name) => {
            const chosen = refs.find((r) => r.split("@")[0] === name) || "";
            const skill = available.find(
              (s) => `${s.name}@${s.version}` === chosen,
            );
            return (
              <div key={name} className="detail-section">
                <label htmlFor={`skill-${name}`}>{name}</label>
                <select
                  id={`skill-${name}`}
                  value={chosen}
                  disabled={busy}
                  onChange={(e) => choose(name, e.target.value)}
                >
                  <option value="">Not assigned</option>
                  {available
                    .filter((s) => s.name === name)
                    .map((s) => (
                      <option key={s.version} value={`${s.name}@${s.version}`}>
                        v{s.version} · {s.description}
                      </option>
                    ))}
                </select>
                {skill && (
                  <details style={{ marginTop: 8 }}>
                    <summary>Read assigned SKILL.md</summary>
                    <pre
                      className="code"
                      style={{
                        whiteSpace: "pre-wrap",
                        maxHeight: 280,
                        overflow: "auto",
                      }}
                    >
                      {skill.content}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
          {!available.length && (
            <p className="subtitle">
              Publish a package in Skill Registry first.
            </p>
          )}
          <button
            className="primary"
            disabled={busy || refs.length > 10}
            style={{ marginTop: 16 }}
          >
            <Save size={14} />
            Save agent skills · {refs.length}/10
          </button>
        </form>
      )}
    </section>
  );
}
