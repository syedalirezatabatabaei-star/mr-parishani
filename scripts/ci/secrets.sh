#!/bin/sh
# Secret scan over the full git history. CI must check out with full depth.
. "$(dirname "$0")/lib.sh"

# The mounted repo is owned by another user inside the container; let git read it anyway.
docker run --rm -v "$REPO_ROOT:/src:ro" -w /src \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  "$GITLEAKS_IMAGE" git /src --redact --no-banner --verbose
