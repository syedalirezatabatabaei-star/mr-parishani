-- 0086 the cases guard widened (owner 1405/07/23, question 8, option A). Hand-written (ADR-003).
-- Replaces the function only; no table, column or row changes.
--
-- The case funnel consumer now brings a case to appointment_booked, examined and
-- proforma_issued, so a case whose loan is settled may stand at any of them. 0057 let a
-- settled case go to completed from advising only; now from every open stage before the
-- loan that the funnel reaches: advising, appointment_booked, examined, proforma_issued
-- (SETTLEABLE_CASE_STATUSES in @sepehr/contracts). new is still never passed on (owner
-- 1405/07/15); credit_requested to funded are still refused; in_treatment -> completed
-- remains the chain's own step. 0057 itself is not edited: it is applied.

CREATE OR REPLACE FUNCTION public.cases_guard_status() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  chain CONSTANT text[] := ARRAY['new','advising','appointment_booked','examined',
    'proforma_issued','credit_requested','credit_decided','contracted','funded',
    'in_treatment','completed'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'new' THEN RAISE EXCEPTION 'a case starts as new' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'case % is closed', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    -- Task 6-2, widened (owner 1405/07/23): a settled case is completed from a settleable stage.
    IF NEW.status <> 'cancelled'
       AND NOT (NEW.status = 'completed'
                AND OLD.status IN ('advising','appointment_booked','examined','proforma_issued'))
       AND array_position(chain, NEW.status) IS DISTINCT FROM array_position(chain, OLD.status) + 1 THEN
      RAISE EXCEPTION 'case % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
