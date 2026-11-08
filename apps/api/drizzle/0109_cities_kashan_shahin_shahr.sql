-- 0109 (owner asked for the draft 1405/08/07; the doctors' workbook has centers in Kashan and
-- Shahin Shahr). Add only: two rows in cities (0020), no UPDATE of the rows there; the table
-- refuses deletes and is read only for the application. Both active, like Isfahan, so a center
-- or a patient there can be registered with its own city.
INSERT INTO "cities" ("code", "name", "active", "sort_order") VALUES
  ('kashan', 'کاشان', true, 11),
  ('shahin_shahr', 'شاهین‌شهر', true, 12)
ON CONFLICT DO NOTHING;
