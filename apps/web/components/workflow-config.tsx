"use client";
import { useEffect, useState } from "react";
import { Plus, Save, Copy, Trash2 } from "lucide-react";
import { api } from "../lib/api";

export type WorkflowSpec = {
  key: string;
  kind: string;
  role: string;
  agent_id: string | null;
  instructions: string;
  depends_on: string[];
};
export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  version: number;
  steps: WorkflowSpec[];
  builtin?: boolean;
};
export type WorkflowCatalog = {
  templates: WorkflowTemplate[];
  default_workflow_id: string | null;
  version: number;
};
type Agent = {
  id: string;
  name: string;
  role: string;
  runtime: string;
  model: string;
  enabled: boolean;
};

export function suggestedAgent(agents: Agent[], spec: WorkflowSpec) {
  if (spec.agent_id) return spec.agent_id;
  const aliases: Record<string, string[]> = {
    plan: ["plan", "architect"],
    implement: ["engineer", "builder", "implement", "developer"],
    review: ["review"],
    test: ["test", "qa"],
  };
  const terms = aliases[spec.role || spec.kind] || [spec.role];
  return (
    agents.find((a) =>
      terms.some((t) =>
        `${a.role} ${a.name}`.toLowerCase().includes(t.toLowerCase()),
      ),
    )?.id || (agents.length === 1 ? agents[0].id : "")
  );
}

export function WorkflowDesigner({
  projectId,
  agents,
}: {
  projectId: string;
  agents: Agent[];
}) {
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [draft, setDraft] = useState<WorkflowTemplate | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    const data = await api<WorkflowCatalog>(
      `projects/${projectId}/workflow-templates`,
    );
    setCatalog(data);
  }
  useEffect(() => {
    let alive = true;
    setCatalog(null);
    setDraft(null);
    setError("");
    setNotice("");
    if (projectId)
      api<WorkflowCatalog>(`projects/${projectId}/workflow-templates`)
        .then((data) => {
          if (alive) setCatalog(data);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [projectId]);
  function editStep(index: number, patch: Partial<WorkflowSpec>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            steps: current.steps.map((step, i) =>
              i === index ? { ...step, ...patch } : step,
            ),
          }
        : null,
    );
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        steps: draft.steps,
        ...(draft.id ? { version: draft.version } : {}),
      };
      const result = await api<WorkflowTemplate>(
        `projects/${projectId}/workflow-templates${draft.id ? `/${draft.id}` : ""}`,
        draft.id ? "PUT" : "POST",
        body,
      );
      setDraft(result);
      await load();
      setNotice(
        `Saved ${result.name} · v${result.version}. Existing runs keep their original snapshot.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setDefault(id: string) {
    if (!catalog) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`projects/${projectId}/default-workflow`, "PATCH", {
        version: catalog.version,
        workflow_template_id: id || null,
      });
      await load();
      setNotice("Project default saved. Tasks without an override inherit it.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!projectId) return <p>Create a project to configure workflows.</p>;
  return (
    <section className="panel-card" style={{ marginTop: 24 }}>
      <h2>Workflow configuration</h2>
      <p className="subtitle">
        Task selection → project default → system default. Runtime and model
        belong to each agent. Human review is always required.
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
      {catalog && (
        <>
          <label htmlFor="project-default-workflow">
            Project default workflow
          </label>
          <select
            id="project-default-workflow"
            disabled={busy}
            value={catalog.default_workflow_id || ""}
            onChange={(e) => void setDefault(e.target.value)}
          >
            <option value="">
              Use system default · Plan → Implement → Review
            </option>
            {catalog.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · v{t.version}
              </option>
            ))}
          </select>
          <div className="file-list" style={{ marginTop: 16 }}>
            {catalog.templates.map((t) => (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  padding: "8px 0",
                  flexWrap: "wrap",
                }}
              >
                <strong style={{ flex: 1 }}>
                  {t.name}{" "}
                  <small>
                    v{t.version}
                    {t.builtin ? " · built-in" : ""}
                  </small>
                </strong>
                {!t.builtin && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setDraft(structuredClone(t));
                      setNotice("");
                    }}
                  >
                    Edit
                  </button>
                )}
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setDraft({
                      ...structuredClone(t),
                      id: "",
                      name: `${t.name} copy`,
                      builtin: false,
                      version: 1,
                    });
                    setNotice("");
                  }}
                >
                  <Copy size={13} />
                  Clone
                </button>
              </div>
            ))}
          </div>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              setDraft({
                id: "",
                name: "New workflow",
                description: "",
                version: 1,
                steps: [
                  {
                    key: "implement",
                    kind: "implement",
                    role: "implement",
                    agent_id: null,
                    instructions:
                      "Implement the task and return complete files.",
                    depends_on: [],
                  },
                ],
              })
            }
          >
            <Plus size={14} />
            New workflow
          </button>
        </>
      )}
      {draft && (
        <form
          style={{ marginTop: 24 }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h3>{draft.id ? "Edit workflow" : "Create workflow"}</h3>
          <label htmlFor="template-name">Workflow name</label>
          <input
            id="template-name"
            required
            maxLength={100}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <label htmlFor="template-description">Workflow description</label>
          <textarea
            id="template-description"
            maxLength={10000}
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
          {draft.steps.map((step, index) => (
            <div className="panel-card" key={index} style={{ marginTop: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <h3>Step {index + 1}</h3>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Remove step ${index + 1}`}
                  disabled={draft.steps.length === 1}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      steps: draft.steps
                        .filter((_, i) => i !== index)
                        .map((s) => ({
                          ...s,
                          depends_on: s.depends_on.filter(
                            (k) => k !== step.key,
                          ),
                        })),
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <label htmlFor={`step-key-${index}`}>Step key</label>
              <input
                id={`step-key-${index}`}
                required
                pattern="[a-z][a-z0-9_]{0,39}"
                value={step.key}
                onChange={(e) => {
                  const next = e.target.value;
                  setDraft({
                    ...draft,
                    steps: draft.steps.map((s, i) =>
                      i === index
                        ? { ...s, key: next }
                        : {
                            ...s,
                            depends_on: s.depends_on.map((k) =>
                              k === step.key ? next : k,
                            ),
                          },
                    ),
                  });
                }}
              />
              <label htmlFor={`step-kind-${index}`}>Step type</label>
              <select
                id={`step-kind-${index}`}
                value={step.kind}
                onChange={(e) => editStep(index, { kind: e.target.value })}
              >
                {["plan", "implement", "review", "test"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <label htmlFor={`step-role-${index}`}>Suggested role</label>
              <input
                id={`step-role-${index}`}
                maxLength={100}
                placeholder="plan / implement / review / frontend / backend"
                value={step.role}
                onChange={(e) => editStep(index, { role: e.target.value })}
              />
              <label htmlFor={`step-agent-${index}`}>Default agent</label>
              <select
                id={`step-agent-${index}`}
                value={step.agent_id || ""}
                onChange={(e) =>
                  editStep(index, { agent_id: e.target.value || null })
                }
              >
                <option value="">Suggest by role; choose before running</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.runtime} · {a.model}
                    {!a.enabled ? " · disabled" : ""}
                  </option>
                ))}
              </select>
              <label htmlFor={`step-instructions-${index}`}>
                Step instructions
              </label>
              <textarea
                id={`step-instructions-${index}`}
                maxLength={10000}
                value={step.instructions}
                onChange={(e) =>
                  editStep(index, { instructions: e.target.value })
                }
              />
              <label htmlFor={`step-deps-${index}`}>Wait for steps</label>
              <select
                id={`step-deps-${index}`}
                multiple
                value={step.depends_on}
                onChange={(e) =>
                  editStep(index, {
                    depends_on: Array.from(
                      e.target.selectedOptions,
                      (o) => o.value,
                    ),
                  })
                }
              >
                {draft.steps
                  .filter((_, i) => i !== index)
                  .map((s, i) => (
                    <option key={i} value={s.key}>
                      {s.key}
                    </option>
                  ))}
              </select>
              <small>
                No dependencies starts immediately. Multiple dependencies wait
                for all. Ctrl/Cmd selects multiple; cycles are rejected.
              </small>
            </div>
          ))}
          <div
            style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}
          >
            <button
              type="button"
              className="secondary"
              disabled={draft.steps.length >= 12}
              onClick={() => {
                let n = draft.steps.length + 1;
                while (draft.steps.some((s) => s.key === `step_${n}`)) n++;
                setDraft({
                  ...draft,
                  steps: [
                    ...draft.steps,
                    {
                      key: `step_${n}`,
                      kind: "review",
                      role: "review",
                      agent_id: null,
                      instructions: "Review supplied evidence.",
                      depends_on: [draft.steps[draft.steps.length - 1].key],
                    },
                  ],
                });
              }}
            >
              <Plus size={13} />
              Add step
            </button>
            <button className="primary" disabled={busy}>
              <Save size={13} />
              Save workflow
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              Close editor
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
