-- 0006 credit purse (task 1-2; doc 02 §3–4; ADR-018). Hand-written (ADR-003: explicit SQL
-- in financial modules); written only by the wallet module.

-- Purse accounts and the borrower's debt are kept per case, not per person (task 1-2
-- decision): a borrower with two cases has two purses and two debts. Expand only.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner_check";--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_check" CHECK (
  ("owner_type" = 'company' AND "owner_id" IS NULL)
  OR ("owner_type" IN ('borrower', 'doctor', 'center', 'purse') AND "owner_id" IS NOT NULL)
);--> statement-breakpoint

-- One credit purse (کیف اعتبار) per case: the row every purse operation locks FOR UPDATE
-- (doc 02 §1.6). It never holds a balance (rule 4); balances are sums of ledger entries.
-- The allowed center, doctor and treatment field are fixed at approval (doc 02 §4).
CREATE TABLE "credit_purses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" text NOT NULL REFERENCES "legal_entities" ("code"),
	"case_id" uuid NOT NULL,
	"credit_application_id" uuid,
	"borrower_person_id" uuid NOT NULL,
	"approved_amount_rial" bigint NOT NULL,
	"center_node_id" uuid NOT NULL,
	"doctor_node_id" uuid NOT NULL,
	"treatment_field_code" text NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"funded_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_purses_case_key" UNIQUE ("case_id"),
	CONSTRAINT "credit_purses_amount_check" CHECK ("approved_amount_rial" > 0),
	CONSTRAINT "credit_purses_field_check" CHECK ("treatment_field_code" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "credit_purses_status_check" CHECK ("status" IN ('approved', 'funded', 'closed')),
	CONSTRAINT "credit_purses_dates_check" CHECK (
	  ("status" = 'approved' AND "funded_at" IS NULL AND "closed_at" IS NULL)
	  OR ("status" = 'funded' AND "funded_at" IS NOT NULL AND "closed_at" IS NULL)
	  OR ("status" = 'closed' AND "closed_at" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE TRIGGER credit_purses_set_updated_at BEFORE UPDATE ON "credit_purses"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER credit_purses_no_delete BEFORE DELETE ON "credit_purses"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- Only the state may change, and only forward (rule 8): approved → funded → closed, or
-- approved → closed. Nothing else about a purse is ever rewritten.
CREATE FUNCTION public.credit_purses_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.id, NEW.entity_id, NEW.case_id, NEW.credit_application_id, NEW.borrower_person_id,
      NEW.approved_amount_rial, NEW.center_node_id, NEW.doctor_node_id,
      NEW.treatment_field_code, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.entity_id, OLD.case_id, OLD.credit_application_id, OLD.borrower_person_id,
      OLD.approved_amount_rial, OLD.center_node_id, OLD.doctor_node_id,
      OLD.treatment_field_code, OLD.created_at) THEN
    RAISE EXCEPTION 'credit purse % can only change its state', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'approved' AND NEW.status IN ('funded', 'closed'))
    OR (OLD.status = 'funded' AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'credit purse % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.funded_at IS NOT NULL AND NEW.funded_at IS DISTINCT FROM OLD.funded_at THEN
    RAISE EXCEPTION 'funded_at of credit purse % is fixed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_purses_guard BEFORE UPDATE ON "credit_purses"
  FOR EACH ROW EXECUTE FUNCTION public.credit_purses_guard();--> statement-breakpoint
REVOKE UPDATE ON "credit_purses" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "funded_at", "closed_at") ON "credit_purses" TO sepehr_app;--> statement-breakpoint

-- Every purse operation, append-only. A reservation's state (open, consumed, finalized,
-- held) is derived from these rows, never stored; a reversal is a new row pointing to the
-- one it reverses. `authorization_id` is the external service authorization (task 1-2
-- decision: the service module does not exist yet).
CREATE TABLE "purse_operations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"purse_id" uuid NOT NULL REFERENCES "credit_purses" ("id"),
	"kind" text NOT NULL,
	"authorization_id" text,
	"doctor_node_id" uuid,
	"amount_rial" bigint,
	"journal_entry_id" uuid REFERENCES "journal_entries" ("id"),
	"reverses_operation_id" uuid REFERENCES "purse_operations" ("id"),
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purse_operations_idempotency_key_key" UNIQUE ("idempotency_key"),
	CONSTRAINT "purse_operations_reverses_key" UNIQUE ("reverses_operation_id"),
	CONSTRAINT "purse_operations_kind_check" CHECK ("kind" IN (
	  'approve', 'charge', 'reserve', 'cancel_reservation', 'register_service',
	  'finalize', 'cancel_unused', 'hold', 'release', 'reversal')),
	CONSTRAINT "purse_operations_amount_check" CHECK ("amount_rial" IS NULL OR "amount_rial" > 0),
	CONSTRAINT "purse_operations_shape_check" CHECK (
	  ("kind" IN ('hold', 'release') AND "amount_rial" IS NULL AND "journal_entry_id" IS NULL
	     AND "authorization_id" IS NOT NULL)
	  OR ("kind" = 'reversal' AND "reverses_operation_id" IS NOT NULL AND "journal_entry_id" IS NOT NULL
	     AND "reason" IS NOT NULL)
	  OR ("kind" NOT IN ('hold', 'release', 'reversal') AND "amount_rial" IS NOT NULL
	     AND "journal_entry_id" IS NOT NULL AND "reverses_operation_id" IS NULL)
	),
	CONSTRAINT "purse_operations_authorization_check" CHECK (
	  "kind" NOT IN ('reserve', 'cancel_reservation', 'register_service', 'finalize') OR "authorization_id" IS NOT NULL
	)
);--> statement-breakpoint
CREATE INDEX "purse_operations_purse_idx" ON "purse_operations" ("purse_id", "created_at");--> statement-breakpoint
CREATE INDEX "purse_operations_authorization_idx" ON "purse_operations" ("purse_id", "authorization_id")
  WHERE "authorization_id" IS NOT NULL;--> statement-breakpoint
REVOKE UPDATE ON "purse_operations" FROM sepehr_app;--> statement-breakpoint
CREATE TRIGGER purse_operations_append_only BEFORE UPDATE OR DELETE ON "purse_operations"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER purse_operations_no_truncate BEFORE TRUNCATE ON "purse_operations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint

-- Reading purses: accounting and the auditor only (task 1-2 decision); the patient sees
-- their own purse later through the patient panel, not through this permission.
INSERT INTO "permissions" ("code") VALUES ('wallet.read');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'wallet.read' FROM "roles" r
WHERE r.code IN ('auditor', 'accounting') AND r.deleted_at IS NULL;
