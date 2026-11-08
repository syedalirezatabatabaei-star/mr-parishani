-- 0107 (owner 1405/08/03; plan docs/decisions/config-technical-split-plan.md). Add only: no
-- UPDATE, DELETE, DROP or ALTER COLUMN; no trigger, no financial table, no existing grant changed.
--  1. Two permissions: proposing a technical setting, and approving or rejecting one.
--  2. A role that only approves technical settings (technical_config_approver), held by nobody
--     until the owner assigns it in the panel.
--  3. Grants: system_admin may propose; technical_config_approver may approve. No role holds both.
-- config.manage_technical stays with system_admin for now: taking it away is a separate step
-- the owner approves (until then both ways work, and the second-person rule of the service and
-- of the trigger config_values_guard is unchanged).
INSERT INTO "permissions" ("code") VALUES
  ('config.propose_technical'),
  ('config.approve_technical')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "roles" ("code", "name", "is_system") VALUES
  ('technical_config_approver', 'تأییدکننده تنظیمات فنی', true)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", g."permission_code"
FROM (VALUES
  ('system_admin', 'config.propose_technical'),
  ('technical_config_approver', 'config.approve_technical')
) AS g("role_code", "permission_code")
JOIN "roles" r ON r."code" = g."role_code" AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
