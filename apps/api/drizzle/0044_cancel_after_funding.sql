-- 0044 cancelling after funding (task 4-8 [financial], part 7; doc 02 §6; owner 1405/07/14:
-- پ۱۱ الف, پ۱۲, پ۱۲-ب ج, پ۱۳, س۱ to س۵). Hand-written (ADR-003). Expand only, but for one
-- CHECK of 0039 replaced by a wider one (owner س۵), as 0040 did:
--   - the request kinds widen to cancel_after_funding;
--   - repayment_charges: the cancellation penalty, a lump sum with its own due day;
--   - contract_penalty_terms: the penalty rate locked when a contract is made (س۴);
--   - credit_penalty_overrides: a case's own rate, asked and approved by two people (پ۱۳);
--   - one configuration key and two permissions.

ALTER TABLE "purse_operation_requests" DROP CONSTRAINT "purse_operation_requests_kind_check";--> statement-breakpoint
ALTER TABLE "purse_operation_requests" ADD CONSTRAINT "purse_operation_requests_kind_check"
  CHECK ("kind" IN ('cancel_unused', 'reverse_cancel_unused', 'change_doctor', 'cancel_after_funding'));--> statement-breakpoint

-- === Charges outside the installments (repayment module) =================================
-- A cancellation penalty is collected at once, on its own due day (owner پ۱۲-ب ج); once per
-- schedule. Its payment's allocation is phase 6's (doc 15).
CREATE TABLE "repayment_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"schedule_id" uuid NOT NULL REFERENCES "installment_schedules" ("id"),
	"purse_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_rial" bigint NOT NULL,
	"due_on" date NOT NULL,
	-- The rate it was computed with (basis points), and from what.
	"rate_bps" integer NOT NULL,
	"base_rial" bigint NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repayment_charges_kind_check" CHECK ("kind" IN ('cancellation_penalty')),
	CONSTRAINT "repayment_charges_amount_check" CHECK ("amount_rial" > 0 AND "base_rial" > 0),
	CONSTRAINT "repayment_charges_rate_check" CHECK ("rate_bps" BETWEEN 0 AND 1800),
	CONSTRAINT "repayment_charges_reason_check" CHECK (length(trim("reason")) >= 3)
);--> statement-breakpoint
-- The penalty is never posted twice (owner): one per schedule.
CREATE UNIQUE INDEX "repayment_charges_once_key" ON "repayment_charges" ("schedule_id", "kind");--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_charges_key_key" ON "repayment_charges" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_charges_journal_key" ON "repayment_charges" ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "repayment_charges_due_idx" ON "repayment_charges" ("due_on");--> statement-breakpoint
CREATE TRIGGER repayment_charges_append_only BEFORE UPDATE OR DELETE ON "repayment_charges"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "repayment_charges" FROM sepehr_app;--> statement-breakpoint

-- === The penalty rate of each contract, locked when it is made (contract module; س۴) ======
-- A contract made before this migration has no row: its rate is the configuration in force
-- when it was made (the service reads it at the contract's own time).
CREATE TABLE "contract_penalty_terms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"contract_id" uuid NOT NULL REFERENCES "contracts" ("id"),
	"credit_application_id" uuid NOT NULL,
	"penalty_bps" integer NOT NULL,
	"source" text NOT NULL,
	"config_version_id" uuid,
	-- The credit module's override (no foreign key across modules).
	"override_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_penalty_terms_bps_check" CHECK ("penalty_bps" BETWEEN 0 AND 1800),
	CONSTRAINT "contract_penalty_terms_source_check" CHECK (
	  ("source" = 'config' AND "config_version_id" IS NOT NULL AND "override_id" IS NULL)
	  OR ("source" = 'override' AND "override_id" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX "contract_penalty_terms_contract_key" ON "contract_penalty_terms" ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_penalty_terms_application_idx" ON "contract_penalty_terms" ("credit_application_id");--> statement-breakpoint
CREATE TRIGGER contract_penalty_terms_append_only BEFORE UPDATE OR DELETE ON "contract_penalty_terms"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "contract_penalty_terms" FROM sepehr_app;--> statement-breakpoint

-- === A case's own penalty rate, asked by one and approved by another (credit module; پ۱۳) ==
-- 0 to 18% only (higher only with a new ADR); it counts for a contract made after it.
CREATE TABLE "credit_penalty_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL REFERENCES "credit_applications" ("id"),
	"penalty_bps" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_penalty_overrides_bps_check" CHECK ("penalty_bps" BETWEEN 0 AND 1800),
	CONSTRAINT "credit_penalty_overrides_reason_check" CHECK (length(trim("reason")) >= 3),
	CONSTRAINT "credit_penalty_overrides_status_check"
	  CHECK ("status" IN ('requested', 'approved', 'rejected')),
	CONSTRAINT "credit_penalty_overrides_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "credit_penalty_overrides_decision_check" CHECK (
	  ("status" = 'requested' AND "decided_by" IS NULL AND "decided_at" IS NULL)
	  OR ("status" IN ('approved', 'rejected') AND "decided_by" IS NOT NULL
	      AND "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX "credit_penalty_overrides_open_key" ON "credit_penalty_overrides" ("credit_application_id")
  WHERE "status" = 'requested';--> statement-breakpoint
CREATE INDEX "credit_penalty_overrides_application_idx"
  ON "credit_penalty_overrides" ("credit_application_id", "decided_at");--> statement-breakpoint
CREATE FUNCTION public.credit_penalty_overrides_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_reason', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'penalty override % can only be decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'requested'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'penalty override % was decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_penalty_overrides_guard BEFORE UPDATE ON "credit_penalty_overrides"
  FOR EACH ROW EXECUTE FUNCTION public.credit_penalty_overrides_guard();--> statement-breakpoint
CREATE TRIGGER credit_penalty_overrides_set_updated_at BEFORE UPDATE ON "credit_penalty_overrides"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER credit_penalty_overrides_no_delete BEFORE DELETE ON "credit_penalty_overrides"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "credit_penalty_overrides" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_reason", "updated_at")
  ON "credit_penalty_overrides" TO sepehr_app;--> statement-breakpoint

-- === Configuration and permissions ========================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('repayment.cancellation_penalty_due_days', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('repayment.cancellation_penalty_due_days', 'global', '30', '2020-01-01T00:00:00Z', 'approved',
   'مقدار اولیه، پاسخ مالک پ۱۲-ب؛ پیش از راه‌اندازی تأیید مشاور حقوقی (مهاجرت 0044)', now());--> statement-breakpoint
INSERT INTO "permissions" ("code") VALUES
  ('credit.request_penalty_override'), ('credit.approve_penalty_override');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('credit_specialist', 'credit.request_penalty_override'),
  ('credit_manager', 'credit.request_penalty_override'),
  ('credit_manager', 'credit.approve_penalty_override')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
