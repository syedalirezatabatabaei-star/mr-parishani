#!/usr/bin/env bash
# Shared by the backup scripts (ADR-052 era, owner 1405/08/03). Nothing here ever prints a key,
# a key share, a password or a database URL. Every command can be replaced through the
# environment (for a test through containers); on the server the defaults are the real tools.
set -euo pipefail
umask 077

AGE=${AGE:-age}
AGE_KEYGEN=${AGE_KEYGEN:-age-keygen}
SSSS_SPLIT=${SSSS_SPLIT:-ssss-split}
SSSS_COMBINE=${SSSS_COMBINE:-ssss-combine}
PG_DUMP=${PG_DUMP:-pg_dump}
PG_DUMPALL=${PG_DUMPALL:-pg_dumpall}
PG_RESTORE=${PG_RESTORE:-pg_restore}
PSQL=${PSQL:-psql}
CREATEDB=${CREATEDB:-createdb}
DROPDB=${DROPDB:-dropdb}

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
need() { [ -n "${!1:-}" ] || die "$1 is required"; }

# Overwrites then removes a file that held key material (best effort on copy-on-write disks).
burn() {
  for f in "$@"; do
    [ -e "$f" ] || continue
    if command -v shred >/dev/null 2>&1; then shred -u "$f"; else rm -f "$f"; fi
  done
}
