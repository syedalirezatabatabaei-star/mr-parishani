-- 0070 (task 7-5; a bug of 7-4 the doctor's rank test found): org_nodes has row-level security
-- with policies for sepehr_app only, so the reporting role saw none of its rows and the
-- reports' doctor and center names were always empty. The reporting role reads every node's
-- id, name, kind and path (its column grant, 0066); each report narrows its own rows. Expand
-- only: sepehr_app's policies are unchanged.
CREATE POLICY org_nodes_report_read ON "org_nodes" FOR SELECT TO sepehr_report USING (true);
