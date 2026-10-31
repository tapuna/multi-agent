# Relay — Multi-Agent Engineering Control Center

Engineering handoff and current limitations: [docs/HANDOFF.md](docs/HANDOFF.md).

Next.js + FastAPI control center with **Firebird Embedded 5** as the primary database. Tasks, agents, sessions, approvals and audit history persist locally in `.data/control.fdb`. No Docker or database service is required.

## Run locally

Python 3.12+ and Node.js 22+ recommended. From PowerShell:

```powershell
cd D:\Multi-agent
# First setup only:
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r apps/api/requirements.lock.txt
npm ci

# Start the application (development):
.\scripts\dev.ps1
# Or: npm run build, then .\scripts\dev.ps1 -Production
# Optional sample project: .\scripts\dev.ps1 -Seed
```

The existing workspace already has dependencies installed and migrated Firebird data. Run only `scripts/dev.ps1`. If an earlier instance is using ports 3000/8000, stop it first. Ctrl+C stops the owned backend.

Open [Kanban](http://127.0.0.1:3000) and [API docs](http://127.0.0.1:8000/docs). The UI header reads the actual database through `/api/system` and displays **Firebird Embedded**. The launcher generates ephemeral service and human credentials if they are not already set in the process environment.

The Python driver explicitly loads the embedded engine bundled inside `.venv`; nothing is installed as a Windows service. On Linux, install the system library `libtommath1` before using the embedded runtime. Codex desktop's bundled Python can create the virtual environment if Python is not on PATH: `C:/Users/Homely/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`.

## Data

- Primary database: `.data/control.fdb`.
- Firebird backups: `.data/backups/`.
- Agent workspace directories: `workspaces/`.
- Configure the data directory with `CONTROL_DATA_DIR`; an explicit `DATABASE_URL` overrides it.
- All processes opening the same embedded database must use the same `FIREBIRD_LOCK` directory. The app uses `.data/firebird-lock` by default.

Existing project/task/agent IDs and audit/session history persist in Firebird. Unsupported database URLs are rejected before a connection or file can be created. See [Firebird setup](docs/FIREBIRD.md).

## Implemented

- Project-scoped task keys; five-column Kanban and list views; task search and priority filters.
- Task detail editing, agent assignment, priority, sprint, dependencies, sessions, approvals and audit history.
- Enforced status transitions, optimistic versions, dependency-cycle rejection and blocked transitions.
- Atomic audit writes with database triggers rejecting updates/deletes.
- Human review tied to exact task versions/artifact hashes; separate verified local Git merge. No automatic push or deployment.
- Agent registry and actual Codex, Claude, Gemini and LiteLLM API runtime adapters; provider session IDs and API conversations persist per task/agent.
- Unique workspace directory for every prepared session; company-policy envelope and digest.
- Project shared memory; portable JSON documents stored as Firebird text BLOBs. Vector similarity search is not implemented on Firebird.
- Versioned standard `SKILL.md` publishing/selection and editable Company → Team → Project → Role → Task context snapshots.
- LangGraph workflows: sequential/parallel steps, dependency handoffs, Firebird checkpoints, cancel, startup recovery and resume.
- Isolated workspaces and optional detached Git worktrees; generated file validation, file explorer and ZIP export.
- Live execution events, artifacts and active-agent board badges; optional S3-compatible artifact replication.
- Alembic migrations, test suite, lockfiles and CI for Windows/Linux embedded Firebird.

This is a local single-operator tool. The frontend proxy has operator authority. Public production hosting requires identity/RBAC, network restrictions and a security review. Embedded database access is controlled by filesystem permissions. CLI runtimes use read-only/planning modes; the app validates and writes generated proposals. Arbitrary generated shell commands are not executed, including in review/test stages. This is not an OS sandbox for hostile providers.

## Start an agent workflow

Authenticate a CLI (for example `codex login`) or configure provider credentials/local endpoint in the root `.env` using `.env.example`, then restart. In Agent Studio, register/edit agents with real model IDs. Open a task, select a workflow and agents, then click **Start workflow**. Independent roots run together; dependent stages wait for their prerequisites. Monitor shows actual `agent.started` events, names, session IDs and timestamps. Review generated artifacts and approve completion; merging is a separate human action. Runs resume from durable Firebird checkpoints. Configure reusable workflows in **Orchestration**: create/clone/edit steps and dependencies, then choose a project default. Each task can save its own workflow or inherit the default. Resolution is task → project → built-in Plan/Implement/Review; old runs retain their snapshots.

On this machine Codex CLI is installed but not logged in; Claude/Gemini CLI and provider credentials are not configured. Real cloud inference requires this account setup. See the complete [Thai usage guide](docs/USER_GUIDE_TH.md).

## Structure

```text
apps/web/                 Next.js, TypeScript, Tailwind, server-side API proxy
apps/api/control/         Modular routes, models, schemas, database and runtime interfaces
apps/api/migrations/      Core schema, audit guards and Firebird compatibility
apps/api/tests/           Firebird integration, database configuration and lock tests
contexts/                 Mandatory company policy and context layers
skills/                   Versioned SKILL.md packages
scripts/dev.ps1           Local launcher (no database service)
docs/                     Setup, migration notes and implementation status
```

## API

All `/api` routes require `X-API-Key` (service) or `X-Human-Key` (operator). The browser proxy supplies its configured human credential server-side. `/health` checks the actual database connection.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/system` | Active database engine/mode |
| GET / POST | `/api/projects` | List / create projects |
| GET / POST | `/api/tasks` | List by project / create backlog task |
| GET / PATCH | `/api/tasks/{id}` | Detail / versioned update |
| POST | `/api/tasks/{id}/dependencies` | Add acyclic dependency |
| GET / POST | `/api/agents` | List / human registration |
| PATCH | `/api/agents/{id}` | Edit runtime/model configuration |
| POST | `/api/tasks/{id}/workflows` | Start actual agent DAG |
| GET | `/api/workflows/{id}` | Steps, session IDs, events, artifacts and checkpoints |
| POST | `/api/workflows/{id}/resume` | Resume failed/interrupted execution |
| POST | `/api/workflows/{id}/cancel` | Cancel active execution |
| POST | `/api/workflows/{id}/decision` | Hash-bound human review |
| POST | `/api/workflows/{id}/merge` | Human-approved local Git fast-forward |
| GET | `/api/workflows/{id}/export` | Download generated source ZIP |
| GET / POST | `/api/skills` | List / publish standard skill packages |
| GET / PUT | `/api/contexts/{scope}/{target}` | Read / revision-checked context edit |
| POST | `/api/tasks/{id}/sessions` | Prepare isolated workspace/snapshot |
| PATCH | `/api/sessions/{id}` | Bind provider session ID once |
| GET | `/api/sessions/{id}/resume` | Resume metadata (no execution) |
| POST | `/api/tasks/{id}/approvals` | Human approval of a task version |
| GET | `/api/audit` | Recent immutable audit events |
| GET / POST | `/api/projects/{id}/memory` | Shared project knowledge |

## Validation

```powershell
cd D:\Multi-agent\apps\api
../../.venv/Scripts/python.exe -m pytest tests -q
../../.venv/Scripts/python.exe -m pip check
cd ../..
npm run build
```

Database integration tests run on actual Firebird Embedded, including native lock contention. Workflow tests cover DAG/fan-in, checkpoint/session resume, cancellation, artifact integrity, Git worktrees, human approvals and local merge. Runtime tests include real subprocesses and LiteLLM HTTP transport against a local contract server; this does not claim live cloud inference. See [implementation status](docs/IMPLEMENTATION_STATUS.md). Firebird waits up to 5 seconds per lock and returns HTTP 409 without replaying writes. Stop the frontend before building on Windows to avoid `.next` file locks.

Optional Docker Compose remains available with the embedded Firebird engine inside the API container; no separate database container is used. It has not been locally tested because Docker is unavailable. For setup details and next steps see [Firebird notes](docs/FIREBIRD.md) and [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Agent conversations

In **Agent Studio → Chat & context**, chat with each agent using its configured runtime/model. Conversations persist separately per project/agent. **Generate context summary** asks that agent to summarize known context, decisions, unknowns and next information needed. The source inventory reports included project memory, own artifacts, available skills, policy hash and budget limits; **Inspect supplied context** shows the exact frozen input. This is an evidence-based context report, not a measurement of model training knowledge. Summaries do not automatically become shared project memory. Chat is text-only and does not execute task changes. See the Thai usage guide for limits, cancellation and provider authentication.


Skills are assigned per agent in **Agent Studio → Skills**, with one pinned version per package (maximum 10). Skill Registry remains the central publishing library. Workflow steps, prepared sessions and agent chat use only that agent's assigned packages; no assignment means an empty skill set. New runs snapshot assignments and contents. The former workflow-wide skill picker is removed; legacy `skill_refs` requests return 422 with configuration guidance. `GET/PUT /api/agents/{id}/skills` supports version-checked updates.


**Agent Studio → Readiness → Test** verifies each configured agent with a tiny actual provider request. Preflight (installation/configuration) is separate from a verified fresh provider response. Tests are human-triggered, audited, isolated, bounded and may incur provider charges. Results show latency, actionable errors and stale configuration status. No project data is transmitted by a diagnostic.


Runtime lifecycle: **Configuration → Runtime adapter setup → enable/save → verify → Available → register agent**. Registration and execution reject unavailable adapters server-side. Existing agents show warnings when disabled or stale; configuration changes require a new verification. Runtime verification works before any agent exists and does not send project data. Adapters start unconfigured after this update; prior agents/history are preserved.


Set **LLM_PROFILES_JSON** in the root `.env` to a JSON array of `{id, label, runtime, model, enabled, api_base?, api_key_env?}`. See `.env.example` for a one-line value. Secrets stay in separate environment variables referenced by name. Restart, then select a profile in runtime Setup and Agent Studio. Each profile routes independently; adding supported connections does not require source edits. Literal model IDs/global environment configuration remain supported for existing agents.
