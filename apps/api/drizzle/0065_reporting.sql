-- 0065 the reporting module (task 7-3; doc 17 §2, §4, §5). Hand-written (ADR-003). Expand
-- only: two new tables of the reporting module, SELECT for the read-only reporting role on the
-- ticket tables its first report reads, one technical configuration key, three permissions.
-- Summary: docs/decisions/task-7-3-decisions.md.

-- === Saved filters: conditions only, a relative range kept relative (doc 17 §4) ============
CREATE TABLE "report_saved_filters" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"report_code" text NOT NULL,
	"name" text NOT NULL,
	"conditions" jsonb NOT NULL,
	-- Shared with one unit (a role code the owner held when sharing), else only the owner's.
	"shared_unit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "report_saved_filters_code_check" CHECK ("report_code" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "report_saved_filters_name_check" CHECK (length("name") BETWEEN 2 AND 80),
	CONSTRAINT "report_saved_filters_unit_check"
	  CHECK ("shared_unit" IS NULL OR "shared_unit" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "report_saved_filters_conditions_check" CHECK (jsonb_typeof("conditions") = 'object'),
	CONSTRAINT "report_saved_filters_deleted_check"
	  CHECK (("deleted_at" IS NULL) = ("deleted_by" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "report_saved_filters_name_key"
  ON "report_saved_filters" ("owner_account_id", "report_code", "name")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "report_saved_filters_unit_idx" ON "report_saved_filters" ("shared_unit", "report_code")
  WHERE "deleted_at" IS NULL AND "shared_unit" IS NOT NULL;--> statement-breakpoint
-- A filter is deleted once, softly (rule 7); nothing else of it changes.
CREATE FUNCTION public.report_saved_filters_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'saved filter % is never deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by'])
     OR OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'saved filter % only gets deleted, once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER report_saved_filters_guard BEFORE UPDATE OR DELETE ON "report_saved_filters"
  FOR EACH ROW EXECUTE FUNCTION public.report_saved_filters_guard();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "report_saved_filters" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "report_saved_filters" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("deleted_at", "deleted_by") ON "report_saved_filters" TO sepehr_app;--> statement-breakpoint

-- === Exports: each one recorded, made at once or in the background (doc 17 §5) ============
CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL,
	-- Who, as the watermark names them (a display name, at the time of the export).
	"account_name" text NOT NULL,
	"report_code" text NOT NULL,
	"params" jsonb NOT NULL,
	"format" text NOT NULL,
	"money_unit" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"reason" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"row_count" integer,
	"object_key" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "report_exports_format_check" CHECK ("format" IN ('csv', 'pdf')),
	CONSTRAINT "report_exports_unit_check" CHECK ("money_unit" IN ('rial', 'toman')),
	CONSTRAINT "report_exports_status_check" CHECK ("status" IN ('queued', 'ready', 'failed')),
	-- The full value of encrypted fields only with a reason (doc 17 §5).
	CONSTRAINT "report_exports_sensitive_check"
	  CHECK (NOT "sensitive" OR length(trim(coalesce("reason", ''))) >= 3),
	CONSTRAINT "report_exports_result_check" CHECK (
	  ("status" = 'queued' AND "finished_at" IS NULL AND "object_key" IS NULL)
	  OR ("status" = 'ready' AND "finished_at" IS NOT NULL AND "object_key" IS NOT NULL
	      AND "row_count" IS NOT NULL)
	  OR ("status" = 'failed' AND "finished_at" IS NOT NULL AND "error" IS NOT NULL)
	),
	CONSTRAINT "report_exports_rows_check" CHECK ("row_count" IS NULL OR "row_count" >= 0)
);--> statement-breakpoint
CREATE INDEX "report_exports_account_idx" ON "report_exports" ("account_id", "created_at");--> statement-breakpoint
CREATE INDEX "report_exports_queued_idx" ON "report_exports" ("created_at")
  WHERE "status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "report_exports_key" ON "report_exports" ("object_key")
  WHERE "object_key" IS NOT NULL;--> statement-breakpoint
-- What was asked never changes; only queued → ready | failed, with its result.
CREATE FUNCTION public.report_exports_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  result constant text[] := ARRAY['status', 'row_count', 'object_key', 'error', 'finished_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'export % is never deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - result) IS DISTINCT FROM (to_jsonb(OLD) - result) THEN
    RAISE EXCEPTION 'export % keeps what was asked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'queued' OR NEW.status NOT IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'export % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER report_exports_guard BEFORE UPDATE OR DELETE ON "report_exports"
  FOR EACH ROW EXECUTE FUNCTION public.report_exports_guard();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "report_exports" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "report_exports" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "row_count", "object_key", "error", "finished_at") ON "report_exports"
  TO sepehr_app;--> statement-breakpoint

-- === The reporting role reads what the first report reads (ADR-012) ======================
GRANT SELECT ON "tickets", "ticket_links", "ticket_events" TO sepehr_report;--> statement-breakpoint

-- === Configuration (technical: a performance threshold, 7.3) ==============================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('reporting.async_export_rows', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('reporting.async_export_rows', 'global', '5000', '2020-01-01T00:00:00Z', 'approved',
   'پیش‌فرض مستند ۷.۳ (۵٬۰۰۰ ردیف)؛ مهاجرت 0065', now());--> statement-breakpoint

-- === Permissions (task 7-3 decisions ر۵) ==================================================
INSERT INTO "permissions" ("code") VALUES
  ('reporting.run'), ('reporting.share_filters'), ('reporting.export_sensitive');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('support', 'reporting.run'),
  ('accounting', 'reporting.run'),
  ('collection', 'reporting.run'),
  ('collection_manager', 'reporting.run'),
  ('strategy_manager', 'reporting.run'),
  ('credit_manager', 'reporting.run'),
  ('ceo', 'reporting.run'),
  ('auditor', 'reporting.run'),
  ('system_admin', 'reporting.run'),
  ('strategy_manager', 'reporting.share_filters'),
  ('collection_manager', 'reporting.share_filters'),
  ('credit_manager', 'reporting.share_filters'),
  ('ceo', 'reporting.share_filters')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
