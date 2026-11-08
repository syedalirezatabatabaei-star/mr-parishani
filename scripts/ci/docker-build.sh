#!/bin/sh
# Builds the production image of every service and app. Images are not pushed anywhere.
# TODO(decision): image registry and tagging scheme for deployment.
. "$(dirname "$0")/lib.sh"

tag=${IMAGE_TAG:-local}
for app in api worker; do
  docker build --build-arg APP="$app" --target "$app" -t "sepehr-$app:$tag" .
done
for app in web admin; do
  docker build -f Dockerfile.next --build-arg APP="$app" -t "sepehr-$app:$tag" .
done

# The worker's image prints a contract to PDF with its own Chromium, as the node user.
docker run --rm --network none -v "$REPO_ROOT/scripts/ci/pdf-smoke.mjs:/tmp/pdf-smoke.mjs:ro" \
  "sepehr-worker:$tag" node /tmp/pdf-smoke.mjs
