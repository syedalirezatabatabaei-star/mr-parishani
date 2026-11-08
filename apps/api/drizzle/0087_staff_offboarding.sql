-- 0087 offboarding a staff or center account (owner 1405/07/23, plan 4; go-live blocker م۱۱).
-- One holder of identity.request_staff_offboarding asks, with a reason; another holder of
-- identity.approve_staff_offboarding, neither the asker nor the target, approves or rejects.
-- Approving disables the account (user_accounts.status, which login and every session read
-- already), revokes each role assignment and ends every session; nothing is deleted.
-- Add only: one new table, its checks, indexes and triggers, and two permission codes given
-- to no role (as 0081): an administrator grants them. Summary:
-- docs/decisions/task-plan4-staff-offboarding-decisions.md. Written, not applied (owner).
CREATE TABLE "staff_offboarding_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"target_account_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"roles_revoked" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "staff_offboarding_requests_status_check" CHECK ("staff_offboarding_requests"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "staff_offboarding_requests_reason_check" CHECK (length(trim("staff_offboarding_requests"."reason")) >= 3),
	CONSTRAINT "staff_offboarding_requests_two_people_check" CHECK ("staff_offboarding_requests"."requested_by" <> "staff_offboarding_requests"."target_account_id" AND ("staff_offboarding_requests"."decided_by" IS NULL OR ("staff_offboarding_requests"."decided_by" <> "staff_offboarding_requests"."requested_by" AND "staff_offboarding_requests"."decided_by" <> "staff_offboarding_requests"."target_account_id"))),
	CONSTRAINT "staff_offboarding_requests_decided_check" CHECK (("staff_offboarding_requests"."status" = 'pending') = ("staff_offboarding_requests"."decided_by" IS NULL AND "staff_offboarding_requests"."decided_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "staff_offboarding_requests" ADD CONSTRAINT "staff_offboarding_requests_target_account_id_user_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_offboarding_requests" ADD CONSTRAINT "staff_offboarding_requests_requested_by_user_accounts_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_offboarding_requests" ADD CONSTRAINT "staff_offboarding_requests_decided_by_user_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_offboarding_requests_target_idx" ON "staff_offboarding_requests" USING btree ("target_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_offboarding_requests_open_key" ON "staff_offboarding_requests" USING btree ("target_account_id") WHERE "staff_offboarding_requests"."status" = 'pending';--> statement-breakpoint
-- A request is decided once: only pending leaves, and only to approved or rejected; who and
-- why never change. For every role, the owner's too.
CREATE FUNCTION public.staff_offboarding_requests_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'staff_offboarding_requests: a decided request does not change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.target_account_id <> OLD.target_account_id OR NEW.requested_by <> OLD.requested_by
     OR NEW.reason <> OLD.reason OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'staff_offboarding_requests: who and why do not change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER staff_offboarding_requests_guard BEFORE UPDATE ON "staff_offboarding_requests"
  FOR EACH ROW EXECUTE FUNCTION public.staff_offboarding_requests_guard();--> statement-breakpoint
CREATE TRIGGER staff_offboarding_requests_set_updated_at BEFORE UPDATE ON "staff_offboarding_requests"
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint
REVOKE DELETE ON "staff_offboarding_requests" FROM sepehr_app;--> statement-breakpoint
INSERT INTO "permissions" ("code") VALUES
  ('identity.request_staff_offboarding'),
  ('identity.approve_staff_offboarding');--> statement-breakpoint
-- Owner 1405/07/24: both to the system admin and the owner's role (ceo; there is no security
-- role). Two people still: the database refuses a decision by the asker or the target.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, p.code FROM "roles" r
CROSS JOIN (VALUES ('identity.request_staff_offboarding'), ('identity.approve_staff_offboarding')) AS p(code)
WHERE r.code IN ('system_admin', 'ceo') AND r.deleted_at IS NULL;
