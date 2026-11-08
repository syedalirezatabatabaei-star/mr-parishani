-- 0078 the re-encryption tool's key named after the module that owns it (task 9-3, R4; owner
-- 1405/07/18): `security.field_reencryption` (0077) becomes `audit.field_reencryption`.
-- Hand-written (ADR-003). Add only: the new key and its value; the old key soft-deleted
-- (rule 7), its one version kept as history. Summary: docs/decisions/task-9-3-decisions.md (part 6).
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('audit.field_reencryption', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('audit.field_reencryption', 'global', '{"until": null}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه: هیچ اجرایی مجاز نیست (مهاجرت 0078)', now());--> statement-breakpoint
UPDATE "config_keys" SET "deleted_at" = now()
  WHERE "code" = 'security.field_reencryption' AND "deleted_at" IS NULL;
