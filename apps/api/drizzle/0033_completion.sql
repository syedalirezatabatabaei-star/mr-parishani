-- 0033 case completion and its receipts (task 4-3 [financial]; doc 12 §4; owner 1405/07/11).
-- Expand only: three new tables, their rules, two permissions. No existing table changes.
CREATE TABLE "credit_condition_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"condition_index" integer NOT NULL,
	"condition_text" text NOT NULL,
	"checked_by" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_condition_checks_index_check" CHECK ("credit_condition_checks"."condition_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "case_completions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"completed_by" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "completion_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_rial" bigint NOT NULL,
	"expected_rial" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"reference" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"rejection_reason" text,
	"journal_entry_id" uuid,
	"uploaded_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "completion_receipts_amount_check" CHECK ("completion_receipts"."amount_rial" > 0 AND "completion_receipts"."expected_rial" > 0 AND "completion_receipts"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_condition_checks" ADD CONSTRAINT "credit_condition_checks_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_condition_checks_condition_key" ON "credit_condition_checks" USING btree ("credit_application_id","condition_index");--> statement-breakpoint
CREATE UNIQUE INDEX "case_completions_application_key" ON "case_completions" USING btree ("credit_application_id");--> statement-breakpoint
CREATE INDEX "completion_receipts_application_idx" ON "completion_receipts" USING btree ("credit_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "completion_receipts_open_key" ON "completion_receipts" USING btree ("credit_application_id","kind") WHERE "completion_receipts"."status" IN ('pending_approval', 'approved') AND "completion_receipts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "completion_receipts_storage_key" ON "completion_receipts" USING btree ("storage_key");--> statement-breakpoint
-- === Hand-written (task 4-3, doc 12 §4; owner 1405/07/11): expand only. =================
-- No existing table changes; the ledger is written only through the ledger module's port.
ALTER TABLE "completion_receipts" ADD CONSTRAINT "completion_receipts_values_check" CHECK (
  "kind" IN ('origination_fee', 'plan_fee', 'down_payment')
  AND "status" IN ('pending_approval', 'approved', 'rejected')
  AND (("status" = 'pending_approval') = ("decided_at" IS NULL))
  AND (("status" = 'pending_approval') = ("decided_by" IS NULL))
  AND (("status" = 'rejected') = ("rejection_reason" IS NOT NULL))
  -- Approved only at exactly the amount owed (owner, پ۴).
  AND ("status" <> 'approved' OR "amount_rial" = "expected_rial")
  -- The down payment has no ledger entry yet (owner, پ۳); the fees always one.
  AND ("status" <> 'approved' OR ("kind" = 'down_payment') = ("journal_entry_id" IS NULL))
  AND ("status" = 'approved' OR "journal_entry_id" IS NULL)
  AND "sha256" ~ '^[0-9a-f]{64}$'
);--> statement-breakpoint

-- A receipt: decided once; what was paid, by whom, and its file never change.
CREATE FUNCTION public.completion_receipts_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'rejection_reason', 'journal_entry_id',
                                 'decided_by', 'decided_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'receipt % can only change its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending_approval' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'receipt % was decided', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER completion_receipts_guard_change BEFORE UPDATE ON "completion_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.completion_receipts_guard_change();--> statement-breakpoint
CREATE TRIGGER completion_receipts_set_updated_at BEFORE UPDATE ON "completion_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER completion_receipts_no_delete BEFORE DELETE ON "completion_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER case_completions_append_only BEFORE UPDATE OR DELETE ON "case_completions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER credit_condition_checks_append_only BEFORE UPDATE OR DELETE ON "credit_condition_checks"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

REVOKE UPDATE ON "completion_receipts" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "rejection_reason", "journal_entry_id", "decided_by", "decided_at", "updated_at")
  ON "completion_receipts" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "case_completions" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "credit_condition_checks" FROM sepehr_app;--> statement-breakpoint

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES ('contract.complete'), ('credit.check_conditions');--> statement-breakpoint
-- Finance decides receipts with the permission of task 1-3 (repayment.approve_payment).
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('case_completion', 'contract.complete'),
  ('case_completion', 'credit.check_conditions')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
