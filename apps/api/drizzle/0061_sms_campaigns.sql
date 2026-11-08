-- Task 6-5 (doc 15 §7; owner 1405/07/16): scheduled and bulk SMS. Add-only: two tables,
-- three configuration keys, three permissions and their grants. Nothing existing changes.

-- === Campaigns: a named filter, a locked template, approved always by a second person ===
CREATE TABLE "sms_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"audience" text NOT NULL,
	"filter_code" text NOT NULL,
	"filter_params" jsonb NOT NULL,
	"template_id" uuid NOT NULL REFERENCES "sms_templates" ("id"),
	"category" text NOT NULL,
	-- Locked when made: above it only a holder of approve_campaigns approves.
	"two_person_threshold" integer NOT NULL,
	"send_from" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	-- Fixed at approval, with the recipients (doc 15 test 8).
	"recipient_count" integer,
	"excluded" jsonb,
	"cost_estimate_rial" bigint,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"last_batch_at" timestamp with time zone,
	"stopped_by" uuid,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_campaigns_audience_check" CHECK ("audience" IN ('patient', 'borrower', 'guarantor')),
	CONSTRAINT "sms_campaigns_category_check" CHECK ("category" IN ('transactional', 'promotional')),
	CONSTRAINT "sms_campaigns_status_check" CHECK ("status" IN (
	  'draft', 'sending', 'paused', 'stopped', 'completed', 'cancelled')),
	-- Owner (ج): always two people, below the threshold too.
	CONSTRAINT "sms_campaigns_two_person_check"
	  CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by"),
	CONSTRAINT "sms_campaigns_approved_check" CHECK (
	  "status" IN ('draft', 'cancelled')
	  OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL AND "recipient_count" IS NOT NULL
	      AND "excluded" IS NOT NULL AND "cost_estimate_rial" IS NOT NULL)),
	CONSTRAINT "sms_campaigns_threshold_check" CHECK ("two_person_threshold" >= 0),
	CONSTRAINT "sms_campaigns_counts_check"
	  CHECK (coalesce("recipient_count", 0) >= 0 AND coalesce("cost_estimate_rial", 0) >= 0)
);--> statement-breakpoint
CREATE INDEX "sms_campaigns_sending_idx" ON "sms_campaigns" ("status")
  WHERE "status" = 'sending';--> statement-breakpoint
CREATE FUNCTION public.sms_campaigns_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'recipient_count', 'excluded', 'cost_estimate_rial',
    'approved_by', 'approved_at', 'last_batch_at', 'stopped_by', 'stopped_at', 'stop_reason',
    'completed_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'sms campaign % keeps its filter, template and creator', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- The approval and its snapshot are set once, leaving the draft.
  IF OLD.status <> 'draft' AND (
       NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.recipient_count IS DISTINCT FROM OLD.recipient_count
    OR NEW.excluded IS DISTINCT FROM OLD.excluded
    OR NEW.cost_estimate_rial IS DISTINCT FROM OLD.cost_estimate_rial) THEN
    RAISE EXCEPTION 'sms campaign % was approved once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('sending', 'cancelled'))
    OR (OLD.status = 'sending' AND NEW.status IN ('paused', 'stopped', 'completed'))
    OR (OLD.status = 'paused' AND NEW.status IN ('sending', 'stopped'))
  ) THEN
    RAISE EXCEPTION 'sms campaign % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sms_campaigns_guard BEFORE UPDATE ON "sms_campaigns"
  FOR EACH ROW EXECUTE FUNCTION public.sms_campaigns_guard();--> statement-breakpoint
CREATE TRIGGER sms_campaigns_set_updated_at BEFORE UPDATE ON "sms_campaigns"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER sms_campaigns_no_delete BEFORE DELETE ON "sms_campaigns"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "sms_campaigns" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "sms_campaigns" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "recipient_count", "excluded", "cost_estimate_rial", "approved_by",
  "approved_at", "last_batch_at", "stopped_by", "stopped_at", "stop_reason", "completed_at",
  "updated_at") ON "sms_campaigns" TO sepehr_app;--> statement-breakpoint

-- === Recipients: the snapshot of the approval; one message each ==========================
CREATE TABLE "sms_campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campaign_id" uuid NOT NULL REFERENCES "sms_campaigns" ("id"),
	"person_id" uuid,
	-- Normalized 9XXXXXXXXX (rule 24): operational data, never a log line (rule 30).
	"mobile" text NOT NULL,
	"values" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cancel_reason" text,
	"dispatch_id" uuid REFERENCES "sms_dispatches" ("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_campaign_recipients_mobile_check" CHECK ("mobile" ~ '^9[0-9]{9}$'),
	CONSTRAINT "sms_campaign_recipients_status_check"
	  CHECK ("status" IN ('pending', 'dispatched', 'cancelled')),
	CONSTRAINT "sms_campaign_recipients_dispatch_check"
	  CHECK (("status" = 'dispatched') = ("dispatch_id" IS NOT NULL)),
	CONSTRAINT "sms_campaign_recipients_cancel_check"
	  CHECK (("status" = 'cancelled') = ("cancel_reason" IS NOT NULL)),
	CONSTRAINT "sms_campaign_recipients_reason_check"
	  CHECK ("cancel_reason" IS NULL OR "cancel_reason" IN ('stopped', 'held'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "sms_campaign_recipients_mobile_key"
  ON "sms_campaign_recipients" ("campaign_id", "mobile");--> statement-breakpoint
CREATE INDEX "sms_campaign_recipients_pending_idx" ON "sms_campaign_recipients" ("campaign_id")
  WHERE "status" = 'pending';--> statement-breakpoint
CREATE FUNCTION public.sms_campaign_recipients_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'cancel_reason', 'dispatch_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'campaign recipient % keeps its snapshot', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'campaign recipient % is %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sms_campaign_recipients_guard BEFORE UPDATE ON "sms_campaign_recipients"
  FOR EACH ROW EXECUTE FUNCTION public.sms_campaign_recipients_guard();--> statement-breakpoint
CREATE TRIGGER sms_campaign_recipients_set_updated_at BEFORE UPDATE ON "sms_campaign_recipients"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER sms_campaign_recipients_no_delete BEFORE DELETE ON "sms_campaign_recipients"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "sms_campaign_recipients" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "sms_campaign_recipients" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "cancel_reason", "dispatch_id", "updated_at")
  ON "sms_campaign_recipients" TO sepehr_app;--> statement-breakpoint

-- === Configuration: in the panel (6.6, 6.8; owner) =====================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('notification.bulk_two_person_threshold', 'business', true),
  ('notification.campaign_batch_per_minute', 'technical', true),
  ('notification.promotional_campaigns_enabled', 'technical', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('notification.bulk_two_person_threshold', 'global', '200', '2020-01-01T00:00:00Z', 'approved',
   'پیش‌فرض مستند ۶.۶ (۲۰۰ گیرنده)؛ مهاجرت 0061', now()),
  ('notification.campaign_batch_per_minute', 'global', '100', '2020-01-01T00:00:00Z', 'approved',
   'مالک ۱۴۰۵/۰۷/۱۶: ۱۰۰ در دقیقه؛ سقف واقعی از قرارداد کاوه‌نگار (۶.۸)؛ مهاجرت 0061', now()),
  ('notification.promotional_campaigns_enabled', 'global', 'false', '2020-01-01T00:00:00Z', 'approved',
   'مالک ۱۴۰۵/۰۷/۱۶: خاموش تا ساخت لغو اشتراک؛ مهاجرت 0061', now());--> statement-breakpoint

-- === Permissions (owner ب) =============================================================
INSERT INTO "permissions" ("code") VALUES
  ('notification.manage_campaigns'), ('notification.approve_campaigns'),
  ('notification.schedule_sms');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('strategy_manager', 'notification.manage_campaigns'),
  ('strategy_manager', 'notification.approve_campaigns'),
  ('support', 'notification.manage_campaigns'),
  ('support', 'notification.schedule_sms'),
  ('collection', 'notification.schedule_sms')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
