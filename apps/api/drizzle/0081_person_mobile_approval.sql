-- 0081 task 9-3, go-live blocker م۵ (owner, 1405/07/19): a mobile added to a Person who already
-- existed (a national ID matched) stays pending, and gives nothing of that Person and gets no
-- SMS, until a proved mobile of the Person approves it in their own panel, or permitted staff
-- with evidence; refused by itself at the deadline. Summary and counts:
-- docs/decisions/task-9-3-person-mobile-decisions.md §8.
-- Add only, but for one check widened (factor_change_notices_event_check, approved by the
-- owner): dropped and added again in this migration's one transaction, fully validated (no
-- NOT VALID); every existing row still meets it. Owner's changes of 1405/07/19 (second
-- approval): status with no default, set explicitly on the rows there are; a trigger that lets
-- status only leave pending and proved_at be set once; merge-moved and import mobiles.
CREATE TABLE "person_mobile_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_mobile_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"method" text NOT NULL,
	"decided_by" uuid,
	"reason" text NOT NULL,
	"evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_mobile_decisions_decision_check" CHECK ("person_mobile_decisions"."decision" IN ('approved', 'rejected')),
	CONSTRAINT "person_mobile_decisions_method_check" CHECK ("person_mobile_decisions"."method" IN ('owner_panel', 'staff', 'expiry', 'import_cancelled'))
);
--> statement-breakpoint
-- status: added empty, the rows there are made active by name, then NOT NULL with no default,
-- so an insert that does not say which is refused.
ALTER TABLE "person_mobiles" ADD COLUMN "status" text;--> statement-breakpoint
UPDATE "person_mobiles" SET "status" = 'active';--> statement-breakpoint
ALTER TABLE "person_mobiles" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD COLUMN "proved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD COLUMN "added_via" text;--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD COLUMN "added_by" uuid;--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "person_mobile_decisions" ADD CONSTRAINT "person_mobile_decisions_person_mobile_id_person_mobiles_id_fk" FOREIGN KEY ("person_mobile_id") REFERENCES "public"."person_mobiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_mobile_decisions_mobile_idx" ON "person_mobile_decisions" USING btree ("person_mobile_id");--> statement-breakpoint
CREATE INDEX "person_mobiles_pending_idx" ON "person_mobiles" USING btree ("pending_expires_at") WHERE "person_mobiles"."status" = 'pending' AND "person_mobiles"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD CONSTRAINT "person_mobiles_status_check" CHECK ("person_mobiles"."status" IN ('active', 'pending', 'rejected'));--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD CONSTRAINT "person_mobiles_rejected_deleted_check" CHECK ("person_mobiles"."status" <> 'rejected' OR "person_mobiles"."deleted_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD CONSTRAINT "person_mobiles_added_via_check" CHECK ("person_mobiles"."added_via" IN ('person_created', 'intake', 'import', 'credit_transfer', 'merge'));--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD CONSTRAINT "person_mobiles_pending_expires_check" CHECK ("person_mobiles"."status" <> 'pending' OR "person_mobiles"."pending_expires_at" IS NOT NULL);--> statement-breakpoint
-- The widened check: the old one and the new one in the same transaction.
ALTER TABLE "factor_change_notices" DROP CONSTRAINT "factor_change_notices_event_check";--> statement-breakpoint
ALTER TABLE "factor_change_notices" ADD CONSTRAINT "factor_change_notices_event_check" CHECK ("factor_change_notices"."event" IN ('password_changed', 'totp_reset', 'totp_enrolled', 'mobile_changed', 'patient_mobile_changed', 'patient_mobile_added', 'patient_mobile_approved', 'patient_mobile_rejected'));--> statement-breakpoint
-- proved_at only with a witness of a real OTP login: a patient session, which only a verified
-- OTP code creates (identity otp-login). The first one is the proof. Mobiles staff entered,
-- with no such login, stay null.
UPDATE "person_mobiles" pm
   SET "proved_at" = s."first_login_at"
  FROM (
    SELECT u."mobile", min(se."created_at") AS "first_login_at"
      FROM "user_accounts" u
      JOIN "sessions" se ON se."account_id" = u."id"
     WHERE u."kind" = 'patient' AND u."deleted_at" IS NULL
     GROUP BY u."mobile"
  ) s
 WHERE s."mobile" = pm."mobile" AND pm."deleted_at" IS NULL;--> statement-breakpoint
-- The application may change, of a mobile, only what a decision and a login change: its status
-- and its first login; deleted_at it had already (0015). Nothing else.
GRANT UPDATE ("status", "proved_at") ON "person_mobiles" TO sepehr_app;--> statement-breakpoint
-- And of those, only forward: status leaves pending once, for active or rejected, and never
-- changes otherwise; proved_at, once set, never changes; a soft-deleted row stays deleted.
-- For every role, the owner's too.
CREATE FUNCTION public.person_mobiles_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('active', 'rejected')) THEN
    RAISE EXCEPTION 'person_mobiles: status may not change from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.proved_at IS NOT NULL AND NEW.proved_at IS DISTINCT FROM OLD.proved_at THEN
    RAISE EXCEPTION 'person_mobiles: proved_at is set once'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'person_mobiles: a deleted row stays deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER person_mobiles_guard BEFORE UPDATE ON "person_mobiles"
  FOR EACH ROW EXECUTE FUNCTION public.person_mobiles_guard();--> statement-breakpoint
CREATE TRIGGER person_mobile_decisions_append_only BEFORE UPDATE OR DELETE ON "person_mobile_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "person_mobile_decisions" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "person_mobile_decisions" TO sepehr_app;--> statement-breakpoint
-- No role gets it: the access manager grants it on its own.
INSERT INTO "permissions" ("code") VALUES ('lead.approve_person_mobile');--> statement-breakpoint
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('lead.person_mobile_pending_days', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('lead.person_mobile_pending_days', 'global', '30',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، دستور مالک ۱۴۰۵/۰۷/۱۹ (مهاجرت 0081)', now());--> statement-breakpoint
INSERT INTO "sms_templates" ("code", "version", "audience", "category", "body", "reason") VALUES
  ('identity.factor.patient_mobile_added', 1, 'patient', 'urgent',
   'درخواست افزودن یک شماره تازه به حساب شما در سپهر سلامتی ثبت شد. تا تأیید شما در پنل، به هیچ اطلاعاتی دسترسی ندارد. اگر شما درخواست نداده‌اید، آن را در پنل رد کنید یا با پشتیبانی تماس بگیرید.',
   'نسخه اول، مهاجرت 0081 (تسک ۹-۳، م۵)'),
  ('identity.factor.patient_mobile_approved', 1, 'patient', 'urgent',
   'یک شماره تازه به حساب شما در سپهر سلامتی افزوده شد و اکنون به اطلاعات حساب دسترسی دارد. اگر این را نمی‌شناسید، فوراً با پشتیبانی تماس بگیرید.',
   'نسخه اول، مهاجرت 0081 (تسک ۹-۳، م۵)'),
  ('identity.factor.patient_mobile_rejected', 1, 'patient', 'urgent',
   'درخواست افزودن یک شماره تازه به حساب شما در سپهر سلامتی رد شد و آن شماره دسترسی ندارد.',
   'نسخه اول، مهاجرت 0081 (تسک ۹-۳، م۵)');
