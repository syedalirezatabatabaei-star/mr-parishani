-- 0106 (owner 1405/08/02, ADR-052; plan docs/decisions/m3-financial-reauth-plan.md). Add only:
-- no UPDATE, DELETE, DROP or ALTER COLUMN; no existing financial table, two-person trigger or
-- grant changes. The SMS code itself lives in Redis only, never here.
--  1. One verified mobile per staff account: a financial approval's code goes to the signer's
--     own number, never one shared with another staff member.
--  2. A financial signer's new mobile: asked, approved by two others (never the account's owner),
--     in force 24 hours after the second approval; the old number is told. Approvals are rows
--     of their own, append only.
--  3. A cheque or promissory note released by two people: a request another person decides. The
--     release row of 0062 is still written only on approval, as before.
--  4. Three permissions and their grants; two roles (owner 1405/08/03): release_requester only
--     asks for a release (accounting only approves; no role holds both), and
--     mobile_change_approver, a third approver of a signer's mobile change (approve only, never
--     ask), held by nobody until the owner assigns it.
--  5. Two configuration keys with the owner's numbers; the SMS code is off (enabled: false)
--     until the owner's conditions are met and two people turn it on.

-- === 1. One verified mobile per staff account =====================================================
CREATE UNIQUE INDEX "user_accounts_staff_verified_mobile_key" ON "user_accounts" ("mobile")
  WHERE "kind" = 'staff' AND "mobile_verified_at" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint

-- === 2. A financial signer's mobile change ======================================================
CREATE TABLE "staff_mobile_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "user_accounts" ("id"),
	"new_mobile" text NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL REFERENCES "user_accounts" ("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_mobile_changes_mobile_check" CHECK ("new_mobile" ~ '^9[0-9]{9}$'),
	CONSTRAINT "staff_mobile_changes_reason_check" CHECK (length(btrim("reason")) >= 3)
);--> statement-breakpoint
CREATE INDEX "staff_mobile_changes_account_idx" ON "staff_mobile_changes" ("account_id", "created_at");--> statement-breakpoint
CREATE TRIGGER staff_mobile_changes_append_only BEFORE UPDATE OR DELETE ON "staff_mobile_changes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "staff_mobile_changes" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "staff_mobile_changes" TO sepehr_app;--> statement-breakpoint

-- Each decision is its own row: an approval, a refusal, or the change taking effect.
CREATE TABLE "staff_mobile_change_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"change_id" uuid NOT NULL REFERENCES "staff_mobile_changes" ("id"),
	"kind" text NOT NULL,
	"by_account_id" uuid REFERENCES "user_accounts" ("id"),
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_mobile_change_events_kind_check"
	  CHECK ("kind" IN ('approved', 'refused', 'withdrawn', 'applied')),
	CONSTRAINT "staff_mobile_change_events_by_check"
	  CHECK (("kind" = 'applied') = ("by_account_id" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "staff_mobile_change_events_one_approval_key"
  ON "staff_mobile_change_events" ("change_id", "by_account_id") WHERE "kind" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "staff_mobile_change_events_one_end_key"
  ON "staff_mobile_change_events" ("change_id") WHERE "kind" IN ('refused', 'withdrawn', 'applied');--> statement-breakpoint
-- Never by the account's owner: the database refuses it too.
CREATE FUNCTION public.staff_mobile_change_not_own() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.kind IN ('approved', 'refused') AND EXISTS (
    SELECT 1 FROM staff_mobile_changes c WHERE c.id = NEW.change_id AND c.account_id = NEW.by_account_id
  ) THEN
    RAISE EXCEPTION 'a staff member never decides their own mobile change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER staff_mobile_change_events_not_own BEFORE INSERT ON "staff_mobile_change_events"
  FOR EACH ROW EXECUTE FUNCTION public.staff_mobile_change_not_own();--> statement-breakpoint
CREATE TRIGGER staff_mobile_change_events_append_only BEFORE UPDATE OR DELETE ON "staff_mobile_change_events"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "staff_mobile_change_events" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "staff_mobile_change_events" TO sepehr_app;--> statement-breakpoint

-- === 3. A release asked by one and decided by another ===========================================
CREATE TABLE "instrument_release_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"instrument_id" uuid NOT NULL REFERENCES "instruments" ("id"),
	"case_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_release_requests_reason_check" CHECK (length(btrim("reason")) >= 3)
);--> statement-breakpoint
CREATE INDEX "instrument_release_requests_instrument_idx" ON "instrument_release_requests" ("instrument_id", "created_at");--> statement-breakpoint
CREATE TRIGGER instrument_release_requests_append_only BEFORE UPDATE OR DELETE ON "instrument_release_requests"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "instrument_release_requests" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "instrument_release_requests" TO sepehr_app;--> statement-breakpoint

CREATE TABLE "instrument_release_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL REFERENCES "instrument_release_requests" ("id"),
	"outcome" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_release_decisions_outcome_check" CHECK ("outcome" IN ('approved', 'refused', 'withdrawn'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_release_decisions_request_key" ON "instrument_release_decisions" ("request_id");--> statement-breakpoint
-- Two people: the approver or refuser is never the one who asked (withdrawing is the asker's own).
CREATE FUNCTION public.instrument_release_two_person() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  asker uuid;
BEGIN
  SELECT requested_by INTO asker FROM instrument_release_requests WHERE id = NEW.request_id;
  IF NEW.outcome IN ('approved', 'refused') AND NEW.decided_by = asker THEN
    RAISE EXCEPTION 'a release is decided by someone other than who asked for it' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome = 'withdrawn' AND NEW.decided_by <> asker THEN
    RAISE EXCEPTION 'only who asked for a release withdraws it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER instrument_release_decisions_two_person BEFORE INSERT ON "instrument_release_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.instrument_release_two_person();--> statement-breakpoint
CREATE TRIGGER instrument_release_decisions_append_only BEFORE UPDATE OR DELETE ON "instrument_release_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "instrument_release_decisions" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "instrument_release_decisions" TO sepehr_app;--> statement-breakpoint

-- === 4. Permissions, grants and configuration ====================================================
INSERT INTO "permissions" ("code") VALUES
  ('identity.request_financial_mobile_change'),
  ('identity.approve_financial_mobile_change'),
  ('instrument.request_release')
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Owner 1405/08/03: no role both asks for a release and approves it. accounting keeps the
-- approval; asking is a role of its own, granted to people who are not approvers. A third
-- approver of a signer's mobile change (besides the CEO and the system administrator), so the
-- mobile of either of those two can still be changed by two others: it approves only, never
-- asks, and holds nothing else; the owner assigns it on launch day.
INSERT INTO "roles" ("code", "name", "is_system") VALUES
  ('release_requester', 'درخواست‌دهنده استرداد چک و سفته', true),
  ('mobile_change_approver', 'تأییدکننده سوم تغییر شماره امضاکنندگان', true)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r."id", g."permission_code"
FROM (VALUES
  ('ceo', 'identity.request_financial_mobile_change'),
  ('ceo', 'identity.approve_financial_mobile_change'),
  ('system_admin', 'identity.request_financial_mobile_change'),
  ('system_admin', 'identity.approve_financial_mobile_change'),
  ('mobile_change_approver', 'identity.approve_financial_mobile_change'),
  ('release_requester', 'instrument.request_release')
) AS g("role_code", "permission_code")
JOIN "roles" r ON r."code" = g."role_code" AND r."deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('identity.financial_step_up', 'technical', true),
  ('notification.sms_credit_alert_rial', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('identity.financial_step_up', 'global',
   '{"enabled": false, "codeTtlSeconds": 120, "maxAttempts": 5, "lockoutSeconds": 900, "resendAfterSeconds": 60, "maxSendsPerHour": 3, "mobileChangeDelayHours": 24}',
   '2020-01-01T00:00:00Z', 'approved', 'کد پیامکی تأیید مالی، عددهای مالک (ADR-052، مهاجرت 0106)', now()),
  ('notification.sms_credit_alert_rial', 'global', '"0"', '2020-01-01T00:00:00Z', 'approved',
   'هشدار اعتبار کاوه‌نگار خاموش تا تنظیم دونفره (ADR-052، مهاجرت 0106)', now());
