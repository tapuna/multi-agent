"use client";
import { useEffect, useState } from "react";
import { Save, Play, Bot } from "lucide-react";
import { api } from "../lib/api";
import { useLLMProfiles } from "./llm-profiles";
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
function AdapterForm({ adapter: a }: { adapter: Adapter }) {
  const profiles = useLLMProfiles();
  const [model, setModel] = useState(a.probe_model);
  const [enabled, setEnabled] = useState(a.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setModel(a.probe_model);
    setEnabled(a.enabled);
  }, [a.version, a.probe_model, a.enabled]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`runtime-adapters/${a.runtime}`, "PUT", {
        version: a.version,
        enabled,
        probe_model: model,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setError("");
    try {
      await api(`runtime-adapters/${a.runtime}/verify`, "POST", {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const dirty = model !== a.probe_model || enabled !== a.enabled;
  return (
    <article className="panel-card">
      <Bot size={22} />
      <h3>{a.runtime.toUpperCase()}</h3>
      <span className={`run-badge ${a.available ? "completed" : "failed"}`}>
        {a.available ? "Available" : a.status}
      </span>
      <p className="subtitle">{a.reason}</p>
      <small>
        {a.installed
          ? "Adapter/executable detected"
          : "CLI executable not found"}
      </small>
      <label htmlFor={`runtime-model-${a.runtime}`}>Verification model</label>
      {profiles.length > 0 ? (
        <select
          id={`runtime-model-${a.runtime}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="">Select LLM profile</option>
          {model && !profiles.some((p) => p.reference === model) && (
            <option value={model} disabled>
              {model} · select a configured profile
            </option>
          )}
          {profiles
            .filter((p) => p.runtime === a.runtime)
            .map((p) => (
              <option
                key={p.id}
                value={p.reference}
                disabled={!p.enabled || !p.credential_configured}
              >
                {p.label} · {p.model}
                {!p.enabled
                  ? " · disabled"
                  : !p.credential_configured
                    ? " · credential missing"
                    : ""}
              </option>
            ))}
        </select>
      ) : (
        <input
          id={`runtime-model-${a.runtime}`}
          value={model}
          maxLength={150}
          placeholder={a.runtime === "api" ? "provider/model-id" : "model-id"}
          onChange={(e) => setModel(e.target.value)}
        />
      )}
      <label
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          marginTop: 14,
        }}
      >
        <input
          type="checkbox"
          style={{ width: "auto" }}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable {a.runtime} adapter
      </label>
      <div className="chat-toolbar">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void save()}
        >
          <Save size={13} />
          Save {a.runtime} setup
        </button>
        <button
          className="primary"
          disabled={busy || dirty || !a.enabled || a.status === "running"}
          onClick={() => void verify()}
        >
          <Play size={13} />
          Verify {a.runtime} adapter
        </button>
      </div>
      {dirty && (
        <small>
          Save changes before verification. Saving invalidates the previous
          verification.
        </small>
      )}
      {a.result.tested_at && (
        <p className="subtitle">
          Last tested: {new Date(a.result.tested_at).toLocaleString()}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </article>
  );
}
export function RuntimeAdapterSetup() {
  const adapters = useRuntimeAdapters();
  return (
    <section>
      <h2>Runtime adapter setup</h2>
      <p className="subtitle">
        Set up → enable → verify with a real provider response → register
        agents. Verification may incur provider charges. Configure CLI login/API
        credentials on this machine first; no project data is sent. A verified
        adapter does not guarantee every model is accessible.
      </p>
      <div className="panel-grid">
        {adapters.map((a) => (
          <AdapterForm key={a.runtime} adapter={a} />
        ))}
      </div>
      {!adapters.length && (
        <p className="subtitle">Loading runtime registry…</p>
      )}
    </section>
  );
}
