-- 0049 payout orders of an approved statement (task 5-5 [financial]; doc 06 §5 steps 3–6, §8
-- test 6; doc 14 الف, ث; doc 02 §4 "doctor's statement paid"; owner 1405/07/14: paid to each
-- center's Sheba, one order per center). Hand-written (ADR-003). Expand only: two new tables
-- and two permissions; no existing table, column or constraint changes.

-- === One order per center of an approved statement (settlement module) ====================
CREATE TABLE "payout_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"statement_id" uuid NOT NULL REFERENCES "settlement_statements" ("id"),
	-- The catalog's center (no foreign key across modules): whose Sheba is paid.
	"center_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"amount_rial" bigint NOT NULL,
	-- A snapshot when issued (rule 27: encrypted; a later change of Sheba does not move it).
	"iban_enc" text NOT NULL,
	"iban_last4" text NOT NULL,
	"account_holder" text,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_by" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The bank file it went in (the same file can be fetched again).
	"export_batch_id" uuid,
	"exported_by" uuid,
	"exported_at" timestamp with time zone,
	-- The bank's tracking number: recorded by one, confirmed by another.
	"bank_tracking_ref" text,
	"paid_on" date,
	"tracking_recorded_by" uuid,
	"tracking_recorded_at" timestamp with time zone,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"journal_entry_id" uuid,
	-- Returned by the bank, or a wrong Sheba: asked by one, done by another; then reissued.
	"fail_requested_by" uuid,
	"fail_requested_at" timestamp with time zone,
	"failure_reason" text,
	"failed_by" uuid,
	"failed_at" timestamp with time zone,
	"replaces_payout_id" uuid REFERENCES "payout_orders" ("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_orders_amount_check" CHECK ("amount_rial" > 0),
	CONSTRAINT "payout_orders_status_check"
	  CHECK ("status" IN ('issued', 'sent_to_bank', 'confirmed', 'failed')),
	CONSTRAINT "payout_orders_tracking_check" CHECK (
	  "bank_tracking_ref" IS NULL OR length(trim("bank_tracking_ref")) >= 4
	),
	-- doc 06 §8 test 6: never one person alone.
	CONSTRAINT "payout_orders_two_people_check" CHECK (
	  ("confirmed_by" IS NULL OR "confirmed_by" IS DISTINCT FROM "tracking_recorded_by")
	  AND ("failed_by" IS NULL OR "failed_by" IS DISTINCT FROM "fail_requested_by")
	),
	CONSTRAINT "payout_orders_confirmed_check" CHECK (
	  ("status" = 'confirmed') = ("journal_entry_id" IS NOT NULL)
	  AND ("status" <> 'confirmed' OR ("bank_tracking_ref" IS NOT NULL AND "paid_on" IS NOT NULL
	       AND "tracking_recorded_by" IS NOT NULL AND "confirmed_by" IS NOT NULL
	       AND "confirmed_at" IS NOT NULL))
	),
	CONSTRAINT "payout_orders_failed_check" CHECK (
	  ("status" = 'failed') = ("failed_at" IS NOT NULL)
	  AND ("status" <> 'failed' OR "failed_by" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX "payout_orders_live_key" ON "payout_orders" ("statement_id", "center_id")
  WHERE "status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_orders_tracking_key" ON "payout_orders" ("bank_tracking_ref")
  WHERE "status" <> 'failed' AND "bank_tracking_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_orders_journal_key" ON "payout_orders" ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "payout_orders_status_idx" ON "payout_orders" ("status", "issued_at");--> statement-breakpoint
CREATE INDEX "payout_orders_batch_idx" ON "payout_orders" ("export_batch_id");--> statement-breakpoint
CREATE FUNCTION public.payout_orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'export_batch_id', 'exported_by', 'exported_at',
    'bank_tracking_ref', 'paid_on', 'tracking_recorded_by', 'tracking_recorded_at',
    'confirmed_by', 'confirmed_at', 'journal_entry_id', 'fail_requested_by',
    'fail_requested_at', 'failure_reason', 'failed_by', 'failed_at', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'payout order % keeps its statement, center, amount and Sheba', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('confirmed', 'failed') AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'payout order % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'issued' AND NEW.status IN ('sent_to_bank', 'failed'))
    OR (OLD.status = 'sent_to_bank' AND NEW.status IN ('confirmed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'payout order % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payout_orders_guard BEFORE UPDATE ON "payout_orders"
  FOR EACH ROW EXECUTE FUNCTION public.payout_orders_guard();--> statement-breakpoint
CREATE TRIGGER payout_orders_set_updated_at BEFORE UPDATE ON "payout_orders"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER payout_orders_no_delete BEFORE DELETE ON "payout_orders"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "payout_orders" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "export_batch_id", "exported_by", "exported_at", "bank_tracking_ref",
  "paid_on", "tracking_recorded_by", "tracking_recorded_at", "confirmed_by", "confirmed_at",
  "journal_entry_id", "fail_requested_by", "fail_requested_at", "failure_reason", "failed_by",
  "failed_at", "updated_at") ON "payout_orders" TO sepehr_app;--> statement-breakpoint

-- === What an order pays from each doctor node (append-only) ===============================
CREATE TABLE "payout_order_nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"payout_id" uuid NOT NULL REFERENCES "payout_orders" ("id"),
	"doctor_node_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_order_nodes_amount_check" CHECK ("amount_rial" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "payout_order_nodes_key" ON "payout_order_nodes" ("payout_id", "doctor_node_id");--> statement-breakpoint
CREATE TRIGGER payout_order_nodes_append_only BEFORE UPDATE OR DELETE ON "payout_order_nodes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "payout_order_nodes" FROM sepehr_app;--> statement-breakpoint

-- === Permissions (accounting: review, approve and pay — each step two people) ==============
INSERT INTO "permissions" ("code") VALUES
  ('settlement.review_statement'), ('settlement.export_payouts');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('accounting', 'settlement.review_statement'),
  ('accounting', 'settlement.export_payouts')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
