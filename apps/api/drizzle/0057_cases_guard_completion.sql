-- 0057 the cases guard narrowed (owner 1405/07/15, after task 6-2). Hand-written (ADR-003).
-- Replaces the function only; no table, column or row changes.
--
-- 0055 let any open case go straight to completed. Now only from advising: the stage a case
-- whose loan is settled is really in, since nothing moves a case further along the chain yet
-- (lead's only forward step is startAdvising: new -> advising). in_treatment -> completed
-- remains the chain's own step. Every other jump to completed is refused again.

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
    -- Task 6-2, narrowed: a settled case is completed from advising, its real stage.
    IF NEW.status <> 'cancelled'
       AND NOT (NEW.status = 'completed' AND OLD.status = 'advising')
       AND array_position(chain, NEW.status) IS DISTINCT FROM array_position(chain, OLD.status) + 1 THEN
      RAISE EXCEPTION 'case % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
