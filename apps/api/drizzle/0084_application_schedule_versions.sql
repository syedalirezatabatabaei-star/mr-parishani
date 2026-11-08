-- 0084 T1 and T3 [financial] (owner 1405/07/22; ADR-041; docs/decisions/go-live-m1-t1-t3-shift-grace-plan.md):
-- a credit application locks, when it is created, the versions of the due-day shift
-- (`repayment.shift_due_to_next_working_day`) and of the grace days (`repayment.grace_days`)
-- its schedule uses, as it locks its rounding unit (ADR-039). The holidays stay those known
-- at funding (T2). Hand-written (ADR-003); drizzle-kit's draft added the columns NOT NULL at
-- once, which the existing rows cannot meet. One transaction, rolled back whole on error.
-- Order (owner): columns, backfill, NOT NULL, foreign keys, the immutability trigger.

-- === 1. The columns, empty for the rows that exist ========================================
ALTER TABLE "credit_applications" ADD COLUMN "shift_version_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD COLUMN "grace_version_id" uuid;--> statement-breakpoint

-- === 2. Backfill: the version in force when each application was created ===================
-- As ConfigService.resolve reads it: the global, approved, not deleted version with the
-- latest effective_at at or before created_at (then decided_at, then id). When none was in
-- force yet, the oldest such version (owner: reported; 0 rows locally on 1405/07/22). A key
-- with no version at all leaves NULL, and step 3 then stops the migration.
-- The existing guards pass: credit_applications_guard_change does not list these columns,
-- and no status changes. set_updated_at moves updated_at of each backfilled row.
UPDATE "credit_applications" a SET
  "shift_version_id" = coalesce(
    (SELECT v.id FROM "config_values" v
     WHERE v.key = 'repayment.shift_due_to_next_working_day' AND v.scope_level = 'global'
       AND v.scope_ref IS NULL AND v.status = 'approved' AND v.deleted_at IS NULL
       AND v.effective_at <= a.created_at
     ORDER BY v.effective_at DESC, v.decided_at DESC, v.id DESC LIMIT 1),
    (SELECT v.id FROM "config_values" v
     WHERE v.key = 'repayment.shift_due_to_next_working_day' AND v.scope_level = 'global'
       AND v.scope_ref IS NULL AND v.status = 'approved' AND v.deleted_at IS NULL
     ORDER BY v.effective_at, v.decided_at, v.id LIMIT 1)),
  "grace_version_id" = coalesce(
    (SELECT v.id FROM "config_values" v
     WHERE v.key = 'repayment.grace_days' AND v.scope_level = 'global'
       AND v.scope_ref IS NULL AND v.status = 'approved' AND v.deleted_at IS NULL
       AND v.effective_at <= a.created_at
     ORDER BY v.effective_at DESC, v.decided_at DESC, v.id DESC LIMIT 1),
    (SELECT v.id FROM "config_values" v
     WHERE v.key = 'repayment.grace_days' AND v.scope_level = 'global'
       AND v.scope_ref IS NULL AND v.status = 'approved' AND v.deleted_at IS NULL
     ORDER BY v.effective_at, v.decided_at, v.id LIMIT 1));--> statement-breakpoint

-- === 3. Every application has both, from now on ===========================================
ALTER TABLE "credit_applications" ALTER COLUMN "shift_version_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_applications" ALTER COLUMN "grace_version_id" SET NOT NULL;--> statement-breakpoint

-- === 4. A locked version can never vanish under the application (as 0082) =================
ALTER TABLE "credit_applications"
  ADD CONSTRAINT "credit_applications_shift_version_id_fk"
    FOREIGN KEY ("shift_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "credit_applications_grace_version_id_fk"
    FOREIGN KEY ("grace_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "credit_applications" VALIDATE CONSTRAINT "credit_applications_shift_version_id_fk";--> statement-breakpoint
ALTER TABLE "credit_applications" VALIDATE CONSTRAINT "credit_applications_grace_version_id_fk";--> statement-breakpoint

-- === 5. Never changed after: not by the owner either (the application role has no UPDATE on
-- them at all: 0024 grants it on the state columns only) =================================
CREATE FUNCTION public.credit_applications_schedule_versions_locked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.shift_version_id IS DISTINCT FROM OLD.shift_version_id
     OR NEW.grace_version_id IS DISTINCT FROM OLD.grace_version_id THEN
    RAISE EXCEPTION 'the schedule versions of credit application % are locked', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER credit_applications_schedule_versions_locked BEFORE UPDATE ON "credit_applications"
  FOR EACH ROW EXECUTE FUNCTION public.credit_applications_schedule_versions_locked();
