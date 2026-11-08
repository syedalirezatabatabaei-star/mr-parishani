-- 0009 holiday calendar (task 2-1; doc 08 §5; ADR-011, ADR-021). Drafted by drizzle-kit for
-- the config module's new tables, then extended by hand (ADR-003).

CREATE TABLE "admin_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"audience_permission" text NOT NULL,
	"message" text NOT NULL,
	"first_raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raise_count" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"holiday_on" date NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"city_code" text,
	"created_by" uuid,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_notices_open_code_key" ON "admin_notices" USING btree ("code") WHERE "admin_notices"."resolved_at" IS NULL AND "admin_notices"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "holidays_day_scope_key" ON "holidays" USING btree ("holiday_on",coalesce("city_code", '')) WHERE "holidays"."deleted_at" IS NULL;--> statement-breakpoint

-- A holiday is national (no city) or for one city, named by its code (task 2-1 decision).
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_scope_check" CHECK (
  ("kind" = 'national' AND "city_code" IS NULL)
  OR ("kind" = 'city' AND "city_code" ~ '^[a-z][a-z0-9_]{1,62}$')
);--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_title_check" CHECK (length("title") BETWEEN 2 AND 200);--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_deleted_check" CHECK (("deleted_at" IS NULL) = ("deleted_by" IS NULL));--> statement-breakpoint
CREATE TRIGGER holidays_set_updated_at BEFORE UPDATE ON "holidays"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER holidays_no_delete BEFORE DELETE ON "holidays"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- A holiday is only ever soft-deleted: nothing else about it changes.
REVOKE UPDATE ON "holidays" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("deleted_at", "deleted_by") ON "holidays" TO sepehr_app;--> statement-breakpoint

ALTER TABLE "admin_notices" ADD CONSTRAINT "admin_notices_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "admin_notices" ADD CONSTRAINT "admin_notices_raise_count_check" CHECK ("raise_count" >= 1);--> statement-breakpoint
CREATE TRIGGER admin_notices_set_updated_at BEFORE UPDATE ON "admin_notices"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER admin_notices_no_delete BEFORE DELETE ON "admin_notices"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- A notice is raised again or resolved; what it is and whom it is for never change.
REVOKE UPDATE ON "admin_notices" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("message", "last_raised_at", "raise_count", "resolved_at") ON "admin_notices" TO sepehr_app;--> statement-breakpoint

-- Installment schedules record whether their due dates were moved off non-working days,
-- and the configuration versions behind it (rule 16). Expand only: added with defaults,
-- so the append-only trigger never fires and existing rows read as "not shifted".
ALTER TABLE "installment_schedules" ADD COLUMN "due_dates_shifted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "installment_schedules" ADD COLUMN "shift_config_version_id" uuid;--> statement-breakpoint
ALTER TABLE "installment_schedules" ADD COLUMN "weekly_days_off_config_version_id" uuid;--> statement-breakpoint
ALTER TABLE "installment_schedules" ADD CONSTRAINT "installment_schedules_shift_check" CHECK (
  "due_dates_shifted" = ("weekly_days_off_config_version_id" IS NOT NULL)
  AND (NOT "due_dates_shifted" OR "shift_config_version_id" IS NOT NULL)
);--> statement-breakpoint

-- Weekly days off (task 2-1 decision: Friday; whether Thursday too is for accounting).
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('calendar.weekly_days_off', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('calendar.weekly_days_off', 'global', '["friday"]',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0009)', now());--> statement-breakpoint

-- Managing holidays: the system admin, one person, audited (task 2-1 decision).
INSERT INTO "permissions" ("code") VALUES ('config.manage_holidays');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'config.manage_holidays' FROM "roles" r
WHERE r.code = 'system_admin' AND r.deleted_at IS NULL;
