-- 0074 the WordPress form (task 8-2; doc 05 §7, doc 19 8-2). Drafted by drizzle-kit, edited by
-- hand (ADR-003). Summary: docs/decisions/task-8-2-decisions.md.

-- The page that sent the visitor to the form, as the plugin saw it (add only).
ALTER TABLE "case_intakes" ADD COLUMN "referrer" text;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_referrer_check"
  CHECK ("referrer" IS NULL OR length("referrer") <= 2000);--> statement-breakpoint

-- The form's SMS consent recorded in 6-4's consent ledger, from its own source (the owner's
-- ruling, 1405/07/17): the CHECK widened, no row changed.
ALTER TABLE "sms_consents" DROP CONSTRAINT "sms_consents_source_check";--> statement-breakpoint
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_source_check"
  CHECK ("source" IN ('panel', 'keyword', 'link', 'wordpress'));
