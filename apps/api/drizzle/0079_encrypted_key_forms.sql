-- 0079 the encrypted columns accept a newer key's form, and the centers' guard lets a
-- re-encryption run through (task 9-3, R4; owner approval 1405/07/18). Hand-written (ADR-003).
-- Summary, constraints, guard text and risks: docs/decisions/task-9-3-decisions.md (part 8).
--
-- Widening only: `v1.` (key 1, every existing row) still passes; `k<N>.` (key N) is added.
-- A plaintext value still never passes. instruments_values_check and payout_orders (financial)
-- are not touched: they stay on key 1 until the owner approves their plan.
ALTER TABLE "centers" DROP CONSTRAINT "centers_identifier_check";--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_identifier_check" CHECK (
  "identifier_enc" ~ '^(v1|k[0-9]{1,2})\.' AND "identifier_index" ~ '^(v1|k[0-9]{1,2})\.'
  AND "identifier_last4" ~ '^[0-9]{4}$'
);--> statement-breakpoint
ALTER TABLE "centers" DROP CONSTRAINT "centers_sheba_check";--> statement-breakpoint
ALTER TABLE "centers" ADD CONSTRAINT "centers_sheba_check" CHECK (
  ("sheba_enc" IS NULL AND "sheba_index" IS NULL AND "sheba_last4" IS NULL)
  OR ("sheba_enc" ~ '^(v1|k[0-9]{1,2})\.' AND "sheba_index" ~ '^(v1|k[0-9]{1,2})\.'
      AND "sheba_last4" ~ '^[0-9]{4}$')
);--> statement-breakpoint
ALTER TABLE "center_change_requests" DROP CONSTRAINT "center_change_requests_payload_check";--> statement-breakpoint
ALTER TABLE "center_change_requests" ADD CONSTRAINT "center_change_requests_payload_check" CHECK (
  ("kind" = 'bank_account'
    AND "sheba_enc" ~ '^(v1|k[0-9]{1,2})\.' AND "sheba_index" ~ '^(v1|k[0-9]{1,2})\.'
    AND "sheba_last4" ~ '^[0-9]{4}$' AND "account_holder_name" IS NOT NULL)
  OR ("kind" <> 'bank_account'
    AND "sheba_enc" IS NULL AND "sheba_index" IS NULL AND "sheba_last4" IS NULL
    AND "account_holder_name" IS NULL)
);--> statement-breakpoint
ALTER TABLE "doctors" DROP CONSTRAINT "doctors_national_id_check";--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_national_id_check" CHECK (
  ("national_id_enc" IS NULL AND "national_id_index" IS NULL AND "national_id_last4" IS NULL)
  OR ("national_id_enc" ~ '^(v1|k[0-9]{1,2})\.' AND "national_id_index" ~ '^(v1|k[0-9]{1,2})\.'
      AND "national_id_last4" ~ '^[0-9]{4}$')
);--> statement-breakpoint
ALTER TABLE "persons" DROP CONSTRAINT "persons_national_id_check";--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_national_id_check" CHECK (
  ("national_id_enc" IS NULL AND "national_id_index" IS NULL AND "national_id_last4" IS NULL)
  OR ("national_id_enc" ~ '^(v1|k[0-9]{1,2})\.' AND "national_id_index" ~ '^(v1|k[0-9]{1,2})\.'
      AND "national_id_last4" ~ '^[0-9]{4}$')
);--> statement-breakpoint
ALTER TABLE "lead_import_rows" DROP CONSTRAINT "lead_import_rows_national_id_check";--> statement-breakpoint
ALTER TABLE "lead_import_rows" ADD CONSTRAINT "lead_import_rows_national_id_check" CHECK (
  "national_id_enc" IS NULL OR "national_id_enc" ~ '^(v1|k[0-9]{1,2})\.'
);--> statement-breakpoint

-- The centers' guard (0010) as it was, with one way in for a re-encryption run, first.
CREATE OR REPLACE FUNCTION public.centers_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  -- R4 (task 9-3): a re-encryption run rewrites the encrypted identifier and Sheba and their
  -- blind indexes under a new key, and nothing else. Only as the table's owner (the tool runs
  -- as the schema owner; the application role never can, nor reads the runs table), only
  -- inside a run recorded as running, and only when every other column is as it was. The
  -- tool audits each center it rewrites, in the same transaction.
  IF current_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
                     WHERE c.oid = TG_RELID) THEN
    IF EXISTS (
         SELECT 1 FROM field_reencryption_runs f
         WHERE f.id::text = current_setting('sepehr.field_reencryption_run', true)
           AND f.outcome = 'running'
       )
       AND (to_jsonb(NEW) - ARRAY['identifier_enc', 'identifier_index', 'sheba_enc', 'sheba_index', 'updated_at'])
         = (to_jsonb(OLD) - ARRAY['identifier_enc', 'identifier_index', 'sheba_enc', 'sheba_index', 'updated_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  -- A terminated center is kept as it ended: only reports and settling earlier items.
  IF OLD.status = 'terminated' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminated center % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Only a draft that was never activated may be soft-deleted, and never restored: an
  -- active, suspended or terminated center keeps blocking its IDs (task 2-2 decision).
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     AND (OLD.deleted_at IS NOT NULL OR OLD.status <> 'draft' OR OLD.first_activated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'center % cannot be deleted or restored in status %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- Set once, by the first activation.
  IF NEW.first_activated_at IS DISTINCT FROM OLD.first_activated_at
     AND NOT (OLD.first_activated_at IS NULL AND OLD.status = 'under_review' AND NEW.status = 'active') THEN
    RAISE EXCEPTION 'first_activated_at of center % is set only by its first activation', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Under review (and so in the activation itself) the reviewed identity and bank account
  -- stay as they were checked.
  IF OLD.status = 'under_review'
     AND (NEW.person_type <> OLD.person_type
          OR NEW.identifier_index <> OLD.identifier_index
          OR NEW.sheba_index IS DISTINCT FROM OLD.sheba_index
          OR NEW.account_holder_name IS DISTINCT FROM OLD.account_holder_name) THEN
    RAISE EXCEPTION 'the identity and bank account of center % under review cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'draft' AND NEW.status = 'under_review')
      OR (OLD.status = 'under_review' AND NEW.status IN ('needs_fix', 'active'))
      OR (OLD.status = 'needs_fix' AND NEW.status = 'under_review')
      OR (OLD.status = 'active' AND NEW.status IN ('suspended', 'terminated'))
      OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'terminated'))
    ) THEN
      RAISE EXCEPTION 'center % cannot go from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM center_change_requests r
      WHERE r.center_id = NEW.id AND r.status = 'approved'
        AND r.kind = CASE OLD.status WHEN 'suspended' THEN 'reactivation' ELSE 'activation' END
        AND r.decided_at = now()
    ) THEN
      RAISE EXCEPTION 'center % becomes active only by an approved two-person request', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.first_activated_at IS NOT NULL THEN
    IF NEW.first_activated_at IS DISTINCT FROM OLD.first_activated_at
       OR NEW.person_type <> OLD.person_type
       OR NEW.identifier_index <> OLD.identifier_index THEN
      RAISE EXCEPTION 'the identity of activated center % cannot change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.sheba_index IS DISTINCT FROM OLD.sheba_index
        OR NEW.account_holder_name IS DISTINCT FROM OLD.account_holder_name)
       AND NOT EXISTS (
         SELECT 1 FROM center_change_requests r
         WHERE r.center_id = NEW.id AND r.kind = 'bank_account' AND r.status = 'approved'
           AND r.sheba_index = NEW.sheba_index
           AND r.account_holder_name = NEW.account_holder_name
           AND r.decided_at = now()
       ) THEN
      RAISE EXCEPTION 'the bank account of activated center % changes only by an approved two-person request', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
