-- 0019 the bulk import of centers and doctors (task 2-9; doc 08 §12; ADR-030). Drafted by
-- drizzle-kit for the catalog module's tables, then extended by hand (ADR-003). Expand only:
-- new tables, a key and a permission. The file is never kept; its checked rows are, their
-- identifiers only encrypted (rule 27).

CREATE TABLE "catalog_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid NOT NULL,
	"summary" jsonb NOT NULL,
	"committed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"batch_id" uuid NOT NULL,
	"sheet" text NOT NULL,
	"row_number" integer NOT NULL,
	"ref" text,
	"center_ref" text,
	"status" text NOT NULL,
	"problems" jsonb NOT NULL,
	"data" jsonb,
	"entity_id" uuid,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "catalog_import_rows" ADD CONSTRAINT "catalog_import_rows_batch_id_catalog_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_import_rows_batch_row_key" ON "catalog_import_rows" USING btree ("batch_id","sheet","row_number");--> statement-breakpoint
CREATE INDEX "catalog_import_rows_held_idx" ON "catalog_import_rows" USING btree ("batch_id","center_ref") WHERE "catalog_import_rows"."status" = 'held';--> statement-breakpoint

-- === Checks ================================================================================
ALTER TABLE "catalog_import_batches" ADD CONSTRAINT "catalog_import_batches_status_check" CHECK ("status" IN ('previewed', 'committed', 'processed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "catalog_import_rows" ADD CONSTRAINT "catalog_import_rows_sheet_check" CHECK ("sheet" IN ('centers', 'branches', 'doctors', 'tariffs', 'schedules'));--> statement-breakpoint
ALTER TABLE "catalog_import_rows" ADD CONSTRAINT "catalog_import_rows_status_check" CHECK ("status" IN ('valid', 'duplicate', 'error', 'created', 'held', 'proposed', 'applied', 'failed', 'cancelled'));--> statement-breakpoint

-- === The batch lifecycle (rule 8) =========================================================
-- previewed → committed → processed; previewed, committed or processed → cancelled.
CREATE FUNCTION public.catalog_import_batches_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'previewed' AND NEW.status IN ('committed', 'cancelled'))
    OR (OLD.status = 'committed' AND NEW.status IN ('processed', 'cancelled'))
    OR (OLD.status = 'processed' AND NEW.status = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'import batch % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_import_batches_guard BEFORE UPDATE ON "catalog_import_batches"
  FOR EACH ROW EXECUTE FUNCTION public.catalog_import_batches_guard();--> statement-breakpoint

-- A row moves forward only: what it became, or why it failed, is never rewritten.
CREATE FUNCTION public.catalog_import_rows_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'valid' AND NEW.status IN ('created', 'held', 'failed', 'cancelled'))
    OR (OLD.status = 'created' AND NEW.status = 'cancelled')
    OR (OLD.status = 'held' AND NEW.status IN ('applied', 'proposed', 'failed', 'cancelled'))
    OR (OLD.status = 'proposed' AND NEW.status IN ('applied', 'failed'))
  ) THEN
    RAISE EXCEPTION 'import row % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_import_rows_guard BEFORE UPDATE ON "catalog_import_rows"
  FOR EACH ROW EXECUTE FUNCTION public.catalog_import_rows_guard();--> statement-breakpoint

-- === Timestamps, no deletes, what the application may change ==============================
CREATE TRIGGER catalog_import_batches_set_updated_at BEFORE UPDATE ON "catalog_import_batches"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER catalog_import_rows_set_updated_at BEFORE UPDATE ON "catalog_import_rows"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER catalog_import_batches_no_delete BEFORE DELETE ON "catalog_import_batches"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER catalog_import_rows_no_delete BEFORE DELETE ON "catalog_import_rows"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "catalog_import_batches" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "committed_at", "processed_at", "cancelled_at", "cancel_reason") ON "catalog_import_batches" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "catalog_import_rows" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "data", "entity_id", "failure") ON "catalog_import_rows" TO sepehr_app;--> statement-breakpoint

-- === Configuration and permission (task 2-9) ==============================================
-- The import ships behind its flag, off (CLAUDE.md §4).
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('catalog.bulk_import_enabled', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('catalog.bulk_import_enabled', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0019)', now());--> statement-breakpoint
INSERT INTO "permissions" ("code") VALUES ('catalog.import_centers');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'catalog.import_centers'
FROM "roles" r
WHERE r.code = 'network_specialist' AND r.deleted_at IS NULL;
