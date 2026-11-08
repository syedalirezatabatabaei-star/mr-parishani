-- 0105 (owner 1405/08/01 and 1405/08/02; plan pilot-panel-gaps-plan.md item ج). Data only: no
-- table, column, ledger row or holiday changes; the holidays already saved and any request
-- already made stay as they are.
--  1. The secretary sees and handles their own doctor's appointments: the two booking grants of
--     the doctor (0016). A secretary's scope is their doctor's node and AccessService caps them
--     by the doctor's own grants; no proforma, service or settlement grant comes with it.
--  2. config.approve_holidays: deciding a holiday batch or removal another person asked for,
--     and nothing else, held by one new system role, holiday_deputy («قائم‌مقام مدیرعامل (فقط
--     تعطیلات)», owner 1405/08/02), with that grant alone. Nobody holds the role until it is
--     assigned.
--  3. Holidays are the CEO's alone: system_admin's config.manage_holidays ends by deleted_at
--     (rule 7, never a DELETE), as 0093 did.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", g."permission_code"
FROM (VALUES
  ('secretary', 'booking.read_appointments'),
  ('secretary', 'booking.manage_appointments')
) AS g("role_code", "permission_code")
JOIN "roles" r ON r."code" = g."role_code" AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "permissions" ("code") VALUES ('config.approve_holidays')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "roles" ("code", "name", "is_system") VALUES
  ('holiday_deputy', 'قائم‌مقام مدیرعامل (فقط تعطیلات)', true)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", 'config.approve_holidays'
FROM "roles" r
WHERE r."code" = 'holiday_deputy' AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "role_permissions" rp SET "deleted_at" = now(), "updated_at" = now()
FROM "roles" r
WHERE rp."role_id" = r."id"
  AND r."code" = 'system_admin'
  AND rp."permission_code" = 'config.manage_holidays'
  AND rp."deleted_at" IS NULL;
