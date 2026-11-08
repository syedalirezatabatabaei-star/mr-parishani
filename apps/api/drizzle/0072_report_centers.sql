-- 0072 (task 7-5, found by the module-boundary test): the purse report names the center from a
-- view of its own, so the reporting module never names the catalog's tables (as 0068 for the
-- purses). Expand only, and 0071's direct read taken back.
CREATE MATERIALIZED VIEW "report_centers" AS SELECT id, name FROM centers WITH DATA;--> statement-breakpoint
CREATE UNIQUE INDEX "report_centers_key" ON "report_centers" ("id");--> statement-breakpoint
GRANT SELECT, MAINTAIN ON "report_centers" TO sepehr_app;--> statement-breakpoint
GRANT SELECT ON "report_centers" TO sepehr_report;--> statement-breakpoint
REVOKE SELECT ("id", "name") ON "centers" FROM sepehr_report;--> statement-breakpoint
INSERT INTO "report_refreshes" ("view_name", "refreshed_at", "duration_ms") VALUES
  ('report_centers', now(), 0);
