-- 0059 settled cases left to staff (owner 1405/07/15, after task 6-2). Hand-written (ADR-003).
-- Expand only: one new table. A case whose loans are all paid but which stands where it may
-- not be completed from (new included) is never passed on automatically; staff see it here.

CREATE TABLE "case_completion_alerts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"case_id" uuid NOT NULL REFERENCES "cases" ("id"),
	"status_at_settlement" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_completion_alerts_status_check" CHECK ("status_at_settlement" IN ('new', 'advising',
	  'appointment_booked', 'examined', 'proforma_issued', 'credit_requested', 'credit_decided',
	  'contracted', 'funded', 'in_treatment'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "case_completion_alerts_case_key" ON "case_completion_alerts" ("case_id");--> statement-breakpoint
CREATE TRIGGER case_completion_alerts_append_only BEFORE UPDATE OR DELETE ON "case_completion_alerts"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "case_completion_alerts" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "case_completion_alerts" TO sepehr_app;
