# Relay — Multi-Agent Engineering Control Center

A local engineering workspace built with **TypeScript, Next.js, Fastify, LangGraph JavaScript and Firebird Embedded 5**. Kanban tasks are the system of record. No separate database service or Docker is required.

## Run locally

Install **Node.js 22+ x64** and Git. From the repository root:

```powershell
npm ci
npm run setup:firebird
npm run dev
```

Open http://127.0.0.1:3000. The launcher starts both Node processes, creates temporary operator credentials when absent, and applies additive database migrations. Ctrl+C stops both processes. The database is `.data/control.fdb`. `setup:firebird` downloads checksum-pinned official engine binaries into `.data/firebird-runtime`; it installs no service. Windows x64 is locally validated. Linux x64 additionally needs `libtommath1`, `libncurses6` and `tar`; container/CI execution remains to be verified on Linux.

For a compiled local run:

```powershell
npm run build
npm start
```

Optional sample tasks: `npm run seed`, or `node scripts/dev.mjs --seed`. Existing projects are not reseeded. The PowerShell compatibility entry point remains `./scripts/dev.ps1 -Production`.

## Configure agents

1. Put `LLM_PROFILES_JSON` in the root `.env` as a JSON array. See `.env.example`. Store actual API keys in separate environment variables and reference their names with `api_key_env`.
   Agent execution defaults to off when unset. Enable it explicitly with `AGENT_EXECUTION_ENABLED=1` in local configuration when ready to run providers.
2. Restart after environment changes. Configuration → Runtime adapter setup renders each profile directly.
3. Click **Test LLM** for each desired profile. Only that specific profile becomes Ready. Tests call the configured provider and may incur charges; opening the page makes no inference calls.
4. Agent Studio → Register/Edit agent → choose a Ready profile. Assign versioned Skills per agent. Chat & context opens project-scoped conversations and context summaries. The compact Readiness control on each agent card performs an additional agent-specific test.

API adapters use a TypeScript gateway: OpenAI-compatible endpoints (including local models), native Anthropic Messages, and native Gemini GenerateContent. Built-in compatible endpoints include OpenAI, Groq, DeepSeek, Mistral and OpenRouter. For other compatible providers set `api_base` explicitly and use an `openai/` model prefix. Provider coverage is intentionally explicit; this is not a claim of compatibility with every model gateway integration. API agents are text-only; tool requests are rejected. CLI adapters support Codex, Claude Code and Gemini CLI with native login, bounded execution and provider session IDs. Native binaries and standard npm CLI shims are supported; arbitrary shell wrappers are rejected.

## Workflow and approvals

Task workflow > project default > built-in default. Templates support 1–12 steps, dependencies, parallel branches and agent overrides. Start workflow explicitly from a task. LangGraph runs up to three nodes concurrently, persists checkpoints to Firebird, saves handoffs/artifacts, and interrupts for human review. Approval checks task version, company policy and artifact digest. Merge is a separate human action, limited to a local fast-forward of reviewed generated files. No automatic push or deployment.

Each run and agent session has an isolated directory; configured Git projects use detached worktrees. Skills are standard immutable `SKILL.md` packages. Company policy is a separate mandatory envelope. Shared project memory contains supplied notes and approved run summaries. Audit records are append-only at database level.

## Migrating this checkout

The former backend has been replaced, including APIs, runtime adapters, gateway, migrations and orchestration. Existing Firebird schema through revision 0011 is adopted in place; tasks, agents, audit history, conversations and artifacts remain. New checkpoints use a separate `nodejs:` namespace. Old graph serialization is retained as history, not deserialized by JavaScript. Existing unfinished runs with incompatible frozen configuration must be cancelled and started fresh. LLM profiles must be tested again after migration because readiness hashes changed. Existing agents with literal model IDs must select a tested profile.

The old local environment folder can remain on disk but is not used. There is no application dependency on its interpreter, packages or engine path. Old code remains recoverable through Git history. Do not copy an open embedded database file as a backup; stop both processes first.

## Checks

```powershell
npm run typecheck
npm test
```

`npm test` is one focused integration smoke test: fresh Firebird schema, Unicode persistence, immutable audit, profile isolation, LangGraph checkpoint/human approval and agent context-summary chat. It uses three local HTTP contract responses and no cloud inference. The broad old test suite was retired with the replaced implementation. Testing is kept small while the operator reviews the app.

## Boundaries

This is a local single-operator application, not an Internet-facing multi-tenant service. There is no background task-claim scheduler, task comment thread, arbitrary generated command/test execution, deployment runner or production RBAC. Agents must not claim tests ran without evidence. Firebird is the only database in this build; vector search is not implemented. Optional S3 replication and container definitions exist but were not exercised in this migration. See [handoff](docs/HANDOFF.md) and [Thai guide](docs/USER_GUIDE_TH.md).
