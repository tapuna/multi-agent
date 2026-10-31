"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
export type LLMProfile = {
  id: string;
  reference: string;
  label: string;
  runtime: string;
  model: string;
  enabled: boolean;
  available: boolean;
  status: string;
  reason: string;
  version: number;
  installed?: boolean;
  tested_at: string | null;
  latency_ms: number | null;
  credential_configured: boolean;
  api_base: string | null;
  uses_native_auth: boolean;
  execution_enabled: boolean;
  can_test: boolean;
  test_blockers: string[];
  test_checks: { name: string; ok: boolean; detail: string }[];
  test_result: {
    message: string;
    logs: { at: string; kind: string; message: string }[];
  } | null;
};
export function useLLMProfiles() {
  const [profiles, setProfiles] = useState<LLMProfile[]>([]);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = await api<LLMProfile[]>("llm-profiles");
        if (alive) setProfiles(data);
      } catch {
        if (alive) setProfiles([]);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return profiles;
}
