# Firebird Embedded

Node.js accesses Firebird's public DSQL API through prebuilt Koffi. No database service or native compilation toolchain is required on supported Windows x64 installations.

Run `npm run setup:firebird` once. The installer downloads official Firebird 5.0.4.1812-0 binaries and verifies a repository-pinned SHA-256 before extracting. Files are local to `.data/firebird-runtime`; licenses shipped by Firebird remain included. No installer executable or service is launched. Linux x64 additionally needs libtommath1, libncurses6 and tar. Linux packaging is provided but not locally exercised.

Default database: `.data/control.fdb`. Override with `DATABASE_URL=firebird://SYSDBA@/D:/path/control.fdb?charset=UTF8`. Legacy URL spelling is accepted for migration compatibility. Only local embedded paths are supported by this build. `FIREBIRD_CLIENT_LIBRARY` selects an existing native client library; `FIREBIRD_RUNTIME_DIR` selects the downloaded runtime directory.

Transactions use READ COMMITTED RECORD_VERSION and a bounded lock wait, default 5 seconds. Set `FIREBIRD_LOCK_TIMEOUT_SECONDS=1..10`. Lock conflicts return HTTP 409 with database_busy and Retry-After. Writes are not automatically replayed.

Existing schemas through revision 0011 are adopted without dropping tables or clearing data. New installs create the app schema, foreign keys/unique constraints and the immutable audit trigger. JavaScript checkpoints use nodejs: namespaces to avoid interpreting old serialized graph state.

Stop all processes attached to the file before copying it as a backup. Keep workspaces and context/skill files alongside database backups. Do not start the previous backend against the same file while Node.js runs.
