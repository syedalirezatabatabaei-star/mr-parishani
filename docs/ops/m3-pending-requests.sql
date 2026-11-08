-- ADR-052 (owner 1405/08/02): two-person requests still waiting when the SMS-code step-up is
-- deployed are cancelled and asked again. Read-only, counts only (no names, no amounts): run
-- before the deploy; each waiting request is then refused in the panel by a second person,
-- with the reason «استقرار م۳», and asked again with a code.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/ops/m3-pending-requests.sql
BEGIN READ ONLY;
SELECT kind, waiting FROM (
            SELECT 'funding_requests' AS kind, count(*) AS waiting FROM funding_requests WHERE status = 'requested'
  UNION ALL SELECT 'purse_operation_requests', count(*) FROM purse_operation_requests WHERE status = 'requested'
  UNION ALL SELECT 'credit_transfers', count(*) FROM credit_transfers WHERE status IN ('awaiting_codes', 'requested', 'revoke_requested')
  UNION ALL SELECT 'credit_application_cancellations', count(*) FROM credit_application_cancellations WHERE status = 'requested'
  UNION ALL SELECT 'credit_penalty_overrides', count(*) FROM credit_penalty_overrides WHERE status = 'requested'
  UNION ALL SELECT 'refund_payments', count(*) FROM refund_payments WHERE status = 'requested'
  UNION ALL SELECT 'completion_receipts', count(*) FROM completion_receipts WHERE status = 'pending_approval'
  UNION ALL SELECT 'payments', count(*) FROM payments WHERE status = 'pending_approval'
  UNION ALL SELECT 'cash_services', count(*) FROM cash_services WHERE status IN ('recorded', 'disputed')
  UNION ALL SELECT 'settlement_statements (cancel asked)', count(*) FROM settlement_statements WHERE cancel_requested_by IS NOT NULL AND status <> 'cancelled'
  UNION ALL SELECT 'financial_disputes', count(*) FROM financial_disputes WHERE status = 'open'
  UNION ALL SELECT 'instrument_executions', count(*) FROM instrument_executions WHERE status = 'proposed'
  UNION ALL SELECT 'center_change_requests', count(*) FROM center_change_requests WHERE status = 'proposed'
  UNION ALL SELECT 'credit_decisions', count(*) FROM credit_decisions WHERE status = 'proposed'
  UNION ALL SELECT 'visit_tariff_proposals', count(*) FROM visit_tariff_proposals WHERE status = 'pending'
  UNION ALL SELECT 'holiday_batches', count(*) FROM holiday_batches WHERE status = 'pending'
  UNION ALL SELECT 'holiday_removals', count(*) FROM holiday_removals WHERE status = 'pending'
  UNION ALL SELECT 'patient_mobile_change_requests', count(*) FROM patient_mobile_change_requests WHERE status = 'pending'
  UNION ALL SELECT 'person_mobile_proposals', count(*) FROM person_mobile_proposals p
             WHERE NOT EXISTS (SELECT 1 FROM person_mobile_decisions d WHERE d.proposal_id = p.id)
  UNION ALL SELECT 'totp_reset_requests', count(*) FROM totp_reset_requests WHERE status = 'pending'
  UNION ALL SELECT 'config_values', count(*) FROM config_values WHERE status = 'proposed'
) t
ORDER BY waiting DESC, kind;
COMMIT;
