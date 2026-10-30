# Engineering handoff — Relay

Prepared 2026-10-31. This document describes the delivered source, operational boundaries, and remaining work for another engineer or AI agent.

## Start here

Read [README](../README.md), [Thai operator guide](USER_GUIDE_TH.md), and [implementation history](IMPLEMENTATION_STATUS.md). The history includes older phases; the current behavior and known gaps below take precedence when assessing completion.

Relay is a working local single-operator Multi-Agent Engineering Control Center, with actual Next.js/FastAPI APIs, Firebird persistence, agent workflows and provider adapters. It is not a finished multi-user enterprise service or a production deployment.

## Architecture and key files

| Area | Location |
|---|---|
| Next.js UI / server-side credential proxy | `apps/web/app/`, `apps/web/lib/api.ts` |
| Agent cards, chat, skills, readiness, runtime setup | `apps/web/components/` |
| FastAPI application and recovery hooks | `apps/api/control/main.py` |
| Models / portable JSON document storage | `apps/api/control/models.py`, `types.py` |
| Firebird bootstrap and lock configuration | `database_config.py`, `db.py`, `bootstrap.py` |
| Kanban source of truth and optimistic versions | `routes_tasks.py`, `services.py` |
| LangGraph DAG / native Firebird checkpoints | `workflows.py`, `checkpoints.py` |
| Reusable workflows and default resolution | `workflow_templates.py`, `routes_workflow_templates.py` |
| CLI/API execution and LiteLLM gateway | `runtime.py`, `gateway.py` |
| Environment-owned LLM profile array | `llm_profiles.py`, root `.env.example` |
| Runtime verification and availability gates | `runtime_registry.py` |
| Per-agent model readiness checks | `agent_diagnostics.py` |
| Project/agent conversations and summaries | `agent_chat.py`, `routes_agent_chat.py` |
| Per-agent version-pinned skills | `agent_skills.py`, `routes_agents.py` |
| Isolated files and Git worktrees / local merge | `workspaces.py`, `routes_workflows.py` |
| Optional S3-compatible artifact replication | `storage.py` |
| Company policy, context layers and SKILL.md packages | `contexts/`, `skills/` |
| Schema migrations | `apps/api/migrations/versions/0001…0010` |
| Backend integration/regression tests | `apps/api/tests/` |
| Windows launcher / isolated local HTTP browser fixture | `scripts/dev.ps1`, `apps/api/scripts/browser_qa.py` |
| GitHub Actions configuration | `.github/workflows/ci.yml` |

Backend filenames without a directory above are under `apps/api/control/`.

## Reproduce on a fresh checkout

Use Python 3.12 and Node.js 22. On PowerShell, from the repository root:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r apps/api/requirements.lock.txt
npm ci
Copy-Item .env.example .env
# Edit .env locally. Never commit provider credentials.
npm run build
.\scripts\dev.ps1 -Production
```

Optional sample data: `.\scripts\dev.ps1 -Seed`. Development UI: `.\scripts\dev.ps1`. The launcher runs migrations before starting, binds the API/UI to loopback in production mode, and generates process-local control/human keys if absent. Stop the owned launcher with Ctrl+C. Stop the frontend before rebuilding `.next` on Windows.

UI: http://127.0.0.1:3000. API docs: http://127.0.0.1:8000/docs. Health: `/health`; authenticated `/api/system` reports the actual engine/mode and lock timeout.

Firebird Embedded runs inside the API process; no Docker or database service is required. On Linux the embedded package needs `libtommath1`. All processes using the same Firebird runtime must share `FIREBIRD_LOCK` (the application defaults to `.data/firebird-lock`). The lock wait defaults to 5 seconds and is configurable from 1–10; lock contention returns HTTP 409 without silently replaying writes.

## Provider and agent onboarding

1. Put provider keys in local environment variables. `LLM_PROFILES_JSON` accepts a JSON array of `{id, label?, runtime, model, enabled?, api_base?, api_key_env?}`. See `.env.example` for a one-line dotenv value. `api_key_env` references another variable; literal keys are not accepted in profile objects. CLI profiles use native CLI login.
2. Restart after changing `.env`. Profile metadata sent to the browser excludes credentials. API profiles use their own endpoint/key rather than silently inheriting a different profile's global connection. Existing literal model IDs/global settings retain compatibility.
3. In Configuration, enable/save a runtime adapter and verify a selected model/profile. Only verified, available adapters can be used to register/edit agents. Disabled/stale/missing runtimes produce global and per-agent warnings and are rejected server-side.
4. In Agent Studio register agents, select runtime/model profile, and assign Skills. Assignments are per agent, maximum 10 packages and one version per package. New/unassigned agents have no automatically attached skill.
5. Use the compact Readiness → Test control on each agent card to verify that particular model/profile. Test details show checks, errors and latency. No provider call occurs merely by opening a page. Actual tests may incur charges.

No live cloud-model authentication or inference was certified during implementation. Local HTTP contract providers and subprocess fixtures verify integration; they must not be represented as real AI inference. Each operator must authenticate their provider and run the readiness checks.

## Task execution and review

- Open a task and press **Start workflow**. Agents do not automatically take every To do task.
- Workflow resolution: task selection → project default → built-in Plan/Implement/Review. Custom DAGs support up to 12 steps, independent parallel roots (up to 3), handoffs and fan-in. Human review is mandatory at the end regardless of custom steps.
- Each execution has an isolated directory or optional detached Git worktree. Each step receives only its assigned agent's pinned skills; standard packages are copied into `.agents/skills/<name>/SKILL.md`.
- Provider CLI session IDs and API conversation state persist. Completed steps are reused on resume. Startup marks interrupted work without automatically replaying paid requests.
- Context, skill contents and public model/profile selections are snapshotted. Company policy cannot be overridden by lower layers. Changed profile configuration prevents a resumed run from silently using another connection.
- Generated files, events and artifacts are visible in Task detail, Workspaces and Execution monitor. Human approval is bound to the reviewed task version and artifact digest.
- Local Git merge is a separate authenticated human action. It verifies files, current policy, task version, clean repository and unchanged base revision, disables hooks/filters, and fast-forwards locally. There is no automatic push or deployment.
- Agent chat is project/agent scoped, persistent and text-only. Context summaries disclose supplied sources and truncation; they do not measure model training knowledge or automatically become shared project memory.

## Important unfinished work

1. **Automatic task claiming/scheduler is not implemented.** Moving a task to To do does not start AI. Manual Start workflow is currently required. A future scheduler needs atomic claiming, dependency/readiness checks, concurrency limits and idempotency before any provider call.
2. **Task comment threads are not implemented.** Task Activity/Audit records starts, completion and handoffs; agent findings live in artifacts. There is no human/agent conversational comment stream attached directly to tasks yet.
3. **Arbitrary generated test/shell execution is not implemented.** Test/review agents analyze evidence; their output is not proof that project tests ran. API agents are text-only and CLI agents use read-only/planning modes. Runtime adapters are not a complete OS sandbox for untrusted providers.
4. **Public multi-user production hardening remains.** Add identity/RBAC, project membership, credential scope, network isolation, distributed worker lifecycle, resource limits and operational monitoring before public exposure. The local Next.js proxy has operator authority.
5. Firebird does not provide pgvector similarity search. Project memory currently stores documents. PostgreSQL compatibility code exists, but the requested/local tested database is Firebird.
6. Docker Compose is optional and has not been executed on this host. OpenShift packaging/deployment remains future work. No production deployment was performed. S3 transport is optional; no real bucket was certified.

## Verification

Latest baseline from implementation: **83 backend tests passed** on real freshly migrated Firebird databases, production Next.js build/TypeScript passed, and dependency consistency checks passed. Browser QA verified workflows/review, agent chat/context inspection, per-agent skill assignment, runtime disable warnings, card readiness tests, and LLM array selection through an isolated local HTTP contract provider.

Handoff preparation on 2026-10-31 re-ran the backend suite (**83 passed**, two upstream deprecation warnings) and `npm run typecheck` (passed). The running frontend was left available; the production build result above is from the preceding implementation validation, not a new build during upload preparation.

Re-run from the repository root:

```powershell
Push-Location apps/api
..\..\.venv\Scripts\python.exe -m pytest tests -q
Pop-Location
npm run typecheck
# Stop a running frontend first on Windows:
npm run build
```

Tests explicitly stub provider readiness where credentials are not the unit under test; runtime-registry tests restore the actual gate. Do not weaken production availability checks to make tests pass. GitHub Actions is configured for Windows/Linux backend and Linux frontend; a configured workflow is not evidence that a remote CI run has passed.

## Files deliberately excluded from Git

- `.env` and local environment variants, provider credentials and private key files.
- `.data/`, Firebird databases/locks/backups, archived legacy databases and runtime logs.
- Agent `workspaces/`, session material, local artifacts and installed runtimes/dependencies/caches.

These local files are preserved on the original workstation; a source checkout does not contain the user's historic task board, provider sessions or credentials. Back up `.data/control.fdb` only after stopping the application, and transfer any required operational data separately through an approved private channel. Do not re-add SQLite dependencies or delete archived source databases merely because they are not used by the application.

The repository contains source, migrations, lockfiles, standard skills/context scaffolds, usage documents, screenshots, test fixtures and handoff instructions. No license is assumed on behalf of the owner.
