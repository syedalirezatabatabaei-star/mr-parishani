-- 0032 physical deliveries and guarantee instruments (task 4-2; doc 12 §3). Expand only:
-- three new tables, their rules, three permissions, one configuration key.
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"delivery_id" uuid,
	"item_id" uuid,
	"kind" text NOT NULL,
	"issuer_person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"guarantor_id" uuid,
	"amount_rial" bigint NOT NULL,
	"due_on" date,
	"bank_name" text,
	"number_enc" text NOT NULL,
	"number_bidx" text NOT NULL,
	"number_last4" text NOT NULL,
	"sayad_registered_confirmed" boolean DEFAULT false NOT NULL,
	"sayad_confirmed_at" timestamp with time zone,
	"sayad_confirmed_by" uuid,
	"status" text DEFAULT 'received' NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "instruments_amount_check" CHECK ("instruments"."amount_rial" > 0),
	CONSTRAINT "instruments_role_check" CHECK (("instruments"."role" = 'guarantor') = ("instruments"."guarantor_id" IS NOT NULL)),
	CONSTRAINT "instruments_sayad_check" CHECK ("instruments"."sayad_registered_confirmed" = ("instruments"."sayad_confirmed_at" IS NOT NULL)
          AND (NOT "instruments"."sayad_registered_confirmed" OR "instruments"."kind" = 'cheque'))
);
--> statement-breakpoint
CREATE TABLE "physical_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"status" text DEFAULT 'awaiting_send' NOT NULL,
	"method" text,
	"tracking_code" text,
	"sent_at" timestamp with time zone,
	"received_by" uuid,
	"received_at" timestamp with time zone,
	"archive_location" text,
	"return_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "physical_deliveries_received_check" CHECK (("physical_deliveries"."status" IN ('awaiting_send', 'sent')) = ("physical_deliveries"."received_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "physical_delivery_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'expected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_delivery_id_physical_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."physical_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_item_id_physical_delivery_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."physical_delivery_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "physical_delivery_items" ADD CONSTRAINT "physical_delivery_items_delivery_id_physical_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."physical_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instruments_application_idx" ON "instruments" USING btree ("credit_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_number_key" ON "instruments" USING btree ("kind","number_bidx") WHERE "instruments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_item_key" ON "instruments" USING btree ("item_id") WHERE "instruments"."item_id" IS NOT NULL AND "instruments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "physical_deliveries_application_idx" ON "physical_deliveries" USING btree ("credit_application_id");--> statement-breakpoint
CREATE INDEX "physical_delivery_items_delivery_idx" ON "physical_delivery_items" USING btree ("delivery_id");--> statement-breakpoint
-- === Hand-written (task 4-2, doc 12 §3): expand only; no existing table changes. =========
ALTER TABLE "physical_deliveries" ADD CONSTRAINT "physical_deliveries_values_check" CHECK (
  "status" IN ('awaiting_send', 'sent', 'received', 'verified', 'incomplete', 'returned', 'archived', 'released')
  AND ("method" IS NULL OR "method" IN ('courier', 'post', 'in_person'))
  AND (("status" IN ('archived', 'released')) = ("archive_location" IS NOT NULL))
  AND (("status" = 'returned') = ("return_reason" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "physical_delivery_items" ADD CONSTRAINT "physical_delivery_items_values_check" CHECK (
  "kind" IN ('signed_contract', 'cheque', 'promissory_note', 'other')
  AND "status" IN ('expected', 'received', 'missing')
);--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_values_check" CHECK (
  "kind" IN ('cheque', 'promissory_note')
  AND "role" IN ('borrower', 'guarantor')
  AND "status" IN ('received', 'verified', 'held', 'released', 'presented', 'cleared', 'bounced', 'legal_action')
  -- The number never in clear: encrypted (v1.<iv>.<…>) and indexed (v1.<hmac>).
  AND "number_enc" LIKE 'v1.%' AND "number_bidx" LIKE 'v1.%'
  AND length("number_last4") BETWEEN 1 AND 4
  -- A cheque is checked only once its issuer registered it in Sayad (doc 12 §3).
  AND ("kind" <> 'cheque' OR "status" = 'received' OR "sayad_registered_confirmed")
);--> statement-breakpoint

-- A delivery: the life of the glossary; who it is for never changes.
CREATE FUNCTION public.physical_deliveries_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.credit_application_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.credit_application_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'delivery % can only change its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'awaiting_send' AND NEW.status IN ('sent', 'received'))
    OR (OLD.status = 'sent' AND NEW.status IN ('received', 'returned'))
    OR (OLD.status = 'received' AND NEW.status IN ('verified', 'incomplete', 'returned'))
    OR (OLD.status = 'incomplete' AND NEW.status IN ('verified', 'returned'))
    OR (OLD.status = 'verified' AND NEW.status = 'archived')
    OR (OLD.status = 'archived' AND NEW.status = 'released')
  ) THEN
    RAISE EXCEPTION 'delivery % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER physical_deliveries_guard_change BEFORE UPDATE ON "physical_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.physical_deliveries_guard_change();--> statement-breakpoint
CREATE TRIGGER physical_deliveries_set_updated_at BEFORE UPDATE ON "physical_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER physical_deliveries_no_delete BEFORE DELETE ON "physical_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- An item: only whether it came changes.
CREATE FUNCTION public.physical_delivery_items_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.delivery_id, NEW.kind, NEW.label, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.delivery_id, OLD.kind, OLD.label, OLD.created_at) THEN
    RAISE EXCEPTION 'delivery item % can only change its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER physical_delivery_items_guard_change BEFORE UPDATE ON "physical_delivery_items"
  FOR EACH ROW EXECUTE FUNCTION public.physical_delivery_items_guard_change();--> statement-breakpoint
CREATE TRIGGER physical_delivery_items_set_updated_at BEFORE UPDATE ON "physical_delivery_items"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER physical_delivery_items_no_delete BEFORE DELETE ON "physical_delivery_items"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- An instrument: its life (doc 12 §3); what it is, whose and its number never change; the
-- Sayad confirmation is given once.
CREATE FUNCTION public.instruments_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'sayad_registered_confirmed', 'sayad_confirmed_at',
                                 'sayad_confirmed_by', 'notes', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'instrument % can only change its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sayad_registered_confirmed AND NOT NEW.sayad_registered_confirmed THEN
    RAISE EXCEPTION 'instrument % was confirmed in Sayad', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'received' AND NEW.status = 'verified')
    OR (OLD.status = 'verified' AND NEW.status = 'held')
    OR (OLD.status = 'held' AND NEW.status IN ('released', 'presented'))
    OR (OLD.status = 'presented' AND NEW.status IN ('cleared', 'bounced'))
    OR (OLD.status = 'bounced' AND NEW.status = 'legal_action')
  ) THEN
    RAISE EXCEPTION 'instrument % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER instruments_guard_change BEFORE UPDATE ON "instruments"
  FOR EACH ROW EXECUTE FUNCTION public.instruments_guard_change();--> statement-breakpoint
CREATE TRIGGER instruments_set_updated_at BEFORE UPDATE ON "instruments"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER instruments_no_delete BEFORE DELETE ON "instruments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

REVOKE UPDATE ON "physical_deliveries" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "method", "tracking_code", "sent_at", "received_by", "received_at",
              "archive_location", "return_reason", "updated_at")
  ON "physical_deliveries" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "physical_delivery_items" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "updated_at") ON "physical_delivery_items" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "instruments" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "sayad_registered_confirmed", "sayad_confirmed_at", "sayad_confirmed_by",
              "notes", "updated_at")
  ON "instruments" TO sepehr_app;--> statement-breakpoint

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES
  ('instrument.manage'),
  ('instrument.read'),
  ('instrument.view_numbers');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('case_completion', 'instrument.manage'),
  ('case_completion', 'instrument.read'),
  ('case_completion', 'instrument.view_numbers'),
  ('credit_manager', 'instrument.read'),
  ('accounting', 'instrument.read'),
  ('auditor', 'instrument.read')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration =========================================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('instrument.sms_templates', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('instrument.sms_templates', 'global',
   '{"deliveryIncomplete": "مدارک پرونده اعتباری شما در سپهر سلامتی کامل نرسیده است. موارد کم: {items}. لطفاً ارسال کنید."}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، سند ۱۲ §۳ (مهاجرت 0032)', now());
