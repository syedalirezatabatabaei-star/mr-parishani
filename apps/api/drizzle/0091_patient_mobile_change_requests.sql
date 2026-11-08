-- 0091 (owner 1405/07/26, f12 option «ب», path ب2): a patient whose previous mobile is lost has
-- staff replace their login mobile, by two people as 0085. A holder of
-- identity.change_patient_mobile proposes, with the evidence seen and the code sent to the new
-- mobile; a second holder, never the first nor the patient, approves; refusing takes one.
-- Add only: one new table, its checks, indexes and triggers, and one permission code given to
-- no role (as 0081 and 0085): an administrator grants it. Nothing existing changes.
-- Summary: docs/decisions/task-f12-b2-staff-mobile-change-decisions.md. Written, not applied
-- (owner).
CREATE TABLE "patient_mobile_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"target_account_id" uuid NOT NULL,
	"from_mobile" text NOT NULL,
	"to_mobile" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"sessions_ended" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "patient_mobile_change_requests_status_check" CHECK ("patient_mobile_change_requests"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "patient_mobile_change_requests_mobiles_check" CHECK ("patient_mobile_change_requests"."from_mobile" ~ '^9[0-9]{9}$' AND "patient_mobile_change_requests"."to_mobile" ~ '^9[0-9]{9}$' AND "patient_mobile_change_requests"."from_mobile" <> "patient_mobile_change_requests"."to_mobile"),
	CONSTRAINT "patient_mobile_change_requests_text_check" CHECK (length(trim("patient_mobile_change_requests"."reason")) >= 3 AND length(trim("patient_mobile_change_requests"."evidence")) >= 3),
	CONSTRAINT "patient_mobile_change_requests_two_people_check" CHECK ("patient_mobile_change_requests"."requested_by" <> "patient_mobile_change_requests"."target_account_id" AND ("patient_mobile_change_requests"."decided_by" IS NULL OR "patient_mobile_change_requests"."decided_by" <> "patient_mobile_change_requests"."target_account_id") AND ("patient_mobile_change_requests"."status" <> 'approved' OR "patient_mobile_change_requests"."decided_by" <> "patient_mobile_change_requests"."requested_by")),
	CONSTRAINT "patient_mobile_change_requests_decided_check" CHECK (("patient_mobile_change_requests"."status" = 'pending') = ("patient_mobile_change_requests"."decided_by" IS NULL AND "patient_mobile_change_requests"."decided_at" IS NULL AND "patient_mobile_change_requests"."decision_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "patient_mobile_change_requests" ADD CONSTRAINT "patient_mobile_change_requests_target_account_id_user_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_mobile_change_requests" ADD CONSTRAINT "patient_mobile_change_requests_requested_by_user_accounts_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_mobile_change_requests" ADD CONSTRAINT "patient_mobile_change_requests_decided_by_user_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_mobile_change_requests_target_idx" ON "patient_mobile_change_requests" USING btree ("target_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_mobile_change_requests_open_key" ON "patient_mobile_change_requests" USING btree ("target_account_id") WHERE "patient_mobile_change_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "patient_mobile_change_requests_open_to_key" ON "patient_mobile_change_requests" USING btree ("to_mobile") WHERE "patient_mobile_change_requests"."status" = 'pending';--> statement-breakpoint
-- A request is decided once: only pending leaves, and only to approved or rejected; who, which
-- mobiles and why never change. For every role, the owner's too.
CREATE FUNCTION public.patient_mobile_change_requests_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'patient_mobile_change_requests: a decided request does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.target_account_id <> OLD.target_account_id OR NEW.requested_by <> OLD.requested_by
     OR NEW.from_mobile <> OLD.from_mobile OR NEW.to_mobile <> OLD.to_mobile
     OR NEW.reason <> OLD.reason OR NEW.evidence <> OLD.evidence
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'patient_mobile_change_requests: who, which mobiles and why do not change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER patient_mobile_change_requests_guard BEFORE UPDATE ON "patient_mobile_change_requests"
  FOR EACH ROW EXECUTE FUNCTION public.patient_mobile_change_requests_guard();--> statement-breakpoint
CREATE TRIGGER patient_mobile_change_requests_set_updated_at BEFORE UPDATE ON "patient_mobile_change_requests"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
REVOKE DELETE ON "patient_mobile_change_requests" FROM sepehr_app;--> statement-breakpoint
INSERT INTO "permissions" ("code") VALUES ('identity.change_patient_mobile');
