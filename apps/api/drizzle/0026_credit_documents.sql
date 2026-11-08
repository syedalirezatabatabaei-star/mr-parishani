-- 0026 credit documents (task 3-5 part C; doc 10 §4). Expand only: one table, one nullable
-- column on credit_applications, new triggers beside the old, three configuration keys.
CREATE TABLE "credit_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"guarantor_id" uuid,
	"item_code" text NOT NULL,
	"checklist_version_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"reason" text,
	"uploaded_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credit_documents_size_check" CHECK ("credit_documents"."size_bytes" > 0),
	CONSTRAINT "credit_documents_role_check" CHECK (("credit_documents"."role" = 'guarantor') = ("credit_documents"."guarantor_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "checklist_version_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_documents" ADD CONSTRAINT "credit_documents_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_documents" ADD CONSTRAINT "credit_documents_guarantor_id_credit_guarantors_id_fk" FOREIGN KEY ("guarantor_id") REFERENCES "public"."credit_guarantors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_documents_application_idx" ON "credit_documents" USING btree ("credit_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_documents_current_key" ON "credit_documents" USING btree ("credit_application_id","person_id","role","item_code") WHERE "credit_documents"."status" IN ('submitted', 'accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "credit_documents_storage_key" ON "credit_documents" USING btree ("storage_key");--> statement-breakpoint
-- === Hand-written (task 3-5 part C, doc 10 §4): expand only. ==============================
ALTER TABLE "credit_documents" ADD CONSTRAINT "credit_documents_status_check" CHECK ("status" IN ('submitted', 'accepted', 'rejected', 'superseded'));--> statement-breakpoint
ALTER TABLE "credit_documents" ADD CONSTRAINT "credit_documents_role_values_check" CHECK ("role" IN ('borrower', 'guarantor'));--> statement-breakpoint
ALTER TABLE "credit_documents" ADD CONSTRAINT "credit_documents_mime_check" CHECK ("mime" IN ('application/pdf', 'image/jpeg', 'image/png'));--> statement-breakpoint
-- Decided: by someone, at a time; a rejection says why.
ALTER TABLE "credit_documents" ADD CONSTRAINT "credit_documents_decision_check" CHECK (
  ("status" IN ('accepted', 'rejected')) = ("decided_at" IS NOT NULL AND "decided_by" IS NOT NULL)
  OR "status" = 'superseded'
);--> statement-breakpoint
ALTER TABLE "credit_documents" ADD CONSTRAINT "credit_documents_reason_check" CHECK (
  ("status" = 'rejected') = ("reason" IS NOT NULL) OR "status" = 'superseded'
);--> statement-breakpoint

-- A document: submitted → accepted | rejected | superseded; never back. What it is and
-- where its file lies never change.
CREATE FUNCTION public.credit_documents_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.credit_application_id, NEW.person_id, NEW.role, NEW.guarantor_id, NEW.item_code,
      NEW.checklist_version_id, NEW.storage_key, NEW.mime, NEW.size_bytes, NEW.sha256,
      NEW.uploaded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.credit_application_id, OLD.person_id, OLD.role, OLD.guarantor_id, OLD.item_code,
      OLD.checklist_version_id, OLD.storage_key, OLD.mime, OLD.size_bytes, OLD.sha256,
      OLD.uploaded_by, OLD.created_at) THEN
    RAISE EXCEPTION 'credit document % can only change its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.status = 'submitted' AND NEW.status IN ('accepted', 'rejected', 'superseded')
  ) THEN
    RAISE EXCEPTION 'credit document % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_documents_guard_change BEFORE UPDATE ON "credit_documents"
  FOR EACH ROW EXECUTE FUNCTION public.credit_documents_guard_change();--> statement-breakpoint
CREATE TRIGGER credit_documents_set_updated_at BEFORE UPDATE ON "credit_documents"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER credit_documents_no_delete BEFORE DELETE ON "credit_documents"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- The checklist version, once locked at submission, never changes (rule 16).
CREATE FUNCTION public.credit_applications_checklist_locked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.checklist_version_id IS NOT NULL AND NEW.checklist_version_id IS DISTINCT FROM OLD.checklist_version_id THEN
    RAISE EXCEPTION 'the checklist of credit application % is locked', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_applications_checklist_locked BEFORE UPDATE ON "credit_applications"
  FOR EACH ROW EXECUTE FUNCTION public.credit_applications_checklist_locked();--> statement-breakpoint

REVOKE UPDATE ON "credit_documents" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "reason", "decided_by", "decided_at") ON "credit_documents" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("checklist_version_id") ON "credit_applications" TO sepehr_app;--> statement-breakpoint

-- === Configuration =========================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('credit.document_checklist', 'business', true),
  ('credit.document_policy', 'technical', true),
  ('credit.document_sms_templates', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('credit.document_checklist', 'global',
   '{"items": [
      {"code": "national_card", "title": "تصویر کارت ملی", "roles": ["borrower", "guarantor"], "jobs": null, "required": true},
      {"code": "job_proof", "title": "مدرک شغل (حکم، قرارداد یا جواز کسب)", "roles": ["borrower", "guarantor"], "jobs": null, "required": true},
      {"code": "bank_statement", "title": "گردش حساب سه ماه اخیر", "roles": ["borrower", "guarantor"], "jobs": null, "required": true},
      {"code": "insurance_record", "title": "سابقه بیمه", "roles": ["borrower", "guarantor"], "jobs": ["self_employed_over_5", "self_employed_under_5"], "required": true}
    ]}',
   '2020-01-01T00:00:00Z', 'approved', 'فهرست آغازین تا فهرست کارفرما (مهاجرت 0026)', now()),
  ('credit.document_policy', 'global', '{"maxBytes": 10485760, "signedUrlSeconds": 300}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0026)', now()),
  ('credit.document_sms_templates', 'global',
   '{"documentRejected": "مدرک «{document}» پرونده اعتباری شما در سپهر سلامتی پذیرفته نشد. برای دیدن دلیل و بارگذاری دوباره وارد شوید."}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۰ §۴ (مهاجرت 0026)', now());
