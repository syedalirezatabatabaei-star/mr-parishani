-- 0017 the public search (task 2-7; doc 08 §9; ADR-028). Drafted by drizzle-kit for the
-- catalog module's tables, then extended by hand (ADR-003). Expand only: new tables, one new
-- column with a default, keys and a permission; nothing existing changes.
-- search_entries is a read model built by the search indexer from outbox events; it decides
-- nothing (booking's EXCLUDE constraint decides a booking), so it carries no foreign key to
-- the workplaces it describes and is rebuilt by `pnpm catalog:rebuild-search`.
-- pg_trgm (trusted since PostgreSQL 13) indexes the normalized text; on a server where the
-- schema owner may not create it, the DBA creates it first (doc 09, deployment notes).

CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

CREATE TABLE "search_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workplace_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"center_id" uuid,
	"city_code" text NOT NULL,
	"doctor_name" text NOT NULL,
	"place_name" text,
	"search_key" text NOT NULL,
	"doctor_name_key" text NOT NULL,
	"place_name_key" text,
	"treatment_fields" jsonb NOT NULL,
	"treatment_field_codes" text[] NOT NULL,
	"service_codes" text[] NOT NULL,
	"credit_enabled" boolean NOT NULL,
	"listed" boolean NOT NULL,
	"next_free_slot_at" timestamp with time zone,
	"refresh_due_at" timestamp with time zone NOT NULL,
	"pending_changes" integer DEFAULT 0 NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_entry_prices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entry_id" uuid NOT NULL,
	"service_code" text NOT NULL,
	"is_visit" boolean NOT NULL,
	"offered" boolean NOT NULL,
	"is_free" boolean NOT NULL,
	"min_amount_rial" bigint NOT NULL,
	"max_amount_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_rebuild_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"mode" text NOT NULL,
	"workplaces" integer NOT NULL,
	"inserted" integer NOT NULL,
	"updated" integer NOT NULL,
	"unchanged" integer NOT NULL,
	"listed" integer NOT NULL,
	"unlisted" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doctor_workplaces" ADD COLUMN "credit_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "search_entry_prices" ADD CONSTRAINT "search_entry_prices_entry_id_search_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."search_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_entries_workplace_id_key" ON "search_entries" USING btree ("workplace_id");--> statement-breakpoint
CREATE INDEX "search_entries_doctor_id_idx" ON "search_entries" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "search_entries_center_id_idx" ON "search_entries" USING btree ("center_id");--> statement-breakpoint
CREATE INDEX "search_entries_refresh_due_at_idx" ON "search_entries" USING btree ("refresh_due_at");--> statement-breakpoint
CREATE INDEX "search_entries_listed_city_idx" ON "search_entries" USING btree ("city_code","next_free_slot_at") WHERE "search_entries"."listed" AND "search_entries"."next_free_slot_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "search_entries_listed_next_free_idx" ON "search_entries" USING btree ("next_free_slot_at") WHERE "search_entries"."listed" AND "search_entries"."next_free_slot_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "search_entries_search_key_trgm" ON "search_entries" USING gin ("search_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_entries_doctor_name_key_trgm" ON "search_entries" USING gin ("doctor_name_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_entries_place_name_key_trgm" ON "search_entries" USING gin ("place_name_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_entries_treatment_field_codes_idx" ON "search_entries" USING gin ("treatment_field_codes");--> statement-breakpoint
CREATE INDEX "search_entries_service_codes_idx" ON "search_entries" USING gin ("service_codes");--> statement-breakpoint
CREATE UNIQUE INDEX "search_entry_prices_entry_service_key" ON "search_entry_prices" USING btree ("entry_id","service_code");--> statement-breakpoint
CREATE INDEX "search_entry_prices_service_idx" ON "search_entry_prices" USING btree ("service_code","min_amount_rial","max_amount_rial") WHERE "search_entry_prices"."offered";--> statement-breakpoint

-- === Checks ================================================================================
ALTER TABLE "search_entry_prices" ADD CONSTRAINT "search_entry_prices_amounts_check" CHECK ("min_amount_rial" >= 0 AND "max_amount_rial" >= "min_amount_rial");--> statement-breakpoint
ALTER TABLE "search_rebuild_runs" ADD CONSTRAINT "search_rebuild_runs_mode_check" CHECK ("mode" IN ('dry_run', 'apply'));--> statement-breakpoint

-- === Triggers and grants ===================================================================
CREATE TRIGGER search_entries_set_updated_at BEFORE UPDATE ON "search_entries"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER search_entry_prices_set_updated_at BEFORE UPDATE ON "search_entry_prices"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER search_rebuild_runs_append_only BEFORE UPDATE OR DELETE ON "search_rebuild_runs"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "search_rebuild_runs" FROM sepehr_app;--> statement-breakpoint
-- Whether a workplace takes credit is the only new thing the application changes on it.
GRANT UPDATE ("credit_enabled") ON "doctor_workplaces" TO sepehr_app;--> statement-breakpoint

-- === Configuration (task 2-7) ==============================================================
-- The search ships behind its flag, off (CLAUDE.md §4); the featured section behind its own,
-- off and empty (task 2-7 decision 3).
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('catalog.search_enabled', 'technical', true),
  ('catalog.search_featured_enabled', 'business', true),
  ('catalog.search_policy', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('catalog.search_enabled', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0017)', now()),
  ('catalog.search_featured_enabled', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0017)', now()),
  ('catalog.search_policy', 'global', '{"perIpPerMinute": 60, "slotsPerResult": 3, "maxEntryAgeMinutes": 60}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0017)', now());--> statement-breakpoint

-- === Permissions (task 2-7 decision 2) =====================================================
INSERT INTO "permissions" ("code") VALUES ('catalog.manage_workplace_credit');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'catalog.manage_workplace_credit'
FROM "roles" r
WHERE r.code = 'network_specialist' AND r.deleted_at IS NULL;
