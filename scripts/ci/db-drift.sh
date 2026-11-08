#!/bin/sh
# Fails when the Drizzle schema (apps/api/src/db/schema.ts) has changes that no committed
# migration covers, or when the migration journal is inconsistent. Runs in `lint`.
# Locally, a failure leaves the drafted migration in apps/api/drizzle for review (ADR-003).
set -eu
cd "$(dirname "$0")/../../apps/api"

pnpm exec drizzle-kit check

before=$(git status --porcelain --untracked-files=all -- drizzle)
pnpm exec drizzle-kit generate --name schema_drift >/dev/null
after=$(git status --porcelain --untracked-files=all -- drizzle)

if [ "$before" != "$after" ]; then
  echo 'The schema has changes without a migration. drizzle-kit drafted one:' >&2
  git status --porcelain --untracked-files=all -- drizzle >&2
  echo 'Review and edit the draft, rename it, and commit it with the schema change.' >&2
  exit 1
fi
echo 'Schema and migrations are in sync.'
