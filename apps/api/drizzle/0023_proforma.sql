-- 0023 proformas (task 3-4; doc 10 §2). Expand only: four new tables, their rules, three
-- permissions and proforma.validity_days. No existing table changes.
CREATE TABLE "proforma_deviation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"proforma_id" uuid NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proforma_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"proforma_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"service_id" uuid NOT NULL,
	"service_code" text NOT NULL,
	"tariff_version_id" uuid NOT NULL,
	"tariff_min_rial" bigint NOT NULL,
	"tariff_max_rial" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"unit_rial" bigint NOT NULL,
	"deviation_reason" text,
	"line_total_rial" bigint NOT NULL,
	"tooth_or_site" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proforma_lines_quantity_check" CHECK ("proforma_lines"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "proforma_lines_amounts_check" CHECK ("proforma_lines"."unit_rial" >= 0 AND "proforma_lines"."tariff_min_rial" >= 0 AND "proforma_lines"."tariff_max_rial" >= "proforma_lines"."tariff_min_rial"
          AND "proforma_lines"."line_total_rial" = "proforma_lines"."unit_rial" * "proforma_lines"."quantity"),
	CONSTRAINT "proforma_lines_deviation_check" CHECK (("proforma_lines"."unit_rial" BETWEEN "proforma_lines"."tariff_min_rial" AND "proforma_lines"."tariff_max_rial") OR "proforma_lines"."deviation_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "proformas" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"case_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"referral_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"workplace_id" uuid NOT NULL,
	"center_id" uuid,
	"city_code" text NOT NULL,
	"version" integer NOT NULL,
	"supersedes_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_rial" bigint NOT NULL,
	"tariff_snapshot_at" timestamp with time zone NOT NULL,
	"issued_by" uuid,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"validity_config_version_id" uuid,
	"patient_responded_at" timestamp with time zone,
	"patient_response_note" text,
	"created_by" uuid,
	"discard_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proformas_version_check" CHECK ("proformas"."version" >= 1),
	CONSTRAINT "proformas_total_check" CHECK ("proformas"."total_rial" >= 0)
);
--> statement-breakpoint
CREATE TABLE "support_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"account_id" uuid,
	"note" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proforma_deviation_reviews" ADD CONSTRAINT "proforma_deviation_reviews_proforma_id_proformas_id_fk" FOREIGN KEY ("proforma_id") REFERENCES "public"."proformas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_lines" ADD CONSTRAINT "proforma_lines_proforma_id_proformas_id_fk" FOREIGN KEY ("proforma_id") REFERENCES "public"."proformas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_supersedes_id_proformas_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."proformas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proforma_deviation_reviews_proforma_idx" ON "proforma_deviation_reviews" USING btree ("proforma_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proforma_lines_line_key" ON "proforma_lines" USING btree ("proforma_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "proformas_supersedes_key" ON "proformas" USING btree ("supersedes_id") WHERE "proformas"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "proformas_city_status_idx" ON "proformas" USING btree ("city_code","status");--> statement-breakpoint
CREATE INDEX "proformas_case_idx" ON "proformas" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "proformas_workplace_status_idx" ON "proformas" USING btree ("workplace_id","status");--> statement-breakpoint
CREATE INDEX "proformas_person_idx" ON "proformas" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "support_requests_subject_idx" ON "support_requests" USING btree ("subject_type","subject_id");--> statement-breakpoint
-- === Hand-written (task 3-4, doc 10 §2): expand only; no existing table changes. ==========
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_status_check" CHECK ("status" IN ('draft', 'issued', 'patient_confirmed', 'disputed', 'superseded', 'expired'));--> statement-breakpoint
-- Issued: by someone, at a time, with its deadline; a draft has none of these.
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_issue_check" CHECK (
  ("status" = 'draft') = ("issued_at" IS NULL)
  AND ("issued_at" IS NULL) = ("expires_at" IS NULL)
  AND ("issued_at" IS NULL) = ("issued_by" IS NULL)
  AND ("expires_at" IS NULL OR "expires_at" > "issued_at")
);--> statement-breakpoint
-- A discarded draft says why; only a draft is discarded (rule 7: never deleted).
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_discard_check" CHECK (
  ("deleted_at" IS NULL) = ("discard_reason" IS NULL) AND ("deleted_at" IS NULL OR "status" = 'draft')
);--> statement-breakpoint
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_version_chain_check" CHECK (
  ("supersedes_id" IS NULL) = ("version" = 1)
);--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_subject_check" CHECK ("subject_type" IN ('proforma'));--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_status_check" CHECK ("status" IN ('open'));--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_note_check" CHECK (length("note") BETWEEN 3 AND 1000);--> statement-breakpoint
ALTER TABLE "proforma_deviation_reviews" ADD CONSTRAINT "proforma_deviation_reviews_note_check" CHECK (length("note") BETWEEN 3 AND 1000);--> statement-breakpoint

-- Only the life of the glossary (rule 8): draft → issued → patient_confirmed | disputed |
-- superseded | expired; disputed → superseded | expired. An expired one is never revived:
-- a new version only points at it. What a proforma says never changes after it is made.
CREATE FUNCTION public.proformas_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.case_id, NEW.person_id, NEW.referral_id, NEW.doctor_id, NEW.workplace_id,
      NEW.center_id, NEW.city_code, NEW.version, NEW.supersedes_id, NEW.total_rial, NEW.tariff_snapshot_at,
      NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.case_id, OLD.person_id, OLD.referral_id, OLD.doctor_id, OLD.workplace_id,
      OLD.center_id, OLD.city_code, OLD.version, OLD.supersedes_id, OLD.total_rial, OLD.tariff_snapshot_at,
      OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'proforma % can only change its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'proforma % was discarded', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'issued')
    OR (OLD.status = 'issued' AND NEW.status IN ('patient_confirmed', 'disputed', 'superseded', 'expired'))
    OR (OLD.status = 'disputed' AND NEW.status IN ('superseded', 'expired'))
  ) THEN
    RAISE EXCEPTION 'proforma % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.issued_at IS NOT NULL AND (NEW.issued_at, NEW.issued_by, NEW.expires_at, NEW.validity_config_version_id)
     IS DISTINCT FROM (OLD.issued_at, OLD.issued_by, OLD.expires_at, OLD.validity_config_version_id) THEN
    RAISE EXCEPTION 'proforma % was issued once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.patient_responded_at IS NOT NULL AND (NEW.patient_responded_at, NEW.patient_response_note)
     IS DISTINCT FROM (OLD.patient_responded_at, OLD.patient_response_note) THEN
    RAISE EXCEPTION 'the patient answered proforma % once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER proformas_guard_change BEFORE UPDATE ON "proformas"
  FOR EACH ROW EXECUTE FUNCTION public.proformas_guard_change();--> statement-breakpoint
CREATE TRIGGER proformas_set_updated_at BEFORE UPDATE ON "proformas"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER proformas_no_delete BEFORE DELETE ON "proformas"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- A line is written only while its proforma is a draft (doc 10 §10 test 3), and never
-- changed or removed.
CREATE FUNCTION public.proforma_lines_only_in_draft() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state text;
BEGIN
  SELECT status INTO state FROM public.proformas WHERE id = NEW.proforma_id FOR SHARE;
  IF state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'proforma % is %, its lines are fixed', NEW.proforma_id, state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER proforma_lines_only_in_draft BEFORE INSERT ON "proforma_lines"
  FOR EACH ROW EXECUTE FUNCTION public.proforma_lines_only_in_draft();--> statement-breakpoint
CREATE TRIGGER proforma_lines_append_only BEFORE UPDATE OR DELETE ON "proforma_lines"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER proforma_lines_no_truncate BEFORE TRUNCATE ON "proforma_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- The total is the sum of its lines, and there is at least one, checked at commit
-- (doc 10 §2 rule 3).
CREATE FUNCTION public.proformas_check_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  expected numeric;
  lines integer;
BEGIN
  SELECT coalesce(sum(line_total_rial), 0), count(*) INTO expected, lines
  FROM public.proforma_lines WHERE proforma_id = NEW.id;
  IF lines = 0 OR expected <> NEW.total_rial THEN
    RAISE EXCEPTION 'proforma % totals % over % lines, not %', NEW.id, expected, lines, NEW.total_rial
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER proformas_total
  AFTER INSERT ON "proformas"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.proformas_check_total();--> statement-breakpoint

CREATE TRIGGER proforma_deviation_reviews_append_only BEFORE UPDATE OR DELETE ON "proforma_deviation_reviews"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER support_requests_append_only BEFORE UPDATE OR DELETE ON "support_requests"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

REVOKE UPDATE ON "proforma_lines", "proforma_deviation_reviews", "support_requests" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "proformas" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "issued_by", "issued_at", "expires_at", "validity_config_version_id",
  "patient_responded_at", "patient_response_note", "deleted_at", "discard_reason")
  ON "proformas" TO sepehr_app;--> statement-breakpoint

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES
  ('proforma.issue'),
  ('proforma.read'),
  ('proforma.review_deviations');--> statement-breakpoint
-- Issuing is the doctor's; a secretary only by their own doctor's delegation (the service
-- checks the doctor has an account). Reading by scope; treatment details need
-- access.view_treatment. Patients need no permission: their own proformas (self-service).
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('doctor', 'proforma.issue'),
  ('doctor', 'proforma.read'),
  ('center_manager', 'proforma.read'),
  ('network_specialist', 'proforma.read'),
  ('network_specialist', 'proforma.review_deviations'),
  ('network_manager', 'proforma.read'),
  ('auditor', 'proforma.read'),
  ('ceo', 'proforma.read')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration =========================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('proforma.validity_days', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('proforma.validity_days', 'global', '30',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۰ §۲ (مهاجرت 0023)', now());
