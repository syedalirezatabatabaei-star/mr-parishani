-- 0008 reconciliation and the financial health report (task 1-4; doc 02 §2, §7; ADR-012,
-- ADR-020). Hand-written (ADR-003); written only by the ledger module.

-- The role must exist before its grants: `pnpm db:bootstrap` creates it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sepehr_report') THEN
    RAISE EXCEPTION 'role sepehr_report is missing: run pnpm db:bootstrap (with DB_REPORT_PASSWORD) first';
  END IF;
END
$$;--> statement-breakpoint

-- Balances kept up to date from ledger.journal_posted events (doc 02 §2): the fast answer
-- for reports, never the source of truth, which is always the sum of entries (rule 4).
-- Nothing takes a financial decision from this table; the nightly reconciliation
-- compares it with the entries.
CREATE TABLE "account_balances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "ledger_accounts" ("id"),
	"entity_id" text NOT NULL REFERENCES "legal_entities" ("code"),
	"debit_rial" bigint DEFAULT 0 NOT NULL,
	"credit_rial" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_balances_account_key" UNIQUE ("account_id"),
	CONSTRAINT "account_balances_totals_check" CHECK ("debit_rial" >= 0 AND "credit_rial" >= 0)
);--> statement-breakpoint
CREATE TRIGGER account_balances_set_updated_at BEFORE UPDATE ON "account_balances"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER account_balances_no_delete BEFORE DELETE ON "account_balances"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- Which journals have been added into account_balances: one row per journal, written in
-- the same transaction as the addition, so a journal is never counted twice.
CREATE TABLE "ledger_balance_applications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entries" ("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_balance_applications_journal_key" UNIQUE ("journal_entry_id")
);--> statement-breakpoint

-- Every nightly run, clean or not, with what it found: audit evidence, kept indefinitely
-- (task 1-4 decision), unlike the 6-month operational outbox.
CREATE TABLE "ledger_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"accounts_checked" integer NOT NULL,
	"journals_applied" integer NOT NULL,
	"mismatches" integer NOT NULL,
	"invariant_violations" integer NOT NULL,
	"unbalanced_entities" integer NOT NULL,
	"overdue_unapplied" integer NOT NULL,
	"clean" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_reconciliation_runs_counts_check" CHECK (
	  "accounts_checked" >= 0 AND "journals_applied" >= 0 AND "mismatches" >= 0
	  AND "invariant_violations" >= 0 AND "unbalanced_entities" >= 0 AND "overdue_unapplied" >= 0
	),
	CONSTRAINT "ledger_reconciliation_runs_clean_check" CHECK (
	  "clean" = ("mismatches" = 0 AND "invariant_violations" = 0 AND "unbalanced_entities" = 0
	             AND "overdue_unapplied" = 0)
	)
);--> statement-breakpoint
CREATE INDEX "ledger_reconciliation_runs_started_idx" ON "ledger_reconciliation_runs" ("started_at");--> statement-breakpoint

-- One row per problem found: a balance that differs from its entries, or a broken
-- invariant of doc 02 (a purse or suspense account below zero).
CREATE TABLE "ledger_discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "ledger_reconciliation_runs" ("id"),
	"kind" text NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "ledger_accounts" ("id"),
	"expected_debit_rial" bigint NOT NULL,
	"expected_credit_rial" bigint NOT NULL,
	"actual_debit_rial" bigint NOT NULL,
	"actual_credit_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_discrepancies_kind_check" CHECK ("kind" IN ('balance_mismatch', 'negative_balance'))
);--> statement-breakpoint
CREATE INDEX "ledger_discrepancies_run_idx" ON "ledger_discrepancies" ("run_id");--> statement-breakpoint

-- The daily financial health report (doc 02 §7): per legal entity, the day's debits and
-- credits (a Tehran calendar day) and the totals of all time; each pair must be equal.
CREATE TABLE "ledger_daily_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "ledger_reconciliation_runs" ("id"),
	"entity_id" text NOT NULL REFERENCES "legal_entities" ("code"),
	"report_date" date NOT NULL,
	"day_debit_rial" bigint NOT NULL,
	"day_credit_rial" bigint NOT NULL,
	"total_debit_rial" bigint NOT NULL,
	"total_credit_rial" bigint NOT NULL,
	"balanced" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_daily_reports_run_entity_key" UNIQUE ("run_id", "entity_id"),
	CONSTRAINT "ledger_daily_reports_balanced_check" CHECK (
	  "balanced" = ("day_debit_rial" = "day_credit_rial" AND "total_debit_rial" = "total_credit_rial")
	)
);--> statement-breakpoint
CREATE INDEX "ledger_daily_reports_date_idx" ON "ledger_daily_reports" ("entity_id", "report_date");--> statement-breakpoint

-- The applications, runs, discrepancies and reports never change or disappear.
REVOKE UPDATE ON "ledger_balance_applications", "ledger_reconciliation_runs",
  "ledger_discrepancies", "ledger_daily_reports" FROM sepehr_app;--> statement-breakpoint
CREATE TRIGGER ledger_balance_applications_append_only BEFORE UPDATE OR DELETE ON "ledger_balance_applications"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER ledger_reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON "ledger_reconciliation_runs"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER ledger_discrepancies_append_only BEFORE UPDATE OR DELETE ON "ledger_discrepancies"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER ledger_daily_reports_append_only BEFORE UPDATE OR DELETE ON "ledger_daily_reports"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- The read-only reporting role (ADR-012, ADR-020): SELECT on what reconciliation and
-- reports read, nothing else. In production it connects to the replica.
GRANT USAGE ON SCHEMA public TO sepehr_report;--> statement-breakpoint
GRANT SELECT ON "legal_entities", "ledger_accounts", "journal_entries", "ledger_entries",
  "account_balances", "ledger_balance_applications", "ledger_reconciliation_runs",
  "ledger_discrepancies", "ledger_daily_reports" TO sepehr_report;--> statement-breakpoint

-- Alert when a posted journal has not reached account_balances within an hour (task 1-4
-- decision), changed from the panel by two people.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('ops.ledger_lag_alert', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('ops.ledger_lag_alert', 'global', '{"maxUnappliedSeconds": 3600}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0008)', now());
