-- 0025 consent, score sheets and guarantors (task 3-5 part B; doc 10 §4–§5). Expand only:
-- three new tables, three new nullable columns on credit_applications (made in 0024), new
-- triggers beside the old ones, one permission, two configuration keys.
CREATE TABLE "credit_consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"consent_text_version_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"session_id" uuid,
	"ip" text,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_guarantors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" uuid NOT NULL,
	"consent_at" timestamp with time zone,
	"grade" text,
	"weight" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credit_guarantors_weight_check" CHECK ("credit_guarantors"."weight" IS NULL OR "credit_guarantors"."weight" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "score_sheets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"person_id" uuid NOT NULL,
	"guarantor_id" uuid,
	"ruleset_version_id" uuid NOT NULL,
	"raw_inputs" jsonb NOT NULL,
	"answers" jsonb NOT NULL,
	"criteria_scores" jsonb NOT NULL,
	"total" integer,
	"grade" text,
	"stop" boolean,
	"computed_by" uuid NOT NULL,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "score_sheets_subject_check" CHECK (("score_sheets"."subject" = 'guarantor') = ("score_sheets"."guarantor_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "ruleset_version_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "borrower_grade" text;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "amount_level" text;--> statement-breakpoint
ALTER TABLE "credit_consents" ADD CONSTRAINT "credit_consents_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_guarantors" ADD CONSTRAINT "credit_guarantors_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_sheets" ADD CONSTRAINT "score_sheets_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_sheets" ADD CONSTRAINT "score_sheets_guarantor_id_credit_guarantors_id_fk" FOREIGN KEY ("guarantor_id") REFERENCES "public"."credit_guarantors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_consents_person_key" ON "credit_consents" USING btree ("credit_application_id","person_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_guarantors_person_key" ON "credit_guarantors" USING btree ("credit_application_id","person_id") WHERE "credit_guarantors"."status" <> 'withdrawn';--> statement-breakpoint
CREATE INDEX "credit_guarantors_person_idx" ON "credit_guarantors" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "score_sheets_application_idx" ON "score_sheets" USING btree ("credit_application_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "score_sheets_current_key" ON "score_sheets" USING btree ("credit_application_id","person_id","subject") WHERE "score_sheets"."superseded_by" IS NULL;--> statement-breakpoint
-- === Hand-written (task 3-5 part B, doc 10 §4–§5): expand only. ============================
ALTER TABLE "credit_consents" ADD CONSTRAINT "credit_consents_role_check" CHECK ("role" IN ('borrower', 'guarantor'));--> statement-breakpoint
ALTER TABLE "credit_guarantors" ADD CONSTRAINT "credit_guarantors_status_check" CHECK ("status" IN ('invited', 'consented', 'scored', 'withdrawn'));--> statement-breakpoint
ALTER TABLE "credit_guarantors" ADD CONSTRAINT "credit_guarantors_scored_check" CHECK (
  ("status" = 'scored') = ("grade" IS NOT NULL AND "weight" IS NOT NULL)
  OR "status" = 'withdrawn'
);--> statement-breakpoint
ALTER TABLE "score_sheets" ADD CONSTRAINT "score_sheets_subject_values_check" CHECK ("subject" IN ('borrower', 'guarantor'));--> statement-breakpoint

-- The rules version of an application, once locked by its first sheet, never changes
-- (doc 03 §8-3). A trigger of its own, beside 0024's guard.
CREATE FUNCTION public.credit_applications_ruleset_locked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.ruleset_version_id IS NOT NULL AND NEW.ruleset_version_id IS DISTINCT FROM OLD.ruleset_version_id THEN
    RAISE EXCEPTION 'the rules version of credit application % is locked', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_applications_ruleset_locked BEFORE UPDATE ON "credit_applications"
  FOR EACH ROW EXECUTE FUNCTION public.credit_applications_ruleset_locked();--> statement-breakpoint

-- A guarantor: invited → consented → scored (scored again on a new sheet); withdrawn from
-- any; consent given once. Who they are and on what application never changes.
CREATE FUNCTION public.credit_guarantors_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.credit_application_id, NEW.person_id, NEW.invited_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.credit_application_id, OLD.person_id, OLD.invited_by, OLD.created_at) THEN
    RAISE EXCEPTION 'guarantor % can only change its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'withdrawn' THEN
    RAISE EXCEPTION 'guarantor % was withdrawn', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'invited' AND NEW.status IN ('consented', 'withdrawn'))
    OR (OLD.status = 'consented' AND NEW.status IN ('scored', 'withdrawn'))
    OR (OLD.status = 'scored' AND NEW.status = 'withdrawn')
  ) THEN
    RAISE EXCEPTION 'guarantor % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.consent_at IS NOT NULL AND NEW.consent_at IS DISTINCT FROM OLD.consent_at THEN
    RAISE EXCEPTION 'guarantor % consented once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_guarantors_guard_change BEFORE UPDATE ON "credit_guarantors"
  FOR EACH ROW EXECUTE FUNCTION public.credit_guarantors_guard_change();--> statement-breakpoint
CREATE TRIGGER credit_guarantors_set_updated_at BEFORE UPDATE ON "credit_guarantors"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER credit_guarantors_no_delete BEFORE DELETE ON "credit_guarantors"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- A sheet is never changed, except that a later one supersedes it, once.
CREATE FUNCTION public.score_sheets_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
     OR (to_jsonb(NEW) - 'superseded_by') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_by') THEN
    RAISE EXCEPTION 'score sheet % is fixed; only a later sheet supersedes it, once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER score_sheets_guard_change BEFORE UPDATE ON "score_sheets"
  FOR EACH ROW EXECUTE FUNCTION public.score_sheets_guard_change();--> statement-breakpoint
CREATE TRIGGER score_sheets_no_delete BEFORE DELETE ON "score_sheets"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER credit_consents_append_only BEFORE UPDATE OR DELETE ON "credit_consents"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

REVOKE UPDATE ON "credit_consents" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "credit_guarantors" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "consent_at", "grade", "weight") ON "credit_guarantors" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "score_sheets" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("superseded_by") ON "score_sheets" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("ruleset_version_id", "borrower_grade", "amount_level") ON "credit_applications" TO sepehr_app;--> statement-breakpoint

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES ('credit.score_applications');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'credit.score_applications' FROM "roles" r
WHERE r.code = 'credit_specialist' AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration =========================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('credit.consent_text', 'business', true),
  ('credit.sms_templates', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('credit.consent_text', 'global',
   '{"text": "متن نمونه — غیرقابل استفاده: اینجانب با بررسی اطلاعات اعتباری، شغلی و بانکی خود برای این پرونده اعتباری موافقت می‌کنم. متن نهایی را مشاور حقوقی شرکت تأمین می‌کند."}',
   '2020-01-01T00:00:00Z', 'approved', 'متن نمونه تا رسیدن متن حقوقی (مهاجرت 0025)', now()),
  ('credit.sms_templates', 'global',
   '{"guarantorInvited": "شما به‌عنوان ضامن یک پرونده اعتباری با تعهد {amount} تومان در سپهر سلامتی معرفی شده‌اید. برای بررسی و رضایت وارد شوید."}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۰ §۵ (مهاجرت 0025)', now());
