-- 0068 (task 7-4, found by the module-boundary test): the purse report reads the purses'
-- center and treatment field from a view of its own, so the reporting module never names the
-- wallet's tables (as it reads the ledger through report_ledger_daily). Expand only, and the
-- direct read 0066 gave the reporting role taken back.
CREATE MATERIALIZED VIEW "report_purses" AS
SELECT id, center_node_id, treatment_field_code, case_id FROM credit_purses
WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX "report_purses_key" ON "report_purses" ("id");--> statement-breakpoint
CREATE INDEX "report_purses_center_idx" ON "report_purses" ("center_node_id", "treatment_field_code");--> statement-breakpoint
GRANT SELECT, MAINTAIN ON "report_purses" TO sepehr_app;--> statement-breakpoint
GRANT SELECT ON "report_purses" TO sepehr_report;--> statement-breakpoint
REVOKE SELECT ON "credit_purses" FROM sepehr_report;--> statement-breakpoint
INSERT INTO "report_refreshes" ("view_name", "refreshed_at", "duration_ms") VALUES
  ('report_purses', now(), 0);
