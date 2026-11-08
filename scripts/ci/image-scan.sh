#!/bin/sh
# Known-vulnerability, secret and misconfiguration scan of the production images (task 9-2/9-3,
# R16), after docker-build.sh. Fails on any CRITICAL or HIGH finding. The vulnerability
# databases come from GitHub's registry: mirror.gcr.io refuses requests from Iran (403).
. "$(dirname "$0")/lib.sh"

tag=${IMAGE_TAG:-local}
for app in api worker web admin; do
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v sepehr-trivy-cache:/root/.cache \
    "$TRIVY_IMAGE" image \
    --db-repository ghcr.io/aquasecurity/trivy-db:2 \
    --java-db-repository ghcr.io/aquasecurity/trivy-java-db:1 \
    --scanners vuln,secret,misconfig \
    --severity CRITICAL,HIGH \
    --exit-code 1 \
    "sepehr-$app:$tag"
done
