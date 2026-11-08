-- 0043 credit transfer to an AuthorizedRecipient (task 4-8 [financial], part 5; doc 12 §7,
-- §9 test 11; owner 1405/07/14, س۳ to س۹). Hand-written (ADR-003). Expand only: one new
-- table, two permissions and four configuration keys. No money moves: the debt stays with
-- the borrower; the recipient's mobile gets the service codes, up to the transfer's amount.
-- Behind its flag, off (owner س۳: until the mobile and national ID are matched, before launch).

-- === Transfers, asked by one person and approved by another in accounting (wallet module) ==
CREATE TABLE "credit_transfers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"purse_id" uuid NOT NULL REFERENCES "credit_purses" ("id"),
	-- The recipient: a person of the lead module (national ID encrypted there, rule 27).
	"recipient_person_id" uuid NOT NULL,
	-- The mobile the recipient's code was checked on (9XXXXXXXXX): the service codes go there.
	"recipient_mobile" text NOT NULL,
	-- What the recipient may use at most (owner: a cap from configuration).
	"amount_rial" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'awaiting_codes' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The recipient's code and the borrower's consent code, each checked (owner س۴).
	"recipient_verified_at" timestamp with time zone,
	"borrower_consented_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	-- Revoked by the borrower in the portal, or asked by one in finance, approved by another.
	"revoke_requested_by" uuid,
	"revoke_requested_at" timestamp with time zone,
	"revoke_reason" text,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_via" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transfers_amount_check" CHECK ("amount_rial" > 0),
	CONSTRAINT "credit_transfers_mobile_check" CHECK ("recipient_mobile" ~ '^9[0-9]{9}$'),
	CONSTRAINT "credit_transfers_reason_check" CHECK (length(trim("reason")) >= 3),
	CONSTRAINT "credit_transfers_status_check" CHECK ("status" IN
	  ('awaiting_codes', 'requested', 'approved', 'rejected', 'revoke_requested', 'revoked')),
	CONSTRAINT "credit_transfers_via_check"
	  CHECK ("revoked_via" IS NULL OR "revoked_via" IN ('borrower', 'finance')),
	CONSTRAINT "credit_transfers_two_people_check"
	  CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "credit_transfers_revoke_two_people_check"
	  CHECK ("revoked_via" IS DISTINCT FROM 'finance' OR "revoked_by" <> "revoke_requested_by"),
	CONSTRAINT "credit_transfers_codes_check" CHECK (
	  "status" IN ('awaiting_codes', 'rejected')
	  OR ("recipient_verified_at" IS NOT NULL AND "borrower_consented_at" IS NOT NULL)
	),
	CONSTRAINT "credit_transfers_decision_check" CHECK (
	  ("status" IN ('awaiting_codes', 'requested') AND "decided_by" IS NULL)
	  OR ("status" IN ('approved', 'rejected', 'revoke_requested', 'revoked')
	      AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
	),
	CONSTRAINT "credit_transfers_revocation_check" CHECK (
	  (("status" = 'revoked') = ("revoked_at" IS NOT NULL AND "revoked_via" IS NOT NULL))
	  AND ("status" <> 'revoke_requested' OR "revoke_requested_by" IS NOT NULL)
	)
);--> statement-breakpoint
-- One transfer being made per purse, and one active (owner: one recipient at a time).
CREATE UNIQUE INDEX "credit_transfers_open_key" ON "credit_transfers" ("purse_id")
  WHERE "status" IN ('awaiting_codes', 'requested');--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transfers_active_key" ON "credit_transfers" ("purse_id")
  WHERE "status" IN ('approved', 'revoke_requested');--> statement-breakpoint
CREATE INDEX "credit_transfers_status_idx" ON "credit_transfers" ("status", "requested_at");--> statement-breakpoint
CREATE FUNCTION public.credit_transfers_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'recipient_verified_at', 'borrower_consented_at',
    'decided_by', 'decided_at', 'decision_reason', 'revoke_requested_by', 'revoke_requested_at',
    'revoke_reason', 'revoked_by', 'revoked_at', 'revoked_via', 'updated_at'];
BEGIN
  IF (to_jsonb(NEW) - state) IS DISTINCT FROM (to_jsonb(OLD) - state) THEN
    RAISE EXCEPTION 'credit transfer % keeps its purse, recipient and amount', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- The state machine's paths only (rule 8).
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'awaiting_codes' AND NEW.status IN ('requested', 'rejected'))
    OR (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status IN ('revoke_requested', 'revoked'))
    OR (OLD.status = 'revoke_requested' AND NEW.status IN ('approved', 'revoked'))
  ) THEN
    RAISE EXCEPTION 'credit transfer % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('rejected', 'revoked')
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'credit transfer % is closed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_transfers_guard BEFORE UPDATE ON "credit_transfers"
  FOR EACH ROW EXECUTE FUNCTION public.credit_transfers_guard();--> statement-breakpoint
CREATE TRIGGER credit_transfers_set_updated_at BEFORE UPDATE ON "credit_transfers"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER credit_transfers_no_delete BEFORE DELETE ON "credit_transfers"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "credit_transfers" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "recipient_verified_at", "borrower_consented_at", "decided_by",
  "decided_at", "decision_reason", "revoke_requested_by", "revoke_requested_at", "revoke_reason",
  "revoked_by", "revoked_at", "revoked_via", "updated_at") ON "credit_transfers" TO sepehr_app;--> statement-breakpoint

-- === Permissions (owner س۵: asked by case completion or accounting, approved by accounting) =
INSERT INTO "permissions" ("code") VALUES
  ('wallet.request_credit_transfer'), ('wallet.approve_credit_transfer');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('case_completion', 'wallet.request_credit_transfer'),
  ('accounting', 'wallet.request_credit_transfer'),
  ('accounting', 'wallet.approve_credit_transfer')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;--> statement-breakpoint

-- === Configuration (owner س۳, س۶ and the caps; the amount a TODO(decision): 0 until set) ====
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('wallet.credit_transfer_enabled', 'technical', true),
  ('wallet.credit_transfer_code_valid_hours', 'business', true),
  ('wallet.credit_transfer_limits', 'business', true),
  ('wallet.credit_transfer_sms_templates', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('wallet.credit_transfer_enabled', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه: خاموش تا تطبیق موبایل و کد ملی، پاسخ مالک س۳ (مهاجرت 0043)', now()),
  ('wallet.credit_transfer_code_valid_hours', 'global', '24',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، پاسخ مالک س۶ (مهاجرت 0043)', now()),
  ('wallet.credit_transfer_limits', 'global', '{"maxAmountRial": "0", "maxPerPurse": 2}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه: سقف مبلغ TODO(decision)، ۰ تا تعیین مالک (مهاجرت 0043)', now()),
  ('wallet.credit_transfer_sms_templates', 'global',
   '{"serviceRecorded": "خدمتی برای گیرنده مجاز کیف اعتبار شما در {center} ثبت شد."}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه، پاسخ مالک س۸: بی کد و بی مبلغ (مهاجرت 0043)', now());
