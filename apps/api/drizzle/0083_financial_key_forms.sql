-- 0083 R4 [financial] (owner 1405/07/22; ADR-040; docs/decisions/r4-financial-reencryption-plan.md):
-- the encrypted columns of payout orders and instruments may be written under a newer key, and
-- a re-encryption run may rewrite them. Hand-written (ADR-003). Destructive in form only: one
-- CHECK is dropped and added again under its own name, wider (key 1's `v1.` and key N's `kN.`),
-- one CHECK is added, and two guards gain one clause before their unchanged bodies. No column,
-- row, index, grant or ledger table changes; one transaction (rolled back whole on error).

-- === instruments: the number's forms (0032), `v1.` or `kN.` (both during a rotation) ========
ALTER TABLE "instruments" DROP CONSTRAINT "instruments_values_check";--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_values_check" CHECK (
  "kind" IN ('cheque', 'promissory_note')
  AND "role" IN ('borrower', 'guarantor')
  AND "status" IN ('received', 'verified', 'held', 'released', 'presented', 'cleared', 'bounced', 'legal_action')
  -- The number never in clear: encrypted (<key>.<iv>.<…>) and indexed (<key>.<hmac>); the key
  -- is v1 (key 1) or kN (key N, R4).
  AND "number_enc" ~ '^(v1|k[0-9]{1,2})\.' AND "number_bidx" ~ '^(v1|k[0-9]{1,2})\.'
  AND length("number_last4") BETWEEN 1 AND 4
  -- A cheque is checked only once its issuer registered it in Sayad (doc 12 §3).
  AND ("kind" <> 'cheque' OR "status" = 'received' OR "sayad_registered_confirmed")
);--> statement-breakpoint

-- === payout_orders: the Sheba snapshot is never in clear (owner, س5), either key form ========
ALTER TABLE "payout_orders" ADD CONSTRAINT "payout_orders_iban_form_check"
  CHECK ("iban_enc" ~ '^(v1|k[0-9]{1,2})\.');--> statement-breakpoint

-- === The orders' guard (0049) with the re-encryption clause first ===========================
-- Only the table's owner, inside a run recorded as running, changing nothing but the encrypted
-- Sheba (and updated_at), passes it; confirmed and failed orders too. The application role
-- never reaches the run lookup (it has no right to field_reencryption_runs, 0077).
CREATE OR REPLACE FUNCTION public.payout_orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'export_batch_id', 'exported_by', 'exported_at',
    'bank_tracking_ref', 'paid_on', 'tracking_recorded_by', 'tracking_recorded_at',
    'confirmed_by', 'confirmed_at', 'journal_entry_id', 'fail_requested_by',
    'fail_requested_at', 'failure_reason', 'failed_by', 'failed_at', 'updated_at'];
BEGIN
  IF current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
                     WHERE c.oid = TG_RELID) THEN
    IF EXISTS (
         SELECT 1 FROM field_reencryption_runs f
         WHERE f.id::text = current_setting('sepehr.field_reencryption_run', true)
           AND f.outcome = 'running'
       )
       AND (to_jsonb(NEW) - ARRAY['iban_enc', 'updated_at'])
         = (to_jsonb(OLD) - ARRAY['iban_enc', 'updated_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
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

-- === The instruments' guard (0032) with the re-encryption clause first ======================
CREATE OR REPLACE FUNCTION public.instruments_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  state constant text[] := ARRAY['status', 'sayad_registered_confirmed', 'sayad_confirmed_at',
                                 'sayad_confirmed_by', 'notes', 'updated_at'];
BEGIN
  IF current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
                     WHERE c.oid = TG_RELID) THEN
    IF EXISTS (
         SELECT 1 FROM field_reencryption_runs f
         WHERE f.id::text = current_setting('sepehr.field_reencryption_run', true)
           AND f.outcome = 'running'
       )
       AND (to_jsonb(NEW) - ARRAY['number_enc', 'number_bidx', 'updated_at'])
         = (to_jsonb(OLD) - ARRAY['number_enc', 'number_bidx', 'updated_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
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
