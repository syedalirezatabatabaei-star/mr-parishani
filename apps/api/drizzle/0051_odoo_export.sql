-- 0051 the accounting panel's reports and the Odoo 19 export (task 5-7; doc 06 §7; doc 14 ث;
-- owner 1405/07/15, 5.5: an ISO date column for Odoo and a Jalali one beside it). Hand-written
-- (ADR-003). Expand only: two new append-only tables and two permissions.

-- === Which Odoo account each internal account code goes to (append-only; newest wins) ======
CREATE TABLE "odoo_account_mappings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL,
	-- The ledger's logical code (doc 02 §3), e.g. doctor.payable.
	"internal_code" text NOT NULL,
	"odoo_account_code" text NOT NULL,
	"reason" text NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "odoo_account_mappings_internal_check"
	  CHECK ("internal_code" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
	CONSTRAINT "odoo_account_mappings_odoo_check"
	  CHECK (length(trim("odoo_account_code")) BETWEEN 1 AND 64),
	CONSTRAINT "odoo_account_mappings_reason_check" CHECK (length(trim("reason")) >= 3)
);--> statement-breakpoint
CREATE INDEX "odoo_account_mappings_code_idx" ON "odoo_account_mappings"
  ("entity_id", "internal_code", "set_at" DESC, "id" DESC);--> statement-breakpoint
CREATE TRIGGER odoo_account_mappings_append_only BEFORE UPDATE OR DELETE ON "odoo_account_mappings"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "odoo_account_mappings" FROM sepehr_app;--> statement-breakpoint

-- === Each export made: its month, its totals and the file's hash (append-only) ============
CREATE TABLE "odoo_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"documents" integer NOT NULL,
	"debit_total_rial" bigint NOT NULL,
	"credit_total_rial" bigint NOT NULL,
	"sha256" text NOT NULL,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "odoo_exports_period_check"
	  CHECK ("period_year" BETWEEN 1400 AND 1500 AND "period_month" BETWEEN 1 AND 12),
	-- Every document balances; so does the file.
	CONSTRAINT "odoo_exports_balanced_check"
	  CHECK ("debit_total_rial" = "credit_total_rial" AND "debit_total_rial" >= 0 AND "documents" >= 0)
);--> statement-breakpoint
CREATE INDEX "odoo_exports_period_idx" ON "odoo_exports" ("entity_id", "period_year", "period_month");--> statement-breakpoint
CREATE TRIGGER odoo_exports_append_only BEFORE UPDATE OR DELETE ON "odoo_exports"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "odoo_exports" FROM sepehr_app;--> statement-breakpoint

-- === Permissions (accounting: the reports, and the mapping and export) ====================
INSERT INTO "permissions" ("code") VALUES
  ('settlement.read_reports'), ('settlement.manage_odoo_mapping');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('accounting', 'settlement.read_reports'),
  ('accounting', 'settlement.manage_odoo_mapping')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
