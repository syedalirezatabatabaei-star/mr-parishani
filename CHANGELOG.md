# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Ledger skeleton (task 1-1, doc 02, ADR-017) with migration `0005_ledger`:
  `legal_entities`, `ledger_accounts`, `journal_entries` and monthly-partitioned
  `ledger_entries`, append-only for the application and the schema owner alike.
  `postJournal` (the `LEDGER` port) is the only writer: required idempotency key (the
  same key and content return the same document, other content is refused), balanced
  documents only, accounts locked in a fixed order, the caller's transaction honored,
  and a `ledger.journal_posted` event in the outbox. A deferred constraint trigger
  checks the balance again at commit. `reverseJournal` posts the full opposite, once.
  Tested: 500 random documents stay balanced, 20 concurrent postings with one key make
  one document, a reversal restores every balance exactly, opposite postings do not
  deadlock. Read endpoints for auditors and accounting (`ledger.read`).
- Credit purse (task 1-2, doc 02 §3–4, ADR-018) with migration `0006_wallet`:
  `credit_purses` (one per case, a lock that stores no balance) and append-only
  `purse_operations`; purse and borrower-debt accounts per case (owner type `purse`).
  Operations through the `WALLET` port: approve credit, charge once for the whole
  amount, reserve, cancel a reservation, register a service, finalize it to the
  doctor's payable, hold and release a consumption, cancel the unused balance, reverse.
  Hard rules of doc 02 §4 checked in code before and after posting. Tested: a whole
  case closes on the real ledger, 50 concurrent withdrawals never overdraw, a repeated
  key makes one operation, a lost connection mid-registration is recoverable without a
  double charge, a reversal restores every balance, and 400 random operations keep
  available + reserved + pending + finalized equal to the approved amount. Read endpoint
  for accounting and the auditor (`wallet.read`).
- Installments and payment allocation (task 1-3, doc 02 §4–5, ADR-019) with migration
  `0007_repayment`: a pure schedule builder in `@sepehr/contracts` (round down, the
  remainder on the first, due dates from the funding day in Tehran, never chained),
  and the `repayment` module with immutable schedules and installments locked to the
  configuration version at funding, the plan fee posted at schedule creation, bank-slip
  receipts into per-case suspense, and allocation to the oldest outstanding installment
  first with any surplus left in suspense. Installment status is derived; there is no
  late penalty and no early-settlement discount. A total too small for the count is
  refused. Acceptance: 10,000 random combinations always sum to the total, and due dates
  hold in 31-, 30- and 29-day months (every funding day of three years checked).
- Doc 02: a plan-fee row (Dr borrower.debt / Cr company.fee_income, recognized at
  once), and the no-zero-installment rule.
- Nightly reconciliation and financial health report (task 1-4, doc 02 §7, ADR-020) with
  migration `0008_reconciliation`: `account_balances` maintained from ledger events,
  once per journal; a nightly job at 02:00 Tehran comparing it with the entries,
  checking purse and suspense accounts never go below zero, reporting each legal
  entity's day and all-time debits and credits, and flagging journals not applied within
  an hour (`ops.ledger_lag_alert`), with an immediate alert for anything found. Runs,
  discrepancies and daily reports are append-only and kept indefinitely. Acceptance: an
  artificial discrepancy in the test database is found, recorded and alerted.
- The read-only `sepehr_report` database role (created by `db:bootstrap`, which now needs
  `DB_REPORT_PASSWORD`) and `REPORTING_DATABASE_URL`, required in production. The real
  replica is deferred to the deployment phase (ADR-020).
- Glossary: `IdempotencyKey`, `PurseOperation`, `PurseReservation`, `ConsumptionHold`,
  `PaymentAllocation`, `AccountBalance`, `ReconciliationRun`, `LedgerDiscrepancy`.
- Holiday calendar (task 2-1, doc 08 §5, ADR-021) with migration `0009_holidays`:
  national and city holidays (cities by code) in the config module, public listing
  (`GET /calendar/holidays`), adding and soft-removing by the system admin
  (`config.manage_holidays`, one person, audited with a reason). Pure
  `isWorkingDay(date, cityCode, calendar)` and `nextWorkingDay` in the Jalali wrapper, with
  the `HOLIDAY_CALENDAR` port for modules; weekly days off in `calendar.weekly_days_off`
  (default Friday).
- Installment due dates move to the next working day when
  `repayment.shift_due_to_next_working_day` is on (still off by default): weekly days off
  and national holidays only, dates only, never amounts; schedules record whether they
  were shifted and the configuration versions behind it. Acceptance: with it on, a due
  day on a holiday moves to the first working day after it and the total is unchanged;
  with it off, no schedule changes.
- Daily holiday-calendar check in the worker (09:00 Tehran): from 1 Bahman, while next
  year has no national holiday, an in-panel notice for the system admin
  (`admin_notices`, `GET /config/notices`) and a log warning, repeated weekly until the
  holidays are entered.
- Glossary: `Holiday`, `WorkingDay`, `WeeklyDayOff`, `AdminNotice`.
- Center registration and activation (task 2-2, doc 08 §2–3, ADR-022) with migration
  `0010_catalog_centers`: the catalog module's `centers`, `branches`, treatment fields,
  checklist documents, status history and two-person requests, on the `org_nodes` tree,
  which now accepts branches (constraint and trigger) and branch-scoped roles. National
  IDs, legal-entity IDs and Sheba numbers are encrypted with a blind index under the new
  `BLIND_INDEX_KEY`; duplicates are refused. Status machine in the service and the
  database; activation approved by the new `network_manager` role, a new Sheba by
  accounting, never by the proposer; stale requests are withdrawn and a request is
  decided once. Entering a status publishes `catalog.center_submitted`, `_activated`,
  `_suspended` or `_terminated` (doc 08 §14 renamed to the repository's event naming);
  suspension and termination stop new bookings through `CENTER_DIRECTORY`. A branch
  manager sees only their own branch. Acceptance: doc 08 §15 test 8, the first half
  of test 5 (the second is `TODO(2-6)`), and a second registration with the same ID
  refused.
- Validators for the legal-entity national ID and Sheba in `@sepehr/contracts`.
- Glossary: `Branch`, `NetworkManager`, `CenterStatus`, `CenterDocument`,
  `CenterChangeRequest`, `BlindIndex`, `Sheba`.
- Doctors and secretaries (task 2-3, doc 08 §2, ADR-023) with migration `0011_doctors`: one
  provider profile per doctor with or without an account (unique medical council number,
  encrypted national ID), one `doctor` node per workplace at an active center or a private
  practice, secretaries of one doctor at one workplace. A secretary never exceeds their
  doctor; for a doctor without an account the `doctor` role is the cap and the center
  manager delegates within it and their own access. Acceptance: doc 08 §15 tests 6 (the
  calendar half is `TODO(2-5)`) and 7.
- `audit_events.on_behalf_of_doctor_id`: «done by X on behalf of doctor Y», hashed only when
  set.
- Glossary: `Doctor`, `MedicalCouncilNumber`, `DoctorWorkplace`, `DoctorSecretary`,
  `OnBehalfOfDoctor`.
- Catalog of treatment fields, services and tariffs (task 2-4, doc 08 §4, ADR-024) with
  migration `0012_catalog_tariffs`: fields and services with codes unique for ever, managed by
  the network manager and the system admin (`catalog.manage_catalog`) and listed publicly;
  one `visit` service in no field, the only one that may be free. Tariffs belong to a
  doctor's workplace or to a center, as append-only versions (`bigint` rial ranges,
  `effective_at` never in the past, a version not yet started may be cancelled); the
  workplace's version in force always wins over the center's. Set by the center manager
  (center scope), a branch manager for their branch's doctors, or the doctor for their own
  workplace, their secretary only with the doctor's own delegation, audited on the doctor's
  behalf; the network only reads, except that the network specialist prices a private
  practice whose doctor has no account (`catalog.manage_tariff_for_unaccounted_doctor`,
  migration `0013_tariff_network_permission`) until the doctor gets one.
  `TARIFF_BOOK` port for booking. Acceptance: doc 08 §15 test 4 (the appointment half is
  `TODO(2-6)`).
- `docs/import-templates/treatment-fields.csv`: the sheet for entering treatment fields in
  the bulk import of task 2-9.
- Glossary: `TariffVersion`, `VisitService`.
- `docs/decisions/task-2-4-decisions.md`: the owner's decisions for task 2-4.
- Doctors' calendars (task 2-5, doc 08 §6, ADR-025): module `booking` with migration
  `0014_booking_schedule`: weekly schedules, day exceptions (`closed`, `extra`,
  `open_holiday`) and an append-only approval mode per workplace. Slots are computed, never
  stored, by the pure `computeSlots` in Tehran days; holidays close a day unless opened, the
  system's weekly days off do not. A doctor's ranges never overlap across workplaces
  (`EXCLUDE` constraints, `doctor_busy_elsewhere`). Permissions `booking.read_calendar`,
  `booking.manage_own_calendar`, `booking.manage_calendar_in_scope`,
  `booking.manage_any_calendar`, `booking.manage_approval_mode`; config keys
  `booking.default_approval_mode` and `booking.booking_horizon_days`. `WORKPLACE_DIRECTORY`
  port in the catalog. Acceptance: doc 08 §15 tests 3 and 13, the calendar half of test 6, a
  month of one doctor's slots at p95 ≈ 34 ms.
- `@RequireAnyPermission`: an endpoint accepting any of several permissions, the service
  deciding which applies (task 2-5).
- Glossary: `ScheduleTemplate`, `AvailabilityException`, `Slot`, `ApprovalMode`.
- `docs/decisions/task-2-5-decisions.md`: the owner's decisions for task 2-5.
- Leads (task 2-5b, doc 05, ADR-026): module `lead` with migration `0015_lead`: persons with
  their mobiles (national IDs encrypted), cases with the status machine of docs/01 (enforced
  by a trigger), append-only intakes and assignments, abandonment reasons, versioned
  assignment shares, agent presence and caps, reversible person merges, the Excel import and
  the WordPress webhook. One `LeadIntakeService` for every source; smooth weighted
  round-robin assignment with no catch-up for agents who were away. `PERSON_DIRECTORY` now
  has its real provider; `pnpm lead:backfill-persons` (dry run, `--apply`) links earlier
  patient accounts, reported in `person_backfill_runs`. `RepaymentPort.casesWithOutstanding`
  (read only). Permissions `lead.*`; config keys `lead.returning_to_previous_agent`,
  `lead.excel_import_enabled` (off until 2-8) and `lead.webhook_policy`. Acceptance: doc 05
  §10 tests 1–6.
- `docs/integrations/wordpress-lead-webhook.md`: the WordPress developer's guide.
- Glossary: `CaseIntake`, `PersonMerge`, `LeadImportBatch`, `AssignmentWeightVersion`.
- `docs/decisions/task-2-5b-decisions.md`: the owner's decisions for task 2-5b.

### Changed

- New treatment field codes on centers and doctors must name an active field of the
  catalog (`unknown_treatment_field`); codes stored before task 2-4 are kept.
- `org_nodes`: a doctor's account may sit on one doctor node per workplace; every other
  node kind keeps one node per account (task 2-3).

- `createSchedule` no longer refuses with `holiday_calendar_missing` when
  `repayment.shift_due_to_next_working_day` is on (task 2-1).
- ADR-008 amended (owner's decision): financial code may be written before self-hosted
  GitLab, but is not merged through a PR or deployed before it and a human review.
- Migration history versus the local main database (check of 1405/07/29, round 34; owner
  accepted every difference below, no migration 0102):
  - `0100_deposits_visit_tariffs` was edited after it ran: the redundant
    `REVOKE DELETE … FROM sepehr_app` lines were removed (0000's default privileges never
    grant DELETE; `database.int.test.ts` now asserts it). Its hash in
    `drizzle.__drizzle_migrations` differs from the file's, as expected.
  - `0001_identity` was edited after it ran, in `3c7cf2c` (2026-09-27): the patient-mobile
    and username unique indexes became partial (`deleted_at IS NULL`). On the main database
    the same indexes had been changed by hand, with no record. The structure is now
    identical; only the hash differs.
  - Time-dependent only: the `*_2026_09` partitions exist on main because 0002, 0004 and
    0005 create partitions from `now()`, and main ran them in September. The
    `effective_at = now()` of rows from 0064, 0076, 0095 and 0098 differs for the same
    reason. Partitions on main run through `2027_10` (12 months ahead) for all five
    partitioned tables, with no default partition; the worker's `partition-maintenance`
    job (`PartitionMaintenance`, daily 03:00 UTC, `maintain_monthly_partitions`) keeps 12
    months ahead, and `pnpm ops:partitions` runs it by hand.
  - Otherwise a database built from all 102 migrations by `db:bootstrap` and `db:migrate`
    alone matches main: schema with ACLs, `sepehr_app`'s grants and table privileges, the
    default ACL, and the configuration rows. `sepehr_app` holds no DELETE or TRUNCATE on any
    of main's 256 tables.
  - Two test rows of `credit.plans` (reason «طرح آزمایشی تأیید بصری», 2026-10-03) are on
    main. Before launch they are removed or turned off by two people (launch checklist,
    item 18).
  - **Rule from now on:** every fix to the database goes through a new migration. No
    manual DDL on the main database, and no edit to a migration that has run.

## [0.5.0] - 2026-09-27

### Added

- Access module (task 0-5, doc 04) with migration `0002_access`: permission codes in
  `@sepehr/contracts` mirrored by the `permissions` table (the API refuses to start while
  they differ), roles as data with the 14 system roles of doc 04 seeded and locked,
  scoped role assignments (global, city, center, doctor, team queue, own), and the
  center tree `org_nodes` with `ltree` paths kept by a trigger (ADR-015).
- `@RequirePermission(code)` on endpoints; the API refuses to start if any endpoint has
  no access marker. Access is resolved on every request, so role changes apply to active
  sessions at once.
- Hard rules in code: a secretary never exceeds their doctor's permissions or scope; the
  collection role never sees the treatment. Row-level security on `org_nodes` as the
  second line of defense; guessed ids of other doctors answer 404.
- Field-level filtering of every response (`SENSITIVE_FIELD_CLASSES`: treatment, credit
  score, decision reasons, patient financials).
- Audit module: append-only `audit_events` with a SHA-256 hash chain and
  `GET /audit/verify`, `access_logs` for views, both partitioned by month; UPDATE, DELETE
  and TRUNCATE are refused even to the schema owner. `audit:partitions` creates coming
  partitions and archives (detaches) those past the retention.
- Internal panel IP allow-list (starts disabled) and audit retention (24 months), both
  versioned configuration editable from the panel.
- Two-person TOTP reset over HTTP (`/identity/totp-resets`), audited; a request expires
  after 6 hours without a second person.
- `access:grant` command for the first administrator's role.
- Config module (task 0-6, ADR-006) with migration `0003_config`: keys in code
  (`CONFIG_KEYS` in `@sepehr/contracts`, mirrored by `config_keys`; the API refuses to
  start while they differ or a key lacks a global value), immutable versions in
  `config_values` with a start time, and `resolve(key, scope, at)` over the hierarchy
  doctor → center → treatment field → city → global. Values never start in the past, so
  a record's value never changes after the fact; records lock to a `versionId`.
- Two-person approval of every configuration change, audited, enforced by the service
  and by the database; `config.read`, `config.manage_business` (strategy manager) and
  `config.manage_technical` (system admin); the CEO and auditors read only.
- Seeded defaults from docs 02 and 05: installment rounding unit 10,000 rial,
  cancellation penalty 18%, holiday due-date shift off, duplicate-lead window 7 days.
- Transactional outbox (task 0-7, ADR-005) with migration `0004_outbox`: events written
  in the change's own transaction, relayed to BullMQ with the event id as job id
  (`FOR UPDATE SKIP LOCKED`, any number of relays), consumers made idempotent by
  `processed_events`. Tested with simulated crashes of the relay and of the consumer,
  a Redis outage, and two concurrent relays: nothing lost, nothing applied twice.
- The worker runs the API's modules as an application context (ADR-016); BullMQ job
  schedulers run partition maintenance daily and the queue monitor every minute.
  Partition maintenance goes through a guarded SECURITY DEFINER function, so the worker
  needs no owner credentials; `audit:partitions` becomes `ops:partitions` and covers the
  outbox tables too.
- Monitoring: OpenTelemetry (traces and metrics over OTLP to a self-hosted collector,
  off unless configured, no personal data), `/health/live` and `/health/ready`, queue
  and outbox gauges, and alerts on configurable thresholds (`ops.*` keys): logged,
  texted to the on-call numbers through Kavenegar, and as Grafana rules in
  `ops/alerts/queues.yml`.
- Glossary: `Permission`, `Role`, `RoleAssignment`, `Scope`, `OrgNode`, `AccessLog`,
  `ConfigKey`, `DomainEvent`, `OutboxEvent`.

### Changed

- Login limits and lifetimes (formerly `IDENTITY_POLICY`) are versioned configuration
  (`identity.otp`, `identity.staff_login`, `identity.lockout`, `identity.session`), with
  the same values. A TOTP reset request keeps the lifetime in effect when it was made.

### Deprecated

- `access_policy_versions` is frozen and unused; a later migration drops it.

### Fixed

- A malformed `X-Device-Id` no longer skips the per-device OTP limit: the cookie is used
  instead, and the OTP request refuses the header with 400.
- An OTP request refused by a limit, or whose SMS cannot be queued, no longer starts the
  60-second cooldown or replaces the code already sent.
- `TRUST_PROXY=1` (a hop count) no longer fails at start-up.
- CORS is enabled for `WEB_ORIGINS`, with credentials.
- A missing or malformed `WEB_ORIGINS` stops the API at start-up.
- A correct staff password clears the earlier wrong passwords; wrong TOTP codes are
  counted separately and are not cleared by it.

## [0.4.0] - 2026-09-27

### Added

- Identity module (task 0-4) with migration `0001_identity`: `user_accounts`,
  `sessions`, `refresh_tokens` and `totp_reset_requests`. The patient-mobile and username
  unique keys skip soft-deleted rows, so that they agree with the service's lookups and a
  login key freed by a soft delete can be used again.
- Patient login by SMS code: 6 digits, 3-minute lifetime, one use, sending limited per
  mobile (8/hour), IP (20/hour) and device (10/hour); the 6th wrong code locks the mobile
  for 15 minutes. The first login creates the account and links it to its `Person`
  through the `PersonDirectory` port. One-time codes, OTP and TOTP alike, are accepted in
  Persian, Arabic-Indic or ASCII digits and normalized before comparison (rule 23).
- Staff and center login: argon2id password plus mandatory TOTP (RFC 6238, implemented
  in-house, secrets encrypted with AES-256-GCM); a used code is never accepted again.
  Resetting TOTP needs two different people.
- Web sessions in a `__Host-sid` cookie with CSRF token and origin checks; mobile
  access tokens with one-time refresh tokens and reuse detection; device list, logout
  and logout from all devices.
- Global guard that denies every endpoint without an explicit access marker.
- SMS delivery from a BullMQ queue in the worker, behind `SmsProvider`, with Kavenegar and
  a development-only console provider; retries with backoff, timeout per call, expired
  codes dropped.
- `account:create` command for the first staff account; field-level encryption helper.
- Glossary: `UserAccount`, `Session`, `RefreshToken`, `OtpChallenge`, `TotpResetRequest`.

## [0.3.0] - 2026-09-19

### Added

- Database foundation (task 0-3): Drizzle ORM with the `pg` driver in `apps/api/src/db`,
  hand-reviewed migrations in `apps/api/drizzle`, and `db:bootstrap`, `db:migrate` and
  `db:generate` scripts.
- Migration 0000: `uuidv7()` for primary keys, the `set_updated_at()` trigger function,
  and least-privilege grants: the application role `sepehr_app` may only `SELECT`,
  `INSERT` and `UPDATE`.
- Column helpers (`id`, `timestamps`, `appendOnlyTimestamps`, `rial`, `timestamptz`), a
  schema conventions test, and integration tests for privileges, UUIDv7, triggers and
  database invariants on a real Postgres 17.
- Schema drift check in `lint`: schema changes without a migration fail CI.
- Jalali calendar wrapper in `@sepehr/contracts` over `jalaali-js` 2.0.1 (pinned), with
  Tehran time zone handling, clamped month addition (doc 02), formatting and parsing.
  Every day of the supported range (1200–1500) is cross-checked against Intl.
- Lint rule `sepehr/jalali-via-wrapper`: Jalali libraries, Intl's Persian calendar and
  `fa`-locale date formatting are errors outside the wrapper.
- `normalizePersianText`, `normalizeDigits`, `toPersianDigits`, `normalizeMobile` and
  `normalizeNationalId` (with checksum validation; 8- and 9-digit input gets its lost
  leading zeros back) in `@sepehr/contracts`.

## [0.2.0] - 2026-09-19

### Added

- CI pipeline (task 0-2) in GitHub Actions: `typecheck`, `lint`, `test-unit`,
  `test-integration`, `secrets` (gitleaks), `deps` (osv-scanner), `sast` (semgrep) and
  `docker-build`. Every job calls a script from the repository (ADR-008).
- Integration tests (`*.int.test.ts`, `pnpm run test:integration`) with Testcontainers
  and a shared Postgres 17 helper in `apps/api/test/support`.
- Semgrep rules vendored in `.semgrep/rules`, with `scripts/ci/update-semgrep-rules.sh`
  for manual updates.
- `Dockerfile` for the `api` and `worker` services, and `.dockerignore`.

### Changed

- `.env.example` uses the standard Postgres port 5432 again. A machine-specific port
  belongs in the personal `.env` only.

### Known limitations

- GitHub does not enforce the `main` ruleset on this private personal repository, so
  "merge only when CI is green" is followed by hand until the move to self-hosted GitLab,
  which must happen before task 1-1 (ADR-008).

## [0.1.0] - 2026-09-19

### Added

- Monorepo skeleton (task 0-1): pnpm workspaces + Turborepo with `apps/api` (NestJS),
  `apps/worker`, `apps/web` and `apps/admin` (Next.js, RTL), `packages/contracts`,
  `packages/ui` and `packages/config`.
- Strict TypeScript, shared ESLint and Prettier configuration.
- Lint rule `sepehr/no-cross-module-import`: any import between modules in
  `apps/api/src/modules` is an error, including through a module's `index.ts`.
- `docker-compose.yml` for local Postgres 17 and Redis. Postgres is exposed on host
  port 5434 (see `README.md`).
- `README.md` with local development setup.
