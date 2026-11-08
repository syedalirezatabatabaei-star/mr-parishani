-- 0048 a doctor's monthly statement (task 5-4 [financial]; doc 06 §2, §8; doc 14 ب, پ; doc 02
-- §4 "fee offset in the statement"). Hand-written (ADR-003). Expand only: two new tables and
-- two permissions; the items' move due → in_statement is already a path of 0045's guard.

-- === One statement per doctor and Jalali month (settlement module) =========================
CREATE TABLE "settlement_statements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"gross_credit_services_rial" bigint NOT NULL,
	"credit_fees_rial" bigint NOT NULL,
	"cash_fees_rial" bigint NOT NULL,
	"carried_in_rial" bigint NOT NULL,
	"other_deductions_rial" bigint NOT NULL,
	-- Signed: below 0 nothing is paid and the rest is carried (doc 14 پ).
	"payable_rial" bigint NOT NULL,
	"carried_out_rial" bigint NOT NULL,
	-- Dr doctor.payable / Cr doctor.fee_receivable, posted when the draft is made.
	"offset_rial" bigint NOT NULL,
	"offset_journal_entry_id" uuid,
	"previous_statement_id" uuid REFERENCES "settlement_statements" ("id"),
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"pdf_hash" text,
	-- A draft's cancellation: asked by one, done by another (task 5-4).
	"cancel_requested_by" uuid,
	"cancel_requested_at" timestamp with time zone,
	"cancel_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_statements_period_check"
	  CHECK ("period_year" BETWEEN 1400 AND 1500 AND "period_month" BETWEEN 1 AND 12),
	CONSTRAINT "settlement_statements_status_check"
	  CHECK ("status" IN ('draft', 'reviewed', 'approved', 'paid', 'cancelled')),
	CONSTRAINT "settlement_statements_parts_check" CHECK (
	  "gross_credit_services_rial" >= 0 AND "credit_fees_rial" >= 0 AND "cash_fees_rial" >= 0
	  AND "carried_in_rial" >= 0 AND "other_deductions_rial" >= 0
	),
	-- doc 06 §2, exactly.
	CONSTRAINT "settlement_statements_sum_check" CHECK (
	  "payable_rial" = "gross_credit_services_rial" - "credit_fees_rial" - "cash_fees_rial"
	    - "carried_in_rial" - "other_deductions_rial"
	  AND "carried_out_rial" = greatest(0, -"payable_rial")
	  AND "offset_rial" = least("gross_credit_services_rial",
	    "credit_fees_rial" + "cash_fees_rial" + "carried_in_rial" + "other_deductions_rial")
	),
	CONSTRAINT "settlement_statements_offset_check"
	  CHECK (("offset_rial" > 0) = ("offset_journal_entry_id" IS NOT NULL)),
	CONSTRAINT "settlement_statements_cancel_check" CHECK (
	  ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
	  AND ("status" <> 'cancelled' OR ("cancelled_by" IS NOT NULL
	       AND "cancelled_by" IS DISTINCT FROM "cancel_requested_by"
	       AND ("offset_journal_entry_id" IS NULL) = ("cancel_journal_entry_id" IS NULL)))
	)
);--> statement-breakpoint
-- One live statement per doctor and month; a cancelled one may be made again.
CREATE UNIQUE INDEX "settlement_statements_live_key" ON "settlement_statements"
  ("doctor_id", "period_year", "period_month") WHERE "status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_statements_offset_key" ON "settlement_statements" ("offset_journal_entry_id");--> statement-breakpoint
CREATE INDEX "settlement_statements_period_idx" ON "settlement_statements" ("period_year", "period_month", "status");--> statement-breakpoint
CREATE FUNCTION public.settlement_statements_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'reviewed_by', 'reviewed_at', 'approved_by',
    'approved_at', 'pdf_hash', 'cancel_requested_by', 'cancel_requested_at', 'cancel_reason',
    'cancelled_by', 'cancelled_at', 'cancel_journal_entry_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'statement % keeps its doctor, period and amounts', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('reviewed', 'cancelled'))
    OR (OLD.status = 'reviewed' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status = 'paid')
  ) THEN
    RAISE EXCEPTION 'statement % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_statements_guard BEFORE UPDATE ON "settlement_statements"
  FOR EACH ROW EXECUTE FUNCTION public.settlement_statements_guard();--> statement-breakpoint
CREATE TRIGGER settlement_statements_set_updated_at BEFORE UPDATE ON "settlement_statements"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER settlement_statements_no_delete BEFORE DELETE ON "settlement_statements"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "settlement_statements" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "reviewed_by", "reviewed_at", "approved_by", "approved_at", "pdf_hash",
  "cancel_requested_by", "cancel_requested_at", "cancel_reason", "cancelled_by", "cancelled_at",
  "cancel_journal_entry_id", "updated_at") ON "settlement_statements" TO sepehr_app;--> statement-breakpoint

-- === A statement's lines (append-only) ======================================================
-- Its items (ref a payable or a fee), and per doctor node (ref the node): what was carried in,
-- what the offset took from doctor.payable and doctor.fee_receivable, and what is carried out.
CREATE TABLE "settlement_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"statement_id" uuid NOT NULL REFERENCES "settlement_statements" ("id"),
	"line_type" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_statement_lines_type_check" CHECK ("line_type" IN (
	  'credit_service', 'credit_fee', 'cash_fee', 'carried_in', 'other_deduction',
	  'offset_payable', 'offset_fee', 'carried_out')),
	CONSTRAINT "settlement_statement_lines_ref_check" CHECK (
	  ("line_type" = 'credit_service' AND "ref_type" = 'doctor_payable')
	  OR ("line_type" IN ('credit_fee', 'cash_fee') AND "ref_type" = 'service_fee')
	  OR ("line_type" IN ('carried_in', 'offset_payable', 'offset_fee', 'carried_out')
	      AND "ref_type" = 'doctor_node')
	  OR ("line_type" = 'other_deduction')
	),
	CONSTRAINT "settlement_statement_lines_amount_check" CHECK ("amount_rial" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_statement_lines_key" ON "settlement_statement_lines"
  ("statement_id", "line_type", "ref_type", "ref_id");--> statement-breakpoint
CREATE INDEX "settlement_statement_lines_ref_idx" ON "settlement_statement_lines" ("ref_type", "ref_id");--> statement-breakpoint
CREATE TRIGGER settlement_statement_lines_append_only BEFORE UPDATE OR DELETE ON "settlement_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "settlement_statement_lines" FROM sepehr_app;--> statement-breakpoint

-- === Permissions (accounting reads; a draft is cancelled by two of them) ===================
INSERT INTO "permissions" ("code") VALUES
  ('settlement.read_statements'), ('settlement.cancel_statement');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('accounting', 'settlement.read_statements'),
  ('accounting', 'settlement.cancel_statement')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
