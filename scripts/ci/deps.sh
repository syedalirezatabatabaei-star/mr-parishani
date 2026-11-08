#!/bin/sh
# Known-vulnerability scan of the lockfile against the OSV database.
. "$(dirname "$0")/lib.sh"

run_scanner "$OSV_SCANNER_IMAGE" scan source --lockfile /src/pnpm-lock.yaml
