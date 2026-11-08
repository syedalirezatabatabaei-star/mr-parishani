-- 0003 versioned configuration (task 0-6, ADR-006). Drafted by drizzle-kit for
-- config.schema.ts, then reviewed and extended by hand (ADR-003): CHECK constraints, the
-- guard trigger and column grants that keep versions immutable, the seeded keys and
-- values, and the permissions. Values formerly in IDENTITY_POLICY (code) and in
-- access_policy_versions move here with the same values, so behavior does not change.

CREATE TABLE "config_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"category" text NOT NULL,
	"sensitive" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "config_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"scope_level" text NOT NULL,
	"scope_ref" text,
	"value" jsonb,
	"effective_at" timestamp with time zone,
	"status" text DEFAULT 'proposed' NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
-- Moved before the foreign key: config_values.key references it.
CREATE UNIQUE INDEX "config_keys_code_key" ON "config_keys" USING btree ("code");--> statement-breakpoint
ALTER TABLE "config_values" ADD CONSTRAINT "config_values_key_config_keys_code_fk" FOREIGN KEY ("key") REFERENCES "public"."config_keys"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_values_lookup_idx" ON "config_values" USING btree ("key","scope_level","scope_ref","effective_at") WHERE "config_values"."status" = 'approved' AND "config_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "config_values_key_created_idx" ON "config_values" USING btree ("key","created_at");--> statement-breakpoint

-- Allowed values and shapes.
ALTER TABLE "config_keys" ADD CONSTRAINT "config_keys_code_check" CHECK ("code" ~ '^[a-z]+\.[a-z][a-z_]*$');--> statement-breakpoint
ALTER TABLE "config_keys" ADD CONSTRAINT "config_keys_category_check" CHECK ("category" IN ('business', 'technical'));--> statement-breakpoint
ALTER TABLE "config_values" ADD CONSTRAINT "config_values_status_check" CHECK ("status" IN ('proposed', 'approved', 'rejected', 'expired'));--> statement-breakpoint
-- One level per value (ADR-010; task 0-6 decision: no combined city + field level): no
-- reference at the global level, a code for a city or treatment field, a node id for a
-- center or doctor.
ALTER TABLE "config_values" ADD CONSTRAINT "config_values_scope_check" CHECK (
  ("scope_level" = 'global' AND "scope_ref" IS NULL)
  OR ("scope_level" IN ('city', 'treatment_field') AND "scope_ref" ~ '^[a-z][a-z0-9_]{1,62}$')
  OR ("scope_level" IN ('center', 'doctor')
      AND "scope_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);--> statement-breakpoint
ALTER TABLE "config_values" ADD CONSTRAINT "config_values_decision_check" CHECK (
  ("status" = 'proposed') = ("decided_at" IS NULL)
  AND ("status" <> 'approved' OR "effective_at" IS NOT NULL)
);--> statement-breakpoint
-- Only values seeded by migrations have no proposer; they are approved from the start.
ALTER TABLE "config_values" ADD CONSTRAINT "config_values_seed_check" CHECK (
  "proposed_by" IS NOT NULL OR ("status" = 'approved' AND "decided_by" IS NULL)
);--> statement-breakpoint

CREATE TRIGGER config_keys_set_updated_at BEFORE UPDATE ON "config_keys"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER config_values_set_updated_at BEFORE UPDATE ON "config_values"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint

-- A version never changes after it is written; only its one decision is recorded
-- (proposed → approved, rejected or expired). The application may not backdate a value,
-- so the value in effect at a past moment never changes (rule 16, acceptance of 0-6),
-- nor approve its own proposal of a sensitive key (doc 04 §5). Migrations run as the
-- owner and may seed values in the past.
CREATE FUNCTION public.config_values_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  is_sensitive boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'sepehr_app' AND (
      NEW.status <> 'proposed' OR NEW.proposed_by IS NULL
      OR (NEW.effective_at IS NOT NULL AND NEW.effective_at < now() - interval '1 minute')
    ) THEN
      RAISE EXCEPTION 'a configuration value starts as a proposal, never in the past'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.key, NEW.scope_level, NEW.scope_ref, NEW.value, NEW.reason,
      NEW.proposed_by, NEW.created_at, NEW.deleted_at)
     IS DISTINCT FROM
     (OLD.id, OLD.key, OLD.scope_level, OLD.scope_ref, OLD.value, OLD.reason,
      OLD.proposed_by, OLD.created_at, OLD.deleted_at) THEN
    RAISE EXCEPTION 'configuration version % is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'proposed' OR NEW.status = 'proposed' THEN
    RAISE EXCEPTION 'configuration version % is already decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.effective_at IS NOT NULL AND NEW.effective_at IS DISTINCT FROM OLD.effective_at THEN
    RAISE EXCEPTION 'the start of configuration version % cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.effective_at < NEW.decided_at THEN
      RAISE EXCEPTION 'configuration version % would start before its approval', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT sensitive INTO is_sensitive FROM public.config_keys WHERE code = NEW.key;
    IF is_sensitive AND (NEW.decided_by IS NULL OR NEW.decided_by = NEW.proposed_by) THEN
      RAISE EXCEPTION 'a sensitive configuration change needs a second person'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER config_values_guard BEFORE INSERT OR UPDATE ON "config_values"
  FOR EACH ROW EXECUTE FUNCTION public.config_values_guard();--> statement-breakpoint

-- Keys are code: only migrations write them. Of a value, the application may write only
-- the decision.
REVOKE INSERT, UPDATE ON "config_keys" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "config_values" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "effective_at") ON "config_values" TO sepehr_app;--> statement-breakpoint

-- CONFIG_KEYS of @sepehr/contracts. All sensitive for now (task 0-6 decision).
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('identity.otp', 'technical', true),
  ('identity.staff_login', 'technical', true),
  ('identity.lockout', 'technical', true),
  ('identity.session', 'technical', true),
  ('access.internal_panel_ip_allowlist', 'technical', true),
  ('audit.retention', 'technical', true),
  ('repayment.rounding_unit_rial', 'business', true),
  ('repayment.cancellation_penalty_bps', 'business', true),
  ('repayment.shift_due_to_next_working_day', 'business', true),
  ('lead.duplicate_window_days', 'business', true);--> statement-breakpoint

-- Global values, in effect from before any record exists. The identity values are those
-- of IDENTITY_POLICY until now; the business defaults are stated in docs 02 and 05.
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('identity.otp', 'global',
   '{"ttlSeconds": 180, "resendCooldownSeconds": 60, "sendsPerMobilePerHour": 8, "sendsPerIpPerHour": 20, "sendsPerDevicePerHour": 10, "failuresBeforeLock": 6, "failuresPerIpPerHour": 30}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0003)', now()),
  ('identity.staff_login', 'global',
   '{"failuresBeforeLock": 6, "failuresPerIpPerHour": 30, "minPasswordLength": 12, "pendingMfaTtlSeconds": 600, "totpResetRequestTtlSeconds": 21600}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0003)', now()),
  ('identity.lockout', 'global',
   '{"lockSeconds": 900, "failureWindowSeconds": 3600}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0003)', now()),
  ('identity.session', 'global',
   '{"webIdleSeconds": 43200, "accessTokenSeconds": 600, "refreshTokenSeconds": 2592000}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0003)', now()),
  ('repayment.rounding_unit_rial', 'global', '"10000"',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۰۲ (مهاجرت 0003)', now()),
  ('repayment.cancellation_penalty_bps', 'global', '1800',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۰۲ (مهاجرت 0003)', now()),
  -- TODO(decision): the client's confirmation (doc 02 §5); off until then.
  ('repayment.shift_due_to_next_working_day', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۰۲ (مهاجرت 0003)', now()),
  ('lead.duplicate_window_days', 'global', '7',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۰۵ (مهاجرت 0003)', now());--> statement-breakpoint

-- The access policies, carried over with their current values.
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at")
SELECT
  CASE p.policy_key
    WHEN 'internal_panel_ip_allowlist' THEN 'access.internal_panel_ip_allowlist'
    WHEN 'audit_retention' THEN 'audit.retention'
  END,
  'global', p.value, '2020-01-01T00:00:00Z', 'approved',
  'منتقل‌شده از access_policy_versions (مهاجرت 0003)', now()
FROM (
  SELECT DISTINCT ON (policy_key) policy_key, value
  FROM "access_policy_versions"
  WHERE status = 'approved' AND deleted_at IS NULL
  ORDER BY policy_key, decided_at DESC, id DESC
) p;--> statement-breakpoint

-- access_policy_versions is no longer used; frozen now, dropped by a later migration
-- (expand/contract). TODO(contract): drop the table and its schema entry.
REVOKE INSERT, UPDATE ON "access_policy_versions" FROM sepehr_app;--> statement-breakpoint

-- Permissions: reading configuration; changing business rules (strategy) or technical
-- settings (system administration). The access-policy permissions go with their endpoints
-- (soft delete: role_permissions rows keep their reference).
INSERT INTO "permissions" ("code") VALUES
  ('config.read'),
  ('config.manage_business'),
  ('config.manage_technical');--> statement-breakpoint
UPDATE "permissions" SET "deleted_at" = now()
  WHERE "code" IN ('access.read_policies', 'access.manage_policies');--> statement-breakpoint
UPDATE "role_permissions" SET "deleted_at" = now()
  WHERE "permission_code" IN ('access.read_policies', 'access.manage_policies')
    AND "deleted_at" IS NULL;--> statement-breakpoint
-- Task 0-6 decision: the CEO reads only (doc 04 §3).
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('strategy_manager', 'config.read'),
  ('strategy_manager', 'config.manage_business'),
  ('system_admin', 'config.read'),
  ('system_admin', 'config.manage_technical'),
  ('auditor', 'config.read'),
  ('ceo', 'config.read')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
