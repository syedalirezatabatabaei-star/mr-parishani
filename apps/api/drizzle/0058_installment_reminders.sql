-- 0058 installment reminders and overdue notices (task 6-6; doc 15 §4; 6.3). Hand-written (ADR-003).
-- Expand only: one new table, two configuration keys and five SMS templates.

-- === Each reminder step of an installment, once (the unique row decides) ==================
CREATE TABLE "installment_reminders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"installment_id" uuid NOT NULL REFERENCES "installments" ("id"),
	"kind" text NOT NULL,
	"offset_days" integer NOT NULL,
	"dispatch_id" uuid NOT NULL REFERENCES "sms_dispatches" ("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_reminders_kind_check" CHECK ("kind" IN ('before_due', 'overdue')),
	CONSTRAINT "installment_reminders_offset_check" CHECK ("offset_days" BETWEEN 0 AND 365)
);--> statement-breakpoint
CREATE UNIQUE INDEX "installment_reminders_key"
  ON "installment_reminders" ("installment_id", "kind", "offset_days");--> statement-breakpoint
CREATE TRIGGER installment_reminders_append_only BEFORE UPDATE OR DELETE ON "installment_reminders"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "installment_reminders" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "installment_reminders" TO sepehr_app;--> statement-breakpoint

-- === When, by configuration (6.3: 3 and 0 days before; 1, 7 and 15 after) ================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('repayment.reminder_days_before', 'business', true),
  ('repayment.overdue_notice_days', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('repayment.reminder_days_before', 'global', '[3, 0]', '2020-01-01T00:00:00Z', 'approved',
   'پیش‌فرض مستند ۶.۳ (۳ و ۰ روز پیش از سررسید)؛ مهاجرت 0058', now()),
  ('repayment.overdue_notice_days', 'global', '[1, 7, 15]', '2020-01-01T00:00:00Z', 'approved',
   'پیش‌فرض مستند ۶.۳ (۱، ۷ و ۱۵ روز پس از سررسید)؛ مهاجرت 0058', now());--> statement-breakpoint

-- === The templates' first versions (the panel makes later ones; task 6-4) ================
INSERT INTO "sms_templates" ("code", "version", "audience", "category", "body", "reason") VALUES
  ('repayment.reminder_before_due', 1, 'borrower', 'transactional',
   '{{name}} گرامی، قسط {{installment_number}} به مبلغ {{amount}} در تاریخ {{due_date}} سررسید می‌شود.',
   'نسخه اول، مهاجرت 0058 (تسک ۶-۶)'),
  ('repayment.reminder_due_today', 1, 'borrower', 'transactional',
   '{{name}} گرامی، امروز {{due_date}} سررسید قسط {{installment_number}} به مبلغ {{amount}} است.',
   'نسخه اول، مهاجرت 0058 (تسک ۶-۶)'),
  ('repayment.overdue_notice', 1, 'borrower', 'transactional',
   '{{name}} گرامی، قسط {{installment_number}} به مبلغ {{amount}} از {{due_date}} به مدت {{days_overdue}} روز معوق است.',
   'نسخه اول، مهاجرت 0058 (تسک ۶-۶)'),
  ('repayment.receipt_approved', 1, 'borrower', 'transactional',
   'واریز شما به مبلغ {{amount}} تأیید و ثبت شد.',
   'نسخه اول، مهاجرت 0058 (تسک ۶-۶)'),
  ('repayment.guarantor_notice', 1, 'guarantor', 'transactional',
   '{{name}} گرامی، قسط وامی که ضمانت {{borrower_name}} را کرده‌اید به مبلغ {{amount}} به مدت {{days_overdue}} روز معوق است.',
   'نسخه اول، مهاجرت 0058 (تسک ۶-۶؛ مصرف در ۶-۷)');
