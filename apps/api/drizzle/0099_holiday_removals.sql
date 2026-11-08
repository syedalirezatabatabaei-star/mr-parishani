-- 0099 a holiday taken off the calendar by two people (owner 1405/07/29; ADR-043): one holder of
-- config.manage_holidays asks with a reason, a second approves (the holiday is soft deleted, rule
-- 7) or rejects. Add only: one new table, its checks, a foreign key, an index and two triggers;
-- holidays and every other table untouched. Summary:
-- docs/decisions/owner-plans-1405-07-27.md, «دور سی‌ویکم».
CREATE TABLE "holiday_removals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"holiday_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"affected_contracts" integer NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "holiday_removals_status_check" CHECK ("holiday_removals"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "holiday_removals_reason_check" CHECK (length(trim("holiday_removals"."reason")) >= 3),
	CONSTRAINT "holiday_removals_affected_check" CHECK ("holiday_removals"."affected_contracts" >= 0),
	CONSTRAINT "holiday_removals_two_people_check" CHECK ("holiday_removals"."decided_by" IS NULL OR "holiday_removals"."decided_by" <> "holiday_removals"."requested_by"),
	CONSTRAINT "holiday_removals_decided_check" CHECK (("holiday_removals"."status" = 'pending') = ("holiday_removals"."decided_by" IS NULL AND "holiday_removals"."decided_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "holiday_removals" ADD CONSTRAINT "holiday_removals_holiday_id_holidays_id_fk" FOREIGN KEY ("holiday_id") REFERENCES "public"."holidays"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_removals_open_key" ON "holiday_removals" USING btree ("holiday_id") WHERE "holiday_removals"."status" = 'pending';
--> statement-breakpoint
-- A removal is decided once: only pending leaves; what was asked, by whom and why never change.
CREATE FUNCTION public.holiday_removals_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'holiday_removals: a decided removal does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.holiday_id <> OLD.holiday_id OR NEW.reason <> OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.affected_contracts <> OLD.affected_contracts
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'holiday_removals: what was asked does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER holiday_removals_guard BEFORE UPDATE ON "holiday_removals"
  FOR EACH ROW EXECUTE FUNCTION public.holiday_removals_guard();--> statement-breakpoint
CREATE TRIGGER holiday_removals_set_updated_at BEFORE UPDATE ON "holiday_removals"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
REVOKE DELETE ON "holiday_removals" FROM sepehr_app;
