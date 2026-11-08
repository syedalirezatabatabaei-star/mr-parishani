-- 0050 the doctor's settlement panel (task 5-6; doc 06 §6). Hand-written (ADR-003). Expand
-- only: two permissions and three role grants; no table, column or constraint changes.

-- === A doctor reads their own statements, PDF, upcoming and held items; a center its sums ==
INSERT INTO "permissions" ("code") VALUES
  ('settlement.read_own'), ('settlement.read_center_summary');--> statement-breakpoint
-- A doctor opens a dispute on their own item from the panel (decided by accounting, 5-2).
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('doctor', 'settlement.read_own'),
  ('doctor', 'settlement.open_dispute'),
  ('center_manager', 'settlement.read_center_summary')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
