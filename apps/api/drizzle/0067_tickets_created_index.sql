-- 0067 (task 7-4, found by the reports' EXPLAIN test): the tickets report lists by opening time,
-- newest first; without this index it read the whole table and sorted it. Expand only.
CREATE INDEX "tickets_created_idx" ON "tickets" ("created_at" DESC, "id" DESC);
