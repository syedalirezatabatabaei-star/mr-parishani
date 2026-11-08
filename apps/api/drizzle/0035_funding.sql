-- 0035 funding the credit purse (task 4-5 [financial]; doc 12 §5; ADR-034; owner 1405/07/11).
-- Hand-written (ADR-003: explicit SQL in financial modules).
--
-- On existing financial tables (owner's decisions 2 and 5):
--   * credit_purses: an added column, down_payment_rial (expand), and its guard knows it.
--   * one purse and one schedule per credit application instead of per case: the new
--     unique indexes first, then the old case constraints are dropped.
-- New: funding_requests (two people), two permissions, the SMS templates.

-- === The purse holds the down payment (ADR-034) ===============================================
ALTER TABLE "credit_purses" ADD COLUMN "down_payment_rial" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_purses" ADD CONSTRAINT "credit_purses_down_payment_check"
  CHECK ("down_payment_rial" >= 0);--> statement-breakpoint

-- The guard of 0006, with the new column among what never changes.
CREATE OR REPLACE FUNCTION public.credit_purses_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.entity_id, NEW.case_id, NEW.credit_application_id, NEW.borrower_person_id,
      NEW.approved_amount_rial, NEW.down_payment_rial, NEW.center_node_id, NEW.doctor_node_id,
      NEW.treatment_field_code, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.entity_id, OLD.case_id, OLD.credit_application_id, OLD.borrower_person_id,
      OLD.approved_amount_rial, OLD.down_payment_rial, OLD.center_node_id, OLD.doctor_node_id,
      OLD.treatment_field_code, OLD.created_at) THEN
    RAISE EXCEPTION 'credit purse % can only change its state', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'approved' AND NEW.status IN ('funded', 'closed'))
    OR (OLD.status = 'funded' AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'credit purse % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.funded_at IS NOT NULL AND NEW.funded_at IS DISTINCT FROM OLD.funded_at THEN
    RAISE EXCEPTION 'funded_at of credit purse % is fixed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- === One purse and one schedule per credit application (owner, decision 5) ===================
-- Members of a treatment group (task 3-7) share a case; each has its own application, purse,
-- debt and schedule. A purse without an application (phase 1's own use) stays one per case.
CREATE UNIQUE INDEX "credit_purses_application_key" ON "credit_purses" ("credit_application_id")
  WHERE "credit_application_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_purses_case_without_application_key" ON "credit_purses" ("case_id")
  WHERE "credit_application_id" IS NULL;--> statement-breakpoint
ALTER TABLE "credit_purses" DROP CONSTRAINT "credit_purses_case_key";--> statement-breakpoint
-- installment_schedules_purse_key stays: one schedule per purse, so per application.
CREATE INDEX "installment_schedules_case_idx" ON "installment_schedules" ("case_id");--> statement-breakpoint
ALTER TABLE "installment_schedules" DROP CONSTRAINT "installment_schedules_case_key";--> statement-breakpoint

-- === Funding requests: asked by one person, approved by another finance person ===============
CREATE TABLE "funding_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL REFERENCES "credit_applications" ("id"),
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"purse_id" uuid REFERENCES "credit_purses" ("id"),
	"schedule_id" uuid REFERENCES "installment_schedules" ("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_requests_status_check"
	  CHECK ("status" IN ('requested', 'approved', 'rejected', 'cancelled')),
	-- Maker-checker (doc 12 §5; owner, decision 7): never the same person.
	CONSTRAINT "funding_requests_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "funding_requests_decision_check" CHECK (
	  ("status" = 'requested' AND "decided_by" IS NULL AND "decided_at" IS NULL
	     AND "purse_id" IS NULL AND "schedule_id" IS NULL)
	  OR ("status" = 'approved' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL
	     AND "purse_id" IS NOT NULL AND "schedule_id" IS NOT NULL)
	  OR ("status" IN ('rejected', 'cancelled') AND "decided_by" IS NOT NULL
	     AND "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL
	     AND "purse_id" IS NULL AND "schedule_id" IS NULL)
	)
);--> statement-breakpoint
-- One open or approved request per application.
CREATE UNIQUE INDEX "funding_requests_open_key" ON "funding_requests" ("credit_application_id")
  WHERE "status" IN ('requested', 'approved');--> statement-breakpoint
CREATE INDEX "funding_requests_status_idx" ON "funding_requests" ("status", "requested_at");--> statement-breakpoint
CREATE TRIGGER funding_requests_set_updated_at BEFORE UPDATE ON "funding_requests"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER funding_requests_no_delete BEFORE DELETE ON "funding_requests"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- Decided once, from requested; what was asked never changes (rule 8).
CREATE FUNCTION public.funding_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.credit_application_id, NEW.requested_by, NEW.requested_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.credit_application_id, OLD.requested_by, OLD.requested_at, OLD.created_at) THEN
    RAISE EXCEPTION 'funding request % can only be decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'requested' AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'funding request % was decided', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER funding_requests_guard BEFORE UPDATE ON "funding_requests"
  FOR EACH ROW EXECUTE FUNCTION public.funding_requests_guard();--> statement-breakpoint
REVOKE UPDATE ON "funding_requests" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_reason", "purse_id", "schedule_id",
              "updated_at")
  ON "funding_requests" TO sepehr_app;--> statement-breakpoint

-- === Permissions (doc 12 §5; owner, decision 7) ==============================================
INSERT INTO "permissions" ("code") VALUES ('wallet.request_funding'), ('wallet.approve_funding');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('case_completion', 'wallet.request_funding'),
  ('accounting', 'wallet.approve_funding')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration =========================================================================
-- The doctor's SMS has no amount and nothing of the patient's finances (doc 12 §5, §9.10).
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('wallet.sms_templates', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('wallet.sms_templates', 'global',
   '{"patientFunded": "اعتبار درمان شما در سپهر سلامتی به مبلغ {amount} آماده استفاده است. {count} قسط ماهانه، قسط اول {firstAmount} در {firstDue}.", "doctorPatientReady": "یک بیمار معرفی‌شده به شما در سپهر سلامتی آماده دریافت خدمت است. جزئیات در پنل."}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۲ §۵ (مهاجرت 0035)', now());
