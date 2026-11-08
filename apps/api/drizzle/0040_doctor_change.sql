-- 0040 changing a purse's doctor (task 4-8 [financial], part 2; doc 12 §7; owner 1405/07/13:
-- no Referral, پ۲). Hand-written (ADR-003). The purse row and its guard stay as they are:
-- its scope changes by a new version (append-only), as compatibility item 3 proposed.
--
-- One change to a table of 0039: the request kinds widen (its CHECK replaced by a wider one).
-- The table holds only requests of 4-8 itself; no other data depends on the kind.

ALTER TABLE "purse_operation_requests" DROP CONSTRAINT "purse_operation_requests_kind_check";--> statement-breakpoint
ALTER TABLE "purse_operation_requests" ADD CONSTRAINT "purse_operation_requests_kind_check"
  CHECK ("kind" IN ('cancel_unused', 'reverse_cancel_unused', 'change_doctor'));--> statement-breakpoint

-- === The purse's scope, by version (wallet module) =========================================
-- The newest version is the purse's scope; without one, the purse row's (phase 1).
CREATE TABLE "purse_scope_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"purse_id" uuid NOT NULL REFERENCES "credit_purses" ("id"),
	"center_node_id" uuid NOT NULL,
	"doctor_node_id" uuid NOT NULL,
	"treatment_field_code" text NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purse_scope_versions_reason_check" CHECK (length(trim("reason")) >= 3)
);--> statement-breakpoint
CREATE UNIQUE INDEX "purse_scope_versions_key_key" ON "purse_scope_versions" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "purse_scope_versions_purse_idx" ON "purse_scope_versions" ("purse_id", "created_at");--> statement-breakpoint
CREATE TRIGGER purse_scope_versions_append_only BEFORE UPDATE OR DELETE ON "purse_scope_versions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "purse_scope_versions" FROM sepehr_app;--> statement-breakpoint

-- === The doctor's patients follow the purse (service module; read model of wallet.doctor_changed)
CREATE TABLE "service_purse_workplaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"purse_id" uuid NOT NULL,
	"workplace_id" uuid NOT NULL,
	"workplace_node_path" text NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "service_purse_workplaces_event_key" ON "service_purse_workplaces" ("event_id");--> statement-breakpoint
CREATE INDEX "service_purse_workplaces_purse_idx" ON "service_purse_workplaces" ("purse_id", "created_at");--> statement-breakpoint
CREATE TRIGGER service_purse_workplaces_append_only BEFORE UPDATE OR DELETE ON "service_purse_workplaces"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "service_purse_workplaces" FROM sepehr_app;--> statement-breakpoint

-- === Permissions (owner پ۳: asked by case completion, approved by the credit manager) =======
INSERT INTO "permissions" ("code") VALUES
  ('wallet.request_doctor_change'), ('wallet.approve_doctor_change');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('case_completion', 'wallet.request_doctor_change'),
  ('credit_manager', 'wallet.request_doctor_change'),
  ('credit_manager', 'wallet.approve_doctor_change')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
