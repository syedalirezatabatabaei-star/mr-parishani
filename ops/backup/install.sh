#!/usr/bin/env bash
# Installs the backup tools on the internal server (Debian or Ubuntu), from the distribution's
# own packages (an Iranian mirror), never a foreign download: age (encryption), ssss (Shamir's
# 2-of-3 split of the private key, offline machine only) and the PostgreSQL client of the
# server's major version. Run as root.
. "$(dirname "$0")/lib.sh"
PG_MAJOR=${PG_MAJOR:-17}
apt-get update -qq
apt-get install -y -qq age "postgresql-client-${PG_MAJOR}"
# ssss is needed only where the key is made or put back together (the offline machine and a
# restore); installing it on the server too keeps the restore runbook to one machine.
apt-get install -y -qq ssss
for tool in age age-keygen ssss-split ssss-combine pg_dump pg_restore; do
  command -v "$tool" >/dev/null || die "$tool is missing after install"
done
log "installed: $(age --version) and the PostgreSQL ${PG_MAJOR} client"
