# Handoff — TypeScript / Node.js

The repository uses one application language. Backend source is apps/api/src, frontend source is apps/web. See README.md and USER_GUIDE_TH.md for installation and operation. The former backend is recoverable from Git history; it is not part of the active source tree.

## Entry points

- apps/api/src/server.ts: migration, recovery, HTTP startup
- app.ts/http.ts: Fastify routes, authentication, validation and transaction boundaries
- firebird.ts/db.ts/schema.json: asynchronous native DSQL, typed documents, schema adoption and persistence
- board.ts/templates.ts: task system of record and configurable workflow defaults
- profiles.ts/agents.ts: environment profile catalog, independent real-provider readiness and agent configuration
- runtime.ts: bounded CLI adapters, provider session resume and TypeScript HTTP gateway
- workflows.ts/checkpoints.ts/execution-routes.ts: LangGraph JavaScript DAGs, durable native checkpoints, isolated artifacts and human review/merge
- knowledge.ts/chat.ts: mandatory policy, assigned standard skills, grounded conversations and context summaries
- recovery.ts: interrupted work recovery without automatic paid replay
- scripts/dev.mjs: launch both Node processes; scripts/setup-firebird.mjs: checksum-pinned local engine setup

## Running

Node.js 22+ x64 and Git are required. Run npm ci, npm run setup:firebird, then npm run dev. For compiled execution use npm run build and npm start. Optional seed is explicit. The launcher uses process-only generated operator/service keys if absent; configured keys stay in local .env. Keep localhost binding; this app is a single-operator prototype, not a public service.

Database adoption is additive. Existing tasks/agents/audit/conversations/artifacts remain. Re-test each LLM profile after migration. Old graph checkpoints remain readable as history but are not deserialized into JavaScript. Unfinished legacy runs whose frozen profile hashes differ need cancellation and a fresh run. Completed artifacts/history are preserved. Checkpoint namespaces distinguish runtimes.

## Verification and limits

Use npm run typecheck and npm test. The current test is intentionally one focused integration smoke with a real isolated Firebird file and three local HTTP contract replies. It validates profile gating, Unicode persistence, audit immutability, a full LangGraph human approval path and context-summary chat. It makes no live cloud inference requests. Former test counts apply to Git history, not the replacement backend. Expand tests after operator review or when fixing concrete regressions.

API providers: OpenAI-compatible endpoints plus native Anthropic and Gemini. Other compatible endpoints need explicit api_base. Provider-specific integrations outside this list may require an adapter. CLI executables/native logins remain the user's configuration.

Still outstanding: automatic task-claim scheduler, task comment threads, arbitrary generated command/test execution, deployment runner, multi-user production auth, vector search, PostgreSQL adapter, Linux/container runtime verification and live vendor model validation. S3 replication code is present but not exercised here. Human approval is mandatory for local merge, and deployment is not implemented. Never claim generated tests actually ran.
