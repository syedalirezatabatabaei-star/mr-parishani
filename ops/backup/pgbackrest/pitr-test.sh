#!/usr/bin/env bash
# Point-in-time restore test (07 §7.6; owner 1405/08/03), on staging only, never production.
#   1. writes a first marker, waits, notes T, waits, writes a second marker;
#   2. restores to T into a NEW data directory, on another port, from REPO (1, or 2: the outside
#      copy);
#   3. checks: the first marker is there, the second is not; migrations; the ledger balances;
#   4. stops the temporary server and removes its directory.
# The marker is a table of its own in a schema of its own (pitr_drill), never an application row.
# Run as postgres. Prints no secret.
set -euo pipefail
STANZA=${STANZA:-sepehr}
REPO=${REPO:-1}
DB=${DB:-sepehr}
PG_BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
PORT=${RESTORE_PORT:-55432}
DIR=${RESTORE_DIR:-/restore/pitr-$(date -u +%Y%m%d-%H%M%S)}
case "$DIR" in /restore/pitr-*) ;; *) echo "RESTORE_DIR must be under /restore/pitr-" >&2; exit 1 ;; esac
[ ! -e "$DIR" ] || { echo "$DIR exists" >&2; exit 1; }
now() { date +%s; }
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

psql -d "$DB" -v ON_ERROR_STOP=1 -qc "CREATE SCHEMA IF NOT EXISTS pitr_drill; CREATE TABLE IF NOT EXISTS pitr_drill.marker (id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now()); INSERT INTO pitr_drill.marker (id) VALUES ('before-$DIR');"
psql -d "$DB" -qc "SELECT pg_switch_wal();" >/dev/null
sleep 60
T=$(date -u +%Y-%m-%dT%H:%M:%S+00)
sleep 60
psql -d "$DB" -v ON_ERROR_STOP=1 -qc "INSERT INTO pitr_drill.marker (id) VALUES ('after-$DIR');"
psql -d "$DB" -qc "SELECT pg_switch_wal();" >/dev/null
sleep "${ARCHIVE_WAIT:-30}"
log "target time T=$T; restoring from repo $REPO"

t0=$(now)
pgbackrest --stanza="$STANZA" --repo="$REPO" --type=time --target="$T" --target-action=promote \
  --pg1-path="$DIR" restore
"$PG_BIN/pg_ctl" -D "$DIR" -o "-p $PORT -c archive_mode=off" -w -t 600 start
t1=$(now)

q() { psql -p "$PORT" -d "$DB" -Atc "$1"; }
before=$(q "SELECT count(*) FROM pitr_drill.marker WHERE id = 'before-$DIR'")
after=$(q "SELECT count(*) FROM pitr_drill.marker WHERE id = 'after-$DIR'")
migrations=$(q "SELECT count(*) FROM drizzle.__drizzle_migrations")
unbalanced=$(q "SELECT count(*) FROM (SELECT journal_entry_id FROM ledger_entries GROUP BY 1 HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE 0 END) <> sum(CASE direction WHEN 'credit' THEN amount_rial ELSE 0 END)) x")
"$PG_BIN/pg_ctl" -D "$DIR" -m fast -w stop
[ "${KEEP_RESTORE:-}" = 1 ] || rm -rf "$DIR"

log "restore to a running server: $((t1 - t0)) s"
log "marker before T: $before (must be 1) | after T: $after (must be 0) | migrations $migrations | unbalanced journals $unbalanced"
[ "$before" = 1 ] && [ "$after" = 0 ] && [ "$unbalanced" = 0 ] || { log "PITR TEST FAILED"; exit 1; }
log "PITR test passed"
