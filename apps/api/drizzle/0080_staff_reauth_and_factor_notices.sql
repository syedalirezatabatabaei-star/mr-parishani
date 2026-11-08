-- 0080 task 9-3, R1 and R2, and the owner's question 3 (1405/07/18): re-authentication before
-- sensitive actions, an SMS when a login factor changes, and a verified mobile for internal
-- staff. Add only: a nullable column, a new append-only table, three keys (off) and five
-- templates. No existing check or function changes. Summary:
-- docs/decisions/task-9-3-r1-r2-decisions.md §7.
CREATE TABLE "factor_change_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL,
	"event" text NOT NULL,
	"audience" text NOT NULL,
	"mobile" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factor_change_notices_event_check" CHECK ("factor_change_notices"."event" IN ('password_changed', 'totp_reset', 'totp_enrolled', 'mobile_changed', 'patient_mobile_changed')),
	CONSTRAINT "factor_change_notices_audience_check" CHECK ("factor_change_notices"."audience" IN ('staff', 'patient')),
	CONSTRAINT "factor_change_notices_mobile_check" CHECK ("factor_change_notices"."mobile" ~ '^9[0-9]{9}$')
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reauthenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "factor_change_notices" ADD CONSTRAINT "factor_change_notices_account_id_user_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "factor_change_notices_account_idx" ON "factor_change_notices" USING btree ("account_id");--> statement-breakpoint
CREATE TRIGGER factor_change_notices_append_only BEFORE UPDATE OR DELETE ON "factor_change_notices"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "factor_change_notices" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "factor_change_notices" TO sepehr_app;--> statement-breakpoint
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('identity.reauth', 'technical', true),
  ('identity.factor_change_sms', 'technical', true),
  ('identity.staff_mobile_required', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('identity.reauth', 'global', '{"enabled": false, "windowSeconds": 300}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0080)', now()),
  ('identity.factor_change_sms', 'global', '{"enabled": false}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0080)', now()),
  ('identity.staff_mobile_required', 'global', '{"enabled": false}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0080)', now());--> statement-breakpoint
INSERT INTO "sms_templates" ("code", "version", "audience", "category", "body", "reason") VALUES
  ('identity.factor.password_changed', 1, 'staff', 'urgent',
   'گذرواژه حساب شما در سپهر سلامتی تغییر کرد. اگر این کار را نکرده‌اید، فوراً با پشتیبانی تماس بگیرید.',
   'نسخه اول، مهاجرت 0080 (تسک ۹-۳، R2)'),
  ('identity.factor.totp_reset', 1, 'staff', 'urgent',
   'کد دومرحله‌ای حساب شما در سپهر سلامتی بازنشانی شد. اگر درخواست نداده‌اید، فوراً با پشتیبانی تماس بگیرید.',
   'نسخه اول، مهاجرت 0080 (تسک ۹-۳، R2)'),
  ('identity.factor.totp_enrolled', 1, 'staff', 'urgent',
   'برنامه کد دومرحله‌ای تازه‌ای برای حساب شما در سپهر سلامتی ثبت شد. اگر این کار را نکرده‌اید، فوراً با پشتیبانی تماس بگیرید.',
   'نسخه اول، مهاجرت 0080 (تسک ۹-۳، R2)'),
  ('identity.factor.mobile_changed', 1, 'staff', 'urgent',
   'شماره موبایل حساب شما در سپهر سلامتی عوض شد و این شماره دیگر به حساب وصل نیست. اگر این کار را نکرده‌اید، فوراً با پشتیبانی تماس بگیرید.',
   'نسخه اول، مهاجرت 0080 (تسک ۹-۳، R2)'),
  ('identity.factor.patient_mobile_changed', 1, 'patient', 'urgent',
   'شماره موبایل حساب شما در سپهر سلامتی عوض شد و این شماره دیگر به حساب وصل نیست. اگر این کار را نکرده‌اید، با پشتیبانی تماس بگیرید.',
   'نسخه اول، مهاجرت 0080 (تسک ۹-۳، R2)');
