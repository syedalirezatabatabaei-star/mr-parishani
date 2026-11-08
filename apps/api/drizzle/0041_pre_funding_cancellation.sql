-- 0041 cancelling a credit application before funding (task 4-8 [financial], part 3; doc 12
-- §7; owner 1405/07/14: the origination fee, the plan fee paid at completion and the down
-- payment are all refunded, without penalty). Hand-written (ADR-003). Expand only: two new
-- tables and two permissions; no existing table, column or constraint changes.

-- === Cancellations, asked by one person and decided by another (credit module) ============
-- The application row keeps its status; an approved cancellation is what makes the credit
-- module report it `cancelled` to the contract and wallet modules (no funding, no completion).
CREATE TABLE "credit_application_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL REFERENCES "credit_applications" ("id"),
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	-- What was refunded: receipt ids, kinds and amounts as rial text (rule 30: no names).
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_application_cancellations_status_check"
	  CHECK ("status" IN ('requested', 'approved', 'rejected')),
	CONSTRAINT "credit_application_cancellations_reason_check" CHECK (length(trim("reason")) >= 3),
	CONSTRAINT "credit_application_cancellations_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "credit_application_cancellations_decision_check" CHECK (
	  ("status" = 'requested' AND "decided_by" IS NULL AND "decided_at" IS NULL AND "result" IS NULL)
	  OR ("status" = 'approved' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL
	     AND "result" IS NOT NULL)
	  OR ("status" = 'rejected' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL
	     AND "decision_reason" IS NOT NULL AND "result" IS NULL)
	)
);--> statement-breakpoint
-- One open request per application, and an application is cancelled once.
CREATE UNIQUE INDEX "credit_application_cancellations_open_key"
  ON "credit_application_cancellations" ("credit_application_id") WHERE "status" = 'requested';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_application_cancellations_done_key"
  ON "credit_application_cancellations" ("credit_application_id") WHERE "status" = 'approved';--> statement-breakpoint
CREATE INDEX "credit_application_cancellations_status_idx"
  ON "credit_application_cancellations" ("status", "requested_at");--> statement-breakpoint
CREATE FUNCTION public.credit_application_cancellations_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_reason',
                                 'result', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'credit application cancellation % can only be decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'requested'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'credit application cancellation % was decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_application_cancellations_guard BEFORE UPDATE ON "credit_application_cancellations"
  FOR EACH ROW EXECUTE FUNCTION public.credit_application_cancellations_guard();--> statement-breakpoint
CREATE TRIGGER credit_application_cancellations_set_updated_at BEFORE UPDATE ON "credit_application_cancellations"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER credit_application_cancellations_no_delete BEFORE DELETE ON "credit_application_cancellations"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "credit_application_cancellations" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_reason", "result", "updated_at")
  ON "credit_application_cancellations" TO sepehr_app;--> statement-breakpoint

-- === Refunds of a cancelled application's receipts (contract module) ======================
-- One per receipt, append-only. A fee: Dr company.fee_income, Cr fee.refund_payable; a down
-- payment: Dr downpayment.held, Cr downpayment.refund_payable (owner, س۱). The bank transfer
-- that pays it is a later step (Dr the refund account, Cr bank.settlement).
CREATE TABLE "completion_refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"receipt_id" uuid NOT NULL REFERENCES "completion_receipts" ("id"),
	"credit_application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"borrower_person_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	-- The credit module's cancellation (no foreign key across modules).
	"cancellation_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "completion_refunds_kind_check"
	  CHECK ("kind" IN ('origination_fee', 'plan_fee', 'down_payment')),
	CONSTRAINT "completion_refunds_amount_check" CHECK ("amount_rial" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "completion_refunds_receipt_key" ON "completion_refunds" ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "completion_refunds_journal_key" ON "completion_refunds" ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "completion_refunds_application_idx" ON "completion_refunds" ("credit_application_id");--> statement-breakpoint
CREATE TRIGGER completion_refunds_append_only BEFORE UPDATE OR DELETE ON "completion_refunds"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "completion_refunds" FROM sepehr_app;--> statement-breakpoint

-- === Permissions (asked by case completion or accounting, decided by accounting) ===========
INSERT INTO "permissions" ("code") VALUES
  ('credit.request_cancellation'), ('credit.approve_cancellation');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('case_completion', 'credit.request_cancellation'),
  ('accounting', 'credit.request_cancellation'),
  ('accounting', 'credit.approve_cancellation')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
