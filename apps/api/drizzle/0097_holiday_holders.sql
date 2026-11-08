-- 0097 (owner 1405/07/27, plan f): holidays are saved by the general manager and one other,
-- by two people as before (ADR-043). Data only: config.manage_holidays given to ceo, beside
-- system_admin (who already holds it); the named holders are the owner's to grant in /access.
-- No table, column or ledger row changes.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", 'config.manage_holidays'
FROM "roles" r WHERE r."code" = 'ceo' AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
