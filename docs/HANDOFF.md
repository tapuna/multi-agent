# Handoff — Relay / Node.js

Updated: **2026-10-31 (Asia/Bangkok)**. Repository: https://github.com/tapuna/multi-agent, branch `main`. The backend implementation baseline is migration commit `159f4be`; this handoff documents the current source and local operating state.

## Start here

Read README.md, .env.example and this file before continuing. The application uses **TypeScript + Next.js + Fastify + LangGraph JavaScript + Firebird Embedded**. Use the current implementation rather than rebuilding it from the original architecture request. No Python application, PostgreSQL service or external LLM gateway is required by this build.

The operator wants to inspect the app manually and has requested **minimal testing**. For documentation-only changes, validate examples/links; do not rebuild or run model tests. For code changes, run targeted checks and build/type checks as needed. Extend the smoke test only for a concrete regression.

## Current local state

Read-only verification on 2026-10-31 through the Next.js proxy:

| Item                | Observed value                                    |
| ------------------- | ------------------------------------------------- |
| UI / API            | `http://127.0.0.1:3000` / `http://127.0.0.1:8000` |
| Backend             | `nodejs`                                          |
| Database            | Firebird Embedded 5.0.4                           |
| Record lock timeout | 5 seconds                                         |
| Existing data       | 1 project, 9 tasks, 3 agents, 0 workflow runs     |
| Agent execution     | Disabled                                          |

These are a dated observation, not seeded defaults. The running app uses Node 24 from the desktop's bundled runtime. The system PATH previously selected Node 20; ensure `node --version` is 22+ before running npm launch commands in a new terminal. No global Node upgrade was performed.

This machine's running process points `FIREBIRD_RUNTIME_DIR` at `.data/firebird-node-standalone`, independently downloaded and SHA-256 verified. The normal installer/default location is `.data/firebird-runtime`, also present on this machine. Do not hard-code the desktop bundle's absolute Node path into application source.

An offline copy made before launching Node is `.data/control.before-node-20261031.fdb`. Local database, engine binaries, `.env`, workspaces and source ZIPs are ignored by Git. The source ZIP `.data/relay-source-handoff.zip` is refreshed from committed HEAD; it contains source only.

## Run and configure

Use Node.js 22+ x64, npm and Git. Run the README commands from the repository root. Copy `.env.example` only if `.env` does not exist; never overwrite an operator's credentials. Run `npm run setup:firebird` once, then `npm run dev`. Compiled operation is `npm run build` followed by `npm start`.

The launcher starts both processes, generates operator/service keys in process environment if absent, and binds to loopback. It uses port 8000 for API readiness and 3000 for UI; do not assume arbitrary port overrides work through this combined launcher. `.env` is loaded without overriding values already in process environment.

`AGENT_EXECUTION_ENABLED=0` and `LLM_PROFILES_JSON=[]` are the example defaults. To use providers, the operator explicitly configures execution enablement, a profile array and credentials, restarts, then clicks Test LLM for each profile. Each profile needs its own passing result before agent registration/editing or execution. A passing profile never unlocks another on the same runtime. Credentials are resolved on the backend and excluded from public profile metadata.

Do not restore static sample CONTROL keys or legacy global `LLM_API_BASE`/`LLM_API_KEY` instructions as the standard setup. Some compatibility code remains internally; normal operation is profile based. Profile API endpoints must omit credential/query/fragment components. CLI profiles use native login and contain neither api_base nor api_key_env.

## Code map

CLI profiles may omit model (or leave it blank). Internally it resolves to an empty model string; adapters omit --model and public catalog displays CLI default with model_selection=provider_default. API profiles still require a nonempty model. Do not invent an actual resolved model ID for a CLI default; provider selection is not observed here. Codex retains --ignore-user-config and the read-only/approval restrictions, so this does not inherit a user's config.toml model setting. Pin a model explicitly for repeatability. Three focused no-inference profile/argument checks cover defaults, explicit pins, resume IDs and API validation.

The operator has now created root .env. After restart, /api/llm-profiles confirms code / Coding CLI / codex / CLI default, installed=true, status=not_tested. Execution remains disabled per that file. Do not print its credential values or replace it with the example template. This follow-up compiled the backend and ran only the three focused profile checks, not the integration smoke or cloud inference.

| Concern                                                      | Source                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| HTTP startup, recovery, app wiring                           | `apps/api/src/server.ts`, `app.ts`, `recovery.ts`                            |
| Authentication, strict input validation, transaction wrapper | `http.ts`, `config.ts`                                                       |
| Native DSQL, parameter binding, lock wait                    | `firebird.ts`                                                                |
| Typed row/JSON persistence and schema adoption               | `db.ts`, `schema.json`, `migrate.ts`                                         |
| Kanban CRUD, dependencies, transitions, audit                | `board.ts`                                                                   |
| Workflow definitions/defaults/overrides                      | `templates.ts`                                                               |
| Profile catalog/fingerprints and agent readiness             | `profiles.ts`, `agents.ts`                                                   |
| CLI adapters and native HTTP LLM gateway                     | `runtime.ts`                                                                 |
| LangGraph DAG, runtime checks, artifacts and review          | `workflows.ts`, `checkpoints.ts`, `execution-routes.ts`                      |
| Context, immutable skill versions, grounded chat/summary     | `knowledge.ts`, `chat.ts`                                                    |
| Git worktrees, bounded file operations, S3 replication       | `workspaces.ts`, `storage.ts`                                                |
| Frontend and same-origin credential proxy                    | `apps/web/app`, `apps/web/components`, `apps/web/app/api/[...path]/route.ts` |
| Combined launcher and pinned Firebird installer              | `scripts/dev.mjs`, `scripts/setup-firebird.mjs`                              |
| Focused migration smoke                                      | `apps/api/tests-node/migration.test.ts`                                      |

Backend source changes require a restart in the root dev launcher. For a backend watch process use its workspace dev script, but configure authority keys explicitly and start the frontend with the same human key. The root launcher is the supported simple path.

## Invariants to preserve

- Kanban is the task system of record. Audit task transitions and agent/session/provider actions; database triggers reject audit updates/deletes.
- Company policy is a separate mandatory envelope. Task/project/agent/skill instructions cannot override it. Approval checks policy, task version and artifact digest.
- Workflow selection precedence: explicit request, task, project, built-in. The UI shows the effective workflow and agent choices before Start. Steps follow dependency order, up to three concurrent nodes.
- Each task execution has an isolated workspace; Git projects use detached worktrees from a clean repository. Agent output may only write bounded, reviewed paths. Keep filesystem traversal/symlink/protected-path checks.
- Provider session IDs persist in task sessions and project/agent chat conversations. Do not invent IDs or silently reuse a session after its provider binding changes.
- Skills are assigned per agent, maximum 10 and one version per package; publishing a SKILL.md version is immutable. Workflows freeze the selected skill/context snapshots.
- LangGraph saves checkpoints/writes to Firebird. Restart marks unfinished work interrupted and never automatically replays paid requests.
- Human workflow review is mandatory. Local merge is a separate explicit human action with digest/base-revision checks. No automatic Git push or deployment.

## What is implemented

Persisted projects/tasks/dependencies/assignments/priorities/sprints; configurable workflow templates/defaults; agent registration/editing and independent profile readiness; per-agent diagnostics and skills; company/team/project/role/task context; shared project memory; agent chat and context summaries with supplied-source inventory; durable DAG execution/handoffs/checkpoints; execution events/artifacts/file preview/ZIP export; human review and local reviewed Git merge. Optional S3 replication code exists.

API gateway handles OpenAI-compatible endpoints and native Anthropic/Gemini APIs. Other compatible providers need an explicit endpoint; arbitrary provider-specific integrations are not implemented. CLI runtimes support native executables and standard npm shims, native login and bounded execution. They are not a general OS sandbox.

## Remaining work and known limitations

1. **No automatic task-claim worker/scheduler.** A human starts workflow from the task. Agent progress is events/artifacts, not task comments.
2. **No task comment thread.** Add one only as an explicit feature, with author identity and audit integration.
3. **No arbitrary generated shell/test execution.** API agents produce text/structured files; CLI agents use restricted modes. An agent review is not evidence that project tests ran.
4. **No deployment executor or production multi-user RBAC.** Keep this local/single operator. OpenShift and public hosting are unverified.
5. **No vector search or alternate database adapter in this build.** Firebird is authoritative.
6. **Linux/container, S3 and live vendor authentication remain unverified locally.** CI definitions exist; do not report their runs as passing without checking actual results.
7. **Launcher/configuration edges:** combined launcher uses fixed ports. setup-firebird.mjs reads process environment, not .env, for FIREBIRD_RUNTIME_DIR; supply a process variable when overriding the installer target. Changing CONTROL_DATA_DIR also changes the default engine lookup path unless FIREBIRD_CLIENT_LIBRARY/FIREBIRD_RUNTIME_DIR is explicit.
8. **Migration edge:** db.ts adopts schema through revision 0011 and records node_migrations; it is not a full future versioned SQL migration chain. Add explicit migrations as schema changes are introduced. DDL has commit boundaries; future recovery from a partially initialized fresh schema needs review.

## Validation evidence

Implementation commit 159f4be passed complete frontend/backend build and one focused integration smoke on Windows/Node 24 with independently installed Firebird. The smoke uses an isolated file and three local HTTP contract responses. It checks fresh schema, Unicode persistence, per-profile gate isolation, immutable audit, LangGraph checkpoint/approval continuation, context-summary chat and a real lock conflict returning HTTP 409/database_busy. No cloud inference was invoked.

The documentation refresh only rechecks current read-only endpoints, example parsing, links, environment names and Git diff. It does not rerun build, UI automation, smoke or provider tests. Old screenshots and old test counts are historical evidence, not validation of every current feature.

## Optional configuration, outside the normal .env template

| Variables                                                          | Purpose / caveat                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `CONTROL_DATA_DIR`, `WORKSPACE_ROOT`, `CONTEXT_ROOT`               | Override local data/workspace/context roots; use absolute paths                                  |
| `FIREBIRD_CLIENT_LIBRARY`, `FIREBIRD_RUNTIME_DIR`, `FIREBIRD_LOCK` | Native client/runtime/shared lock directory; keep consistent across maintenance processes        |
| `FIREBIRD_USER`, `FIREBIRD_PASSWORD`                               | Native connection credentials; embedded defaults to SYSDBA                                       |
| `CONTROL_HUMAN_KEY`, `CONTROL_API_KEY`                             | Explicit authority keys for manual/split-process startup; root launcher otherwise generates them |
| `API_HOST`, `API_PORT`, `API_INTERNAL_URL`                         | Separate-process/proxy configuration; combined launcher retains its fixed readiness URL/ports    |
| `ARTIFACT_S3_BUCKET`, `ARTIFACT_S3_ENDPOINT`, `ARTIFACT_S3_REGION` | Optional replication; HTTPS required outside loopback; default region us-east-1                  |
| `ARTIFACT_S3_ACCESS_KEY`, `ARTIFACT_S3_SECRET_KEY`                 | Optional S3 credentials; never expose to agents or commit                                        |

## Existing data and transfer

The Node migration preserved tasks, agents, conversations, events and artifacts. Old graph state is retained as history; JavaScript checkpoints use a separate nodejs: namespace. Re-test LLM profiles after migration. Existing agents with literal model IDs must select a tested profile. An unfinished old run whose frozen configuration no longer matches needs cancellation and a fresh run.

For transfer: source is in GitHub; use npm ci on the destination. Stop all database processes before copying .fdb. Transfer data/workspaces/context/skills only as required, and transfer credentials separately. Do not upload operational files or keys into Git. No destructive data operation or production deployment is authorized by this handoff alone.
