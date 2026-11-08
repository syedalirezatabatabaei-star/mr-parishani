-- 0090 (owner 1405/07/26, ف۱۲ option «ب»): a signed-in patient replaces their login mobile by
-- a code sent to the new one. The Person's new row says where it came from ('mobile_change'),
-- which the check on added_via did not allow: the check is widened (DROP and ADD of the same
-- name; every existing row passes, nothing is rewritten). One configuration key, off, as
-- every new flag. No table, no column, no row changed.
-- Summary: docs/decisions/task-f12-patient-mobile-change-decisions.md.
ALTER TABLE "person_mobiles" DROP CONSTRAINT "person_mobiles_added_via_check";--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD CONSTRAINT "person_mobiles_added_via_check" CHECK ("person_mobiles"."added_via" IN ('person_created', 'intake', 'import', 'credit_transfer', 'merge', 'mobile_change'));--> statement-breakpoint
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('identity.patient_mobile_change', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('identity.patient_mobile_change', 'global', '{"enabled": false, "recentLoginSeconds": 600, "cooldownDays": 0}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه: خاموش تا راه‌اندازی، دستور مالک ۱۴۰۵/۰۷/۲۶ (مهاجرت 0090)', now());
