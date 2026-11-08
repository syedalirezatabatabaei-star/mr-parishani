-- 0053 the notification module's SMS (task 6-4; doc 15 §7; 6.5). Hand-written (ADR-003).
-- Expand only: three new tables, two configuration keys and three permissions.

-- === Templates: versioned, append-only; the newest version of a code is in force ===========
CREATE TABLE "sms_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"audience" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_templates_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
	CONSTRAINT "sms_templates_version_check" CHECK ("version" >= 1),
	CONSTRAINT "sms_templates_audience_check"
	  CHECK ("audience" IN ('patient', 'borrower', 'guarantor', 'doctor', 'staff')),
	CONSTRAINT "sms_templates_category_check"
	  CHECK ("category" IN ('transactional', 'promotional', 'urgent')),
	CONSTRAINT "sms_templates_body_check" CHECK (length("body") BETWEEN 2 AND 1000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "sms_templates_version_key" ON "sms_templates" ("code", "version");--> statement-breakpoint
CREATE TRIGGER sms_templates_append_only BEFORE UPDATE OR DELETE ON "sms_templates"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "sms_templates" FROM sepehr_app;--> statement-breakpoint

-- === Each SMS: sent, scheduled for the allowed hours, held back, and its delivery ==========
CREATE TABLE "sms_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"template_id" uuid NOT NULL REFERENCES "sms_templates" ("id"),
	"category" text NOT NULL,
	"audience" text NOT NULL,
	"person_id" uuid,
	-- Normalized 9XXXXXXXXX (rule 24): operational data, never a log line (rule 30).
	"mobile" text NOT NULL,
	"text" text NOT NULL,
	"segments" integer NOT NULL,
	"cost_estimate_rial" bigint NOT NULL,
	"status" text NOT NULL,
	"suppressed_reason" text,
	"send_after" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	-- Put on the queue: once, and again only if still unsent long after (a lost job).
	"queued_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"delivery_status" text,
	"delivery_checked_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_dispatches_mobile_check" CHECK ("mobile" ~ '^9[0-9]{9}$'),
	CONSTRAINT "sms_dispatches_category_check"
	  CHECK ("category" IN ('transactional', 'promotional', 'urgent')),
	CONSTRAINT "sms_dispatches_segments_check"
	  CHECK ("segments" >= 1 AND "cost_estimate_rial" >= 0),
	CONSTRAINT "sms_dispatches_status_check" CHECK ("status" IN (
	  'pending', 'scheduled', 'sent', 'delivered', 'failed', 'suppressed', 'cancelled')),
	CONSTRAINT "sms_dispatches_suppressed_check"
	  CHECK (("status" = 'suppressed') = ("suppressed_reason" IS NOT NULL)),
	-- An urgent SMS is never held for the allowed hours.
	CONSTRAINT "sms_dispatches_urgent_check" CHECK ("category" <> 'urgent' OR "status" <> 'scheduled'),
	CONSTRAINT "sms_dispatches_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 200)
);--> statement-breakpoint
CREATE UNIQUE INDEX "sms_dispatches_key" ON "sms_dispatches" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "sms_dispatches_due_idx" ON "sms_dispatches" ("send_after") WHERE "status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "sms_dispatches_delivery_idx" ON "sms_dispatches" ("sent_at")
  WHERE "status" = 'sent';--> statement-breakpoint
CREATE INDEX "sms_dispatches_person_idx" ON "sms_dispatches" ("person_id", "created_at");--> statement-breakpoint
CREATE FUNCTION public.sms_dispatches_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'queued_at', 'sent_at', 'provider_message_id',
    'delivery_status', 'delivery_checked_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'sms dispatch % keeps its text, recipient and moment', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'scheduled' AND NEW.status IN ('pending', 'cancelled'))
    OR (OLD.status = 'pending' AND NEW.status IN ('sent', 'failed', 'cancelled'))
    OR (OLD.status = 'sent' AND NEW.status IN ('delivered', 'failed'))
  ) THEN
    RAISE EXCEPTION 'sms dispatch % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sms_dispatches_guard BEFORE UPDATE ON "sms_dispatches"
  FOR EACH ROW EXECUTE FUNCTION public.sms_dispatches_guard();--> statement-breakpoint
CREATE TRIGGER sms_dispatches_set_updated_at BEFORE UPDATE ON "sms_dispatches"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER sms_dispatches_no_delete BEFORE DELETE ON "sms_dispatches"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "sms_dispatches" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "queued_at", "sent_at", "provider_message_id", "delivery_status",
  "delivery_checked_at", "updated_at") ON "sms_dispatches" TO sepehr_app;--> statement-breakpoint

-- === Consent to promotional SMS (append-only; the newest row of a mobile is in force) =====
CREATE TABLE "sms_consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"mobile" text NOT NULL,
	"person_id" uuid,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_consents_mobile_check" CHECK ("mobile" ~ '^9[0-9]{9}$'),
	CONSTRAINT "sms_consents_action_check" CHECK ("action" IN ('consent', 'withdraw')),
	CONSTRAINT "sms_consents_source_check" CHECK ("source" IN ('panel', 'keyword', 'link'))
);--> statement-breakpoint
CREATE INDEX "sms_consents_mobile_idx" ON "sms_consents" ("mobile", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE TRIGGER sms_consents_append_only BEFORE UPDATE OR DELETE ON "sms_consents"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "sms_consents" FROM sepehr_app;--> statement-breakpoint

-- === Configuration (CLAUDE.md §4: changed by two people; 6.5's documented hours) ==========
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('notification.allowed_hours', 'business', true),
  ('notification.segment_cost_rial', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('notification.allowed_hours', 'global', '{"fromHour": 8, "toHour": 21}', '2020-01-01T00:00:00Z',
   'approved', 'پیش‌فرض مستند ۶.۵ (۸ تا ۲۱ تهران)؛ مهاجرت 0053', now()),
  ('notification.segment_cost_rial', 'global', '"0"', '2020-01-01T00:00:00Z', 'approved',
   'مقدار اولیه ۰؛ عدد را کارفرما می‌دهد (مهاجرت 0053)', now());--> statement-breakpoint

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES
  ('notification.manage_templates'), ('notification.read_dispatches'),
  ('notification.manage_consent');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('system_admin', 'notification.manage_templates'),
  ('strategy_manager', 'notification.manage_templates'),
  ('system_admin', 'notification.read_dispatches'),
  ('strategy_manager', 'notification.read_dispatches'),
  ('accounting', 'notification.read_dispatches'),
  ('support', 'notification.read_dispatches'),
  ('support', 'notification.manage_consent')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
