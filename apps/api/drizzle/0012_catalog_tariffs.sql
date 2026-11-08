-- 0012 the catalog: treatment fields, services and tariffs (task 2-4; doc 08 §4; ADR-024).
-- Drafted by drizzle-kit for the catalog module's tables, then extended by hand (ADR-003).
-- Expand only: the field codes already stored on centers and doctors are not checked (the
-- foreign keys are NOT VALID), only new ones are.

CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"field_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'standard' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tariff_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tariff_id" uuid NOT NULL,
	"status" text NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"min_amount_rial" bigint,
	"max_amount_rial" bigint,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariffs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"service_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"workplace_id" uuid,
	"center_id" uuid,
	"node_path" text NOT NULL,
	"city_code" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treatment_fields" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "services_code_key" ON "services" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "services_name_key" ON "services" USING btree ("field_id","name") WHERE "services"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "services_visit_key" ON "services" USING btree ("kind") WHERE "services"."kind" = 'visit';--> statement-breakpoint
CREATE INDEX "services_field_id_idx" ON "services" USING btree ("field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_versions_effective_key" ON "tariff_versions" USING btree ("tariff_id","effective_at") WHERE "tariff_versions"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tariffs_workplace_key" ON "tariffs" USING btree ("workplace_id","service_id") WHERE "tariffs"."owner_kind" = 'workplace';--> statement-breakpoint
CREATE UNIQUE INDEX "tariffs_center_key" ON "tariffs" USING btree ("center_id","service_id") WHERE "tariffs"."owner_kind" = 'center';--> statement-breakpoint
CREATE INDEX "tariffs_service_id_idx" ON "tariffs" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_fields_code_key" ON "treatment_fields" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_fields_name_key" ON "treatment_fields" USING btree ("name") WHERE "treatment_fields"."deleted_at" IS NULL;--> statement-breakpoint

-- === Integrity ===========================================================================
ALTER TABLE "treatment_fields" ADD CONSTRAINT "treatment_fields_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "treatment_fields" ADD CONSTRAINT "treatment_fields_name_check" CHECK (length("name") BETWEEN 2 AND 100);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_name_check" CHECK (length("name") BETWEEN 2 AND 200);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_kind_check" CHECK ("kind" IN ('standard', 'visit'));--> statement-breakpoint
-- The visit belongs to no field; every other service belongs to one (task 2-4 decision).
ALTER TABLE "services" ADD CONSTRAINT "services_field_check" CHECK (("kind" = 'visit') = ("field_id" IS NULL));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_field_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."treatment_fields"("id");--> statement-breakpoint

ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id");--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_workplace_id_fk" FOREIGN KEY ("workplace_id") REFERENCES "public"."doctor_workplaces"("id");--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_center_id_fk" FOREIGN KEY ("center_id") REFERENCES "public"."centers"("id");--> statement-breakpoint
-- Exactly one owner: a doctor's workplace or a center.
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_owner_check" CHECK (
  ("owner_kind" = 'workplace' AND "workplace_id" IS NOT NULL AND "center_id" IS NULL)
  OR ("owner_kind" = 'center' AND "center_id" IS NOT NULL AND "workplace_id" IS NULL)
);--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_city_code_check" CHECK ("city_code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint

ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_tariff_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."tariffs"("id");--> statement-breakpoint
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_status_check" CHECK ("status" IN ('offered', 'withdrawn'));--> statement-breakpoint
-- Whole rials (rule 1): free is exactly zero; a price is a range 0 < min <= max; a
-- withdrawal carries no price.
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_amount_check" CHECK (
  ("status" = 'withdrawn' AND NOT "is_free" AND "min_amount_rial" IS NULL AND "max_amount_rial" IS NULL)
  OR ("status" = 'offered' AND "is_free" AND "min_amount_rial" = 0 AND "max_amount_rial" = 0)
  OR ("status" = 'offered' AND NOT "is_free" AND "min_amount_rial" > 0 AND "max_amount_rial" >= "min_amount_rial")
);--> statement-breakpoint
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_reason_check" CHECK (length("reason") BETWEEN 3 AND 500);--> statement-breakpoint
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_cancel_check" CHECK (
  ("cancelled_at" IS NULL AND "cancelled_by" IS NULL AND "cancel_reason" IS NULL)
  OR ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL AND length("cancel_reason") BETWEEN 3 AND 500)
);--> statement-breakpoint
CREATE INDEX "tariff_versions_tariff_id_idx" ON "tariff_versions" USING btree ("tariff_id", "effective_at" DESC) WHERE "cancelled_at" IS NULL;--> statement-breakpoint

-- New field codes on centers and doctors must name a field of the catalog. NOT VALID: the
-- rows stored before 2-4 are not checked (expand only); the services also refuse a retired
-- field for a new choice.
ALTER TABLE "center_treatment_fields" ADD CONSTRAINT "center_treatment_fields_field_code_fk" FOREIGN KEY ("field_code") REFERENCES "public"."treatment_fields"("code") NOT VALID;--> statement-breakpoint
ALTER TABLE "doctor_treatment_fields" ADD CONSTRAINT "doctor_treatment_fields_field_code_fk" FOREIGN KEY ("field_code") REFERENCES "public"."treatment_fields"("code") NOT VALID;--> statement-breakpoint

-- === The visit is never retired ============================================================
CREATE FUNCTION public.services_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.kind = 'visit' AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'the visit service cannot be retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER services_guard_change BEFORE UPDATE ON "services"
  FOR EACH ROW EXECUTE FUNCTION public.services_guard_change();--> statement-breakpoint

-- === Tariff versions: append-only, but a version not yet started may be cancelled ========
-- A version never starts in the past (a minute of clock slack, as for config values), so
-- the price in force at any past moment never changes and a booking's quote stays true
-- (doc 08 §15 test 4). Only the visit may be free.
CREATE FUNCTION public.tariff_versions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  service_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Milliseconds, as a client's clock holds them: the moment a quote returns finds the
    -- same version again.
    NEW.effective_at := date_trunc('milliseconds', NEW.effective_at);
    IF NEW.effective_at < now() - interval '1 minute' THEN
      RAISE EXCEPTION 'a tariff version cannot start in the past' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'a tariff version is not inserted cancelled' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.is_free THEN
      SELECT s.kind INTO service_kind
      FROM tariffs t JOIN services s ON s.id = t.service_id
      WHERE t.id = NEW.tariff_id;
      IF service_kind IS DISTINCT FROM 'visit' THEN
        RAISE EXCEPTION 'only the visit may be free' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: cancelling, once, a version that has not started; nothing else changes.
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'tariff version % is already cancelled', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.effective_at <= now() THEN
    RAISE EXCEPTION 'tariff version % has started and cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.cancelled_at IS NULL
     OR (NEW.id, NEW.tariff_id, NEW.status, NEW.is_free, NEW.min_amount_rial, NEW.max_amount_rial,
         NEW.effective_at, NEW.reason, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tariff_id, OLD.status, OLD.is_free, OLD.min_amount_rial, OLD.max_amount_rial,
         OLD.effective_at, OLD.reason, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'tariff version % can only be cancelled', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.cancelled_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER tariff_versions_guard BEFORE INSERT OR UPDATE ON "tariff_versions"
  FOR EACH ROW EXECUTE FUNCTION public.tariff_versions_guard();--> statement-breakpoint

-- === Never physically deleted (rule 7); the tariff series never changes ==================
CREATE TRIGGER treatment_fields_set_updated_at BEFORE UPDATE ON "treatment_fields"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER services_set_updated_at BEFORE UPDATE ON "services"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER treatment_fields_no_delete BEFORE DELETE ON "treatment_fields"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER services_no_delete BEFORE DELETE ON "services"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER tariffs_append_only BEFORE UPDATE OR DELETE ON "tariffs"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER tariffs_no_truncate BEFORE TRUNCATE ON "tariffs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER tariff_versions_no_delete BEFORE DELETE ON "tariff_versions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER tariff_versions_no_truncate BEFORE TRUNCATE ON "tariff_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- A code, a service's field and kind never change (config scopes and credit purses name
-- the codes).
REVOKE UPDATE ON "treatment_fields" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("name", "sort_order", "deleted_at") ON "treatment_fields" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "services" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("name", "deleted_at") ON "services" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "tariffs" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "tariff_versions" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("cancelled_at", "cancelled_by", "cancel_reason") ON "tariff_versions" TO sepehr_app;--> statement-breakpoint

-- === The visit (doc 08 §4; task 2-4 decision: one, in no field) ==========================
-- Structure, not a business rule: whether a visit is free, and its price, are each tariff's.
INSERT INTO "services" ("code", "name", "kind") VALUES ('visit', 'ویزیت', 'visit');--> statement-breakpoint
-- TODO(decision): the pilot's treatment fields (at least five, doc 08 §4) are entered from
-- the panel, not here; docs/import-templates/treatment-fields.csv is their sheet for the
-- bulk import of task 2-9.

-- === Permissions (task 2-4) ================================================================
INSERT INTO "permissions" ("code") VALUES
  ('catalog.manage_catalog'),
  ('catalog.read_tariffs'),
  ('catalog.manage_tariffs');--> statement-breakpoint
-- Task 2-4 decisions: the catalog by the network manager and the system admin; tariffs by
-- the center manager and the doctor, the network specialist reading only. A secretary gets
-- manage_tariffs only from their own doctor (the service checks it).
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('network_manager', 'catalog.manage_catalog'),
  ('system_admin', 'catalog.manage_catalog'),
  ('network_specialist', 'catalog.read_tariffs'),
  ('network_manager', 'catalog.read_tariffs'),
  ('center_manager', 'catalog.read_tariffs'),
  ('center_manager', 'catalog.manage_tariffs'),
  ('doctor', 'catalog.read_tariffs'),
  ('doctor', 'catalog.manage_tariffs'),
  ('auditor', 'catalog.read_tariffs'),
  ('ceo', 'catalog.read_tariffs')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
