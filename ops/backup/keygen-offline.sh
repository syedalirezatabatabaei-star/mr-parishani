#!/usr/bin/env bash
# Makes the backup key pair on an OFFLINE machine (no network), with the three holders present
# (owner 1405/08/02: two of three). Writes:
#   OUT_DIR/recipient.txt   the public key: copy it to the server (BACKUP_AGE_RECIPIENT_FILE);
#   OUT_DIR/share-1.txt … share-3.txt   one Shamir share per holder (any two rebuild the key).
# The private key itself exists only in memory-backed temporary storage for the seconds the
# split takes, and is destroyed; it is never written to OUT_DIR, never printed.
# Each share goes on its own medium (paper or an encrypted USB stick), in a sealed envelope in a
# locked fire-proof cabinet, one per holder; then OUT_DIR's share files are destroyed (burn).
. "$(dirname "$0")/lib.sh"
need OUT_DIR
mkdir -p "$OUT_DIR"
[ -e "$OUT_DIR/recipient.txt" ] && die "OUT_DIR already holds a key; use a new, empty directory"

TMP=${KEY_TMP:-$(mktemp -d /dev/shm/sepehr-key.XXXXXX 2>/dev/null || mktemp -d)}
trap 'burn "$TMP/key.txt" "$TMP/secret.txt"; rmdir "$TMP" 2>/dev/null || true' EXIT

$AGE_KEYGEN -o "$TMP/key.txt" 2>/dev/null
$AGE_KEYGEN -y "$TMP/key.txt" > "$OUT_DIR/recipient.txt"
grep '^AGE-SECRET-KEY-' "$TMP/key.txt" > "$TMP/secret.txt"
# -q: no prompt; -w: a label on each share (no "-": ssss splits the share on it); the shares go
# to files, never the terminal.
$SSSS_SPLIT -t 2 -n 3 -w sepehrbackup -q < "$TMP/secret.txt" > "$TMP/shares.txt"
for i in 1 2 3; do
  sed -n "${i}p" "$TMP/shares.txt" > "$OUT_DIR/share-$i.txt"
  [ -s "$OUT_DIR/share-$i.txt" ] || die "share $i is empty"
done
# Every pair of shares must rebuild the very key, checked silently before anyone leaves.
for pair in "1 2" "1 3" "2 3"; do
  set -- $pair
  cat "$OUT_DIR/share-$1.txt" "$OUT_DIR/share-$2.txt" | $SSSS_COMBINE -t 2 -q 2> "$TMP/check.txt" || true
  if ! cmp -s "$TMP/check.txt" "$TMP/secret.txt"; then
    burn "$TMP/check.txt" "$TMP/shares.txt"
    die "shares $1 and $2 do not rebuild the key; destroy OUT_DIR and start again"
  fi
  burn "$TMP/check.txt"
done
burn "$TMP/shares.txt"
log "key pair made: recipient.txt and three shares in OUT_DIR, every pair checked (no key printed)"
