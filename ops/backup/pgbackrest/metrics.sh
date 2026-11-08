#!/usr/bin/env bash
# Every 5 minutes (systemd timer): the times of the last archived WAL and the last full backup,
# per repository, for node_exporter's textfile collector, under the names the existing alerts
# already watch (ops/alerts/platform.yml: WalArchiveStale, BaseBackupStale, SecondCopyStale,
# BackupMetricsMissing). A failed backup writes nothing new, so the alert comes from staleness.
# Needs jq. Prints no secret.
set -euo pipefail
OUT=${TEXTFILE_DIR:-/var/lib/node_exporter/textfile}/sepehr_backup.prom
STANZA=${STANZA:-sepehr}
info=$(pgbackrest --stanza="$STANZA" --output=json info)

# The newest full or incremental backup's stop time, per repository key (1 or 2).
last_backup() {
  jq -r --argjson r "$1" '[.[0].backup[] | select(.database["repo-key"] == $r) | .timestamp.stop] | max // empty' <<<"$info"
}
# The newest archived WAL: pgBackRest reports the WAL range; its time is read from the archive
# directory's newest file (the repository is on a mounted disk).
last_wal() {
  local dir=$1
  find "$dir/archive/$STANZA" -type f -name '*.zst' -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1
}

base=$(last_backup 1)
second=$(last_backup 2)
wal=$(last_wal "${REPO1_PATH:-/backup/pgbackrest}")
tmp=$(mktemp "$OUT.XXXXXX")
{
  echo '# HELP sepehr_backup_last_success_timestamp_seconds The last successful backup step.'
  echo '# TYPE sepehr_backup_last_success_timestamp_seconds gauge'
  [ -n "$wal" ] && echo "sepehr_backup_last_success_timestamp_seconds{kind=\"wal\"} $wal"
  [ -n "$base" ] && echo "sepehr_backup_last_success_timestamp_seconds{kind=\"base\"} $base"
  [ -n "$second" ] && echo "sepehr_backup_last_success_timestamp_seconds{kind=\"second_copy\"} $second"
} > "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$OUT"
