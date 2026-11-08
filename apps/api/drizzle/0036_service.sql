-- 0036 service authorization and delivery (task 4-6 [financial]; doc 12 §6; owner 1405/07/12).
-- Hand-written (ADR-003: explicit SQL in financial modules). Expand only: four new tables of
-- the service module, permissions and configuration. No change to any existing financial
-- table: the purse moves only through phase 1's wallet operations (reserve, cancel the
-- reservation, register the service, reverse), on its memo chain; doctor.payable is phase 5's.

-- === Authorizations ==========================================================================
CREATE TABLE "service_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"purse_id" uuid NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"workplace_id" uuid NOT NULL,
	"doctor_node_id" uuid NOT NULL,
	"center_node_id" uuid NOT NULL,
	"treatment_field_code" text NOT NULL,
	"amount_rial" bigint NOT NULL,
	"status" text DEFAULT 'code_sent' NOT NULL,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	-- The configuration in force at issue, locked to the authorization (rule 16).
	"finalize_after_hours" integer NOT NULL,
	"max_code_attempts" integer NOT NULL,
	"max_code_sends" integer NOT NULL,
	"resend_cooldown_seconds" integer NOT NULL,
	"code_ttl_minutes" integer NOT NULL,
	"config_version_ids" jsonb NOT NULL,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"code_sends" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	-- The wallet operation that registered it: what a cancellation reverses (owner, ت۲).
	"register_operation_id" uuid,
	"finalize_due_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_authorizations_amount_check" CHECK ("amount_rial" > 0),
	CONSTRAINT "service_authorizations_limits_check" CHECK ("finalize_after_hours" >= 0
	  AND "max_code_attempts" >= 1 AND "max_code_sends" >= 1 AND "resend_cooldown_seconds" >= 1
	  AND "code_ttl_minutes" >= 1 AND "code_attempts" >= 0 AND "code_sends" >= 0),
	CONSTRAINT "service_authorizations_status_check"
	  CHECK ("status" IN ('code_sent', 'delivered', 'finalized', 'expired', 'cancelled')),
	-- What each status has recorded, and nothing more.
	CONSTRAINT "service_authorizations_state_check" CHECK (
	  ("status" = 'code_sent' AND "delivered_at" IS NULL AND "finalize_due_at" IS NULL
	     AND "finalized_at" IS NULL AND "expired_at" IS NULL AND "cancelled_at" IS NULL)
	  OR ("status" = 'delivered' AND "delivered_at" IS NOT NULL AND "finalize_due_at" IS NOT NULL
	     AND "register_operation_id" IS NOT NULL
	     AND "finalized_at" IS NULL AND "expired_at" IS NULL AND "cancelled_at" IS NULL)
	  OR ("status" = 'finalized' AND "delivered_at" IS NOT NULL AND "finalized_at" IS NOT NULL
	     AND "expired_at" IS NULL AND "cancelled_at" IS NULL)
	  OR ("status" = 'expired' AND "expired_at" IS NOT NULL AND "delivered_at" IS NULL
	     AND "cancelled_at" IS NULL)
	  OR ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL AND "finalized_at" IS NULL
	     AND "expired_at" IS NULL)
	),
	CONSTRAINT "service_authorizations_cancel_check" CHECK (("cancelled_at" IS NULL)
	  = ("cancelled_by" IS NULL) AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL))
);--> statement-breakpoint
CREATE INDEX "service_authorizations_purse_idx" ON "service_authorizations" ("purse_id", "issued_at");--> statement-breakpoint
CREATE INDEX "service_authorizations_workplace_idx" ON "service_authorizations" ("workplace_id", "issued_at");--> statement-breakpoint
CREATE INDEX "service_authorizations_open_idx" ON "service_authorizations" ("expires_at")
  WHERE "status" = 'code_sent';--> statement-breakpoint
CREATE INDEX "service_authorizations_due_idx" ON "service_authorizations" ("finalize_due_at")
  WHERE "status" = 'delivered';--> statement-breakpoint

-- Rule 8: only the service moves an authorization, along its paths; what was authorized
-- (purse, scope, amount, locked configuration, issuer) never changes.
CREATE FUNCTION public.service_authorizations_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'code_attempts', 'code_sends', 'delivered_at', 'register_operation_id',
    'finalize_due_at', 'finalized_at', 'expired_at', 'cancelled_at', 'cancelled_by',
    'cancel_reason', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'service authorization % can only change its state', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'code_sent' AND NEW.status IN ('delivered', 'expired', 'cancelled'))
    OR (OLD.status = 'delivered' AND NEW.status IN ('finalized', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'service authorization % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('finalized', 'expired', 'cancelled')
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'service authorization % is closed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.code_attempts < OLD.code_attempts OR NEW.code_sends < OLD.code_sends THEN
    RAISE EXCEPTION 'service authorization % counters only grow', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER service_authorizations_guard BEFORE UPDATE ON "service_authorizations"
  FOR EACH ROW EXECUTE FUNCTION public.service_authorizations_guard();--> statement-breakpoint
CREATE TRIGGER service_authorizations_set_updated_at BEFORE UPDATE ON "service_authorizations"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER service_authorizations_no_delete BEFORE DELETE ON "service_authorizations"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "service_authorizations" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "code_attempts", "code_sends", "delivered_at", "register_operation_id",
              "finalize_due_at",
              "finalized_at", "expired_at", "cancelled_at", "cancelled_by", "cancel_reason",
              "updated_at")
  ON "service_authorizations" TO sepehr_app;--> statement-breakpoint

-- === Its proforma lines: each line in one live authorization only (owner, پ۷) =============
CREATE TABLE "service_authorization_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"authorization_id" uuid NOT NULL REFERENCES "service_authorizations" ("id"),
	"proforma_line_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	-- Set once when its authorization expires or is cancelled: the line is free again.
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_authorization_lines_amount_check" CHECK ("amount_rial" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "service_authorization_lines_key"
  ON "service_authorization_lines" ("authorization_id", "proforma_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_authorization_lines_live_key"
  ON "service_authorization_lines" ("proforma_line_id") WHERE "released_at" IS NULL;--> statement-breakpoint
CREATE FUNCTION public.service_authorization_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at')
     OR OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'service authorization line % can only be released, once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER service_authorization_lines_guard BEFORE UPDATE ON "service_authorization_lines"
  FOR EACH ROW EXECUTE FUNCTION public.service_authorization_lines_guard();--> statement-breakpoint
CREATE TRIGGER service_authorization_lines_no_delete BEFORE DELETE ON "service_authorization_lines"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "service_authorization_lines" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("released_at") ON "service_authorization_lines" TO sepehr_app;--> statement-breakpoint

-- === Codes: only their HMAC is kept, never the code ============================================
CREATE TABLE "service_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"authorization_id" uuid NOT NULL REFERENCES "service_authorizations" ("id"),
	"code_hash" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	CONSTRAINT "service_codes_end_check" CHECK ("consumed_at" IS NULL OR "voided_at" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "service_codes_open_key" ON "service_codes" ("authorization_id")
  WHERE "consumed_at" IS NULL AND "voided_at" IS NULL;--> statement-breakpoint
CREATE FUNCTION public.service_codes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['consumed_at', 'voided_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumed_at', 'voided_at'])
     OR OLD.consumed_at IS NOT NULL OR OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'service code % can only be consumed or voided, once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER service_codes_guard BEFORE UPDATE ON "service_codes"
  FOR EACH ROW EXECUTE FUNCTION public.service_codes_guard();--> statement-breakpoint
CREATE TRIGGER service_codes_no_delete BEFORE DELETE ON "service_codes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "service_codes" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("consumed_at", "voided_at") ON "service_codes" TO sepehr_app;--> statement-breakpoint

-- === The doctor's funded patients (owner, پ۲): a read model of wallet.funded ==================
-- Ids and the workplace's node path only; the name is read when shown (rule 30).
CREATE TABLE "service_doctor_patients" (
	"purse_id" uuid PRIMARY KEY NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"workplace_id" uuid NOT NULL,
	"workplace_node_path" text NOT NULL,
	"patient_person_id" uuid NOT NULL,
	"funded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "service_doctor_patients_application_key"
  ON "service_doctor_patients" ("credit_application_id");--> statement-breakpoint
CREATE INDEX "service_doctor_patients_workplace_idx"
  ON "service_doctor_patients" ("workplace_id", "funded_at");--> statement-breakpoint
CREATE TRIGGER service_doctor_patients_append_only BEFORE UPDATE OR DELETE ON "service_doctor_patients"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "service_doctor_patients" FROM sepehr_app;--> statement-breakpoint

-- === Permissions (doc 12 §6; owner, پ۳) ====================================================
INSERT INTO "permissions" ("code") VALUES
  ('service.authorize'), ('service.read'), ('service.cancel');--> statement-breakpoint
-- Authorizing is the doctor's; a secretary only by their own doctor's delegation (the
-- service checks it, as for proformas). Cancelling is finance's only.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('doctor', 'service.authorize'),
  ('doctor', 'service.read'),
  ('center_manager', 'service.read'),
  ('case_completion', 'service.read'),
  ('accounting', 'service.read'),
  ('accounting', 'service.cancel'),
  ('auditor', 'service.read')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration (doc 12 §6; doc 13 open items 5 and 6; owner, پ۵) ======================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('service.code_ttl_minutes', 'business', true),
  ('service.authorization_ttl_hours', 'business', true),
  ('service.finalize_after_hours', 'business', true),
  ('service.max_code_attempts', 'business', true),
  ('service.max_code_sends', 'business', true),
  ('service.code_resend_cooldown_seconds', 'business', true),
  ('service.sms_templates', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('service.code_ttl_minutes', 'global', '10', '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۲ §۶ (مهاجرت 0036)', now()),
  ('service.authorization_ttl_hours', 'global', '24', '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۲ §۶ (مهاجرت 0036)', now()),
  ('service.finalize_after_hours', 'global', '0', '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۳ مورد باز ۵ (مهاجرت 0036)', now()),
  ('service.max_code_attempts', 'global', '5', '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۲ §۶ (مهاجرت 0036)', now()),
  ('service.max_code_sends', 'global', '3', '2020-01-01T00:00:00Z', 'approved', 'پاسخ مالک پ۵، ۱۴۰۵/۰۷/۱۲ (مهاجرت 0036)', now()),
  ('service.code_resend_cooldown_seconds', 'global', '60', '2020-01-01T00:00:00Z', 'approved', 'پاسخ مالک پ۵، ۱۴۰۵/۰۷/۱۲ (مهاجرت 0036)', now()),
  ('service.sms_templates', 'global',
   '{"code": "کد تأیید خدمت شما در {center} به مبلغ {amount}: {code}"}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۲ §۶ (مهاجرت 0036)', now());
