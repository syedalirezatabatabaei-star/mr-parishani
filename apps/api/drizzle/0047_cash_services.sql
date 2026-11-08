-- 0047 cash services and their fee (task 5-3 [financial]; doc 06 §4; doc 14 ت, 5-3; client
-- answers 1405/07/10 §3: no attribution window, confirmed by hand). Hand-written (ADR-003).
-- Expand only: one new table and two permissions; the cash fee itself goes in service_fees
-- (0045 already allows kind = 'cash' with cash_service_id).

CREATE TABLE "cash_services" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	-- The booking module's referral (no foreign key across modules): to this very doctor.
	"referral_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"case_id" uuid,
	"doctor_id" uuid NOT NULL,
	"doctor_node_id" uuid NOT NULL,
	"workplace_id" uuid NOT NULL,
	"center_node_id" uuid NOT NULL,
	"treatment_field_code" text NOT NULL,
	-- Tehran's day of the service (Jalali in every page).
	"service_date" date NOT NULL,
	"amount_rial" bigint NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_services_amount_check" CHECK ("amount_rial" > 0),
	CONSTRAINT "cash_services_source_check" CHECK ("source" IN ('doctor_declared', 'advisor_recorded')),
	CONSTRAINT "cash_services_status_check"
	  CHECK ("status" IN ('recorded', 'disputed', 'confirmed', 'voided')),
	CONSTRAINT "cash_services_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 200),
	-- The doctor's own word is their confirmation; an advisor's waits for someone else's.
	CONSTRAINT "cash_services_declared_check"
	  CHECK ("source" <> 'doctor_declared' OR "status" = 'confirmed'),
	CONSTRAINT "cash_services_two_people_check"
	  CHECK ("source" <> 'advisor_recorded' OR "decided_by" IS NULL OR "decided_by" <> "recorded_by"),
	CONSTRAINT "cash_services_decision_check" CHECK (
	  ("status" IN ('recorded', 'disputed') AND "decided_by" IS NULL)
	  OR ("status" IN ('confirmed', 'voided') AND "decided_at" IS NOT NULL
	      AND ("source" = 'doctor_declared' OR "decided_by" IS NOT NULL))
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX "cash_services_key_key" ON "cash_services" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "cash_services_doctor_idx" ON "cash_services" ("doctor_id", "status", "service_date");--> statement-breakpoint
CREATE INDEX "cash_services_referral_idx" ON "cash_services" ("referral_id");--> statement-breakpoint
CREATE FUNCTION public.cash_services_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_reason', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'cash service % keeps its referral, doctor, day and amount', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'recorded' AND NEW.status IN ('confirmed', 'disputed', 'voided'))
    OR (OLD.status = 'disputed' AND NEW.status IN ('confirmed', 'voided'))
  ) THEN
    RAISE EXCEPTION 'cash service % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cash_services_guard BEFORE UPDATE ON "cash_services"
  FOR EACH ROW EXECUTE FUNCTION public.cash_services_guard();--> statement-breakpoint
CREATE TRIGGER cash_services_set_updated_at BEFORE UPDATE ON "cash_services"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER cash_services_no_delete BEFORE DELETE ON "cash_services"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "cash_services" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_reason", "updated_at")
  ON "cash_services" TO sepehr_app;--> statement-breakpoint

-- === Permissions (an advisor or accounting records; accounting confirms, never the recorder)
INSERT INTO "permissions" ("code") VALUES
  ('settlement.record_cash_service'), ('settlement.confirm_cash_service');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('advisor', 'settlement.record_cash_service'),
  ('accounting', 'settlement.record_cash_service'),
  ('accounting', 'settlement.confirm_cash_service')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
