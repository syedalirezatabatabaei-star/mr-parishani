-- 0085 (owner, 1405/07/23): staff approve a pending mobile with two people. The first proposes
-- with the evidence seen (person_mobile_proposals, one per mobile); a second holder of
-- lead.approve_person_mobile, neither the proposer nor who added the mobile, approves, and the
-- decision names the proposal. Add only: a new table, a nullable column, a check added NOT
-- VALID (the one-person staff approvals before 0085 stay valid, every new row is checked), and
-- two triggers. Pending mobiles with no proposal start the new flow from the beginning.
-- Summary: docs/decisions/task-m7-person-mobile-two-person-decisions.md.
CREATE TABLE "person_mobile_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_mobile_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_mobile_decisions" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "person_mobile_proposals" ADD CONSTRAINT "person_mobile_proposals_person_mobile_id_person_mobiles_id_fk" FOREIGN KEY ("person_mobile_id") REFERENCES "public"."person_mobiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_mobile_proposals_mobile_key" ON "person_mobile_proposals" USING btree ("person_mobile_id");--> statement-breakpoint
ALTER TABLE "person_mobile_decisions" ADD CONSTRAINT "person_mobile_decisions_proposal_id_person_mobile_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."person_mobile_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_mobile_decisions" ADD CONSTRAINT "person_mobile_decisions_staff_proposal_check" CHECK ("person_mobile_decisions"."method" <> 'staff' OR "person_mobile_decisions"."decision" <> 'approved' OR "person_mobile_decisions"."proposal_id" IS NOT NULL) NOT VALID;--> statement-breakpoint
-- A decision that names a proposal: of the same mobile, and never by its proposer. For every
-- role, the owner's too.
CREATE FUNCTION public.person_mobile_decisions_proposal_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  p record;
BEGIN
  IF NEW.proposal_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT person_mobile_id, proposed_by INTO p
    FROM public.person_mobile_proposals WHERE id = NEW.proposal_id;
  IF p.person_mobile_id IS DISTINCT FROM NEW.person_mobile_id THEN
    RAISE EXCEPTION 'person_mobile_decisions: the proposal is of another mobile'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_by IS NULL OR NEW.decided_by = p.proposed_by THEN
    RAISE EXCEPTION 'person_mobile_decisions: the proposer does not approve their own proposal'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER person_mobile_decisions_proposal_guard BEFORE INSERT ON "person_mobile_decisions"
  FOR EACH ROW EXECUTE FUNCTION public.person_mobile_decisions_proposal_guard();--> statement-breakpoint
CREATE TRIGGER person_mobile_proposals_append_only BEFORE UPDATE OR DELETE ON "person_mobile_proposals"
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_change();--> statement-breakpoint
REVOKE UPDATE, DELETE ON "person_mobile_proposals" FROM sepehr_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "person_mobile_proposals" TO sepehr_app;
