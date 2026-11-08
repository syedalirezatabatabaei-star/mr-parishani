-- 0092 (owner 1405/07/27, f12 b2 item 14): a staff request for a lost patient mobile not
-- decided within identity.patient_mobile_change.staffRequestDays (7) expires. Only widens the
-- status check by one value, 'expired'; every existing row stays valid (none is expired) and
-- nothing else changes. Summary: docs/decisions/task-f12-b2-staff-mobile-change-decisions.md §7.
ALTER TABLE "patient_mobile_change_requests" DROP CONSTRAINT "patient_mobile_change_requests_status_check";--> statement-breakpoint
ALTER TABLE "patient_mobile_change_requests" ADD CONSTRAINT "patient_mobile_change_requests_status_check" CHECK ("patient_mobile_change_requests"."status" IN ('pending', 'approved', 'rejected', 'expired'));