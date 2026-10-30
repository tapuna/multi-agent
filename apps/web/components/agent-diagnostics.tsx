"use client";
import { useEffect, useState } from "react";
import { Play, Loader2 } from "lucide-react";
import { api } from "../lib/api";
type Row = {
  agent: { id: string; name: string; runtime: string; model: string };
  checks: { name: string; ok: boolean }[];
  latest: {
    id: string;
    status: string;
    stale: boolean;
    latency_ms: number | null;
    created_at: string;
    config_snapshot: { runtime: string; model: string };
    result: {
      message: string;
      hint?: string;
      response_verified: boolean;
      logs?: string[];
    };
  } | null;
};

export function useAgentDiagnostics(enabled: boolean) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    async function load() {
      try {
        const data = await api<Row[]>("agent-diagnostics");
        if (alive) {
          setRows(data);
          setError("");
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);
  async function test(agentId: string) {
    setPending((current) => [...current, agentId]);
    setError("");
    try {
      await api(`agents/${agentId}/diagnostics`, "POST", {});
      setRows(await api<Row[]>("agent-diagnostics"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending((current) => current.filter((id) => id !== agentId));
    }
  }
  return { rows, error, pending, test };
}

export function AgentReadiness({
  agentName,
  row,
  pending,
  error,
  onTest,
}: {
  agentName: string;
  row?: Row;
  pending: boolean;
  error: string;
  onTest: () => void;
}) {
  const result = row?.latest;
  const running = pending || result?.status === "running";
  const label = running
    ? "Testing…"
    : result?.stale
      ? "Retest needed"
      : result?.status || "Not tested";
  const color = running
    ? "running"
    : result?.stale
      ? "interrupted"
      : result?.status === "passed"
        ? "completed"
        : result
          ? "failed"
          : "";
  return (
    <section
      className="agent-readiness"
      aria-label={`Readiness for ${agentName}`}
    >
      <div className="agent-readiness-heading">
        <small>Readiness</small>
        <span className={`run-badge ${color}`}>{label}</span>
        <button
          className="secondary"
          aria-label={`Test ${agentName}`}
          disabled={running || !row}
          onClick={onTest}
        >
          {running ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Play size={12} />
          )}
          Test
        </button>
      </div>
      {result && (
        <small className="agent-readiness-time">
          Last: {new Date(result.created_at).toLocaleString()}
          {result.latency_ms !== null ? ` · ${result.latency_ms} ms` : ""}
        </small>
      )}
      <small className="agent-readiness-time">
        Live provider check · may incur charges
      </small>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <details>
        <summary>Test details</summary>
        {row?.checks.map((check) => (
          <p className="subtitle" key={check.name}>
            {check.ok ? "✓" : "✕"} {check.name}
          </p>
        ))}
        {result && (
          <>
            <p className="subtitle">{result.result.message}</p>
            {result.stale && (
              <p className="subtitle">
                Configuration or adapter availability changed. Run a new test.
              </p>
            )}
            {result.result.hint && (
              <p className="subtitle">{result.result.hint}</p>
            )}
            <p className="code">
              Tested: {result.config_snapshot.runtime} /{" "}
              {result.config_snapshot.model}
            </p>
            {result.result.logs?.length ? (
              <pre
                className="code"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {result.result.logs.join("\n")}
              </pre>
            ) : null}
          </>
        )}
        <p className="subtitle">
          Uses this agent's configured runtime/model in an isolated workspace.
          No project data is sent. A pass confirms the provider response at the
          recorded time.
        </p>
      </details>
    </section>
  );
}
