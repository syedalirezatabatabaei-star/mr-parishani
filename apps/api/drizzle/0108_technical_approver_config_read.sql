-- 0108 (found by the demo seed 1405/08/07; owner asked for the draft 1405/08/07). Add only: no
-- UPDATE, DELETE, DROP or ALTER; no trigger, no financial table, no existing grant changed.
-- technical_config_approver (0107) holds config.approve_technical only, but the approve and
-- reject routes of /config/proposals also ask config.read (config.controller.ts), so the role
-- alone cannot decide. One grant: config.read for that role. It still cannot propose
-- (config.propose_technical stays with system_admin), so no role gains both sides.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", 'config.read'
FROM "roles" r
WHERE r."code" = 'technical_config_approver' AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
