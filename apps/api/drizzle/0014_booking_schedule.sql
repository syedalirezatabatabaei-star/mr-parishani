-- 0014 a doctor's calendar at each workplace (task 2-5; doc 08 §6; ADR-025). Drafted by
-- drizzle-kit for the booking module's tables, then extended by hand (ADR-003). Expand only:
-- new tables, keys and permissions. Slots are never stored; they are computed. The
-- workplace and doctor ids are the catalog's, so they carry no foreign key (module boundary).

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TABLE "availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workplace_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"on_day" date NOT NULL,
	"kind" text NOT NULL,
	"start_minute" integer,
	"end_minute" integer,
	"slot_minutes" integer,
	"service_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schedule_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workplace_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"weekday" text NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"slot_minutes" integer NOT NULL,
	"service_codes" text[] NOT NULL,
	"created_by" uuid,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workplace_approval_modes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workplace_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "availability_exceptions_workplace_day_idx" ON "availability_exceptions" USING btree ("workplace_id","on_day") WHERE "availability_exceptions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "availability_exceptions_open_holiday_key" ON "availability_exceptions" USING btree ("workplace_id","on_day") WHERE "availability_exceptions"."kind" = 'open_holiday' AND "availability_exceptions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "schedule_templates_workplace_id_idx" ON "schedule_templates" USING btree ("workplace_id") WHERE "schedule_templates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workplace_approval_modes_workplace_idx" ON "workplace_approval_modes" USING btree ("workplace_id","created_at");--> statement-breakpoint

-- === Integrity ===========================================================================
-- Minutes since Tehran midnight; a range never crosses midnight and is whole slots.
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_weekday_check" CHECK ("weekday" IN ('saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'));--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_range_check" CHECK (
  "start_minute" >= 0 AND "start_minute" < "end_minute" AND "end_minute" <= 1440
  AND "slot_minutes" BETWEEN 5 AND 480 AND ("end_minute" - "start_minute") % "slot_minutes" = 0
);--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_services_check" CHECK (cardinality("service_codes") BETWEEN 1 AND 50);--> statement-breakpoint
-- One doctor is never in two places at once, nor twice in one (task 2-5 decision): no two
-- live ranges of the same doctor overlap on a weekday, at this workplace or any other.
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_no_overlap" EXCLUDE USING gist (
  "doctor_id" WITH =, "weekday" WITH =, int4range("start_minute", "end_minute") WITH &&
) WHERE ("deleted_at" IS NULL);--> statement-breakpoint

ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_kind_check" CHECK ("kind" IN ('closed', 'extra', 'open_holiday'));--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_shape_check" CHECK (
  ("kind" = 'open_holiday' AND "start_minute" IS NULL AND "end_minute" IS NULL
    AND "slot_minutes" IS NULL AND cardinality("service_codes") = 0)
  OR ("kind" = 'closed' AND "slot_minutes" IS NULL AND cardinality("service_codes") = 0
    AND (("start_minute" IS NULL AND "end_minute" IS NULL)
      OR ("start_minute" >= 0 AND "start_minute" < "end_minute" AND "end_minute" <= 1440)))
  OR ("kind" = 'extra' AND "start_minute" >= 0 AND "start_minute" < "end_minute"
    AND "end_minute" <= 1440 AND "slot_minutes" BETWEEN 5 AND 480
    AND ("end_minute" - "start_minute") % "slot_minutes" = 0
    AND cardinality("service_codes") BETWEEN 1 AND 50)
);--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_reason_check" CHECK (length("reason") BETWEEN 3 AND 500);--> statement-breakpoint
-- Extra hours of one doctor on one day never overlap, wherever they are.
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_extra_no_overlap" EXCLUDE USING gist (
  "doctor_id" WITH =, "on_day" WITH =, int4range("start_minute", "end_minute") WITH &&
) WHERE ("kind" = 'extra' AND "deleted_at" IS NULL);--> statement-breakpoint

ALTER TABLE "workplace_approval_modes" ADD CONSTRAINT "workplace_approval_modes_mode_check" CHECK ("mode" IN ('auto', 'manual'));--> statement-breakpoint
ALTER TABLE "workplace_approval_modes" ADD CONSTRAINT "workplace_approval_modes_reason_check" CHECK (length("reason") BETWEEN 3 AND 500);--> statement-breakpoint

-- === Never physically deleted (rule 7); a removed row stays removed ======================
CREATE FUNCTION public.booking_calendar_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION '% % is removed and cannot change', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER schedule_templates_guard_change BEFORE UPDATE ON "schedule_templates"
  FOR EACH ROW EXECUTE FUNCTION public.booking_calendar_guard_change();--> statement-breakpoint
CREATE TRIGGER availability_exceptions_guard_change BEFORE UPDATE ON "availability_exceptions"
  FOR EACH ROW EXECUTE FUNCTION public.booking_calendar_guard_change();--> statement-breakpoint
CREATE TRIGGER schedule_templates_set_updated_at BEFORE UPDATE ON "schedule_templates"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER availability_exceptions_set_updated_at BEFORE UPDATE ON "availability_exceptions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER schedule_templates_no_delete BEFORE DELETE ON "schedule_templates"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER availability_exceptions_no_delete BEFORE DELETE ON "availability_exceptions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- The approval mode is a history: never changed, never deleted.
CREATE TRIGGER workplace_approval_modes_append_only BEFORE UPDATE OR DELETE ON "workplace_approval_modes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER workplace_approval_modes_no_truncate BEFORE TRUNCATE ON "workplace_approval_modes"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
-- Only removal changes a row: what a range or an exception says never does.
REVOKE UPDATE ON "schedule_templates" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("deleted_at", "deleted_by") ON "schedule_templates" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "availability_exceptions" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("deleted_at", "deleted_by") ON "availability_exceptions" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "workplace_approval_modes" FROM sepehr_app;--> statement-breakpoint

-- === Configuration (task 2-5) ==============================================================
-- TODO(decision): both values (doc 09 open item 1: manual approval; the horizon is new).
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('booking.default_approval_mode', 'business', true),
  ('booking.booking_horizon_days', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('booking.default_approval_mode', 'global', '"manual"',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0014)', now()),
  ('booking.booking_horizon_days', 'global', '60',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0014)', now());--> statement-breakpoint

-- === Permissions (task 2-5 decisions) ======================================================
INSERT INTO "permissions" ("code") VALUES
  ('booking.read_calendar'),
  ('booking.manage_own_calendar'),
  ('booking.manage_calendar_in_scope'),
  ('booking.manage_any_calendar'),
  ('booking.manage_approval_mode');--> statement-breakpoint
-- Which calendar each permission reaches is decided by the service on every request:
-- own (the doctor with an account, or that workplace's secretary it was delegated to), in
-- scope (a center or branch scope), any (a global or city scope). The center manager and
-- the network specialist also hold manage_own_calendar only so that they can delegate it
-- to the secretary of a doctor without an account (task 2-3: nobody hands on what they do
-- not hold); it reaches no calendar of theirs. A secretary gets nothing by default: their
-- doctor, or for a doctor without an account the manager above, delegates.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('doctor', 'booking.read_calendar'),
  ('doctor', 'booking.manage_own_calendar'),
  ('doctor', 'booking.manage_approval_mode'),
  ('center_manager', 'booking.read_calendar'),
  ('center_manager', 'booking.manage_calendar_in_scope'),
  ('center_manager', 'booking.manage_own_calendar'),
  ('center_manager', 'booking.manage_approval_mode'),
  ('network_specialist', 'booking.read_calendar'),
  ('network_specialist', 'booking.manage_any_calendar'),
  ('network_specialist', 'booking.manage_own_calendar'),
  ('network_specialist', 'booking.manage_approval_mode'),
  ('network_manager', 'booking.read_calendar'),
  ('auditor', 'booking.read_calendar'),
  ('ceo', 'booking.read_calendar')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
