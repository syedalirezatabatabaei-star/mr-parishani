-- 0088 plan 3, f5 (owner 1405/07/24; ADR-043): the official holidays the panel suggests for a
-- year. Hand-written (ADR-003). Add only: one configuration key and its first value; no table,
-- column or existing row changes, and the holidays table is not touched: a suggestion is a
-- holiday only once the admin saves it. Summary: docs/decisions/task-plan3-holiday-rules-decisions.md §3.
--
-- Seeded with the seven fixed solar occasions only (owner 1405/07/24): Nowruz (1 to 4
-- Farvardin), 12 and 13 Farvardin, 14 and 15 Khordad, 22 Bahman and 29 Esfand; ten days. No
-- lunar day: those are entered by the admin after the official announcement, from the preview,
-- which marks them as estimates. TODO(decision): Aramesh Sarvat's accounting or legal confirms.
INSERT INTO "config_keys" ("code", "category", "sensitive") VALUES
  ('calendar.holiday_rules', 'business', true);--> statement-breakpoint
INSERT INTO "config_values" ("key", "scope_level", "value", "effective_at", "status", "reason", "decided_at") VALUES
  ('calendar.holiday_rules', 'global', '{
    "solar": [
      {"month": 1, "day": 1, "title": "عید نوروز"},
      {"month": 1, "day": 2, "title": "عید نوروز"},
      {"month": 1, "day": 3, "title": "عید نوروز"},
      {"month": 1, "day": 4, "title": "عید نوروز"},
      {"month": 1, "day": 12, "title": "روز جمهوری اسلامی"},
      {"month": 1, "day": 13, "title": "روز طبیعت"},
      {"month": 3, "day": 14, "title": "رحلت امام خمینی"},
      {"month": 3, "day": 15, "title": "قیام پانزده خرداد"},
      {"month": 11, "day": 22, "title": "پیروزی انقلاب اسلامی"},
      {"month": 12, "day": 29, "title": "روز ملی شدن صنعت نفت"}
    ],
    "lunar": []
  }',
   '2020-01-01T00:00:00Z', 'approved', 'مقدار اولیه (مهاجرت 0088)', now());
