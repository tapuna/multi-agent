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
  credential_configured: boolean;
  api_base: string | null;
  uses_native_auth: boolean;
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
