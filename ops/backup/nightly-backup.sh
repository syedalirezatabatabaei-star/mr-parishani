#!/usr/bin/env bash
# The nightly logical backup (07-backup-restore.md §7.2): pg_dump -Fc and the roles, both
# encrypted with age for the public key only (the server never holds the private key), written
# atomically to the backup disk, then copied outside the building and checked by hash.
#   BACKUP_DB_URL              a read-only connection to the database (from the env file)
#   BACKUP_AGE_RECIPIENT_FILE  recipient.txt from keygen-offline.sh
#   BACKUP_DIR                 the backup disk
#   OFFSITE_DIR                the outside copy (a mounted encrypted disk or NAS; no foreign cloud)
# Nothing is deleted: retention waits for the legal answer (07 §7.2).
. "$(dirname "$0")/lib.sh"
need BACKUP_AGE_RECIPIENT_FILE
need BACKUP_DIR
need OFFSITE_DIR
[ -s "$BACKUP_AGE_RECIPIENT_FILE" ] || die "the recipient file is empty"
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%d-%H%M%S)
DUMP="$BACKUP_DIR/sepehr-$STAMP.dump.age"
ROLES="$BACKUP_DIR/sepehr-roles-$STAMP.sql.age"

# PG_DUMP_ARGS lets a test pass its own connection; on the server: --dbname from BACKUP_DB_URL.
if [ -n "${PG_DUMP_ARGS:-}" ]; then DUMP_ARGS=$PG_DUMP_ARGS; else need BACKUP_DB_URL; DUMP_ARGS="--dbname=$BACKUP_DB_URL"; fi
if [ -n "${PG_DUMPALL_ARGS:-}" ]; then DUMPALL_ARGS=$PG_DUMPALL_ARGS; else DUMPALL_ARGS="--dbname=$BACKUP_DB_URL"; fi

# shellcheck disable=SC2086
$PG_DUMP -Fc $DUMP_ARGS | $AGE -R "$BACKUP_AGE_RECIPIENT_FILE" > "$DUMP.part"
# shellcheck disable=SC2086
$PG_DUMPALL --roles-only --no-role-passwords $DUMPALL_ARGS | $AGE -R "$BACKUP_AGE_RECIPIENT_FILE" > "$ROLES.part"
for f in "$DUMP.part" "$ROLES.part"; do [ -s "$f" ] || die "$(basename "$f") is empty"; done
mv "$DUMP.part" "$DUMP"
mv "$ROLES.part" "$ROLES"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP")" "$(basename "$ROLES")" > "sepehr-$STAMP.sha256" )

mkdir -p "$OFFSITE_DIR"
cp "$DUMP" "$ROLES" "$BACKUP_DIR/sepehr-$STAMP.sha256" "$OFFSITE_DIR/"
( cd "$OFFSITE_DIR" && sha256sum -c --quiet "sepehr-$STAMP.sha256" ) || die "the outside copy does not match"
log "backup $STAMP: encrypted dump and roles on the backup disk and outside, hashes checked"
