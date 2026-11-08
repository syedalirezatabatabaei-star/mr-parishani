-- 0013 the network prices a private practice whose doctor has no account (task 2-4 owner
-- decision, ADR-024). Only a permission and its grant: which workplaces it reaches (a
-- private practice, a doctor without an account, the specialist's own city) is decided by
-- the tariff service on every request, so it stops applying the moment the doctor gets an
-- account. The branch manager setting their branch's prices needs no change here: the
-- center_manager role already holds catalog.manage_tariffs, the scope decides.

INSERT INTO "permissions" ("code") VALUES
  ('catalog.manage_tariff_for_unaccounted_doctor');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'catalog.manage_tariff_for_unaccounted_doctor'
FROM "roles" r
WHERE r.code = 'network_specialist' AND r.deleted_at IS NULL;
