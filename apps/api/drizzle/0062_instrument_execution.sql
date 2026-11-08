-- Task 6-8 [مالی] (doc 15 §6; owner 1405/07/16): executing a guarantee instrument and
-- releasing it after full settlement. Add-only: one table, one append-only table, a
-- configuration key, five permissions and their grants, two SMS templates. instruments,
-- payments and physical_deliveries gain nothing: only their status moves, by the service,
-- along 0032's existing paths. The ledger, the purse and the installments are untouched.

-- === Executions: proposed, approved by two others, presented, cleared or bounced ========
CREATE TABLE "instrument_executions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"instrument_id" uuid NOT NULL REFERENCES "instruments" ("id"),
	"case_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	-- The instrument's amount, never more than what was owed when proposed (owner ۴).
	"amount_rial" bigint NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" uuid NOT NULL,
	"proposal_reason" text NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collection_approved_by" uuid,
	"collection_approved_at" timestamp with time zone,
	"finance_approved_by" uuid,
	"finance_approved_at" timestamp with time zone,
	"rejected_by" uuid,
	"reject_reason" text,
	"outcome_by" uuid,
	"outcome_on" date,
	-- The bank's tracking number of the credit, never the cheque's own number (rule 27).
	"bank_ref" text,
	"bounce_reason" text,
	"bounce_note" text,
	"payment_id" uuid REFERENCES "payments" ("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_executions_status_check"
	  CHECK ("status" IN ('proposed', 'presented', 'cleared', 'bounced', 'rejected')),
	CONSTRAINT "instrument_executions_amount_check" CHECK ("amount_rial" > 0),
	-- Owner (۳): three different people.
	CONSTRAINT "instrument_executions_three_people_check" CHECK (
	  ("collection_approved_by" IS NULL OR "collection_approved_by" <> "proposed_by")
	  AND ("finance_approved_by" IS NULL OR "finance_approved_by" <> "proposed_by")
	  AND ("finance_approved_by" IS NULL OR "collection_approved_by" IS NULL
	       OR "finance_approved_by" <> "collection_approved_by")),
	CONSTRAINT "instrument_executions_presented_check" CHECK (
	  "status" NOT IN ('presented', 'cleared', 'bounced')
	  OR ("collection_approved_by" IS NOT NULL AND "finance_approved_by" IS NOT NULL)),
	CONSTRAINT "instrument_executions_cleared_check"
	  CHECK (("status" = 'cleared') = ("payment_id" IS NOT NULL)),
	CONSTRAINT "instrument_executions_bounced_check"
	  CHECK (("status" = 'bounced') = ("bounce_reason" IS NOT NULL)),
	CONSTRAINT "instrument_executions_bounce_reason_check" CHECK ("bounce_reason" IS NULL
	  OR "bounce_reason" IN ('insufficient_funds', 'signature_mismatch', 'account_closed', 'other')),
	CONSTRAINT "instrument_executions_rejected_check"
	  CHECK (("status" = 'rejected') = ("reject_reason" IS NOT NULL)),
	CONSTRAINT "instrument_executions_outcome_check"
	  CHECK (("status" IN ('cleared', 'bounced')) = ("outcome_on" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_executions_open_key" ON "instrument_executions" ("instrument_id")
  WHERE "status" IN ('proposed', 'presented');--> statement-breakpoint
CREATE INDEX "instrument_executions_status_idx" ON "instrument_executions" ("status");--> statement-breakpoint
CREATE FUNCTION public.instrument_executions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'collection_approved_by', 'collection_approved_at',
    'finance_approved_by', 'finance_approved_at', 'rejected_by', 'reject_reason', 'outcome_by',
    'outcome_on', 'bank_ref', 'bounce_reason', 'bounce_note', 'payment_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'instrument execution % keeps what was proposed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Each approval is given once.
  IF (OLD.collection_approved_by IS NOT NULL
      AND NEW.collection_approved_by IS DISTINCT FROM OLD.collection_approved_by)
  OR (OLD.finance_approved_by IS NOT NULL
      AND NEW.finance_approved_by IS DISTINCT FROM OLD.finance_approved_by) THEN
    RAISE EXCEPTION 'instrument execution % was approved once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('presented', 'rejected'))
    OR (OLD.status = 'presented' AND NEW.status IN ('cleared', 'bounced'))
  ) THEN
    RAISE EXCEPTION 'instrument execution % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status NOT IN ('proposed', 'presented') THEN
    RAISE EXCEPTION 'instrument execution % is %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER instrument_executions_guard BEFORE UPDATE ON "instrument_executions"
  FOR EACH ROW EXECUTE FUNCTION public.instrument_executions_guard();--> statement-breakpoint
CREATE TRIGGER instrument_executions_set_updated_at BEFORE UPDATE ON "instrument_executions"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER instrument_executions_no_delete BEFORE DELETE ON "instrument_executions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "instrument_executions" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "instrument_executions" TO sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "collection_approved_by", "collection_approved_at", "finance_approved_by",
  "finance_approved_at", "rejected_by", "reject_reason", "outcome_by", "outcome_on", "bank_ref",
  "bounce_reason", "bounce_note", "payment_id", "updated_at")
  ON "instrument_executions" TO sepehr_app;--> statement-breakpoint

-- === Releases after full settlement: one row each, append-only ==========================
CREATE TABLE "instrument_releases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"instrument_id" uuid NOT NULL REFERENCES "instruments" ("id"),
	"case_id" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sms_dispatch_id" uuid REFERENCES "sms_dispatches" ("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_releases_instrument_key" ON "instrument_releases" ("instrument_id");--> statement-breakpoint
CREATE TRIGGER instrument_releases_append_only BEFORE UPDATE OR DELETE ON "instrument_releases"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "instrument_releases" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "instrument_releases" TO sepehr_app;--> statement-breakpoint

-- === Configuration (owner: every threshold in the panel) =================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('instrument.execution_min_days_past_due', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('instrument.execution_min_days_past_due', 'global', '0', '2020-01-01T00:00:00Z', 'approved',
   'قاعده ثابت: مقدار اولیه ۰ (هر پرونده معوق)؛ مهاجرت 0062', now());--> statement-breakpoint

-- === Permissions (owner ۳: proposer, collection manager, finance) =======================
INSERT INTO "permissions" ("code") VALUES
  ('instrument.propose_execution'), ('instrument.approve_execution_collection'),
  ('instrument.approve_execution_finance'), ('instrument.record_outcome'),
  ('instrument.approve_release');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('collection', 'instrument.propose_execution'),
  ('collection_manager', 'instrument.approve_execution_collection'),
  ('accounting', 'instrument.approve_execution_finance'),
  ('accounting', 'instrument.record_outcome'),
  ('accounting', 'instrument.approve_release')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === SMS: the instrument is ready to be picked up (name only; never a number or amount) ===
INSERT INTO "sms_templates" ("code", "version", "audience", "category", "body", "reason") VALUES
  ('instrument.release_ready_borrower', 1, 'borrower', 'transactional',
   '{{name}} گرامی، مدرک ضمانت شما آماده تحویل است.', 'تسک ۶-۸؛ مهاجرت 0062'),
  ('instrument.release_ready_guarantor', 1, 'guarantor', 'transactional',
   '{{name}} گرامی، مدرک ضمانت شما آماده تحویل است.', 'تسک ۶-۸؛ مهاجرت 0062');
