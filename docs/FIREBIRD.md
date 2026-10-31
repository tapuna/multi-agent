# Firebird Embedded — local setup

Firebird 5.0.4 is now the default application database. `firebird-embedded==5.0.4.4` bundles the native engine inside the Python virtual environment. The application explicitly loads its runtime provider before creating or opening a database. No Windows service, Docker, global Firebird install, or database listener is required.

## Run

```powershell
cd D:\Multi-agent
.\scripts\dev.ps1
```

Open http://127.0.0.1:3000. The header reports **Firebird Embedded**, based on `/api/system`, not a hardcoded label. `/health` checks an actual database connection and reports `database: firebird`. Optional `-Seed` creates an example project only if it does not already exist.

On a new checkout, first create `.venv`, install `apps/api/requirements.lock.txt`, and run `npm ci`. Python 3.12+ and Node 22+ are recommended. On Linux the embedded runtime additionally requires the OS package providing `libtommath.so.1` (for example `libtommath1`). Windows wheel runtime DLLs are bundled.

## Data and configuration

- Default file: `.data/control.fdb`.
- `CONTROL_DATA_DIR` changes the data directory. `DATABASE_URL` explicitly overrides the default.
- Default connection is embedded with username `SYSDBA` and UTF8 encoding. Embedded access relies on filesystem permissions; it does not authenticate via a database password.
- All app processes use the same absolute `FIREBIRD_LOCK` directory, defaulting to `.data/firebird-lock`. Use the same directory if opening this database from external Firebird tools. Do not open the same database with inconsistent lock directories.
- Firebird transactions use READ COMMITTED / RECORD VERSION with a **5-second lock timeout** by default. Configure `FIREBIRD_LOCK_TIMEOUT_SECONDS` to an integer from 1 to 10 before starting the app, for example `$env:FIREBIRD_LOCK_TIMEOUT_SECONDS='5'` in PowerShell. This is a per-lock wait, not a total-query deadline. Connection checkout reapplies the transaction parameters after pre-ping, so pooled/reused connections keep the setting. Lock/serialization conflicts return HTTP 409 with `code: database_busy` and `Retry-After: 1`; the transaction is rolled back and no write is automatically replayed. `/api/system` reports the active transaction's native `lock_timeout_seconds`.
- `control.bootstrap` creates a missing file, then runs migrations. It never overwrites or resets an existing database.
- Firebird text BLOBs store serialized JSON documents. Existing API payloads remain objects and arrays.
- Embeddings are stored as JSON documents on Firebird. **Vector indexing/similarity search is not implemented.** The PostgreSQL pgvector path remains compatibility code, not the default.

## Existing data

Existing project/task/agent IDs, statuses, versions, audit payloads, and session metadata persist in Firebird. Firebird stores timestamps to 100-microsecond precision. New databases are created directly as Firebird files. Unsupported database URLs fail validation without creating or opening a file.

## Migrations and integrity

Firebird DDL must be committed before newly created relations can be used by DML. The Alembic integration creates/commits its version table and runs each revision in its own transaction. No database-wide schema reset is used.

Database triggers reject audit/event/artifact updates and deletes. Provider session identity uses a computed unique index on Firebird to allow multiple unbound sessions while rejecting duplicate bound IDs for an agent. The API translates Firebird integrity errors to HTTP 409 without exposing database details.

## Validation

- Integration tests use actual Firebird Embedded exclusively, without skipped lock cases or an alternate database fixture. Native timeout persistence across commits/pool reuse and real conflicting transactions are covered.
- Tests cover task persistence, status/dependency enforcement, stale writes, human approvals, audit mutation rejection, isolated sessions, resume metadata, Unicode JSON across connections, existing database preservation, and refusal of retired database URLs before any connection is made.
- CI now runs backend tests on Windows and Linux with Firebird Embedded, with no database service.
- Docker Compose is optional and uses the same embedded backend in the API container. Docker/Linux execution has not been locally verified on this Windows host.
- Frontend production build passed after switching the database indicator to the live `/api/system` result.
- Browser verification on Firebird: imported task RELAY-009 retained version 2 and its session/audit history; a Thai description was saved as version 3 and remained after a full reload, with a new `task.updated` audit event.
- Evidence: [Firebird board](firebird-board.jpg), [persisted task](firebird-task.jpg).
- The actual PowerShell launcher was exercised with `-Seed`: migrations ran idempotently, existing sample data was preserved, and both API and frontend started successfully.

Provider execution and LangGraph orchestration use Firebird persistence. Configure and verify runtimes before registering agents; see the [operator guide](USER_GUIDE_TH.md) and [handoff](HANDOFF.md) for current behavior and operational limits.

References: [Firebird runtime providers](https://firebird-driver.readthedocs.io/usage-guide/configuration/), [SQLAlchemy Firebird](https://github.com/fdcastel/sqlalchemy-firebird), [lock directory configuration](https://www.firebirdsql.org/docs/chunk/en/refdocs/fbconf/fbconf-environment-variables.html).
