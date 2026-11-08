#!/usr/bin/env bash
# Restores an encrypted dump into a NEW temporary database and checks it, then drops it
# (07 §7.5, the second way; §7.6 drill). Two holders bring their shares; the key is rebuilt in
# memory-backed temporary storage only for the decryption and destroyed after.
#   SHARE_A, SHARE_B   two share files (from two different holders)
#   DUMP_FILE          an encrypted sepehr-*.dump.age
#   DRILL_DB           the temporary database: must be named sepehr_restore_drill_<something>
# Never the main database: any other name is refused, and the database must not exist yet.
. "$(dirname "$0")/lib.sh"
need SHARE_A
need SHARE_B
need DUMP_FILE
need DRILL_DB
case "$DRILL_DB" in sepehr_restore_drill_*) ;; *) die "DRILL_DB must start with sepehr_restore_drill_" ;; esac
[ "$SHARE_A" != "$SHARE_B" ] || die "two different shares are needed"

TMP=${KEY_TMP:-$(mktemp -d /dev/shm/sepehr-key.XXXXXX 2>/dev/null || mktemp -d)}
trap 'burn "$TMP/key.txt" "$TMP/secret.txt" "$TMP/shares.txt"; rmdir "$TMP" 2>/dev/null || true' EXIT
now() { date +%s.%N; }
t0=$(now)

cat "$SHARE_A" "$SHARE_B" > "$TMP/shares.txt"
# ssss-combine writes the secret to stderr: it goes to the key file, never the terminal.
$SSSS_COMBINE -t 2 -q < "$TMP/shares.txt" 2> "$TMP/secret.txt"
grep -q '^AGE-SECRET-KEY-' "$TMP/secret.txt" || die "the two shares do not rebuild the key"
cp "$TMP/secret.txt" "$TMP/key.txt"
burn "$TMP/shares.txt" "$TMP/secret.txt"
t1=$(now)

$CREATEDB "$DRILL_DB"
$AGE -d -i "$TMP/key.txt" < "$DUMP_FILE" | $PG_RESTORE --exit-on-error --no-owner -d "$DRILL_DB"
burn "$TMP/key.txt"
t2=$(now)

migrations=$($PSQL -d "$DRILL_DB" -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')
unbalanced=$($PSQL -d "$DRILL_DB" -Atc "SELECT count(*) FROM (SELECT journal_entry_id FROM ledger_entries GROUP BY 1 HAVING sum(CASE direction WHEN 'debit' THEN amount_rial ELSE 0 END) <> sum(CASE direction WHEN 'credit' THEN amount_rial ELSE 0 END)) x")
t3=$(now)
[ "${KEEP_DRILL_DB:-}" = 1 ] || $DROPDB "$DRILL_DB"

d() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }
log "key rebuilt $(d "$t0" "$t1")s | decrypt+restore $(d "$t1" "$t2")s | checks $(d "$t2" "$t3")s | total $(d "$t0" "$t3")s"
log "migrations $migrations | unbalanced journals $unbalanced"
[ "$unbalanced" = 0 ] || die "the restored ledger does not balance"
