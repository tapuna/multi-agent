# SQLite removal verification

The application runs on Firebird Embedded. Retired backend support has been removed from application code rather than merely changing the default URL.

## Removed

- Engine fallback, connection arguments and PRAGMA configuration.
- Model type variant and migration trigger branches for the retired backend.
- Default URL in Alembic configuration; the validated application configuration now supplies it.
- One-time importer module and `-ImportLegacy` launcher option (the actual data import already finished).
- Alternate database fixture and importer tests; persistence and Unicode tests now exercise Firebird directly.
- Installed packages `langgraph-checkpoint-sqlite`, `aiosqlite`, and `sqlite-vec`. They are absent from the dependency manifests and project virtual environment.

The existing PostgreSQL driver compatibility path is retained from the requested architecture. The primary/default database remains Firebird; unsupported drivers are rejected before opening any connection. This change does not remove Python's standard-library modules or third-party type declarations from the interpreter/toolchain.

## Verification

- Final result: **26 tests passed, no skips**. The old count included duplicated alternate-backend cases; the current suite retains the Firebird cases and adds startup/configuration rejection tests.
- All database integration tests run on real embedded Firebird with no skipped lock tests.
- Negative tests cover the retired synchronous and asynchronous URLs; none creates a file or calls the engine constructor.
- A subprocess startup test verifies that a retired URL causes a clear configuration failure instead of a fallback.
- Firebird task and JSON audit payloads with Thai/emoji content survive an independent engine connection.
- Native 5-second lock timeout, pooled reuse, transaction contention, audit immutability, dependencies and approvals remain covered.
- `pip check` reports no broken requirements after uninstalling the three adapters.
- The real launcher was restarted successfully. The live API reports `database: firebird`, `database_mode: embedded`, and `lock_timeout_seconds: 5`. All existing project/agent/task/audit records were compared before and after the restart (timestamps normalized to the same instant).

Remaining mentions in regression tests intentionally verify rejected URLs. Mentions in documentation and audit history explain the completed migration; they do not represent runnable backend support.

## Data preservation

No legacy database or backup was deleted. SHA-256 hashes for all four `.db` source/backup files under `.data` were identical before and after cleanup. Current application data stays in `.data/control.fdb`. The archived files are not read by application startup, runtime, tests or migrations.
