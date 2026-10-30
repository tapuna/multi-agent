# Implementation status — 2026-10-30

Relay executes real task workflows; it is no longer only a Kanban prototype. Firebird Embedded is the system of record and runs inside the API process. No Docker or database service is required locally.

| Module | Working implementation |
|---|---|
| Kanban | Projects, task CRUD, assignment, sprint, dependencies, optimistic versions and live workflow badges |
| Agent Studio | Register/edit roles, models and runtimes; task sessions; actual CLI session IDs; persistent API conversations |
| Context Hub | Editable company/team/project/role/task documents with revision checks; immutable execution snapshots; shared project memory |
| Skill Registry | Publish immutable versioned standard SKILL.md packages; select and pin packages per run |
| Workspaces | Isolated task/agent directories, optional detached Git worktrees, file explorer, previews and ZIP export |
| Orchestration | Actual LangGraph DAG, parallel roots, dependency handoffs, durable Firebird checkpoints, cancel, recovery and manual resume |
| Monitor | Live polling of agent start/end times, session binding, runtime events, workspace writes, artifacts and errors |
| Audit | Transactional append-only events, database guards, policy/context snapshots and version/hash-bound human decisions |
| Review/merge | Human approval to complete workflows; separate verified local Git fast-forward merge |
| Storage | Firebird + filesystem; optional S3-compatible replication with checksums and retry API |

## Verification

- Automated suite uses real freshly migrated Firebird databases. Coverage includes lock contention/timeouts, persistence, audit guards, DAG/fan-in, session resume, cancellation, recovery, artifact integrity and human approval.
- Actual Git worktree/local merge tests include dirty-repository rejection and idempotence.
- Actual subprocess tests verify JSONL events, provider session extraction, credential filtering and a deadline when a provider never reads stdin.
- LiteLLM HTTP transport tested against a local contract provider. Browser QA exercised Start workflow → plan → implement → review → human approval → completed, with persisted generated files. **The contract provider is a test fixture, not live AI inference.** Its database is isolated under `.data/browser-qa/`.
- Final result: **83 tests passed**, no skips; two upstream deprecation warnings. Frontend production build/TypeScript checks, dependency consistency and unused-import checks pass.
- Ten Alembic revisions are applied to the primary Firebird database. Existing tasks and archived source/backups are preserved. SQLite adapters/fallbacks are removed; archived `.db` files are not runtime dependencies.

## Runtime setup on this machine

Codex CLI is installed but was not logged in during validation. Claude/Gemini CLI are not installed. No provider API credentials are configured. Register an actual model in Agent Studio and authenticate its CLI, or configure a provider/local endpoint in the root `.env`, then restart. Paid cloud inference has not been tested or claimed.

## Operational boundaries

This is a working local single-operator application, not a certified enterprise deployment. The Next.js proxy holds operator authority. Public hosting requires identity/RBAC, network restrictions and a security review. CLI providers use read-only/planning modes; the app validates and materializes generated file proposals. This is not an OS sandbox for hostile providers.

No automatic deployment or push is implemented. Local merge checks approved digest, current policy, task version, generated contents, repository cleanliness and pinned revision, and disables hooks/filters. Test/review stages provide model analysis; they do not execute arbitrary generated commands. Run project tests before approving real changes.

S3 transport is tested with a stub; no real bucket was used. Docker/OpenShift deployment is not validated on this host. Firebird shared memory stores JSON documents; pgvector search is unavailable after the requested database switch. Multi-user identity, distributed workers and production deployment remain separate hardening work.

See [Thai usage guide](USER_GUIDE_TH.md), [Firebird setup](FIREBIRD.md) and [SQLite removal evidence](SQLITE_REMOVAL.md).

## Workflow configuration update

Project-scoped workflow templates now persist in Firebird (migration 0006). Orchestration provides a step editor, clone/create/edit, role or agent binding, instructions and DAG dependencies. Tasks save individual selections; omitted selections resolve task → project → system default, enforced on the backend even without explicit steps. System defaults are always available. Templates use optimistic versions, project defaults use a separate configuration version, and all changes are audited. Existing executions keep their original definition/hash/assignments. Start rejects a changed effective definition when the browser supplies expected ID/version. Human review remains mandatory.

Regression tests additionally cover three-level precedence, reset/inheritance, actual default execution, cross-project rejection, cycles/unknown dependencies/duplicate keys, human authorization, stale edits and immutable run snapshots. Runtime/model remain agent configuration, independent of workflow selection.

Browser verification also created/cloned a custom workflow, set it as the project default, saved/reset a task override, and executed the inherited definition through human approval. The isolated QA monitor shows both workflows completed.

## Agent chat and context-summary update

Migration 0007 adds persistent project/agent conversations and messages. Agent Studio exposes chat, Generate context summary, knowledge inventory, exact input snapshot inspection and cancellation. Conversations use the agent's selected runtime/model. Actual CLI provider IDs resume; API conversations replay bounded persisted history. Configuration/policy changes reset provider sessions. Restart recovery marks unfinished requests interrupted without paid replay; cancellation discards late replies.

Summary input includes mandatory company policy, team/project/role context, project memory, available skills and this agent's project artifacts (review status labeled). Inventories report actual inclusion and truncation, not a fabricated knowledge percentage. Summaries remain in conversation history and do not automatically modify shared project memory. Text-only chat cannot merge, deploy or modify task/workspace data.

Eight additional Firebird tests cover persistence, source snapshots, provider resume, scope isolation, policy/config changes, budget disclosure, failure, authorization, cancellation and recovery. Final backend result: 65 passed, two upstream deprecation warnings. Browser QA uses local HTTP contract responses; live provider authentication remains user configuration.

Browser QA also exercised per-agent chat → Generate context summary → exact source/history snapshot inspection using the configured API runtime and local HTTP contract provider. Conversation and summary survived reopening the page.


## Agent-owned skills update

Migration 0008 persists per-agent skill references and optimistic configuration versions. Agent Studio provides per-package version selection, removal and content preview. The registry is a publication library, not an automatic context source. Assignments start empty; no shared workflow-level skill is silently applied. Explicit retired workflow-level overrides are rejected with migration guidance.

Workflow/session snapshots and isolated workspace packages are specific to each assigned agent; prompts exclude other agents' skill maps. Old run snapshots are preserved. Chat/summary inventories include only assigned packages and changes reset provider binding on the next request. Four additional tests cover authorization/CAS/validation, prompt/filesystem isolation, frozen run/chat snapshots, per-agent inventory and blocked workflow-level bypass. Final suite: 69 tests passed; production frontend build passed.


## Setup readiness verification

Migration 0009 persists audited agent diagnostic requests/results. Setup groups registered agents by runtime and supports single-agent or group probes. Read-only preflight is distinct from actual auth/model verification: a fresh expected token is required for a pass. Probes use isolated empty workspaces, no project context and no existing task/chat session. Requests are bounded (API 20s/256 output tokens; CLI 30s); startup recovery never replays provider calls. Configuration fingerprints mark prior results stale without exposing keys. Auth/model/network/quota hints and sanitized runtime logs distinguish failures. Static presence of a CLI or credentials never marks a provider test passed.

Four additional Firebird tests cover fresh responses and isolation, changed configurations, wrong responses, credential redaction, preflight failures, operator authorization, duplicate exclusion and restart recovery. Total: 73 tests passed. Browser integration uses a local HTTP contract provider, not live cloud inference.


## Runtime setup and availability gating

Migration 0010 adds explicit runtime configuration, enablement, optimistic versions and fresh provider verification before agent registration. All adapters start unconfigured; no installation/key-presence heuristic silently activates them. Setup verification has its own model and works without an agent. Registered agents remain intact when their adapter is disabled. Runtime polling produces global/per-agent warnings; registration, editing, prepared sessions, new workflows/chats and execution checks enforce availability server-side. New browser workflow selections exclude unavailable adapters' agents. Disable/config changes invalidate verification; in-flight verification cannot overwrite a newer disabled configuration. CLI disappearance or changed environment fingerprints make an adapter unavailable. Authentication is only proven at the verification time, not polled with repeated paid requests.

Four real-registry tests complement stubbed infrastructure fixtures: setup-before-register, successful probe, disabled use rejection, provider-config invalidation, failed probe, missing CLI, operator authorization, CAS conflicts, startup recovery and disable race protection. Existing tests explicitly stub provider readiness rather than relying on real local credentials. Total suite: 77 passed; frontend production build passes.
Browser QA verified unconfigured selection disabled → fresh API adapter verification → registration selection enabled → adapter disabled → live global/agent warnings and disabled registration option. SDK cache environment changes are excluded from provider fingerprints; regression tested. QA used a local HTTP contract provider, not cloud inference.


## Readiness UI relocation

Agent readiness checks now appear as compact controls on each Agent Studio card: state, Test, latest timestamp/latency and expandable Test details. Setup retains runtime adapter configuration/verification. A shared page-level poll loads results only while Agent Studio is open; no provider call occurs on page load. Existing diagnostic persistence, authorization and audit APIs are unchanged.
Relocation verified in browser: Setup has zero agent readiness sections; card Test performed a fresh request through the isolated local HTTP contract provider, updated timestamp/latency, and displayed expandable preflight/result details. Production build and TypeScript checks passed. Screenshot: agent-readiness-card-qa.jpg.


## Environment-owned LLM profile array

LLM_PROFILES_JSON defines an extensible array of named API/CLI profiles. Setup and agent registration select compatible profiles from sanitized metadata. API connections resolve independent model/base URL/key-environment references; selected profiles do not inherit legacy global endpoint/key overrides. CLI profiles resolve native model IDs and use native authentication. Secrets remain environment-only. Invalid/duplicate/credential-bearing URL configuration fails validation without echoing values. Existing literal model IDs retain compatibility.

Profile references persist in existing model fields, requiring no migration. Public resolved selection and configuration hashes are recorded for workflow/chat/diagnostic traceability. Changed profile configurations prevent silently resuming old work and reset conversation provider binding. Six additional tests cover metadata redaction, malformed arrays, per-profile endpoint/key routing, model allowlists, CLI/runtime compatibility, credential rotation, frozen workflow snapshots/resume rejection and conversation reset. Final suite: 83 passed; frontend production build passes.
Browser QA verified three array entries (two enabled profiles, one disabled), Setup selection/verification with the main profile, registration using the distinct review profile, and a successful fresh readiness response for that agent via the local HTTP contract provider. No live cloud inference is claimed. Screenshot: llm-profile-array-qa.jpg.
