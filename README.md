# Sepehr Salamati

Treatment credit platform. Project rules are in `CLAUDE.md`; specifications are in `docs/`.

## Local development

```sh
cp .env.example .env   # then change the values
docker compose up -d --wait
pnpm install
pnpm db:bootstrap   # database roles (once, and again to rotate passwords)
pnpm db:migrate     # apply migrations
```

Which variables `.env` needs, and how to generate the keys: `docs/local-environment.md`.

### Ports

Ports come from `.env` and are never hardcoded. `.env.example` uses the standard ports:

| Service  | Variable        | Default |
| -------- | --------------- | ------- |
| Postgres | `POSTGRES_PORT` | 5432    |
| Redis    | `REDIS_PORT`    | 6379    |

If a port is already taken on your machine (for example by a natively installed
PostgreSQL), change it in your own `.env` only, e.g. `POSTGRES_PORT=5434`, and use the
same port in any connection string. Do not change `.env.example`.

## Database

Postgres 17 with Drizzle ORM (ADR-003). Code is in `apps/api/src/db`; migrations are in
`apps/api/drizzle`.

### Roles

| Role            | Used by                                            | Allowed                                       |
| --------------- | -------------------------------------------------- | --------------------------------------------- |
| superuser       | `db:bootstrap` (`DB_ADMIN_URL`)                    | create the roles below, set passwords         |
| `sepehr_owner`  | `db:migrate` (`MIGRATION_DATABASE_URL`)            | own the schema, run migrations                |
| `sepehr_app`    | the API (`DATABASE_URL`)                           | `SELECT`, `INSERT`, `UPDATE`; nothing else    |
| `sepehr_report` | reports, reconciliation (`REPORTING_DATABASE_URL`) | `SELECT` on the ledger and report tables only |

`sepehr_app` has no `DELETE`, `TRUNCATE` or DDL on any table. Append-only tables (ledger,
audit) also revoke `UPDATE` in their own migration (ADR-004). Passwords come only from
the environment; `db:bootstrap` is idempotent and also rotates them.

### Base rules for every table

Build tables from the helpers in `apps/api/src/db/columns.ts`:

- `id()`: `uuid` primary key, default `uuidv7()` in the database.
- `timestamps()`: `created_at`, `updated_at` and `deleted_at` (`timestamptz`). Rows are
  never deleted; set `deleted_at`. The table's migration must attach the
  `set_updated_at()` trigger.
- `appendOnlyTimestamps()`: `created_at` only, for tables that are never updated.
- `rial('..._rial')`: money as `bigint`, read as a JS `bigint`.
- `timestamptz('..._at')`: every point in time. Database sessions run in UTC.

A unit test checks every table in `src/db/schema.ts` against these rules, and an
integration test checks the migrated database itself.

### Migrations

1. Change the schema in the owning module and export the table from `src/db/schema.ts`.
2. `pnpm db:generate` drafts a migration in `apps/api/drizzle`. Review and edit it by hand
   (triggers, grants, data moves) before committing it with the schema change.
3. `pnpm db:migrate` applies it. The API never migrates itself on start.

- **Expand/contract only:** add the new column or table first; drop the old one several
  releases later, once no running version uses it.
- `pnpm run lint` fails when the schema has changes that no migration covers.

## Login and sessions

Code is in `apps/api/src/modules/identity`; every limit and lifetime is in
`identity.policy.ts` (to move to versioned configuration in task 0-6).

- **Patients:** one-time code by SMS (`POST /auth/otp/request`, then `/auth/otp/verify`).
  The first successful login creates the account and links it to the patient's `Person`.
  Sending is limited per mobile, IP and device; the 6th wrong code locks the mobile for
  15 minutes.
- **Staff and centers:** password (argon2id), then TOTP, which is mandatory
  (`/auth/staff/login`, `/auth/totp/enroll`, `/auth/totp/verify`). A lost TOTP device is
  reset by a system administrator and approved by a second one.
- **Web:** `__Host-sid` cookie (HttpOnly, Secure, SameSite=Lax). State-changing requests
  need an origin from `WEB_ORIGINS` and the `X-CSRF-Token` header (from the login
  response or `GET /auth/me`).
- **Mobile:** `Authorization: Bearer` access token (10 minutes) and a one-time refresh
  token (`POST /auth/refresh`). Reusing a refresh token ends the whole session.
- **Devices:** `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/logout`,
  `POST /auth/logout-all`.
- **Default deny:** every endpoint declares `@Public()`, `@SelfService()`,
  `@AllowPendingMfa()` or `@RequirePermission(code)`; the API refuses to start if one
  does not. See "Access and audit" below.

SMS goes through a BullMQ queue to the worker (`apps/worker/src/sms`), which retries with
backoff and a 10-second timeout per call. `SMS_PROVIDER=kavenegar` sends real SMS;
`SMS_PROVIDER=fake` prints the code in the worker's console and works only with
`NODE_ENV=development`.

To run locally, start both the API and the worker (`pnpm --filter @sepehr/api start`,
`pnpm --filter @sepehr/worker start`). Create the first staff account with:

```sh
ACCOUNT_KIND=staff ACCOUNT_USERNAME=admin ACCOUNT_PASSWORD='…' pnpm account:create
ACCOUNT_ID=<id printed above> ROLE_CODE=system_admin GRANT_REASON='…' pnpm access:grant
```

## Access and audit

Task 0-5, doc 04. **Permissions** are code (`PERMISSIONS` in `@sepehr/contracts`, mirrored
in the `permissions` table by migrations; the API refuses to start while they differ).
**Roles** are data: the system roles of doc 04 come from migration `0002_access` and are
locked; administrators build their own roles next to them. A role is assigned within a
**scope**: global, a city, a center or doctor node (with everything under it), a team
work queue, or the user's own records.

- Access is resolved from the database on every request, never cached: a role change
  applies to active sessions at once.
- The center tree (`org_nodes`: center → doctor → secretary) uses `ltree` paths. A
  secretary is capped by their doctor in code; the collection role never sees the
  treatment, whatever else it holds.
- Row-level security on `org_nodes` is the second line of defense: the application must
  set the scope for the transaction, or it sees nothing.
- Sensitive response fields (`SENSITIVE_FIELD_CLASSES`) are stripped from every response
  of a caller without the matching permission.
- The internal panel's IP allow-list and the audit retention are versioned
  configuration (see below).
- `audit_events` is append-only, hash-chained (`GET /audit/verify`) and partitioned by
  month; `access_logs` records who viewed what. Run `pnpm ops:partitions` at least
  monthly to create coming partitions and archive (detach, never drop) those past the
  retention.

## Versioned configuration

Task 0-6, ADR-006. Rates, limits and settings are data, not code. **Keys** are code
(`CONFIG_KEYS` in `@sepehr/contracts`: each with its value schema, allowed levels,
category and sensitivity), mirrored in `config_keys` by migrations. **Values** are
versions in `config_values`, each starting at `effective_at`.

- `resolve(key, scope, at)` (the `CONFIG` port) returns the value of the most specific
  level: doctor → center → treatment field → city → global. A `null` value withdraws a
  level. Nothing reads the tables directly; a test fails if anything outside the config
  module names them.
- A value never starts in the past, and a proposal approved after its start expires, so
  the value in effect at a past moment never changes. Records lock to the `versionId`
  they used and read it back with `getVersion`.
- Every change is proposed and then approved by a second person (all keys are sensitive
  for now), and both steps are audited. Business keys need `config.manage_business`
  (strategy), technical ones `config.manage_technical` (system administration).
- Endpoints: `GET /config/keys`, `GET /config/keys/:key/versions`, `GET /config/resolve`,
  `POST /config/proposals`, `POST /config/proposals/:id/approve|reject`.

## Events, queues and monitoring

Task 0-7, ADR-005 and ADR-016. The worker (`apps/worker`) runs the API's own modules as a
NestJS application context without HTTP (`@sepehr/api/worker`), besides SMS delivery.

- **Outbox:** a module publishes a domain event through the `OUTBOX` port in the
  transaction of its change (`outbox_events`). The worker relays unpublished events to
  BullMQ every second (job id = event id) and hands each to the consumers subscribed to
  its type. Consumers register with `EVENT_CONSUMERS`; each (event, consumer) is claimed
  in `processed_events` in the consumer's transaction, so a redelivered event takes
  effect once. Event types and payload schemas are `DOMAIN_EVENTS` in
  `@sepehr/contracts`; order is not guaranteed.
- **Scheduled jobs** (BullMQ job schedulers, once per tick across all workers): partition
  maintenance daily at 03:00 UTC for audit, access log, outbox and processed events
  (`pnpm ops:partitions` runs it by hand); the queue monitor every minute.
- **Monitoring:** `GET /health/live` and `GET /health/ready` (Postgres and Redis).
  OpenTelemetry traces and metrics go to the self-hosted collector at
  `OTEL_EXPORTER_OTLP_ENDPOINT`, and nowhere if it is unset. The monitor alerts on the
  thresholds of `ops.outbox_alert_thresholds` and `ops.queue_alert_thresholds`: logged,
  and texted to `ALERT_SMS_MOBILES` through Kavenegar (`KAVENEGAR_ALERT_TEMPLATE`), at
  most once per alert per 30 minutes. Grafana rules for the same metrics are in
  `ops/alerts/queues.yml`.
- Outbox and processed-event partitions are archived after `ops.outbox_retention`
  (6 months).

## Ledger

Task 1-1, doc 02, ADR-004, ADR-007 and ADR-017. Financial code: per ADR-008 (as amended),
it is not merged through a PR or deployed before self-hosted GitLab with a protected
`main` and a human reviewer.

- `journal_entries` and `ledger_entries` (monthly partitions) are append-only for
  everyone, the schema owner included. Amounts are `bigint` rials, positive, with the
  direction carrying the sign.
- `postJournal` (the `LEDGER` port) is the only writer. It needs an idempotency key,
  refuses unbalanced documents, locks the accounts in a fixed order, and runs in the
  caller's transaction when given one. The database checks the balance again at commit.
- Corrections are `reverseJournal`: the full opposite document, once per document.
- Balances are always sums of entries (`balanceOf`); nothing stores a balance.
- `GET /ledger/journals/:id` and `GET /ledger/accounts/:id/balance` (`ledger.read`:
  auditors and accounting) return amounts as strings. No endpoint writes.

## Credit purse (کیف اعتبار)

Task 1-2, doc 02 §3–4, ADR-018. Financial code, under the same merge rule as the ledger.
In every interface text it is «کیف اعتبار», never «کیف پول» (a test checks).

- One purse per case, with its own `purse.*` and `borrower.debt` accounts. The purse row
  is the lock; it stores no balance. Operations are logged append-only in
  `purse_operations`, and each reservation's state is derived from that log.
- Operations (the `WALLET` port, no writing endpoint): approve credit, charge (once, the
  whole amount), reserve for a service authorization, cancel a reservation, register the
  service, finalize it to the doctor's payable, hold and release a registered
  consumption, cancel what is unused, and reverse an operation. Each takes an
  idempotency key and runs under the purse's row lock.
- Hard rules in code (doc 02 §4), checked before posting and again on the result:
  available never negative, consumption never above the approved amount, services only
  from the case's center, doctor and treatment field, and no cash withdrawal at all.
- `GET /wallet/purses/:id` (`wallet.read`: accounting and the auditor).

## Installments and payments

Task 1-3, doc 02 §4–5, ADR-019. Financial code, under the same merge rule as the ledger.

- `buildInstallmentSchedule` (`@sepehr/contracts`) is pure: installments rounded down
  to the configured unit with the whole remainder on the first; installment k falls due
  k Jalali months after the funding day in Tehran, clamped to the month's last day. A
  total too small for the count is refused (never a zero installment).
- The `REPAYMENT` port: `createSchedule` (one per case, locked to the configuration
  version in force at funding; posts the plan fee), `registerReceipt` (bank slip into
  suspense), `approvePayment` (oldest outstanding installment first; surplus stays in
  suspense), `rejectPayment`, `schedule`. Installment status is derived, never stored;
  no late penalty, no early-settlement discount.
- `GET /repayment/schedules/:id` (`repayment.read`: accounting, auditor);
  `POST /repayment/payments/:id/approve|reject` (`repayment.approve_payment`:
  accounting, one person, audited).

## Reconciliation and financial health

Task 1-4, doc 02 §2 and §7, ADR-012 and ADR-020.

- `account_balances` is kept up to date from `ledger.journal_posted` events, once per
  journal. It is a fast view for reports, never the source of truth: balances for any
  decision are always sums of entries.
- Nightly at 02:00 Tehran time the worker compares it with the entries of the applied
  journals, checks that no purse or suspense account is below zero, reports each legal
  entity's debits and credits for the day and all time, and flags journals not applied
  within `ops.ledger_lag_alert`. Anything found is alerted at once (on-call SMS, logs,
  Grafana). Runs, discrepancies and daily reports are append-only and kept indefinitely.
- Reads go through the read-only `sepehr_report` role at `REPORTING_DATABASE_URL`
  (required in production; the primary database in development). The real read-only
  replica comes with the deployment phase.
- `GET /ledger/reconciliation/runs` (`ledger.read`).
- `pnpm db:bootstrap` now also needs `DB_REPORT_PASSWORD`, and must run before
  migration `0008`.

## Holiday calendar

Task 2-1, doc 08 §5, ADR-021.

- `holidays` (config module): national, or for one city by its code. Never edited: a
  wrong holiday is removed (soft delete) and entered again.
- `GET /calendar/holidays?from=&to=[&cityCode=]` is public; `POST /calendar/holidays` and
  `DELETE /calendar/holidays/:id` need `config.manage_holidays` (system admin, one
  person, audited with a reason). Days are sent as Jalali `{year, month, day}`.
- Working days are decided only by `isWorkingDay(date, cityCode, calendar)` and
  `nextWorkingDay` (`@sepehr/contracts`); modules load the calendar through the
  `HOLIDAY_CALENDAR` port. Weekly days off: `calendar.weekly_days_off` (default Friday).
- With `repayment.shift_due_to_next_working_day` on (off by default), a due day on a
  weekly day off or a national holiday moves to the next working day; amounts never move.
- Daily at 09:00 Tehran the worker checks the calendar: from 1 Bahman, while next year
  has no national holiday, a notice is open for the system admin (`GET /config/notices`,
  `config.read`) and a warning is logged, repeated weekly. No SMS.

## Centers and branches

Task 2-2, doc 08 §2–3, ADR-022.

- Centers and branches are nodes of the access module's `org_nodes` tree (a branch sits
  under a center; a doctor under a center or a branch); the catalog module places them
  through the `ORG_TREE` port. Each center gets a default branch.
- National IDs, legal-entity IDs and Sheba numbers are checked by their algorithms,
  stored only encrypted (`FIELD_ENCRYPTION_KEY`) with a blind index
  (`BLIND_INDEX_KEY`, a separate key: `openssl rand -base64 32`) that keeps them unique.
  Responses, audit and logs carry only the last four digits;
  `GET /catalog/centers/:id/bank-account` (`catalog.view_bank_account`) shows a full Sheba
  and is recorded.
- Status: `draft → under_review → needs_fix → … → active → suspended | terminated`,
  checked in the service and by a database trigger. Submission needs a bank account and
  every document of `catalog.center_document_checklist`.
- Two people: activation and reactivation are approved by a `network_manager`, a new
  bank account after activation by accounting (`POST /catalog/requests/:id/approve`);
  the proposer never decides.
- Entering a status publishes `catalog.center_submitted`, `_activated`, `_suspended` or
  `_terminated`; the `CENTER_DIRECTORY` port answers `isBookable`. Moving existing
  appointments comes with booking (task 2-6).
- A request is valid only for the status it was made in: sending back for a fix
  withdraws an open activation, termination every open request. A terminated center is
  frozen; only a never-activated draft may be soft-deleted.
- A branch manager sees only their own branch of the center: not its other branches,
  documents, requests or bank account.

## Doctors and secretaries

Task 2-3, doc 08 §2, ADR-023.

- One provider profile per doctor (`/catalog/doctors`), with or without an account; the
  medical council number is unique, the national ID encrypted like a center's.
- One `doctor` node per workplace: under a branch of an active center, or a root for a
  private practice. The network adds more workplaces and links an existing center-kind
  account, which gets the `doctor` role on every workplace node.
- A doctor is visible to whoever covers one of their workplaces; doctor A never sees
  doctor B (404). The name and fields change by whoever covers every workplace; the council
  number and national ID by the network only.
- A secretary serves one doctor at one workplace (`POST /catalog/secretaries`). A doctor
  with an account grants their role through `POST /access/org-nodes/:id/assignments`; for
  one without, the center manager uses `POST /catalog/secretaries/:id/assignments`, capped
  by the `doctor` role and by their own access.
- What a secretary or center manager does for a doctor is audited with
  `on_behalf_of_doctor_id`.

## Treatment fields, services and tariffs

Task 2-4, doc 08 §4, ADR-024.

- Fields and services (`/catalog/fields`, `/catalog/services`) are listed publicly and
  changed only with `catalog.manage_catalog` (network manager, system admin). Codes are
  unique for ever; retiring is a soft delete. The `visit` service belongs to no field.
- A tariff (`POST /catalog/tariffs`) prices a service at a doctor's workplace or at a center,
  as append-only versions with `effective_at` (never in the past). Amounts are rial strings
  on the wire and `bigint` everywhere else. Only the visit may be free.
- The price at a workplace is its own version in force, else its center's; the workplace
  always wins, a withdrawal included (`GET /catalog/workplaces/:id/quote`, port
  `TARIFF_BOOK`). A version not started yet may be cancelled
  (`POST /catalog/tariff-versions/:id/cancel`); a started one never changes.
- Prices are set by the center manager (center scope), a branch manager for their branch's
  doctors, or the doctor for their own workplace; a secretary only with their doctor's own
  delegation. The network only reads, except that the network specialist prices a private
  practice whose doctor has no account (`/catalog/network/tariffs`,
  `catalog.manage_tariff_for_unaccounted_doctor`) until the doctor gets one.
- The owner's decisions for this area: `docs/decisions/task-2-4-decisions.md`.

## Doctors' calendars and slots

Task 2-5, doc 08 §6, ADR-025. Module `booking`.

- A workplace's weekly schedule (`PUT /booking/workplaces/:id/schedule`, replaced whole)
  and its exceptions on given Tehran days (`POST /booking/workplaces/:id/exceptions`:
  `closed`, `extra`, `open_holiday`; removed softly with
  `POST /booking/exceptions/:id/remove`). Times are `HH:MM` Tehran wall-clock, 00:00–24:00.
  `GET /booking/workplaces/:id/calendar` shows all of it with the approval mode.
- Slots are never stored: `GET /booking/workplaces/:id/slots?from&to` computes them with the
  pure `computeSlots` (`packages/contracts`) from the schedule, the exceptions, the national
  and city holidays (unless opened) and the doctor's busy time, up to the booking horizon.
  The system's weekly days off do not apply to a doctor's schedule.
- One doctor is never in two places at once: overlapping ranges across their workplaces are
  refused by the database (`EXCLUDE`) with `doctor_busy_elsewhere`, naming nothing else.
- Changed with `booking.manage_own_calendar` (the doctor, or a delegated secretary),
  `booking.manage_calendar_in_scope` (center or branch manager) or
  `booking.manage_any_calendar` (Sepehr's operators); such endpoints use
  `@RequireAnyPermission`. The catalog's `WORKPLACE_DIRECTORY` port supplies the workplace.
- Approval mode per workplace (`PUT /booking/workplaces/:id/approval-mode`), append-only,
  never by a secretary; default from `booking.default_approval_mode`.
- The owner's decisions for this area: `docs/decisions/task-2-5-decisions.md`.

## Leads, persons and cases

Task 2-5b, doc 05, ADR-026. Module `lead`.

- One intake for every source (`LeadIntakeService`): the app, the WordPress webhook, the
  Excel import and an advisor (`POST /lead/intakes`). One Person per normalized mobile
  (an advisory lock per mobile); each intake is `new`, `duplicate_active`, `returning`,
  `existing_customer` or `blocked`, and recorded either way.
- Assignment by smooth weighted round-robin over versioned shares per queue, city and
  treatment field (`PUT /lead/assignment/shares`), skipping agents away or at their cap
  (`/lead/agents/:id/presence`, `/cap`); a share change restarts the counting. Manual
  assignment needs a reason. Target versus actual: `GET /lead/assignment/distribution`
  (reporting database).
- Cases (`/lead/cases`): an advisor sees their own; closing needs an abandonment reason
  from the editable list (`/lead/abandonment-reasons`; `chose_cash` is never retired).
  The case status machine is enforced in the database too.
- Persons: block and unblock, merge and revert a merge (`/lead/person-merges`,
  `lead.merge_persons`).
- `PERSON_DIRECTORY` is provided by the lead module. Patient accounts made before it:
  `pnpm lead:backfill-persons` (dry run) and `pnpm lead:backfill-persons -- --apply` (only
  after the dry run, and on a shared database only with the owner's permission). A lone
  `--` is ignored; any other unknown argument, or both modes, stops the command before it
  touches the database. The report is printed and kept in `person_backfill_runs`.
- WordPress: `POST /api/v1/leads/intake`, signed with HMAC-SHA256 over
  `<timestamp>.<body>` (`LEAD_WEBHOOK_SECRETS_WORDPRESS=new,old`), with an idempotency key,
  a replay window and rate limits; guide: `docs/integrations/wordpress-lead-webhook.md`.
- Excel import of patients and leads (`/lead/imports`): behind `lead.excel_import_enabled`,
  off until task 2-8 adds ClamAV; `.xlsx` only, read in memory with size, row and
  inflate limits; processed by the worker; a batch cancel undoes only untouched records.
- The owner's decisions for this area: `docs/decisions/task-2-5b-decisions.md`.

## Jalali dates and Persian text

`@sepehr/contracts` holds the only Jalali calendar code (`toJalali`, `fromJalali`,
`addJalaliMonths`, `formatJalaliDate`, `parseJalaliDate`, …) and the normalizers
(`normalizePersianText`, `normalizeDigits`, `normalizeMobile`, `normalizeNationalId`).
The lint rule `sepehr/jalali-via-wrapper` rejects any other route to the Persian
calendar. Supported years are 1200–1500.

## CI

`.github/workflows/ci.yml` runs on every pull request to `main` and every push to `main`.
Each job only calls a script from this repository, so every stage runs the same way
locally:

| Job                | Command                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `typecheck`        | `pnpm run typecheck`                                                    |
| `lint`             | `pnpm run format:check` and `pnpm run lint`                             |
| `test-unit`        | `pnpm run test`                                                         |
| `test-integration` | `pnpm run test:integration` (needs Docker)                              |
| `secrets`          | `pnpm run ci:secrets`: gitleaks over the full git history               |
| `deps`             | `pnpm run ci:deps`: osv-scanner over `pnpm-lock.yaml`                   |
| `sast`             | `pnpm run ci:sast`: semgrep with the rules vendored in `.semgrep/rules` |
| `docker-build`     | `pnpm run docker:build`: builds the `api` and `worker` images (no push) |

- Integration tests are named `*.int.test.ts` and start their own Postgres with
  Testcontainers on a random free port. They do not use `docker-compose.yml` or `.env`.
- The scanners run as Docker images pinned by digest in `scripts/ci/lib.sh`.
- The semgrep rules are updated by hand; see `.semgrep/README.md`.
