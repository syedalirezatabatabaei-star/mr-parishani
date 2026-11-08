-- 0045 a doctor's payable and the credit service's fee (task 5-1 [financial]; doc 06 §1, §3;
-- doc 14 الف, ب; owner 1405/07/14). Hand-written (ADR-003). Expand only: two new tables and
-- five configuration keys; no existing table, column or constraint changes.

-- === What the company owes a doctor for one final service (settlement module) ==============
CREATE TABLE "doctor_payables" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	-- The service module's authorization (no foreign key across modules); once per service.
	"service_delivery_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"doctor_node_id" uuid NOT NULL,
	"center_id" uuid,
	"workplace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"purse_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"amount_rial" bigint NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	-- Locked when it is made (rule 16): the cycle, and from which configuration version.
	"contract_cycle_months" integer NOT NULL,
	"cycle_config_version_id" uuid NOT NULL,
	-- UTC; computed from the Tehran day (owner, 5-1).
	"due_at" timestamp with time zone NOT NULL,
	"wallet_operation_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"status" text DEFAULT 'accrued' NOT NULL,
	"statement_id" uuid,
	"hold_reason" text,
	"dispute_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_payables_amount_check" CHECK ("amount_rial" > 0),
	CONSTRAINT "doctor_payables_cycle_check" CHECK ("contract_cycle_months" BETWEEN 1 AND 36),
	CONSTRAINT "doctor_payables_status_check"
	  CHECK ("status" IN ('accrued', 'due', 'in_statement', 'paid', 'on_hold', 'reversed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_payables_delivery_key" ON "doctor_payables" ("service_delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_payables_journal_key" ON "doctor_payables" ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "doctor_payables_doctor_idx" ON "doctor_payables" ("doctor_id", "status", "due_at");--> statement-breakpoint
CREATE INDEX "doctor_payables_due_idx" ON "doctor_payables" ("due_at") WHERE "status" = 'accrued';--> statement-breakpoint

-- === The company's fee on a service (credit now; cash in task 5-3) =========================
CREATE TABLE "service_fees" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"doctor_payable_id" uuid REFERENCES "doctor_payables" ("id"),
	"cash_service_id" uuid,
	"doctor_id" uuid NOT NULL,
	"doctor_node_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	-- Locked when it is made: the rate's basis and value (bps, or rials), and its version.
	"basis" text NOT NULL,
	"rate_value" text NOT NULL,
	"config_version_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	-- None for a fee of 0: nothing is posted.
	"journal_entry_id" uuid,
	"status" text DEFAULT 'accrued' NOT NULL,
	"statement_id" uuid,
	"dispute_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_fees_kind_check" CHECK ("kind" IN ('credit', 'cash')),
	CONSTRAINT "service_fees_subject_check" CHECK (
	  ("kind" = 'credit' AND "doctor_payable_id" IS NOT NULL AND "cash_service_id" IS NULL)
	  OR ("kind" = 'cash' AND "cash_service_id" IS NOT NULL AND "doctor_payable_id" IS NULL)
	),
	CONSTRAINT "service_fees_basis_check" CHECK ("basis" IN ('percent', 'fixed')),
	-- Never negative (owner); posted exactly when there is something to post.
	CONSTRAINT "service_fees_amount_check" CHECK (
	  "amount_rial" >= 0 AND (("amount_rial" > 0) = ("journal_entry_id" IS NOT NULL))
	),
	CONSTRAINT "service_fees_status_check"
	  CHECK ("status" IN ('accrued', 'due', 'in_statement', 'settled', 'on_hold', 'reversed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "service_fees_payable_key" ON "service_fees" ("doctor_payable_id")
  WHERE "doctor_payable_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "service_fees_cash_key" ON "service_fees" ("cash_service_id")
  WHERE "cash_service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "service_fees_journal_key" ON "service_fees" ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "service_fees_doctor_idx" ON "service_fees" ("doctor_id", "status", "due_at");--> statement-breakpoint
CREATE INDEX "service_fees_due_idx" ON "service_fees" ("due_at") WHERE "status" = 'accrued';--> statement-breakpoint

-- === Only the state moves, along its paths (rule 8); nothing else is rewritten =============
CREATE FUNCTION public.settlement_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'statement_id', 'hold_reason', 'dispute_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION '% % keeps its amount, rate and dates', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'accrued' AND NEW.status IN ('due', 'on_hold', 'reversed'))
    OR (OLD.status = 'due' AND NEW.status IN ('in_statement', 'on_hold', 'reversed'))
    OR (OLD.status = 'in_statement' AND NEW.status IN ('paid', 'settled', 'due', 'on_hold'))
    OR (OLD.status = 'on_hold' AND NEW.status IN ('accrued', 'due', 'reversed'))
  ) THEN
    RAISE EXCEPTION '% % cannot go from % to %', TG_TABLE_NAME, OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER doctor_payables_guard BEFORE UPDATE ON "doctor_payables"
  FOR EACH ROW EXECUTE FUNCTION public.settlement_items_guard();--> statement-breakpoint
CREATE TRIGGER doctor_payables_set_updated_at BEFORE UPDATE ON "doctor_payables"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER doctor_payables_no_delete BEFORE DELETE ON "doctor_payables"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER service_fees_guard BEFORE UPDATE ON "service_fees"
  FOR EACH ROW EXECUTE FUNCTION public.settlement_items_guard();--> statement-breakpoint
CREATE TRIGGER service_fees_set_updated_at BEFORE UPDATE ON "service_fees"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER service_fees_no_delete BEFORE DELETE ON "service_fees"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "doctor_payables", "service_fees" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "statement_id", "hold_reason", "dispute_id", "updated_at")
  ON "doctor_payables" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "statement_id", "dispute_id", "updated_at")
  ON "service_fees" TO sepehr_app;--> statement-breakpoint

-- === Configuration (CLAUDE.md §4: 0 at first; changed by two people; locked per record) ====
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('settlement.credit_service_fee', 'business', true),
  ('settlement.cash_service_fee', 'business', true),
  ('settlement.contract_cycle_months', 'business', true),
  ('settlement.payout_day', 'business', true),
  ('settlement.negative_balance_alert_periods', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('settlement.credit_service_fee', 'global', '{"basis": "percent", "bps": 0}', '2020-01-01T00:00:00Z', 'approved',
   'مقدار اولیه ۰ (غیرفعال)؛ عدد را کارفرما می‌دهد، ردیف ۵.۶ (مهاجرت 0045)', now()),
  ('settlement.cash_service_fee', 'global', '{"basis": "percent", "bps": 0}', '2020-01-01T00:00:00Z', 'approved',
   'مقدار اولیه ۰ (غیرفعال)؛ عدد را کارفرما می‌دهد، ردیف ۵.۶ (مهاجرت 0045)', now()),
  ('settlement.contract_cycle_months', 'global', '1', '2020-01-01T00:00:00Z', 'approved',
   'مقدار اولیه: ماهانه، پاسخ مالک (مهاجرت 0045)', now()),
  ('settlement.payout_day', 'global', '10', '2020-01-01T00:00:00Z', 'approved',
   'مقدار اولیه، پاسخ مالک ۵.۲ (مهاجرت 0045)', now()),
  ('settlement.negative_balance_alert_periods', 'global', '2', '2020-01-01T00:00:00Z', 'approved',
   'مقدار اولیه، پاسخ مالک ۵.۳ (مهاجرت 0045)', now());
