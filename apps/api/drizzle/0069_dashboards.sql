-- 0069 the dashboards (task 7-5; doc 17 §3). Expand only: the CEO dashboard's permission. The
-- dashboards read the views and grants of 0065 to 0068.
INSERT INTO "permissions" ("code") VALUES ('reporting.dashboard_ceo');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'reporting.dashboard_ceo' FROM "roles" r WHERE r.code = 'ceo' AND r.deleted_at IS NULL;
