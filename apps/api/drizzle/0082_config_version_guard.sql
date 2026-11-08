-- 0082 go-live M1, condition 2 (owner, 1405/07/21): a configuration version a record is locked
-- to can never vanish. Gap G1: config_values_guard covers INSERT and UPDATE only, so the owner
-- could still DELETE or TRUNCATE a version row; now no role can (soft delete stays the path,
-- through config_values_guard). Gap G2: the version columns locked on a case, a schedule, its
-- terms and a contract's penalty terms had no FK; now each references config_values, ON DELETE
-- RESTRICT. Orphan report before this migration: 0 on every column. SQL only, add only: no row
-- is changed. Summary: docs/decisions/go-live-m1-rounding-version-plan.md §8.
CREATE TRIGGER "config_values_no_delete"
  BEFORE DELETE ON "config_values"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();--> statement-breakpoint
-- A row trigger does not fire on TRUNCATE (nor on TRUNCATE ... CASCADE from a referencing table).
CREATE TRIGGER "config_values_no_truncate"
  BEFORE TRUNCATE ON "config_values"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();--> statement-breakpoint
-- Added NOT VALID, then validated one by one: the existing rows are checked without holding the
-- stronger lock of ADD CONSTRAINT while they are read.
ALTER TABLE "credit_applications"
  ADD CONSTRAINT "credit_applications_plans_version_fk"
    FOREIGN KEY ("plans_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "credit_applications_rounding_version_fk"
    FOREIGN KEY ("rounding_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "credit_applications_reduction_version_fk"
    FOREIGN KEY ("reduction_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "installment_schedules"
  ADD CONSTRAINT "installment_schedules_rounding_version_fk"
    FOREIGN KEY ("rounding_config_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "installment_schedules_shift_version_fk"
    FOREIGN KEY ("shift_config_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "installment_schedules_weekly_version_fk"
    FOREIGN KEY ("weekly_days_off_config_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "installment_schedule_terms"
  ADD CONSTRAINT "installment_schedule_terms_grace_version_fk"
    FOREIGN KEY ("grace_config_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "contract_penalty_terms"
  ADD CONSTRAINT "contract_penalty_terms_version_fk"
    FOREIGN KEY ("config_version_id") REFERENCES "config_values" ("id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE "credit_applications" VALIDATE CONSTRAINT "credit_applications_plans_version_fk";--> statement-breakpoint
ALTER TABLE "credit_applications" VALIDATE CONSTRAINT "credit_applications_rounding_version_fk";--> statement-breakpoint
ALTER TABLE "credit_applications" VALIDATE CONSTRAINT "credit_applications_reduction_version_fk";--> statement-breakpoint
ALTER TABLE "installment_schedules" VALIDATE CONSTRAINT "installment_schedules_rounding_version_fk";--> statement-breakpoint
ALTER TABLE "installment_schedules" VALIDATE CONSTRAINT "installment_schedules_shift_version_fk";--> statement-breakpoint
ALTER TABLE "installment_schedules" VALIDATE CONSTRAINT "installment_schedules_weekly_version_fk";--> statement-breakpoint
ALTER TABLE "installment_schedule_terms" VALIDATE CONSTRAINT "installment_schedule_terms_grace_version_fk";--> statement-breakpoint
ALTER TABLE "contract_penalty_terms" VALIDATE CONSTRAINT "contract_penalty_terms_version_fk";
