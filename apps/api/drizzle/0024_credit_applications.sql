-- 0024 credit applications (task 3-5 part A; doc 10 §4). Expand only: two new tables,
-- their rules, two permissions and three configuration keys. No existing table changes.
CREATE TABLE "credit_application_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_account_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"case_id" uuid NOT NULL,
	"proforma_id" uuid NOT NULL,
	"patient_person_id" uuid NOT NULL,
	"borrower_person_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"plan_code" text NOT NULL,
	"plan_title" text NOT NULL,
	"plans_version_id" uuid NOT NULL,
	"rounding_version_id" uuid NOT NULL,
	"reduction_version_id" uuid NOT NULL,
	"installment_count" integer NOT NULL,
	"proforma_total_rial" bigint NOT NULL,
	"down_payment_rial" bigint NOT NULL,
	"loan_rial" bigint NOT NULL,
	"cash_top_up_rial" bigint NOT NULL,
	"plan_fee_rial" bigint NOT NULL,
	"plan_fee_timing" text NOT NULL,
	"origination_fee_rial" bigint NOT NULL,
	"total_obligation_rial" bigint NOT NULL,
	"needs_more_guarantors" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone,
	"sla_due_at" timestamp with time zone,
	"sla_breached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credit_applications_count_check" CHECK ("credit_applications"."installment_count" BETWEEN 1 AND 360),
	CONSTRAINT "credit_applications_amounts_check" CHECK ("credit_applications"."proforma_total_rial" > 0 AND "credit_applications"."down_payment_rial" >= 0 AND "credit_applications"."loan_rial" > 0
          AND "credit_applications"."cash_top_up_rial" >= 0 AND "credit_applications"."plan_fee_rial" >= 0 AND "credit_applications"."origination_fee_rial" >= 0
          AND "credit_applications"."down_payment_rial" + "credit_applications"."loan_rial" + "credit_applications"."cash_top_up_rial" = "credit_applications"."proforma_total_rial"
          AND "credit_applications"."total_obligation_rial" >= "credit_applications"."loan_rial")
);
--> statement-breakpoint
ALTER TABLE "credit_application_status_changes" ADD CONSTRAINT "credit_application_status_changes_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_application_status_changes_app_idx" ON "credit_application_status_changes" USING btree ("credit_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_applications_open_proforma_key" ON "credit_applications" USING btree ("proforma_id") WHERE "credit_applications"."status" NOT IN ('rejected', 'expired') AND "credit_applications"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "credit_applications_case_idx" ON "credit_applications" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "credit_applications_borrower_idx" ON "credit_applications" USING btree ("borrower_person_id");--> statement-breakpoint
CREATE INDEX "credit_applications_patient_idx" ON "credit_applications" USING btree ("patient_person_id");--> statement-breakpoint
CREATE INDEX "credit_applications_status_idx" ON "credit_applications" USING btree ("status","sla_due_at");--> statement-breakpoint
-- === Hand-written (task 3-5, doc 10 §4): expand only; no existing table changes. ==========
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_status_check" CHECK ("status" IN ('draft', 'incomplete', 'ready_for_review', 'scoring', 'manual_review', 'approved', 'conditional', 'rejected', 'expired'));--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_fee_timing_check" CHECK ("plan_fee_timing" IN ('at_completion', 'spread'));--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_sla_check" CHECK (
  ("sla_breached_at" IS NULL OR "sla_due_at" IS NOT NULL)
  -- A draft was never submitted; anything past it was, except a draft that expired.
  AND (("status" = 'draft' AND "submitted_at" IS NULL)
       OR "status" = 'expired'
       OR ("status" NOT IN ('draft', 'expired') AND "submitted_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "credit_application_status_changes" ADD CONSTRAINT "credit_application_status_changes_status_check" CHECK ("to_status" IN ('draft', 'incomplete', 'ready_for_review', 'scoring', 'manual_review', 'approved', 'conditional', 'rejected', 'expired'));--> statement-breakpoint

-- Only the glossary's life (rule 8):
--   draft → incomplete | expired
--   incomplete → ready_for_review | expired
--   ready_for_review → scoring | incomplete            (back: e.g. more guarantors needed)
--   scoring → manual_review | incomplete
--   manual_review → approved | conditional | rejected | incomplete   (decisions: task 3-6)
-- What was chosen (plan, preview, persons, proforma) never changes.
CREATE FUNCTION public.credit_applications_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.case_id, NEW.proforma_id, NEW.patient_person_id, NEW.borrower_person_id,
      NEW.created_by, NEW.plan_code, NEW.plan_title, NEW.plans_version_id, NEW.rounding_version_id,
      NEW.reduction_version_id, NEW.installment_count, NEW.proforma_total_rial, NEW.down_payment_rial,
      NEW.loan_rial, NEW.cash_top_up_rial, NEW.plan_fee_rial, NEW.plan_fee_timing,
      NEW.origination_fee_rial, NEW.total_obligation_rial, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.case_id, OLD.proforma_id, OLD.patient_person_id, OLD.borrower_person_id,
      OLD.created_by, OLD.plan_code, OLD.plan_title, OLD.plans_version_id, OLD.rounding_version_id,
      OLD.reduction_version_id, OLD.installment_count, OLD.proforma_total_rial, OLD.down_payment_rial,
      OLD.loan_rial, OLD.cash_top_up_rial, OLD.plan_fee_rial, OLD.plan_fee_timing,
      OLD.origination_fee_rial, OLD.total_obligation_rial, OLD.created_at) THEN
    RAISE EXCEPTION 'credit application % can only change its state', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('incomplete', 'expired'))
    OR (OLD.status = 'incomplete' AND NEW.status IN ('ready_for_review', 'expired'))
    OR (OLD.status = 'ready_for_review' AND NEW.status IN ('scoring', 'incomplete'))
    OR (OLD.status = 'scoring' AND NEW.status IN ('manual_review', 'incomplete'))
    OR (OLD.status = 'manual_review' AND NEW.status IN ('approved', 'conditional', 'rejected', 'incomplete'))
  ) THEN
    RAISE EXCEPTION 'credit application % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'credit application % was submitted once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sla_breached_at IS NOT NULL AND NEW.sla_breached_at IS DISTINCT FROM OLD.sla_breached_at THEN
    RAISE EXCEPTION 'the deadline of credit application % was missed once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_applications_guard_change BEFORE UPDATE ON "credit_applications"
  FOR EACH ROW EXECUTE FUNCTION public.credit_applications_guard_change();--> statement-breakpoint
CREATE TRIGGER credit_applications_set_updated_at BEFORE UPDATE ON "credit_applications"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER credit_applications_no_delete BEFORE DELETE ON "credit_applications"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER credit_application_status_changes_append_only BEFORE UPDATE OR DELETE ON "credit_application_status_changes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

REVOKE UPDATE ON "credit_application_status_changes" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "credit_applications" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "needs_more_guarantors", "submitted_at", "sla_due_at", "sla_breached_at")
  ON "credit_applications" TO sepehr_app;--> statement-breakpoint

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES
  ('credit.read_applications'),
  ('credit.complete_applications');--> statement-breakpoint
-- The credit units read applications (field limits apply in the service, doc 10 §6); the
-- case-completion specialist sends them on to review. Patients and borrowers act on their
-- own (self-service).
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('case_completion', 'credit.read_applications'),
  ('case_completion', 'credit.complete_applications'),
  ('credit_specialist', 'credit.read_applications'),
  ('strategy_manager', 'credit.read_applications'),
  ('auditor', 'credit.read_applications')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration =========================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('credit.sla_hours', 'business', true),
  ('credit.sla_business_hours_only', 'business', true),
  ('credit.incomplete_expiry_days', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('credit.sla_hours', 'global', '24',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۰ §۴ (مهاجرت 0024)', now()),
  ('credit.sla_business_hours_only', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۰ §۴ (مهاجرت 0024)', now()),
  ('credit.incomplete_expiry_days', 'global', '30',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۰ §۴ (مهاجرت 0024)', now());
