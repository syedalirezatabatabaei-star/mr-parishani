-- 0093 (owner 1405/07/27, ADR-044): a case's own cancellation-penalty rate is asked by
-- accounting and approved by the general manager (ceo); the credit unit holds neither.
-- Data only: the two grants of 0044 to the credit roles end by deleted_at (rule 7, never a
-- DELETE); accounting may ask, ceo may approve. No table, column or ledger row changes; the
-- requests already made stay as they are.
UPDATE "role_permissions" rp SET "deleted_at" = now(), "updated_at" = now()
FROM "roles" r
WHERE rp."role_id" = r."id"
  AND r."code" IN ('credit_specialist', 'credit_manager')
  AND rp."permission_code" IN ('credit.request_penalty_override', 'credit.approve_penalty_override')
  AND rp."deleted_at" IS NULL;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", g."permission_code"
FROM (VALUES
  ('accounting', 'credit.request_penalty_override'),
  ('ceo', 'credit.approve_penalty_override')
) AS g("role_code", "permission_code")
JOIN "roles" r ON r."code" = g."role_code" AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
