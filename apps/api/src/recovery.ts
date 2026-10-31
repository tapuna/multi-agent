import { transaction } from "./db.js";
import { profiles, fingerprint } from "./profiles.js";
import { emit } from "./workflows.js";
export async function recover() {
  await transaction(async (tx) => {
    for (const r of await tx.all(
      "workflow_runs",
      "STATUS IN ('queued','running')",
    )) {
      await tx.update("workflow_runs", r.id, {
        status: "interrupted",
        error: "Application restarted. Resume from the durable checkpoint.",
      });
      for (const s of await tx.all("workflow_steps", "RUN_ID=? AND STATE=?", [
        r.id,
        "running",
      ])) {
        await tx.update("workflow_steps", s.id, { state: "interrupted" });
        await tx.update("agent_sessions", s.session_id, {
          state: "interrupted",
        });
      }
      await emit(tx, r, "workflow.interrupted");
    }
    for (const c of await tx.all("agent_conversations", "STATUS=?", [
      "running",
    ])) {
      if (c.active_message_id)
        await tx.update("agent_messages", c.active_message_id, {
          state: "interrupted",
        });
      await tx.update("agent_conversations", c.id, {
        status: "idle",
        active_message_id: null,
        error: "Application restarted; send a fresh request",
        provider_session_id: null,
      });
      await tx.audit("system:chat", "agent.chat.interrupted", {
        conversation_id: c.id,
      });
    }
    for (const d of await tx.all("agent_diagnostics", "STATUS=?", [
      "running",
    ])) {
      await tx.update("agent_diagnostics", d.id, {
        status: "interrupted",
        active_agent_id: null,
        result: {
          message: "Application restarted; test again",
          response_verified: false,
        },
      });
      await tx.audit("system:diagnostics", "agent.diagnostic.interrupted", {
        test_id: d.id,
        agent_id: d.agent_id,
      });
    }
    for (const r of await tx.all("llm_readiness")) {
      const p = profiles().find((p) => p.id === r.profile_id);
      if (r.status === "running") {
        await tx.update("llm_readiness", r.profile_id, {
          status: "interrupted",
          result: { message: "Application restarted; test again" },
        });
        await tx.audit("system:llm-setup", "llm.profile.interrupted", {
          profile_id: r.profile_id,
        });
      } else if (
        r.status === "passed" &&
        (!p?.enabled || r.config_hash !== fingerprint(p))
      ) {
        await tx.update("llm_readiness", r.profile_id, {
          status: "stale",
          result: {
            message:
              "Profile changed, disabled or runtime migrated; test again before use",
          },
        });
        await tx.audit("system:llm-setup", "llm.profile.invalidated", {
          profile_id: r.profile_id,
        });
      }
    }
  });
}
