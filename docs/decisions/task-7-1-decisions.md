# تسک ۷-۱: تیکت

> **وضعیت:** نقشه و اجرا (حالت خودکار CLAUDE.md §۴؛ تسک غیرمالی، بی انتظار تأیید نقشه). ۱۴۰۵/۰۷/۱۶.
>
> **پایه:**
> - سند ۱۷ §۱ (بی بخش شکایت مالی، که ۷-۲ است) و §۸.
> - سند ۱۸، تسک ۷-۱.
> - سند ۰۴ §۳ (پشتیبانی تراکنش مالی را تغییر نمی‌دهد).
> - سند ۰۵ §۶ و ۳-۵ (موتور عمومی تخصیص `ASSIGNMENT_ENGINE`).
> - ۲-۸ (فایل خصوصی، ClamAV، نوع واقعی).
> - ۳-۴ (`support_requests`).
>
> **پذیرش:** آزمون‌های ۲، ۳ و ۱۱ سند ۱۷ §۹:
> - **IDOR:** پیوند به موجودیتی که ثبت‌کننده به آن دسترسی ندارد رد می‌شود.
> - **پیام داخلی:** برای بیمار یا مرکز دیده نمی‌شود.
> - **مهلت:** در `waiting_on_requester` متوقف می‌شود.
>
> **صفحه‌ها:** در ۷-۷ ساخته می‌شوند. این تسک API، مهاجرت، کار زمان‌بندی‌شده و آزمون است.

## TODO(decision) و انتخاب‌ها

| # | موضوع | انتخاب | چرا |
|---|---|---|---|
| ت۱ | مهلت پاسخ (۷.۵) | کلید `ticket.topics`، برای هر موضوع `responseHours`. **مقدار اولیه ۰ = بی مهلت** (قاعده عددهای کسب‌وکار، CLAUDE.md §۴). عدد مستند ۲۴ در `pending-client-decisions.md` می‌ماند. | دستور مالک ۱۴۰۵/۰۷/۱۴ مقدم است |
| ت۲ | «ساعت کاری» در مهلت | ساعت تقویمی. مثل ۳-۵: ساعات کاری تعریف نشده است. | همان پیش‌فرض ۳-۵ |
| ت۳ | مهلت reopen (۷.۴) | کلید `ticket.reopen_days`، **مقدار اولیه ۰ = reopen خاموش**؛ عدد مستند ۷ | قاعده عددها |
| ت۴ | هشدار پیش از سررسید | کلید `ticket.sla_warning_minutes`، **۰ = خاموش**؛ هشدار پس از گذشتن مهلت همیشه هست | قاعده عددها |
| ت۵ | مهلت «پاسخ» تا کجا | تا `resolved`. زمان `waiting_on_requester` کسر نمی‌شود (§۱ «مسیر») | توقف در انتظار فقط با مهلت حل معنا دارد |
| ت۶ | واحد مقصد | کد نقش (`support`، `accounting`، `collection`، …). صف موتور: `ticket_<unit>` (قاعده کد صف 0015 نقطه نمی‌پذیرد) | سند ۰۴ واحد را با نقش می‌شناسد |
| ت۷ | فهرست موضوع آغازین | `general` (support)، `appointment` (support)، `proforma_dispute` (support)، `service` (support)، `installment` (collection)، `payment` (accounting)، `statement` (accounting)؛ همه با مهلت ۰ | قابل‌ویرایش در پیکربندی؛ کارفرما فهرست را می‌دهد |
| ت۸ | پیوند «تراکنش» (کیف) | **در ۷-۱ ساخته نمی‌شود.** فقط شش نوع: نوبت، پیش‌فاکتور، خدمت، قسط، فیش، صورت‌وضعیت. | کیف کد مالی است. افزودن پیوند به ماژول wallet در ۷-۲ همراه شکایت مالی، با نقشه |
| ت۹ | مدیر واحد (گیرنده هشدار، تخصیص دستی) | مجوز `ticket.assign`: `strategy_manager`، `collection_manager`، `credit_manager`، `system_admin` | نقش «مدیر پشتیبانی» در سند ۰۴ نیست |
| ت۱۰ | شماره تیکت | `number` از sequence، فقط برای نمایش و تلفن؛ شناسه همچنان UUIDv7 | قاعده ۱۰ |
| ت۱۱ | پیوست «حاوی اطلاعات درمان» | ستون `contains_treatment` همین حالا ساخته می‌شود. **فیلتر دید معوقات در ۷-۲** (آزمون ۴ پذیرش ۷-۲ است) | add-only؛ بی مهاجرت دوباره |

## طراحی

### ماژول `ticket` (`apps/api/src/modules/ticket`)

- نامش در CLAUDE.md §۵ آمده است (سند ۱۷ نام `support` را پیشنهاد می‌کند، ولی همان CLAUDE.md ملاک است).
- **جدول‌ها:** با SQL صریح در سرویس، مثل `collection` (بی Drizzle schema). snapshot مهاجرت رونوشت قبلی است.
- **مرز ماژول:** هیچ جدول ماژول دیگری خوانده نمی‌شود.
  - **پیوند:** از درگاه تازه `TICKET_LINK_TARGETS` (`common/ticket`). هر ماژول مالک یک adapter فقط‌خواندنی می‌دهد:
    - booking: نوبت
    - proforma: پیش‌فاکتور
    - service: خدمت
    - repayment: قسط و فیش
    - settlement: صورت‌وضعیت
  - **کد موجود:** هیچ کد موجودی بازنویسی نمی‌شود. فقط فایل adapter تازه و یک خط provider.
  - **پیش‌فاکتور:** متن اعتراض بیمار با یک فیلد افزودنی `patientResponseNote` روی `ProformaRecord` به ماژول تیکت می‌رسد.

### مسیر وضعیت (لایه سرویس و trigger)

```
open → assigned → in_progress → waiting_on_requester → in_progress → resolved → closed
                                                                     ↘ reopened → in_progress
انتقال واحد (با دلیل): هر وضعیت باز → open (بی کارشناس، واحد تازه)
```

- **resolved از** `assigned`، `in_progress`، `waiting_on_requester` و `reopened`.
- **reopen:** فقط ثبت‌کننده، و فقط تا `reopen_days` پس از `resolved`.
- **closed:** با تأیید ثبت‌کننده، یا خودکار پس از گذشتن مهلت reopen در کار زمان‌بندی‌شده.

### مهلت

- `due_at = opened_at + responseHours`، از نسخه پیکربندی زمان ثبت (قاعده ۱۶؛ ساعت روی تیکت قفل می‌شود).
- **ورود به `waiting_on_requester`:** `paused_at` ثبت می‌شود.
- **خروج:** `due_at += now − paused_at`.
- **کار هر ۵ دقیقه** (`ticket-sweep`):
  - هشدار پیش از سررسید و پس از آن، **یک‌بار برای هر `due_at`**: رویداد `ticket.sla_warning` و `ticket.sla_breached`، و اعلان مدیر با شمار، بی داده شخصی (قاعده ۳۰).
  - تیکت در انتظار هرگز هشدار نمی‌گیرد.
  - تخصیص تیکت‌های بی کارشناس.
  - بستن خودکار.

### تخصیص

- `engine.pick({ queueCode: 'ticket_<unit>' })`. بار باز هر کارشناس از تیکت‌های باز همان واحد شمرده می‌شود.
- **بی کارشناس:** `open` می‌ماند و اعلان مدیر می‌آید.
- **دستی:** با `ticket.assign` و دلیل.

### دید

- **بیمار:** تیکت‌های خودش (حساب، یا شخص‌های ادغام‌شده)؛ فقط پیام و پیوست عمومی.
- **مرکز:** تیکت‌هایی که گره ثبتشان در حوزه کاربر است؛ فقط پیام و پیوست عمومی.
- **کارکنان:**
  - **`ticket.work`:** تیکت واحدهایی که نقششان را دارند.
  - **`ticket.read_all`:** همه، فقط‌خواندنی.
  - **پیام داخلی:** فقط کارکنان.

### support_requests (۳-۴)

- **مهاجرت داده در SQL:**
  - برای هر ردیف یک تیکت `proforma_dispute`، پیام اول همان متن، و پیوند به پیش‌فاکتور.
  - `source = 'proforma_dispute'` و `source_id = proforma`.
  - **یکتایی:** `(source, source_id)`.
  - **ردیف قبلی** حذف یا تغییر نمی‌شود (`legacy_support_request_id`).
- **از این به بعد:** مصرف‌کننده `proforma.disputed` در ماژول تیکت همان تیکت را می‌سازد.
  - **تکرار:** با `ON CONFLICT DO NOTHING` بی‌اثر است.
  - **ماژول proforma:** دست نمی‌خورد و همچنان `support_requests` را می‌نویسد.

## مهاجرت `0063_tickets` (خلاصه SQL، پیش از اجرا)

فقط افزودنی است. جدول ماژول دیگری تغییر نمی‌کند. `support_requests` فقط خوانده می‌شود.

1. **`CREATE SEQUENCE ticket_number_seq`.**
2. **`tickets`:**
   - **ستون‌ها:**
     - `id`، `number`، `kind` (CHECK `'ticket'`؛ ۷-۲ گسترش می‌دهد)، `topic_code`، `unit`، `subject`.
     - `requester_channel`: `patient`، `center` یا `staff`.
     - `requester_account_id`، `requester_person_id`، `requester_node_id`، `requester_node_path` (ltree).
     - `opened_by`، `status`، `assignee_account_id`.
     - `response_hours`، `config_version_id`، `due_at`، `paused_at`، `resolved_at`، `closed_at`، `reopened_count`.
     - `source`، `source_id`، `legacy_support_request_id`، `created_at`.
   - **CHECK:**
     - وضعیت.
     - کانال با ستون‌های ثبت‌کننده سازگار باشد.
     - `paused_at` فقط در `waiting_on_requester`.
     - `resolved_at` و `closed_at` با وضعیت سازگار باشند.
   - **یکتا:**
     - `number`.
     - `(source, source_id)` WHERE source IS NOT NULL.
   - **ایندکس:** `(unit, status)`، `assignee`، `requester_person_id`، `requester_account_id`، `requester_node_path` (gist)، `due_at` باز.
   - **trigger `tickets_guard`:**
     - فقط ستون‌های وضعیت عوض می‌شوند: `status`، `assignee`، `unit`، `due_at`، `paused_at`، `resolved_at`، `closed_at`، `reopened_count`.
     - مسیرهای مجاز بالا اعمال می‌شوند.
     - DELETE ممنوع است.
3. **`ticket_links`:**
   - **ستون‌ها:** `ticket_id`، `entity_type` (CHECK شش نوع)، `entity_id`، `label`، `created_by`، `created_at`.
   - **یکتا:** `(ticket_id, entity_type, entity_id)`.
   - **فقط‌افزودنی.**
4. **`ticket_messages`:**
   - **ستون‌ها:** `ticket_id`، `author_account_id`، `author_side` (`requester` یا `staff`)، `visibility` (`public` یا `internal`؛ CHECK: پیام ثبت‌کننده همیشه `public`)، `body` (۱ تا ۴۰۰۰)، `created_at`.
   - **فقط‌افزودنی.**
5. **`ticket_attachments`:**
   - **ستون‌ها:** `ticket_id`، `message_id`، `object_key`، `content_type`، `size_bytes`، `sha256`، `contains_treatment`، `uploaded_by`، `created_at`.
   - **فقط‌افزودنی.**
6. **`ticket_events`:**
   - **ستون‌ها:** `ticket_id`، `kind` (`opened`، `assigned`، `status`، `transferred`، `sla_warning`، `sla_breached`)، `from_status`، `to_status`، `from_unit`، `to_unit`، `assignee_account_id`، `reason`، `due_at`، `actor_account_id`، `created_at`.
   - **یکتا:** `(ticket_id, kind, due_at)` WHERE kind IN (`sla_warning`، `sla_breached`).
   - **فقط‌افزودنی.**
7. **GRANT به `sepehr_app`:**
   - SELECT و INSERT روی همه.
   - UPDATE فقط ستون‌های وضعیت `tickets`.
   - USAGE روی sequence.
   - هیچ DELETE.
8. **پیکربندی:**
   - **`ticket.topics`:** هفت موضوع ت۷، `responseHours: 0`.
   - **`ticket.reopen_days`:** ۰.
   - **`ticket.sla_warning_minutes`:** ۰.
   - همه `business` و `approved`.
9. **مجوزها:** `ticket.open_center`، `ticket.open_on_behalf`، `ticket.work`، `ticket.assign`، `ticket.read_all`.
10. **اعطاها:**
    - **`ticket.open_center`:** `center_manager`، `doctor`، `secretary`.
    - **`ticket.open_on_behalf`:** `support`، `advisor`.
    - **`ticket.work`:** `support`، `collection`، `accounting`، `network_specialist`، `case_completion`، `credit_specialist`، `advisor`.
    - **`ticket.assign`:** ت۹.
    - **`ticket.read_all`:** `ceo`، `auditor`.
11. **داده:** تیکت از هر `support_requests` (بالا)، `ON CONFLICT DO NOTHING`.

## آزمون‌ها (integration، Postgres واقعی)

- **آزمون ۲ (IDOR):**
  - بیمار به نوبت، پیش‌فاکتور یا فیش دیگری پیوند نمی‌دهد (۴۰۴).
  - مرکز به نوبت مرکز دیگر پیوند نمی‌دهد.
  - پیوند به موجودیت خودش پذیرفته می‌شود.
- **آزمون ۳ (پیام داخلی):**
  - بیمار و مرکز در پاسخ تیکت، فهرست پیام‌ها و پیوست‌ها پیام داخلی را نمی‌بینند. شمار و شناسه هم لو نمی‌رود.
  - کارکنان می‌بینند.
- **آزمون ۱۱ (توقف مهلت):**
  - تیکت با `responseHours` > ۰ در `waiting_on_requester` هشدار نمی‌گیرد، حتی پس از گذشتن `due_at` اولیه.
  - با پاسخ ثبت‌کننده، `due_at` به اندازه زمان انتظار جلو می‌رود.
  - سپس پس از گذشتن مهلت تازه، `sla_breached` یک‌بار ثبت می‌شود و اجرای دوم اثری ندارد.
- **دیگر:**
  - مسیر وضعیت (رد مسیر غیرمجاز در سرویس و trigger).
  - reopen در مهلت و پس از آن.
  - تخصیص با موتور.
  - انتقال با دلیل.
  - مهاجرت داده `support_requests`.
  - مصرف‌کننده `proforma.disputed` (یک‌بار).
  - پیوست (نوع واقعی، ClamAV).
  - مجوز هر endpoint.

## وضعیت پیشرفت (۱۴۰۵/۰۷/۱۶)

- **ساخته شد:**
  - **قراردادها:** `packages/contracts/src/ticket`، پنج مجوز، سه کلید پیکربندی و شش رویداد.
  - **درگاه:** `common/ticket/ticket-link-targets.port.ts`.
  - **adapterهای فقط‌خواندنی:** booking، proforma، service، repayment (`ReceiptUploadModule`، فقط API) و settlement (از قاعده خود پنل ۵-۶).
  - **ماژول تیکت:** سرویس، سه کنترلر (`me/tickets`، `panel/tickets`، `tickets`)، مصرف‌کننده `proforma.disputed` و کار `ticket-sweep` هر ۵ دقیقه در worker.
- **افزوده‌های کوچک به درگاه‌ها (فقط افزودنی، غیرمالی):**
  - `ProformaRecord.patientResponseNote`.
  - `LeadCases.personByMobile`، که فقط می‌خواند و شخص نمی‌سازد.
- **مهاجرت `0063_tickets`:**
  - **اعمال:** روی پایگاه محلی اعمال شد؛ مجموع ۶۴.
  - **پشتیبان:** `D:\sepehr_app\db-backups\sepehr-before-0063-20261008-103812.dump`.
  - **بررسی فقط‌خواندنی:**
    - پنج جدول و پنج trigger.
    - `sepehr_app` روی همه فقط SELECT/INSERT، و UPDATE فقط هشت ستون وضعیت `tickets`.
    - سه کلید پیکربندی (۷ موضوع، ۰ و ۰)، پنج مجوز و ۱۸ اعطا.
    - `support_requests` محلی ۰ ردیف دارد. مسیر کپی با آزمون integration پوشش داده شد.
- **فرق با نقشه:**
  - **کد صف موتور:** `ticket_<unit>` است، چون قاعده کد صف 0015 نقطه نمی‌پذیرد.
  - **کد اعلان مدیر:** `ticket_unassigned` و `ticket_sla_breached` است، چون قاعده کد 0009 نقطه نمی‌پذیرد.
  - **پیوست:** ستون `visibility` هم گرفت، تا پیوست داخلی کارکنان از ثبت‌کننده پنهان بماند.
- **پوشش آزمون پیوند:**
  - **با آزمون:** نوبت، پیش‌فاکتور، قسط و فیش؛ برای بیمار، مرکز و کارکنان.
  - **بی آزمون جدا:** خدمت و صورت‌وضعیت. هر دو قاعده خود ماژول مالک را صدا می‌زنند (`mine` و `reachByScope` خدمت، `statement` پنل ۵-۶).
- **آزمون integration تازه:** `test/ticket/tickets.int.test.ts`، ۱۲ از ۱۲ سبز.
  - آزمون‌های ۲، ۳ و ۱۱ سند ۱۷.
  - مسیر وضعیت (سرویس و trigger)، reopen، بستن خودکار، انتقال، تخصیص دستی، مصرف‌کننده، و کپی مهاجرت.
- **باگ‌های پیداشده در اجرای اول (کد خودم، اصلاح شد):**
  - کد اعلان با نقطه را CHECK رد می‌کرد.
  - انتظار آزمون خودم برای ارقام اشتباه بود. متن اعتراض پیش‌فاکتور با ارقام لاتین ذخیره می‌شود (قاعده ۲۳). ورودی آزمون همچنان فارسی است و انتظار با رفتار درست سامانه یکی شد.
- **باگ واقعی سوم (کد خودم، اصلاح شد):** context worker بالا نمی‌آمد.
  - **علت:** `ProformaDisputeTickets` درگاه `PROFORMA_DIRECTORY` را مستقیم تزریق می‌کرد. در worker این درگاه فقط provider داخلی `WorkerModule` است و به `TicketCoreModule` نمی‌رسد. در API پیدا نشد، چون `ProformaModule` سراسری است.
  - **اثر:** همه آزمون‌هایی که `WorkerModule` را بالا می‌آورند. در اجرای کامل اول، `ledger/reconciliation` با crash (exit 134) و چند فایل دیگر با مهلت `beforeAll` شکستند.
  - **اصلاح:** حل تنبل با `ModuleRef` (`strict: false`)، همان الگوی collection.
  - **نتیجه:** reconciliation و تیکت ۲۰ از ۲۰.
- **OpenAPI:**
  - هیچ endpointی حذف نشد.
  - ۲۵ endpoint افزوده شد.
  - سه عملیات `access` فقط فهرست مجوزها را عوض کردند.
- **آزمون موجود تغییرکرده (گسترش، نه ضعیف):** `test/outbox/outbox.int.test.ts`، «scheduled jobs are registered once».
  - **علت:** این آزمون فهرست کامل کارهای زمان‌بندی‌شده را می‌سنجد.
  - **تغییر:** `TICKET_SWEEP_JOB` به فهرست افزوده شد، با شرط تازه «هر ۳۰۰٬۰۰۰ میلی‌ثانیه»، همان‌طور که هر تسک قبلی کار خودش را افزوده است.
  - هیچ شرط قبلی حذف نشد.
- **turbo:** ۳۳ از ۳۳ (با `--continue`)، با drift پاک («Schema and migrations are in sync»).
  - **اجرای اول:** `api-client#test` با مهلت ۵ ثانیه زیر بار شکست. همان ب۶ است؛ تنها ۹ از ۹ سبز بود.
- **integration کامل، اجرای دوم (پس از اصلاح worker):** ۵۵ از ۶۲ فایل سبز.
  - **شکست واقعی یک آزمون:** فهرست کارهای زمان‌بندی‌شده (بالا).
  - **شش فایل دیگر** در `beforeAll` (راه‌اندازی container زیر بار) شکستند، یعنی هیچ آزمونی اجرا نشد. اجرای دوباره هر شش با آزمون outbox: ۶ از ۶ فایل و ۷۰ از ۷۰ آزمون.
  - **worker:** ۷ از ۷.
  - **آزمون ۱۰٬۰۰۰ انتخاب (ف۹):** جدا و تنها اجرا می‌شود.
- **آزمون ۱۰٬۰۰۰ انتخاب، تنها:** ۵ از ۵.
- **e2e:** ۳۵ از ۳۵. worker در stack بالا آمد، پس اصلاح DI worker هم تأیید شد.
- **lint، typecheck و drift دوباره پس از آخرین تغییر:** سبز.
- **وضعیت:** commit محلی ۷-۱.
