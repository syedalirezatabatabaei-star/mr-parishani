-- 0027 credit queues (task 3-5 part D; doc 10 §8, doc 05 §6). Expand only: one append-only
-- table of assignments and one permission. No existing table changes.
CREATE TABLE "credit_application_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"credit_application_id" uuid NOT NULL,
	"queue_code" text NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"weight_version_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_application_assignments_kind_check" CHECK (("credit_application_assignments"."kind" = 'unassigned') = ("credit_application_assignments"."account_id" IS NULL)
          AND ("credit_application_assignments"."kind" <> 'manual' OR "credit_application_assignments"."reason" IS NOT NULL)
          AND ("credit_application_assignments"."kind" <> 'auto' OR "credit_application_assignments"."weight_version_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "credit_application_assignments" ADD CONSTRAINT "credit_application_assignments_credit_application_id_credit_applications_id_fk" FOREIGN KEY ("credit_application_id") REFERENCES "public"."credit_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_application_assignments_app_idx" ON "credit_application_assignments" USING btree ("credit_application_id","queue_code");--> statement-breakpoint
CREATE INDEX "credit_application_assignments_account_idx" ON "credit_application_assignments" USING btree ("account_id","queue_code");--> statement-breakpoint
-- === Hand-written (task 3-5 part D, doc 10 §8): expand only. ==============================
ALTER TABLE "credit_application_assignments" ADD CONSTRAINT "credit_application_assignments_queue_check" CHECK ("queue_code" IN ('completion', 'credit', 'committee'));--> statement-breakpoint
ALTER TABLE "credit_application_assignments" ADD CONSTRAINT "credit_application_assignments_kind_values_check" CHECK ("kind" IN ('auto', 'manual', 'unassigned'));--> statement-breakpoint
CREATE TRIGGER credit_application_assignments_append_only BEFORE UPDATE OR DELETE ON "credit_application_assignments"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE ON "credit_application_assignments" FROM sepehr_app;--> statement-breakpoint

-- === Permissions ===========================================================================
INSERT INTO "permissions" ("code") VALUES ('credit.assign_manually');--> statement-breakpoint
-- The strategy manager sets every queue's shares (lead.manage_assignment) and assigns by
-- hand, with a reason (doc 05 §6). TODO(decision): a queue manager of each credit unit.
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT r.id, 'credit.assign_manually' FROM "roles" r
WHERE r.code = 'strategy_manager' AND r.deleted_at IS NULL;
