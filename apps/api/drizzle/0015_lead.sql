-- 0015 the lead module (task 2-5b; doc 05; ADR-026): persons, their mobiles, cases, intakes,
-- assignment, abandonment reasons, merges, the Excel import and the WordPress webhook;
-- identity's person_backfill_runs. Drafted by drizzle-kit, then extended by hand (ADR-003).
-- Expand only: new tables, keys and permissions. Linking the patient accounts made before
-- this module is not a migration: `pnpm lead:backfill-persons` does it through the services,
-- so every link is audited (task 2-5b decision 1).

CREATE TABLE "person_backfill_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"mode" text NOT NULL,
	"candidates" integer NOT NULL,
	"filled" integer NOT NULL,
	"manual_review" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abandonment_reasons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_caps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL,
	"max_open_cases" integer,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_presence" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_rr_state" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"current_weight" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assignment_weight_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"queue_code" text NOT NULL,
	"city_code" text,
	"treatment_field_code" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_weights" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"percent" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"case_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"weight_version_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_intakes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"case_id" uuid,
	"category" text NOT NULL,
	"channel" text NOT NULL,
	"mobile" text NOT NULL,
	"name" text,
	"treatment_field_code" text NOT NULL,
	"city_code" text,
	"sms_consent" boolean NOT NULL,
	"utm" jsonb,
	"page_url" text,
	"note" text,
	"import_batch_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"case_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason_code" text,
	"note" text,
	"actor_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"queue_code" text NOT NULL,
	"treatment_field_code" text NOT NULL,
	"city_code" text,
	"channel" text NOT NULL,
	"is_returning" boolean DEFAULT false NOT NULL,
	"previous_case_id" uuid,
	"assignee_account_id" uuid,
	"abandonment_reason_code" text,
	"abandonment_note" text,
	"closed_at" timestamp with time zone,
	"import_batch_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lead_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"status" text NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"valid_count" integer NOT NULL,
	"error_count" integer NOT NULL,
	"created_by" uuid,
	"committed_at" timestamp with time zone,
	"committed_by" uuid,
	"processed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lead_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"status" text NOT NULL,
	"errors" text[] NOT NULL,
	"mobile" text,
	"name" text,
	"national_id_enc" text,
	"treatment_field_code" text,
	"city_code" text,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"intake_id" uuid,
	"case_id" uuid,
	"person_id" uuid,
	"created_person" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_merges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"survivor_id" uuid NOT NULL,
	"merged_id" uuid NOT NULL,
	"moved_case_ids" uuid[] NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"reverted_at" timestamp with time zone,
	"reverted_by" uuid,
	"revert_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_mobiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"mobile" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"display_name" text,
	"national_id_enc" text,
	"national_id_index" text,
	"national_id_last4" text,
	"blocked_kind" text,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"merged_into_id" uuid,
	"account_linked_at" timestamp with time zone,
	"sms_opted_out_at" timestamp with time zone,
	"import_batch_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"intake_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignment_rr_state" ADD CONSTRAINT "assignment_rr_state_version_id_assignment_weight_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."assignment_weight_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_weights" ADD CONSTRAINT "assignment_weights_version_id_assignment_weight_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."assignment_weight_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_assignments" ADD CONSTRAINT "case_assignments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_status_changes" ADD CONSTRAINT "case_status_changes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_import_rows" ADD CONSTRAINT "lead_import_rows_batch_id_lead_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."lead_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_survivor_id_persons_id_fk" FOREIGN KEY ("survivor_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_merged_id_persons_id_fk" FOREIGN KEY ("merged_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD CONSTRAINT "person_mobiles_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "abandonment_reasons_code_key" ON "abandonment_reasons" USING btree ("code");--> statement-breakpoint
CREATE INDEX "agent_caps_account_idx" ON "agent_caps" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_presence_account_idx" ON "agent_presence" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_rr_state_key" ON "assignment_rr_state" USING btree ("version_id","account_id");--> statement-breakpoint
CREATE INDEX "assignment_weight_versions_key_idx" ON "assignment_weight_versions" USING btree ("queue_code","city_code","treatment_field_code","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_weights_key" ON "assignment_weights" USING btree ("version_id","account_id");--> statement-breakpoint
CREATE INDEX "case_assignments_case_id_idx" ON "case_assignments" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "case_assignments_version_idx" ON "case_assignments" USING btree ("weight_version_id","account_id");--> statement-breakpoint
CREATE INDEX "case_intakes_person_id_idx" ON "case_intakes" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "case_intakes_case_id_idx" ON "case_intakes" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "case_status_changes_case_id_idx" ON "case_status_changes" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "cases_person_id_idx" ON "cases" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "cases_assignee_idx" ON "cases" USING btree ("assignee_account_id","status") WHERE "cases"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cases_queue_idx" ON "cases" USING btree ("queue_code","status");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_import_rows_key" ON "lead_import_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "person_merges_merged_id_idx" ON "person_merges" USING btree ("merged_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_mobiles_mobile_key" ON "person_mobiles" USING btree ("mobile") WHERE "person_mobiles"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "person_mobiles_person_id_idx" ON "person_mobiles" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persons_national_id_index_key" ON "persons" USING btree ("national_id_index") WHERE "persons"."deleted_at" IS NULL AND "persons"."national_id_index" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "persons_merged_into_id_idx" ON "persons" USING btree ("merged_into_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_key" ON "webhook_deliveries" USING btree ("source","idempotency_key");--> statement-breakpoint

-- === Integrity ===========================================================================
ALTER TABLE "persons" ADD CONSTRAINT "persons_national_id_check" CHECK (
  ("national_id_enc" IS NULL AND "national_id_index" IS NULL AND "national_id_last4" IS NULL)
  OR ("national_id_enc" LIKE 'v1.%' AND "national_id_index" LIKE 'v1.%' AND "national_id_last4" ~ '^[0-9]{4}$')
);--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_blocked_check" CHECK (
  ("blocked_kind" IS NULL AND "blocked_at" IS NULL AND "blocked_reason" IS NULL)
  OR ("blocked_kind" IN ('abuse', 'do_not_contact') AND "blocked_at" IS NOT NULL
    AND length("blocked_reason") BETWEEN 3 AND 500)
);--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_not_self_merged" CHECK ("merged_into_id" IS DISTINCT FROM "id");--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_merged_into_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."persons"("id");--> statement-breakpoint
ALTER TABLE "person_mobiles" ADD CONSTRAINT "person_mobiles_mobile_check" CHECK ("mobile" ~ '^9[0-9]{9}$');--> statement-breakpoint

ALTER TABLE "cases" ADD CONSTRAINT "cases_status_check" CHECK ("status" IN ('new', 'advising', 'appointment_booked', 'examined', 'proforma_issued', 'credit_requested', 'credit_decided', 'contracted', 'funded', 'in_treatment', 'completed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_codes_check" CHECK (
  "queue_code" ~ '^[a-z][a-z0-9_]{1,62}$' AND "treatment_field_code" ~ '^[a-z][a-z0-9_]{1,62}$'
  AND ("city_code" IS NULL OR "city_code" ~ '^[a-z][a-z0-9_]{1,62}$')
);--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_channel_check" CHECK ("channel" IN ('app', 'wordpress', 'excel', 'advisor'));--> statement-breakpoint
-- Closing needs a reason from the list (doc 05 §5); only a closed case has a close time.
ALTER TABLE "cases" ADD CONSTRAINT "cases_closed_check" CHECK (
  ("status" = 'cancelled') = ("abandonment_reason_code" IS NOT NULL)
  AND ("status" IN ('cancelled', 'completed')) = ("closed_at" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_returning_check" CHECK ("is_returning" = ("previous_case_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_previous_case_id_fk" FOREIGN KEY ("previous_case_id") REFERENCES "public"."cases"("id");--> statement-breakpoint

ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_category_check" CHECK ("category" IN ('new', 'duplicate_active', 'returning', 'existing_customer', 'blocked'));--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_channel_check" CHECK ("channel" IN ('app', 'wordpress', 'excel', 'advisor'));--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_mobile_check" CHECK ("mobile" ~ '^9[0-9]{9}$');--> statement-breakpoint
-- A blocked person's intake is recorded and never becomes a case.
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_case_check" CHECK (("category" = 'blocked') = ("case_id" IS NULL));--> statement-breakpoint

ALTER TABLE "case_assignments" ADD CONSTRAINT "case_assignments_kind_check" CHECK (
  ("kind" = 'unassigned' AND "account_id" IS NULL)
  OR ("kind" IN ('auto', 'returning') AND "account_id" IS NOT NULL)
  OR ("kind" = 'manual' AND "account_id" IS NOT NULL AND length("reason") BETWEEN 3 AND 500)
);--> statement-breakpoint
ALTER TABLE "case_assignments" ADD CONSTRAINT "case_assignments_version_check" CHECK (("kind" = 'auto') = ("weight_version_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "case_assignments" ADD CONSTRAINT "case_assignments_weight_version_id_fk" FOREIGN KEY ("weight_version_id") REFERENCES "public"."assignment_weight_versions"("id");--> statement-breakpoint
ALTER TABLE "case_status_changes" ADD CONSTRAINT "case_status_changes_status_check" CHECK ("to_status" IN ('new', 'advising', 'appointment_booked', 'examined', 'proforma_issued', 'credit_requested', 'credit_decided', 'contracted', 'funded', 'in_treatment', 'completed', 'cancelled'));--> statement-breakpoint

ALTER TABLE "abandonment_reasons" ADD CONSTRAINT "abandonment_reasons_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,62}$');--> statement-breakpoint
ALTER TABLE "abandonment_reasons" ADD CONSTRAINT "abandonment_reasons_title_check" CHECK (length("title") BETWEEN 2 AND 200);--> statement-breakpoint

ALTER TABLE "assignment_weight_versions" ADD CONSTRAINT "assignment_weight_versions_codes_check" CHECK (
  "queue_code" ~ '^[a-z][a-z0-9_]{1,62}$'
  AND ("city_code" IS NULL OR "city_code" ~ '^[a-z][a-z0-9_]{1,62}$')
  AND ("treatment_field_code" IS NULL OR "treatment_field_code" ~ '^[a-z][a-z0-9_]{1,62}$')
);--> statement-breakpoint
ALTER TABLE "assignment_weight_versions" ADD CONSTRAINT "assignment_weight_versions_reason_check" CHECK (length("reason") BETWEEN 3 AND 500);--> statement-breakpoint
ALTER TABLE "assignment_weights" ADD CONSTRAINT "assignment_weights_percent_check" CHECK ("percent" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "agent_presence" ADD CONSTRAINT "agent_presence_status_check" CHECK ("status" IN ('present', 'on_leave', 'absent'));--> statement-breakpoint
ALTER TABLE "agent_caps" ADD CONSTRAINT "agent_caps_max_check" CHECK ("max_open_cases" IS NULL OR "max_open_cases" >= 0);--> statement-breakpoint

ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_distinct_check" CHECK ("survivor_id" <> "merged_id");--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_revert_check" CHECK (
  ("reverted_at" IS NULL AND "reverted_by" IS NULL AND "revert_reason" IS NULL)
  OR ("reverted_at" IS NOT NULL AND length("revert_reason") BETWEEN 3 AND 500)
);--> statement-breakpoint
ALTER TABLE "lead_import_batches" ADD CONSTRAINT "lead_import_batches_status_check" CHECK ("status" IN ('previewed', 'committed', 'processed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "lead_import_rows" ADD CONSTRAINT "lead_import_rows_status_check" CHECK ("status" IN ('valid', 'error', 'processed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "lead_import_rows" ADD CONSTRAINT "lead_import_rows_national_id_check" CHECK ("national_id_enc" IS NULL OR "national_id_enc" LIKE 'v1.%');--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_status_check" CHECK ("status" IN ('accepted', 'dropped'));--> statement-breakpoint
ALTER TABLE "person_backfill_runs" ADD CONSTRAINT "person_backfill_runs_mode_check" CHECK ("mode" IN ('dry_run', 'apply'));--> statement-breakpoint

-- === The case status machine (rule 8) =====================================================
-- A case moves one step forward along the chain of docs/01, or is cancelled; a closed case
-- never moves again. The service is the only writer; this refuses anything else.
CREATE FUNCTION public.cases_guard_status() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  chain CONSTANT text[] := ARRAY['new', 'advising', 'appointment_booked', 'examined',
    'proforma_issued', 'credit_requested', 'credit_decided', 'contracted', 'funded',
    'in_treatment', 'completed'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'new' THEN
      RAISE EXCEPTION 'a case starts as new' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'case % is closed', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'cancelled'
       AND array_position(chain, NEW.status) IS DISTINCT FROM array_position(chain, OLD.status) + 1 THEN
      RAISE EXCEPTION 'case % cannot move from % to %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cases_guard_status BEFORE INSERT OR UPDATE ON "cases"
  FOR EACH ROW EXECUTE FUNCTION public.cases_guard_status();--> statement-breakpoint

-- === The shares of a version sum to 100 (doc 05 §6), checked at commit ====================
CREATE FUNCTION public.assignment_weights_check_total() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  total integer;
BEGIN
  SELECT coalesce(sum(percent), 0) INTO total FROM assignment_weights WHERE version_id = NEW.version_id;
  IF total <> 100 THEN
    RAISE EXCEPTION 'the shares of version % sum to %, not 100', NEW.version_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER assignment_weights_total
  AFTER INSERT ON "assignment_weights"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assignment_weights_check_total();--> statement-breakpoint

-- === chose_cash is never retired (doc 05 §5: it drives the cash-service commission) ======
CREATE FUNCTION public.abandonment_reasons_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.code = 'chose_cash' AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'the chose_cash reason cannot be retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER abandonment_reasons_guard_change BEFORE UPDATE ON "abandonment_reasons"
  FOR EACH ROW EXECUTE FUNCTION public.abandonment_reasons_guard_change();--> statement-breakpoint

-- === Append-only history; never physically deleted (rules 7 and 9) ========================
CREATE TRIGGER case_status_changes_append_only BEFORE UPDATE OR DELETE ON "case_status_changes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER case_intakes_append_only BEFORE UPDATE OR DELETE ON "case_intakes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER case_assignments_append_only BEFORE UPDATE OR DELETE ON "case_assignments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER assignment_weight_versions_append_only BEFORE UPDATE OR DELETE ON "assignment_weight_versions"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER assignment_weights_append_only BEFORE UPDATE OR DELETE ON "assignment_weights"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER agent_presence_append_only BEFORE UPDATE OR DELETE ON "agent_presence"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER agent_caps_append_only BEFORE UPDATE OR DELETE ON "agent_caps"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER webhook_deliveries_append_only BEFORE UPDATE OR DELETE ON "webhook_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER person_backfill_runs_append_only BEFORE UPDATE OR DELETE ON "person_backfill_runs"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER persons_no_delete BEFORE DELETE ON "persons"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER person_mobiles_no_delete BEFORE DELETE ON "person_mobiles"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER cases_no_delete BEFORE DELETE ON "cases"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER abandonment_reasons_no_delete BEFORE DELETE ON "abandonment_reasons"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER assignment_rr_state_no_delete BEFORE DELETE ON "assignment_rr_state"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER person_merges_no_delete BEFORE DELETE ON "person_merges"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER lead_import_batches_no_delete BEFORE DELETE ON "lead_import_batches"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER lead_import_rows_no_delete BEFORE DELETE ON "lead_import_rows"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER persons_set_updated_at BEFORE UPDATE ON "persons"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER person_mobiles_set_updated_at BEFORE UPDATE ON "person_mobiles"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER cases_set_updated_at BEFORE UPDATE ON "cases"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER abandonment_reasons_set_updated_at BEFORE UPDATE ON "abandonment_reasons"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER assignment_rr_state_set_updated_at BEFORE UPDATE ON "assignment_rr_state"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER lead_import_batches_set_updated_at BEFORE UPDATE ON "lead_import_batches"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER lead_import_rows_set_updated_at BEFORE UPDATE ON "lead_import_rows"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint

-- What the application may change, column by column.
REVOKE UPDATE ON "persons" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("display_name", "national_id_enc", "national_id_index", "national_id_last4",
  "blocked_kind", "blocked_at", "blocked_reason", "merged_into_id", "account_linked_at",
  "sms_opted_out_at", "deleted_at") ON "persons" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "person_mobiles" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("deleted_at") ON "person_mobiles" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "cases" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("person_id", "status", "assignee_account_id", "abandonment_reason_code",
  "abandonment_note", "closed_at", "deleted_at") ON "cases" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "abandonment_reasons" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("title", "sort_order", "deleted_at") ON "abandonment_reasons" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "assignment_rr_state" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("current_weight") ON "assignment_rr_state" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "person_merges" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("reverted_at", "reverted_by", "revert_reason") ON "person_merges" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "lead_import_batches" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "committed_at", "committed_by", "processed_at", "cancelled_at",
  "cancelled_by", "cancel_reason") ON "lead_import_batches" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "lead_import_rows" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "errors", "intake_id", "case_id", "person_id", "created_person",
  "processed_at") ON "lead_import_rows" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "case_status_changes", "case_intakes", "case_assignments",
  "assignment_weight_versions", "assignment_weights", "agent_presence", "agent_caps",
  "webhook_deliveries", "person_backfill_runs" FROM sepehr_app;--> statement-breakpoint

-- The distribution report reads the reporting database (ADR-012): ids and counts only.
GRANT SELECT ON "case_assignments", "assignment_weight_versions", "assignment_weights"
  TO sepehr_report;--> statement-breakpoint

-- === The base abandonment reasons (doc 05 §5), edited from the panel ======================
INSERT INTO "abandonment_reasons" ("code", "title", "sort_order") VALUES
  ('price_too_high', 'قیمت بالا', 10),
  ('guarantor_rejected', 'رد ضامن', 20),
  ('credit_rejected', 'رد اعتبار', 30),
  ('chose_cash', 'پرداخت نقدی', 40),
  ('chose_competitor', 'انتخاب رقیب', 50),
  ('treatment_cancelled', 'انصراف از درمان', 60),
  ('unreachable', 'عدم دسترسی', 70),
  ('other', 'سایر', 80);--> statement-breakpoint

-- === Configuration (task 2-5b) ==============================================================
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('lead.returning_to_previous_agent', 'business', true),
  ('lead.excel_import_enabled', 'technical', true),
  ('lead.webhook_policy', 'technical', true);--> statement-breakpoint
-- The Excel import stays off until task 2-8 scans uploads (task 2-5b decision 2).
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('lead.returning_to_previous_agent', 'global', 'true',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0015)', now()),
  ('lead.excel_import_enabled', 'global', 'false',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0015)', now()),
  ('lead.webhook_policy', 'global', '{"maxAgeSeconds": 300, "perSourcePerMinute": 120, "perMobilePerHour": 5}',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0015)', now());--> statement-breakpoint

-- === Permissions (task 2-5b decision 6: no new role) =======================================
INSERT INTO "permissions" ("code") VALUES
  ('lead.intake_manual'),
  ('lead.read_cases'),
  ('lead.update_cases'),
  ('lead.assign_manually'),
  ('lead.manage_assignment'),
  ('lead.manage_reasons'),
  ('lead.block_person'),
  ('lead.merge_persons'),
  ('lead.import'),
  ('lead.read_distribution_report');--> statement-breakpoint
-- An advisor's own cases come from the scope of the grant (`own`), decided by the service.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('advisor', 'lead.intake_manual'),
  ('advisor', 'lead.read_cases'),
  ('advisor', 'lead.update_cases'),
  ('strategy_manager', 'lead.read_cases'),
  ('strategy_manager', 'lead.assign_manually'),
  ('strategy_manager', 'lead.manage_assignment'),
  ('strategy_manager', 'lead.manage_reasons'),
  ('strategy_manager', 'lead.block_person'),
  ('strategy_manager', 'lead.merge_persons'),
  ('strategy_manager', 'lead.import'),
  ('strategy_manager', 'lead.read_distribution_report'),
  ('auditor', 'lead.read_distribution_report'),
  ('ceo', 'lead.read_distribution_report')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;
