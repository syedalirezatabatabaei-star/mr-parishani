-- 0089 holidays saved together (owner 1405/07/24, plan 3; ADR-043): one holder of
-- config.manage_holidays asks with the days and a reason, a second approves or rejects.
-- Approved, every day is added to holidays in one transaction, or none; a day already there is
-- refused, never written over. Add only: one new table, its checks, an index and two
-- triggers; holidays and every other table untouched. Summary:
-- docs/decisions/task-plan3-holiday-rules-decisions.md §6.
CREATE TABLE "holiday_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"year" integer NOT NULL,
	"days" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"affected_contracts" integer NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"saved_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "holiday_batches_status_check" CHECK ("holiday_batches"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "holiday_batches_reason_check" CHECK (length(trim("holiday_batches"."reason")) >= 3),
	CONSTRAINT "holiday_batches_year_check" CHECK ("holiday_batches"."year" BETWEEN 1400 AND 1500),
	CONSTRAINT "holiday_batches_days_check" CHECK (jsonb_typeof("holiday_batches"."days") = 'array' AND jsonb_array_length("holiday_batches"."days") BETWEEN 1 AND 60),
	CONSTRAINT "holiday_batches_affected_check" CHECK ("holiday_batches"."affected_contracts" >= 0),
	CONSTRAINT "holiday_batches_two_people_check" CHECK ("holiday_batches"."decided_by" IS NULL OR "holiday_batches"."decided_by" <> "holiday_batches"."requested_by"),
	CONSTRAINT "holiday_batches_decided_check" CHECK (("holiday_batches"."status" = 'pending') = ("holiday_batches"."decided_by" IS NULL AND "holiday_batches"."decided_at" IS NULL)
          AND ("holiday_batches"."status" = 'approved') = ("holiday_batches"."saved_count" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_batches_open_key" ON "holiday_batches" USING btree ("year") WHERE "holiday_batches"."status" = 'pending';--> statement-breakpoint
-- A batch is decided once: only pending leaves; what was asked, by whom and why never change.
CREATE FUNCTION public.holiday_batches_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'holiday_batches: a decided batch does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.year <> OLD.year OR NEW.days <> OLD.days OR NEW.reason <> OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.affected_contracts <> OLD.affected_contracts
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'holiday_batches: what was asked does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER holiday_batches_guard BEFORE UPDATE ON "holiday_batches"
  FOR EACH ROW EXECUTE FUNCTION public.holiday_batches_guard();--> statement-breakpoint
CREATE TRIGGER holiday_batches_set_updated_at BEFORE UPDATE ON "holiday_batches"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
REVOKE DELETE ON "holiday_batches" FROM sepehr_app;
