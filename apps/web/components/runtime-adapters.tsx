"use client";
import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { api } from "../lib/api";
import { useLLMProfiles, type LLMProfile } from "./llm-profiles";
export type Adapter = {
  runtime: string;
  available: boolean;
  enabled: boolean;
  installed: boolean;
  version: number;
  probe_model: string;
  status: string;
  reason: string;
  result: { tested_at?: string };
};
export function useRuntimeAdapters() {
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = await api<Adapter[]>("runtime-adapters");
        if (alive) setAdapters(data);
      } catch {
        if (alive) setAdapters([]);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return adapters;
}
function ProfileCard({ profile: p }: { profile: LLMProfile }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (p.status !== "running") setWaiting(false);
  }, [p.version, p.status, p.tested_at]);
  async function test() {
    setBusy(true);
    setWaiting(true);
    setError("");
    try {
      await api(`llm-profiles/${p.id}/verify`, "POST", {});
    } catch (e) {
      setError((e as Error).message);
      setWaiting(false);
    } finally {
      setBusy(false);
    }
  }
  const running = busy || waiting || p.status === "running";
  const blocked = !!p.test_blockers?.length;
  return (
    <article className="panel-card">
      <h3>{p.label}</h3>
      <span
        className={`run-badge ${p.available ? "completed" : running ? "running" : "interrupted"}`}
      >
        {running
          ? "Testing…"
          : blocked
            ? "Blocked"
            : p.available
              ? "Ready"
              : p.status || "Not tested"}
      </span>
      <p className="code" style={{ marginTop: 12 }}>
        {p.runtime.toUpperCase()} · {p.model}
      </p>
      {p.api_base && <p className="subtitle">{p.api_base}</p>}
      <p className="subtitle">{p.reason}</p>
      {blocked && (
        <div role="status" className="error" style={{ marginTop: 12 }}>
          {p.test_blockers.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
      <small>Source: LLM_PROFILES_JSON · {p.id}</small>
      {p.tested_at && (
        <p className="subtitle">
          Last tested: {new Date(p.tested_at).toLocaleString()}
          {p.latency_ms !== null ? ` · ${p.latency_ms} ms` : ""}
        </p>
      )}
      <button
        className="primary"
        aria-label={`Test ${p.label}`}
        style={{ marginTop: 16 }}
        disabled={
          running ||
          p.can_test === false ||
          !p.enabled ||
          !p.credential_configured ||
          p.installed === false
        }
        onClick={() => void test()}
      >
        <Play size={13} />
        Test LLM
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <details
        style={{ marginTop: 16, fontSize: 12 }}
        open={blocked || undefined}
      >
        <summary style={{ cursor: "pointer" }}>Test details &amp; logs</summary>
        <ul style={{ paddingLeft: 18, marginTop: 10 }}>
          {p.test_checks?.map((check) => (
            <li key={check.name} style={{ marginBottom: 8 }}>
              <strong>
                {check.ok ? "PASS" : "BLOCKED"} · {check.name}
              </strong>
              <br />
              {check.detail}
            </li>
          ))}
        </ul>
        {p.test_result?.message && (
          <p className="subtitle">Last test: {p.test_result.message}</p>
        )}
        <pre
          aria-label={`Test logs for ${p.label}`}
          style={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: 240,
            overflow: "auto",
            padding: 12,
            background: "#101216",
            borderRadius: 8,
          }}
        >
          {p.test_result?.logs?.length
            ? p.test_result.logs
                .map((log) => `${log.at} [${log.kind}] ${log.message}`)
                .join("\n")
            : blocked
              ? "Preflight blocked. No provider was started, so no CLI/API logs exist."
              : "No provider test logs yet. Logs appear here after starting a test."}
        </pre>
      </details>
    </article>
  );
}
export function RuntimeAdapterSetup() {
  const profiles = useLLMProfiles();
  return (
    <section>
      <h2>Runtime adapter setup</h2>
      <p className="subtitle">
        LLMs are loaded directly from LLM_PROFILES_JSON. Test each profile
        separately before assigning it to an agent. Passing one profile does not
        enable another profile, even with the same runtime. Tests may incur
        provider charges and send no project data.
      </p>
      {!profiles.length ? (
        <div className="panel-card">
          <h3>No LLM profiles configured</h3>
          <p>
            Define the LLM_PROFILES_JSON array in .env, configure its credential
            environment variables, and restart the application. Each profile
            will appear here for testing.
          </p>
        </div>
      ) : (
        <div className="panel-grid">
          {profiles.map((p) => (
            <ProfileCard key={p.id} profile={p} />
          ))}
        </div>
      )}
    </section>
  );
}
