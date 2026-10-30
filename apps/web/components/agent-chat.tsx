"use client";
import { useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Send,
  Sparkles,
  RefreshCw,
  Square,
  X,
  BookOpen,
  Loader2,
} from "lucide-react";
import { api } from "../lib/api";

type Agent = {
  id: string;
  name: string;
  role: string;
  runtime: string;
  model: string;
  enabled: boolean;
};
type Inventory = {
  source_count: number;
  memory_total: number;
  memory_included: number;
  agent_artifacts_total: number;
  agent_artifacts_included: number;
  skills_total: number;
  skills_included: number;
  included_bytes: number;
  truncated: boolean;
  policy_sha256: string;
  scope: string;
};
type Message = {
  id: string;
  sequence: number;
  role: string;
  kind: string;
  content: string;
  state: string;
  created_at: string;
  inventory: Inventory | null;
  request_id: string | null;
  history_truncated: boolean;
};
type Chat = {
  conversation: {
    status: string;
    provider_session_id: string | null;
    error: string | null;
  } | null;
  messages: Message[];
  total_messages: number;
};
type Source = {
  id: string;
  title: string;
  included_bytes: number;
  bytes: number;
  truncated: boolean;
  human_reviewed?: boolean;
};
type Knowledge = { inventory: Inventory; sources: Source[] };

function KnowledgeStats({ inventory: i }: { inventory: Inventory }) {
  return (
    <div className="chat-knowledge-stats">
      <span>
        <strong>{i.source_count}</strong> supplied sources
      </span>
      <span>
        <strong>
          {i.memory_included}/{i.memory_total}
        </strong>{" "}
        memories
      </span>
      <span>
        <strong>
          {i.agent_artifacts_included}/{i.agent_artifacts_total}
        </strong>{" "}
        own artifacts
      </span>
      <span>
        <strong>
          {i.skills_included}/{i.skills_total}
        </strong>{" "}
        skills
      </span>
      <span>
        <strong>{Math.ceil(i.included_bytes / 1024)} KB</strong> context
      </span>
    </div>
  );
}

export function AgentChat({
  projectId,
  agent,
  onClose,
}: {
  projectId: string;
  agent: Agent;
  onClose: () => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [knowledge, setKnowledge] = useState<Knowledge | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const generation = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const base = `projects/${projectId}/agents/${agent.id}`;
  const active = chat?.conversation?.status === "running";
  const lastMessageId = chat?.messages.at(-1)?.id;
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lastMessageId, active]);
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    let alive = true;
    generation.current++;
    setChat(null);
    setKnowledge(null);
    setText("");
    setError("");
    setSnapshot(null);
    setBusy(false);
    async function load() {
      try {
        const state = await api<Chat>(`${base}/chat`);
        if (alive) setChat(state);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    void load();
    api<Knowledge>(`${base}/knowledge`)
      .then((k) => {
        if (alive) setKnowledge(k);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    const timer = setInterval(() => void load(), 1800);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base, agent.model, agent.runtime, agent.role]);
  async function send(kind: "chat" | "context_summary") {
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      await api(`${base}/chat/messages`, "POST", {
        kind,
        content: kind === "chat" ? text : "",
      });
      if (current !== generation.current) return;
      if (kind === "chat") setText("");
      const [state, context] = await Promise.all([
        api<Chat>(`${base}/chat`),
        api<Knowledge>(`${base}/knowledge`),
      ]);
      if (current === generation.current) {
        setChat(state);
        setKnowledge(context);
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await api(`${base}/chat/cancel`, "POST", {});
      setChat(await api<Chat>(`${base}/chat`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect(message: Message) {
    setError("");
    try {
      setSnapshot(
        await api(
          `${base}/chat/messages/${message.request_id || message.id}/context`,
        ),
      );
      setSourceLabel(
        `Snapshot for message ${message.sequence} · ${new Date(message.created_at).toLocaleString()}`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const latestSummary = chat?.messages
    .filter((m) => m.role === "assistant" && m.kind === "context_summary")
    .at(-1);
  return (
    <section
      ref={panelRef}
      className="panel-card agent-chat"
      aria-label={`Chat with ${agent.name}`}
    >
      <div className="chat-heading">
        <div>
          <h2>
            <MessageSquare size={20} /> {agent.name}
          </h2>
          <p className="subtitle">
            {agent.role} · {agent.runtime} · {agent.model}
          </p>
        </div>
        <button
          className="secondary"
          onClick={onClose}
          aria-label="Close agent chat"
        >
          <X size={16} />
        </button>
      </div>
      <p className="subtitle">
        Persistent conversation for this agent and project. Task execution and
        approvals stay in workflows.
      </p>
      <div className="chat-toolbar">
        <button
          className="primary"
          disabled={busy || active || !chat || !agent.enabled || !projectId}
          onClick={() => void send("context_summary")}
        >
          <Sparkles size={15} />
          Generate context summary
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            setError("");
            void api<Knowledge>(`${base}/knowledge`)
              .then(setKnowledge)
              .catch((e) => setError(e.message));
          }}
        >
          <RefreshCw size={14} />
          Refresh knowledge sources
        </button>
        {active && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void cancel()}
          >
            <Square size={14} />
            Cancel response
          </button>
        )}
      </div>
      {knowledge && (
        <details className="chat-inventory">
          <summary>
            <BookOpen size={14} />
            Available context ·{" "}
            {knowledge.inventory.truncated
              ? "limited / truncated"
              : "within context budget"}
          </summary>
          <KnowledgeStats inventory={knowledge.inventory} />
          <p className="subtitle">{knowledge.inventory.scope}</p>
          <small>
            Company policy SHA-256: {knowledge.inventory.policy_sha256}
          </small>
          {knowledge.sources.map((s) => (
            <p key={s.id} className="chat-source">
              <code>{s.id}</code> · {s.title} · {s.included_bytes}/{s.bytes}{" "}
              bytes{s.truncated ? " · truncated" : ""}
              {s.human_reviewed === false ? " · not human reviewed" : ""}
            </p>
          ))}
        </details>
      )}
      {latestSummary && (
        <p className="subtitle">
          Latest context summary:{" "}
          {new Date(latestSummary.created_at).toLocaleString()}
          {chat?.messages.some(
            (m) =>
              m.role === "user" &&
              m.kind === "chat" &&
              m.sequence > latestSummary.sequence,
          )
            ? " · newer conversation exists; regenerate to include it"
            : ""}
        </p>
      )}
      {(error || chat?.conversation?.error) && (
        <p className="error" role="alert">
          {error || chat?.conversation?.error}
        </p>
      )}
      {!chat ? (
        <p className="subtitle">Loading conversation…</p>
      ) : (
        <>
          {chat.total_messages > chat.messages.length && (
            <p className="subtitle">
              Showing latest {chat.messages.length} of {chat.total_messages}{" "}
              messages. Earlier messages remain stored.
            </p>
          )}
          <div
            className="chat-messages"
            ref={logRef}
            role="log"
            aria-label="Agent conversation history"
          >
            {!chat.messages.length && (
              <p className="subtitle">
                Ask this agent about the project, discuss a decision, or
                generate its current context summary.
              </p>
            )}
            {chat.messages.map((m) => (
              <article
                key={m.id}
                className={`chat-message ${m.role} ${m.kind}`}
              >
                <div className="chat-message-meta">
                  <strong>
                    {m.role === "user" ? "You" : agent.name}
                    {m.kind === "context_summary" ? " · Context summary" : ""}
                  </strong>
                  <small>
                    {new Date(m.created_at).toLocaleString()} · {m.state}
                  </small>
                </div>
                <div className="chat-message-content">{m.content}</div>
                {m.inventory && <KnowledgeStats inventory={m.inventory} />}{" "}
                {m.history_truncated && (
                  <p className="subtitle">
                    Conversation history was limited to the recent context
                    budget.
                  </p>
                )}
                <button className="secondary" onClick={() => void inspect(m)}>
                  Inspect supplied context
                </button>
              </article>
            ))}
            {active && (
              <p role="status" className="chat-running">
                <Loader2 size={15} className="animate-spin" />
                {agent.name} is responding…
              </p>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send("chat");
            }}
          >
            <label htmlFor="agent-chat-input">Message {agent.name}</label>
            <textarea
              id="agent-chat-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={20000}
              required
              placeholder="Discuss the project, explain a requirement, or ask what context is missing…"
            />
            <div className="chat-toolbar">
              <button
                className="primary"
                disabled={
                  busy || active || !text.trim() || !agent.enabled || !projectId
                }
              >
                <Send size={14} />
                Send message
              </button>
              <small>
                Uses this agent's provider. Responses may incur provider
                charges.
              </small>
            </div>
          </form>
        </>
      )}
      {snapshot !== null && (
        <section className="chat-snapshot">
          <div className="chat-heading">
            <h3>{sourceLabel}</h3>
            <button className="secondary" onClick={() => setSnapshot(null)}>
              Close context
            </button>
          </div>
          <p className="subtitle">
            Exact recorded input snapshot. Company policy is mandatory; other
            sources and history are lower-trust data.
          </p>
          <pre className="code">{JSON.stringify(snapshot, null, 2)}</pre>
        </section>
      )}
    </section>
  );
}
