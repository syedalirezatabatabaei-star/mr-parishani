-- 0016 appointments and referrals (task 2-6; doc 08 §7–8; ADR-027). Drafted by drizzle-kit
-- for the booking module's tables, then extended by hand (ADR-003). Expand only: new
-- tables, keys and permissions; nothing existing changes. Workplace, doctor, person and
-- case ids belong to other modules, so they carry no foreign key (module boundary).
-- Double booking is refused by the exclusion constraint below, never by application locks.

CREATE TABLE "appointment_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"offset_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_account_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workplace_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"patient_account_id" uuid,
	"mobile" text NOT NULL,
	"person_id" uuid,
	"case_id" uuid,
	"service_code" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"channel" text NOT NULL,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"approval_mode" text,
	"approval_mode_version_id" uuid,
	"approval_due_at" timestamp with time zone,
	"tariff_version_id" uuid NOT NULL,
	"tariff_is_free" boolean NOT NULL,
	"tariff_min_amount_rial" bigint NOT NULL,
	"tariff_max_amount_rial" bigint NOT NULL,
	"check_in_code" text,
	"check_in_attempts" integer DEFAULT 0 NOT NULL,
	"checked_in_at" timestamp with time zone,
	"rescheduled_from_id" uuid,
	"created_by" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "no_show_disputes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"outcome" text,
	"resolution_reason" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"case_id" uuid,
	"doctor_id" uuid NOT NULL,
	"workplace_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"referred_at" timestamp with time zone NOT NULL,
	"supersedes_referral_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_notices" ADD CONSTRAINT "appointment_notices_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_status_changes" ADD CONSTRAINT "appointment_status_changes_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_from_id_appointments_id_fk" FOREIGN KEY ("rescheduled_from_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_show_disputes" ADD CONSTRAINT "no_show_disputes_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_supersedes_referral_id_referrals_id_fk" FOREIGN KEY ("supersedes_referral_id") REFERENCES "public"."referrals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_payments" ADD CONSTRAINT "visit_payments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_notices_key" ON "appointment_notices" USING btree ("appointment_id","kind","offset_minutes");--> statement-breakpoint
CREATE INDEX "appointment_status_changes_appointment_idx" ON "appointment_status_changes" USING btree ("appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "appointments_workplace_starts_idx" ON "appointments" USING btree ("workplace_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_doctor_starts_idx" ON "appointments" USING btree ("doctor_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_patient_account_idx" ON "appointments" USING btree ("patient_account_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_person_id_idx" ON "appointments" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "appointments_case_id_idx" ON "appointments" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "appointments_held_idx" ON "appointments" USING btree ("hold_expires_at") WHERE "appointments"."status" = 'held';--> statement-breakpoint
CREATE INDEX "appointments_requested_idx" ON "appointments" USING btree ("approval_due_at") WHERE "appointments"."status" = 'requested';--> statement-breakpoint
CREATE INDEX "appointments_confirmed_idx" ON "appointments" USING btree ("starts_at") WHERE "appointments"."status" = 'confirmed';--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_rescheduled_from_key" ON "appointments" USING btree ("rescheduled_from_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_idempotency_key" ON "appointments" USING btree ("created_by","idempotency_key") WHERE "appointments"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "no_show_disputes_appointment_key" ON "no_show_disputes" USING btree ("appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_appointment_key" ON "referrals" USING btree ("appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_supersedes_key" ON "referrals" USING btree ("supersedes_referral_id");--> statement-breakpoint
CREATE INDEX "referrals_doctor_referred_idx" ON "referrals" USING btree ("doctor_id","referred_at");--> statement-breakpoint
CREATE INDEX "referrals_person_id_idx" ON "referrals" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_payments_appointment_key" ON "visit_payments" USING btree ("appointment_id");--> statement-breakpoint

-- === Integrity ===========================================================================
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_status_check" CHECK ("status" IN ('held', 'requested', 'confirmed', 'checked_in', 'examined', 'rejected', 'expired', 'cancelled_by_patient', 'cancelled_by_center', 'no_show', 'rescheduled'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_channel_check" CHECK ("channel" IN ('app', 'web', 'advisor'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_approval_mode_check" CHECK ("approval_mode" IS NULL OR "approval_mode" IN ('auto', 'manual'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_mobile_check" CHECK ("mobile" ~ '^9[0-9]{9}$');--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_time_check" CHECK ("starts_at" < "ends_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_amount_check" CHECK (
  "tariff_min_amount_rial" >= 0 AND "tariff_min_amount_rial" <= "tariff_max_amount_rial");--> statement-breakpoint
-- A request has its person, its approval mode and, when manual, its deadline.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_requested_check" CHECK (
  "status" IN ('held', 'expired')
  OR ("person_id" IS NOT NULL AND "approval_mode" IS NOT NULL AND "approval_mode_version_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_check_in_code_check" CHECK (
  "check_in_code" IS NULL OR "check_in_code" ~ '^[0-9]{6}$');--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_idempotency_key_check" CHECK (
  "idempotency_key" IS NULL OR length("idempotency_key") BETWEEN 8 AND 200);--> statement-breakpoint
-- No two live appointments of one doctor overlap, at any workplace (doc 08 §7, test 1;
-- task 2-5 decision 4). This constraint, not the service's checks, decides who gets a slot.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_double_booking" EXCLUDE USING gist (
  "doctor_id" WITH =,
  tstzrange("starts_at", "ends_at") WITH &&
) WHERE ("status" IN ('held', 'requested', 'confirmed', 'checked_in', 'examined'));--> statement-breakpoint
ALTER TABLE "appointment_status_changes" ADD CONSTRAINT "appointment_status_changes_status_check" CHECK (
  "to_status" IN ('held', 'requested', 'confirmed', 'checked_in', 'examined', 'rejected', 'expired', 'cancelled_by_patient', 'cancelled_by_center', 'no_show', 'rescheduled'));--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_channel_check" CHECK ("channel" IN ('app', 'web', 'advisor'));--> statement-breakpoint
ALTER TABLE "no_show_disputes" ADD CONSTRAINT "no_show_disputes_outcome_check" CHECK (
  ("outcome" IS NULL AND "resolved_at" IS NULL AND "resolved_by" IS NULL AND "resolution_reason" IS NULL)
  OR ("outcome" IN ('upheld', 'overturned') AND "resolved_at" IS NOT NULL AND "resolution_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "no_show_disputes" ADD CONSTRAINT "no_show_disputes_reason_check" CHECK (length("reason") BETWEEN 3 AND 500);--> statement-breakpoint
ALTER TABLE "visit_payments" ADD CONSTRAINT "visit_payments_amount_check" CHECK ("amount_rial" > 0);--> statement-breakpoint
ALTER TABLE "appointment_notices" ADD CONSTRAINT "appointment_notices_kind_check" CHECK (
  ("kind" = 'reminder' AND "offset_minutes" > 0) OR ("kind" = 'approval_overdue' AND "offset_minutes" = 0));--> statement-breakpoint

-- === The lifecycle (rule 8): only the moves of APPOINTMENT_TRANSITIONS ===================
CREATE FUNCTION public.appointments_guard_transition() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'held' AND NEW.status IN ('requested', 'expired'))
    OR (OLD.status = 'requested' AND NEW.status IN ('confirmed', 'rejected', 'cancelled_by_patient', 'expired'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('checked_in', 'cancelled_by_patient', 'cancelled_by_center', 'no_show', 'rescheduled'))
    OR (OLD.status = 'checked_in' AND NEW.status = 'examined')
  ) THEN
    RAISE EXCEPTION 'appointment % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER appointments_guard_transition BEFORE UPDATE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION public.appointments_guard_transition();--> statement-breakpoint
CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
CREATE TRIGGER no_show_disputes_set_updated_at BEFORE UPDATE ON "no_show_disputes"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
-- A dispute is decided once.
CREATE FUNCTION public.no_show_disputes_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'dispute % is already decided', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER no_show_disputes_guard_change BEFORE UPDATE ON "no_show_disputes"
  FOR EACH ROW EXECUTE FUNCTION public.no_show_disputes_guard_change();--> statement-breakpoint

-- === Append-only; never physically deleted (rules 7 and 9) ===============================
-- A referral is never changed or removed (doc 08 §8, test 11).
CREATE TRIGGER referrals_append_only BEFORE UPDATE OR DELETE ON "referrals"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER referrals_no_truncate BEFORE TRUNCATE ON "referrals"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER appointment_status_changes_append_only BEFORE UPDATE OR DELETE ON "appointment_status_changes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER visit_payments_append_only BEFORE UPDATE OR DELETE ON "visit_payments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER appointment_notices_append_only BEFORE UPDATE OR DELETE ON "appointment_notices"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER appointments_no_delete BEFORE DELETE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
CREATE TRIGGER no_show_disputes_no_delete BEFORE DELETE ON "no_show_disputes"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "referrals" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "appointment_status_changes" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "visit_payments" FROM sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "appointment_notices" FROM sepehr_app;--> statement-breakpoint
-- What a move sets; the slot, the doctor, the patient and the price never change.
REVOKE UPDATE ON "appointments" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("status", "person_id", "case_id", "approval_mode", "approval_mode_version_id",
  "approval_due_at", "check_in_code", "check_in_attempts", "checked_in_at") ON "appointments" TO sepehr_app;--> statement-breakpoint
REVOKE UPDATE ON "no_show_disputes" FROM sepehr_app;--> statement-breakpoint
GRANT UPDATE ("outcome", "resolution_reason", "resolved_by", "resolved_at") ON "no_show_disputes" TO sepehr_app;--> statement-breakpoint

-- === Configuration (task 2-6; doc 09 open items 2, 3 and 9) ================================
-- TODO(decision): every value; the defaults of doc 09 until the client answers.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('booking.hold_minutes', 'business', true),
  ('booking.reminder_offsets_minutes', 'business', true),
  ('booking.patient_cancel_cutoff_minutes', 'business', true),
  ('booking.center_approval_sla_minutes', 'business', true),
  ('booking.sms_templates', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('booking.hold_minutes', 'global', '10',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0016)', now()),
  ('booking.reminder_offsets_minutes', 'global', '[1440, 120]',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0016)', now()),
  ('booking.patient_cancel_cutoff_minutes', 'global', '120',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0016)', now()),
  ('booking.center_approval_sla_minutes', 'global', '15',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0016)', now()),
  ('booking.sms_templates', 'global', '{
     "confirmed": "نوبت شما نزد {doctor} در {place} برای {date} ساعت {time} تأیید شد. کد پذیرش: {code}",
     "reminder": "یادآوری نوبت: {doctor}، {place}، {date} ساعت {time}.",
     "cancelledByCenter": "نوبت شما نزد {doctor} در {date} ساعت {time} از سوی مرکز لغو شد. برای زمان جایگزین به سپهر سلامتی مراجعه کنید.",
     "approvalOverdue": "درخواست نوبت {date} ساعت {time} نزد {doctor} هنوز از سوی مرکز پاسخ نگرفته است."
   }',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0016)', now());--> statement-breakpoint

-- === Permissions (task 2-6) ================================================================
INSERT INTO "permissions" ("code") VALUES
  ('booking.read_appointments'),
  ('booking.manage_appointments'),
  ('booking.book_for_patient'),
  ('booking.resolve_no_show_dispute'),
  ('booking.read_referrals');--> statement-breakpoint
-- The workplace a permission reaches is the caller's scope (doctor, center or branch, city
-- or global), checked by the service on every request. A secretary gets nothing by
-- default: their doctor, or for a doctor without an account the manager above, delegates.
-- Patients need no permission: they act on their own appointments (self-service).
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, g.permission_code
FROM (VALUES
  ('doctor', 'booking.read_appointments'),
  ('doctor', 'booking.manage_appointments'),
  ('center_manager', 'booking.read_appointments'),
  ('center_manager', 'booking.manage_appointments'),
  ('network_specialist', 'booking.read_appointments'),
  ('network_specialist', 'booking.manage_appointments'),
  ('network_specialist', 'booking.resolve_no_show_dispute'),
  ('network_manager', 'booking.read_appointments'),
  ('network_manager', 'booking.read_referrals'),
  ('advisor', 'booking.book_for_patient'),
  ('auditor', 'booking.read_appointments'),
  ('auditor', 'booking.read_referrals'),
  ('ceo', 'booking.read_appointments'),
  ('ceo', 'booking.read_referrals')
) AS g(role_code, permission_code)
JOIN "roles" r ON r.code = g.role_code AND r.deleted_at IS NULL;