# Local environment

What the API, the worker and the command-line tools need in `.env` to start locally. Copy
`.env.example` to `.env` and fill it in; `.env` is git-ignored and never committed (rule
29). Never paste a secret's value into an issue, a log, a commit or a chat.

## Generating a key

Every key below is **32 random bytes, base64**, and each one is different:

```sh
openssl rand -base64 32
# or, without openssl:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

A key that is not exactly 32 bytes after base64 decoding stops the app at start with
`<NAME> must be 32 bytes, base64-encoded`.

## Required for the API to start

| Variable | What it is | Without it |
|---|---|---|
| `DATABASE_URL` | Postgres as `sepehr_app` | the API does not start |
| `REDIS_URL` | Redis (sessions, rate limits, queues) | the API and the worker do not start |
| `AUTH_SECRET` | key: session tokens and CSRF | `AUTH_SECRET is not set` |
| `FIELD_ENCRYPTION_KEY` | key: encrypts national IDs, Sheba numbers, TOTP secrets (rule 27) | `FIELD_ENCRYPTION_KEY is not set` |
| `BLIND_INDEX_KEY` | key: the blind index for searching and de-duplicating encrypted identifiers (tasks 2-2, 2-5b); a **separate** key, never the same as `FIELD_ENCRYPTION_KEY` | `BLIND_INDEX_KEY is not set` (catalog and lead modules) |
| `WEB_ORIGINS` | origins allowed to send cookie requests, comma-separated | cookie requests from the web apps are refused |
| `NODE_ENV` | `development` locally | — (`production` makes `REPORTING_DATABASE_URL` required) |

Changing `BLIND_INDEX_KEY` makes every stored blind index stale: duplicate checks and
searches by national ID, legal ID or Sheba stop matching. Locally that only matters for
data you want to keep; on a real server it needs a planned re-index (docs/09, notes
before deployment).

## Required for the database tools

| Variable | Used by |
|---|---|
| `DB_ADMIN_URL`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_REPORT_PASSWORD` | `pnpm db:bootstrap` (creates the roles) |
| `MIGRATION_DATABASE_URL` | `pnpm db:migrate` (as `sepehr_owner`) |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `REDIS_PORT` | `docker compose` |

Docker pulls through a domestic registry mirror (Docker Desktop → Settings → Docker Engine →
`registry-mirrors`, e.g. `https://docker.arvancloud.ir`): Docker Hub's CDN refuses Iran.

## Optional

| Variable | Default and effect |
|---|---|
| `REPORTING_DATABASE_URL` | empty: reports read `DATABASE_URL` with a warning (no replica locally) |
| `TRUST_PROXY` | empty: the socket peer is the client IP |
| `SMS_PROVIDER` | `fake` prints OTP codes (development only); `kavenegar` needs `KAVENEGAR_API_KEY`, `KAVENEGAR_OTP_TEMPLATE` |
| `KAVENEGAR_SENDER` | Kavenegar sender line for appointment SMS (task 2-6); empty: the worker still starts and login codes still go out, but appointment texts fail after the queue's retries and are never sent after the appointment starts. With `SMS_PROVIDER=fake` it is not needed (texts are printed with the mobile masked) |
| `ALERT_SMS_MOBILES`, `KAVENEGAR_ALERT_TEMPLATE` | on-call SMS for critical alerts; required in production |
| `ALERTMANAGER_WEBHOOK_PORT`, `ALERTMANAGER_WEBHOOK_TOKEN`, `ALERTMANAGER_WEBHOOK_HOST` | the worker's receiver for Alertmanager (task 10-3): the Prometheus rules' critical alerts texted to the same on-call numbers, by name only. Both or neither; token at least 32 characters; host `127.0.0.1` unless set. Locally: empty (off) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty: no telemetry |
| `LEAD_WEBHOOK_SECRETS_WORDPRESS` | the WordPress webhook's HMAC secrets, `new,old`, each at least 32 characters (task 2-5b); empty: the webhook answers 503 |
| `PORT` | API port, default 3000 |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_PRIVATE_BUCKET`, `S3_PUBLIC_BUCKET`, `S3_PUBLIC_BASE_URL` | profile media storage (task 2-8): all set or none (a half-set configuration stops the API at start); none: uploads answer 503 `storage_unavailable`. Locally the `seaweedfs` service (any key and secret; values in `.env.example`). `S3_PORT` is the compose port |
| `CLAMAV_HOST`, `CLAMAV_PORT` | clamd for every upload (task 2-8, rule 28); empty host: media uploads, the lead Excel import and the center import answer 503 `scanner_unavailable`. Locally the `clamav` service, about a minute to load its signatures |
| `FFMPEG_PATH`, `FFPROBE_PATH` | only when `catalog.profile_video_hosting` is `self`: the worker makes HLS with them; empty: such videos are rejected (`processing_failed`) |

## Order for a fresh machine

```sh
cp .env.example .env   # fill in the values above
docker compose up -d --wait
pnpm install
pnpm db:bootstrap
pnpm db:migrate        # ask the project owner first on a shared database
pnpm catalog:rebuild-search              # dry run: fills nothing, prints a report
pnpm catalog:rebuild-search -- --apply   # fills the search index (ask first, like migrate)
```

The public search (task 2-7) is behind the `catalog.search_enabled` flag, off after the
migration. Its index is kept current by the worker's event consumer and refresher, so
the worker must be running for search results to follow changes.

The integration tests do not use `.env`: they start their own Postgres and Redis
containers and generate their own keys.
