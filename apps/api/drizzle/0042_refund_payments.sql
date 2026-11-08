-- 0042 paying refunds out by bank (task 4-8 [financial], part 4; ADR-036; owner 1405/07/14):
-- Dr the borrower's fee.refund_payable or downpayment.refund_payable, Cr bank.settlement.
-- Hand-written (ADR-003). Expand only: one new table and two permissions.

-- === Refund payments, recorded by one person and approved by another (contract module) =====
CREATE TABLE "refund_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"borrower_person_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"amount_rial" bigint NOT NULL,
	-- The bank's tracking number, normalized (digits); unique among requests not rejected.
	"bank_reference" text NOT NULL,
	"paid_on" date NOT NULL,
	-- The client's key (rule 5): the same request sent twice records one.
	"idempotency_key" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_payments_account_check"
	  CHECK ("account_code" IN ('fee.refund_payable', 'downpayment.refund_payable')),
	CONSTRAINT "refund_payments_amount_check" CHECK ("amount_rial" > 0),
	CONSTRAINT "refund_payments_reference_check" CHECK (length(trim("bank_reference")) >= 4),
	CONSTRAINT "refund_payments_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 200),
	CONSTRAINT "refund_payments_reason_check" CHECK (length(trim("reason")) >= 3),
	CONSTRAINT "refund_payments_status_check" CHECK ("status" IN ('requested', 'approved', 'rejected')),
	CONSTRAINT "refund_payments_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "refund_payments_decision_check" CHECK (
	  ("status" = 'requested' AND "decided_by" IS NULL AND "decided_at" IS NULL
	     AND "journal_entry_id" IS NULL)
	  OR ("status" = 'approved' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL
	     AND "journal_entry_id" IS NOT NULL)
	  OR ("status" = 'rejected' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL
	     AND "decision_reason" IS NOT NULL AND "journal_entry_id" IS NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX "refund_payments_key_key" ON "refund_payments" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_payments_reference_key" ON "refund_payments" ("bank_reference")
  WHERE "status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "refund_payments_journal_key" ON "refund_payments" ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "refund_payments_account_idx"
  ON "refund_payments" ("entity_id", "borrower_person_id", "account_code");--> statement-breakpoint
CREATE INDEX "refund_payments_application_idx" ON "refund_payments" ("credit_application_id");--> statement-breakpoint
CREATE FUNCTION public.refund_payments_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_reason',
                                 'journal_entry_id', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'refund payment % can only be decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'requested'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'refund payment % was decided', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER refund_payments_guard BEFORE UPDATE ON "refund_payments"
  FOR EACH ROW EXECUTE FUNCTION public.refund_payments_guard();--> statement-breakpoint
CREATE TRIGGER refund_payments_set_updated_at BEFORE UPDATE ON "refund_payments"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER refund_payments_no_delete BEFORE DELETE ON "refund_payments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "refund_payments" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_reason", "journal_entry_id",
  "updated_at") ON "refund_payments" TO sepehr_app;--> statement-breakpoint

-- === Permissions (accounting records and approves; never the same person) ==================
INSERT INTO "permissions" ("code") VALUES
  ('contract.request_refund_payment'), ('contract.approve_refund_payment');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('accounting', 'contract.request_refund_payment'),
  ('accounting', 'contract.approve_refund_payment')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
