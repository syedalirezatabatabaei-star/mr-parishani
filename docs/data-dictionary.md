# فرهنگ داده

> **تولیدشده؛ دستی ویرایش نشود.** با `pnpm --filter @sepehr/api db:data-dictionary` از
> اسکیمای زنده ساخته می‌شود (تسک ۷-۶؛ سند ۱۷ §۷). توضیح جدول‌ها در
> `apps/api/data-dictionary/tables.json` و واژه‌های نام ستون‌ها در
> `apps/api/src/db/data-dictionary/tokens.ts` است.
>
> - **واحد:** از پسوند نام (`_rial` ریال، `_bps` صدم درصد، `_ms`، `_minutes`، …) یا نوع زمان.
> - **حساسیت:** «راز»، «رمزگذاری‌شده»، «نمایه کور» و «شخصی». نمای `analytics` هیچ ستون شخصی ندارد.

شمار جدول‌ها و نماها: 200

## `analytics.cases`

پرونده‌ها بی‌نام: شناسه جایگزین، وضعیت، صف، رشته، شهر، کانال و ماه ایجاد.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `case_pid` | `text` | بله | شناسه جایگزین پرونده |  |  |
| `person_pid` | `text` | بله | شناسه جایگزین شخص |  |  |
| `status` | `text` | بله | وضعیت |  |  |
| `queue_code` | `text` | بله | کد صف |  |  |
| `treatment_field_code` | `text` | بله | کد رشته درمانی |  |  |
| `city_code` | `text` | بله | کد شهر |  |  |
| `channel` | `text` | بله | کانال |  |  |
| `is_returning` | `boolean` | بله | آیا بازگشتی |  |  |
| `created_month` | `date` | بله | ماه ایجاد | روز |  |
| `closed_day` | `date` | بله | روز بسته‌شده | روز |  |
| `abandonment_reason_code` | `text` | بله | کد دلیل رهاشدن |  |  |

## `analytics.credit_applications`

پرونده‌های اعتباری بی‌نام: طرح، مبالغ، نتیجه، رتبه و رعایت مهلت پاسخ.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `application_pid` | `text` | بله | شناسه جایگزین پرونده اعتباری |  |  |
| `case_pid` | `text` | بله | شناسه جایگزین پرونده |  |  |
| `borrower_pid` | `text` | بله | شناسه جایگزین وام‌گیرنده |  |  |
| `status` | `text` | بله | وضعیت |  |  |
| `plan_code` | `text` | بله | کد طرح |  |  |
| `installment_count` | `integer` | بله | شمار قسط |  |  |
| `loan_rial` | `bigint` | بله | وام | ریال |  |
| `down_payment_rial` | `bigint` | بله | پیش‌پرداخت | ریال |  |
| `plan_fee_rial` | `bigint` | بله | کارمزد طرح | ریال |  |
| `total_obligation_rial` | `bigint` | بله | تعهد جمع | ریال |  |
| `submitted_day` | `date` | بله | روز ارسال | روز |  |
| `final_outcome` | `text` | بله | نتیجه نهایی |  |  |
| `grade` | `text` | بله | رتبه |  |  |
| `out_of_matrix` | `boolean` | بله | ماتریس از خارج |  |  |
| `sla_met` | `boolean` | بله | رعایت‌شده مهلت پاسخ |  |  |

## `analytics.installments`

اقساط بی‌نام: سررسید، مبلغ، پرداخت‌شده، مانده و روزهای تأخیر.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `installment_pid` | `text` | بله | شناسه جایگزین قسط |  |  |
| `schedule_pid` | `text` | بله | شناسه جایگزین جدول اقساط |  |  |
| `case_pid` | `text` | بله | شناسه جایگزین پرونده |  |  |
| `index` | `integer` | بله | ردیف |  |  |
| `due_on` | `date` | بله | روز سررسید | روز |  |
| `amount_rial` | `bigint` | بله | مبلغ | ریال |  |
| `paid_rial` | `bigint` | بله | پرداخت‌شده | ریال |  |
| `outstanding_rial` | `bigint` | بله | مانده | ریال |  |
| `status` | `text` | بله | وضعیت |  |  |
| `days_past_due` | `integer` | بله | سررسید گذشته روزها |  |  |
| `as_of` | `date` | بله | از تا | روز |  |

## `analytics.pseudonym_key`

کلید تصادفی شناسه‌های جایگزین؛ فقط مالک پایگاه داده آن را می‌خواند.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `key` | `text` | خیر | کلید |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `analytics.tickets`

تیکت‌ها بی‌نام و بی‌متن: نوع، موضوع، واحد، وضعیت و زمان پاسخ.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `ticket_pid` | `text` | بله | شناسه جایگزین تیکت |  |  |
| `requester_pid` | `text` | بله | شناسه جایگزین درخواست‌کننده |  |  |
| `kind` | `text` | بله | نوع |  |  |
| `topic_code` | `text` | بله | کد موضوع |  |  |
| `unit` | `text` | بله | واحد |  |  |
| `status` | `text` | بله | وضعیت |  |  |
| `requester_channel` | `text` | بله | کانال درخواست‌کننده |  |  |
| `response_hours` | `integer` | بله | پاسخ | ساعت |  |
| `created_day` | `date` | بله | روز ایجاد | روز |  |
| `resolved_day` | `date` | بله | روز حل‌شده | روز |  |
| `breached` | `boolean` | بله | گذشته از مهلت |  |  |
| `reopened_count` | `integer` | بله | شمار بازگشایی‌شده |  |  |

## `public.abandonment_reasons`

دلیل‌های رهاشدن پرونده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `title` | `text` | خیر | عنوان |  |  |
| `sort_order` | `integer` | خیر | ترتیب ترتیب |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.access_logs`

سابقه دیدن داده‌های حساس: چه کسی، کدام رکورد، کی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `session_id` | `uuid` | بله | شناسه نشست |  |  |
| `ip` | `text` | بله | نشانی IP |  | شخصی |
| `entity_type` | `text` | خیر | نوع شخص |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |

## `public.access_policy_versions`

نسخه‌های سیاست دسترسی با تغییر دونفره.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `policy_key` | `text` | خیر | کلید سیاست |  |  |
| `value` | `jsonb` | خیر | مقدار |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `proposed_by` | `uuid` | بله | حساب پیشنهاد |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.account_balances`

مانده حساب‌های دفتر کل (نگهداری‌شده از جمع ثبت‌ها).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `debit_rial` | `bigint` | خیر | بدهکار | ریال |  |
| `credit_rial` | `bigint` | خیر | اعتبار | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.admin_notices`

اعلان‌های پنل مدیر.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `audience_permission` | `text` | خیر | مجوز مخاطب |  |  |
| `message` | `text` | خیر | پیام |  |  |
| `first_raised_at` | `timestamp with time zone` | خیر | زمان اعلام‌شده نخستین | زمان UTC |  |
| `last_raised_at` | `timestamp with time zone` | خیر | زمان اعلام‌شده آخرین | زمان UTC |  |
| `raise_count` | `integer` | خیر | شمار اعلام |  |  |
| `resolved_at` | `timestamp with time zone` | بله | زمان حل‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.agent_caps`

سقف پرونده باز هر کارشناس.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `max_open_cases` | `integer` | بله | پرونده‌ها باز بیشینه |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.agent_presence`

حضور کارشناسان برای تخصیص.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.appointment_notices`

پیام‌های نوبت (یادآوری، لغو، جابه‌جایی).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `appointment_id` | `uuid` | خیر | شناسه نوبت |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `offset_minutes` | `integer` | خیر | جابه‌جایی | دقیقه |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.appointment_status_changes`

سابقه وضعیت نوبت‌ها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `appointment_id` | `uuid` | خیر | شناسه نوبت |  |  |
| `from_status` | `text` | بله | وضعیت از |  |  |
| `to_status` | `text` | خیر | وضعیت به |  |  |
| `actor_account_id` | `uuid` | بله | شناسه حساب کنشگر |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.appointments`

نوبت‌ها: بیمار، پزشک، محل کار، زمان و وضعیت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `patient_account_id` | `uuid` | بله | شناسه حساب بیمار |  |  |
| `mobile` | `text` | خیر | موبایل |  | شخصی |
| `person_id` | `uuid` | بله | شناسه شخص |  |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `service_code` | `text` | خیر | کد خدمت |  |  |
| `starts_at` | `timestamp with time zone` | خیر | زمان آغاز | زمان UTC |  |
| `ends_at` | `timestamp with time zone` | خیر | زمان پایان | زمان UTC |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `channel` | `text` | خیر | کانال |  |  |
| `hold_expires_at` | `timestamp with time zone` | خیر | زمان انقضا نگه‌داشت | زمان UTC |  |
| `approval_mode` | `text` | بله | حالت تأیید |  |  |
| `approval_mode_version_id` | `uuid` | بله | شناسه نسخه حالت تأیید |  |  |
| `approval_due_at` | `timestamp with time zone` | بله | زمان سررسید تأیید | زمان UTC |  |
| `tariff_version_id` | `uuid` | خیر | شناسه نسخه تعرفه |  |  |
| `tariff_is_free` | `boolean` | خیر | آزاد آیا تعرفه |  |  |
| `tariff_min_amount_rial` | `bigint` | خیر | مبلغ کمینه تعرفه | ریال |  |
| `tariff_max_amount_rial` | `bigint` | خیر | مبلغ بیشینه تعرفه | ریال |  |
| `check_in_code` | `text` | بله | کد ورودی بررسی |  |  |
| `check_in_attempts` | `integer` | خیر | تلاش‌ها ورودی بررسی |  |  |
| `checked_in_at` | `timestamp with time zone` | بله | زمان ورودی بررسی‌شده | زمان UTC |  |
| `rescheduled_from_id` | `uuid` | بله | شناسه از جابه‌جاشده |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `idempotency_key` | `text` | بله | کلید عدم تکرار |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.assignment_rr_state`

وضعیت چرخش نوبتی تخصیص.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `version_id` | `uuid` | خیر | شناسه نسخه |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `current_weight` | `integer` | خیر | وزن جاری |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.assignment_weight_versions`

نسخه‌های وزن تخصیص درصدی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `queue_code` | `text` | خیر | کد صف |  |  |
| `city_code` | `text` | بله | کد شهر |  |  |
| `treatment_field_code` | `text` | بله | کد رشته درمانی |  |  |
| `effective_at` | `timestamp with time zone` | خیر | زمان مؤثر | زمان UTC |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.assignment_weights`

وزن هر کارشناس در تخصیص درصدی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `version_id` | `uuid` | خیر | شناسه نسخه |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `percent` | `integer` | خیر | درصد |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.audit_events`

رویدادهای ممیزی فقط‌افزودنی با زنجیره درهم‌سازی: کاربر، عمل، قبل و بعد، دلیل، IP و نشست.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `seq` | `bigint` | خیر | ترتیب |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `actor_account_id` | `uuid` | بله | شناسه حساب کنشگر |  |  |
| `actor_session_id` | `uuid` | بله | شناسه نشست کنشگر |  |  |
| `actor_ip` | `text` | بله | نشانی IP کنشگر |  | شخصی |
| `actor_roles` | `text[]` | خیر | نقش‌ها کنشگر |  |  |
| `action` | `text` | خیر | اقدام |  |  |
| `entity_type` | `text` | خیر | نوع شخص |  |  |
| `entity_id` | `text` | بله | شناسه شخص |  |  |
| `before` | `jsonb` | بله | پیش از |  |  |
| `after` | `jsonb` | بله | پس از |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `prev_hash` | `text` | خیر | درهم‌سازی پیشین |  |  |
| `hash` | `text` | خیر | درهم‌سازی |  |  |
| `on_behalf_of_doctor_id` | `uuid` | بله | شناسه پزشک از از طرف |  |  |

## `public.availability_exceptions`

استثناهای تقویم کاری: مرخصی یا شیفت اضافه.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `on_day` | `date` | خیر | روز روز | روز |  |
| `kind` | `text` | خیر | نوع |  |  |
| `start_minute` | `integer` | بله | دقیقه آغاز |  |  |
| `end_minute` | `integer` | بله | دقیقه پایان |  |  |
| `slot_minutes` | `integer` | بله | زمان آزاد | دقیقه |  |
| `service_codes` | `text[]` | خیر | کدها خدمت |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `deleted_by` | `uuid` | بله | حساب حذف‌کننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.bank_statement_column_maps`

نگاشت ستون‌های صورت‌حساب بانک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `column_map` | `jsonb` | خیر | نگاشت ستون |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.bank_statement_imports`

ورود صورت‌حساب بانک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `file_sha256` | `text` | خیر | SHA-256 فایل |  |  |
| `file_key` | `text` | خیر | کلید فایل |  |  |
| `column_map` | `jsonb` | خیر | نگاشت ستون |  |  |
| `rows_count` | `integer` | خیر | شمار ردیف‌ها |  |  |
| `total_rial` | `bigint` | خیر | جمع | ریال |  |
| `uploaded_by` | `uuid` | بله | حساب بارگذاری |  |  |
| `uploaded_at` | `timestamp with time zone` | خیر | زمان بارگذاری | زمان UTC |  |

## `public.bank_statement_rows`

ردیف‌های صورت‌حساب بانک و تطبیقشان.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `import_id` | `uuid` | خیر | شناسه ورود گروهی |  |  |
| `row_no` | `integer` | خیر | شماره ردیف |  |  |
| `paid_on` | `date` | بله | روز پرداخت‌شده | روز |  |
| `amount_rial` | `bigint` | بله | مبلغ | ریال |  |
| `bank_ref` | `text` | بله | مرجع بانک |  |  |
| `bank_ref_norm` | `text` | بله | یکسان‌شده مرجع بانک |  |  |
| `description` | `text` | بله | شرح |  |  |
| `match_kind` | `text` | خیر | نوع تطبیق |  |  |
| `suggested_payment_id` | `uuid` | بله | شناسه پرداخت پیشنهادی |  |  |
| `reviewed_by` | `uuid` | بله | حساب بازبینی |  |  |
| `reviewed_at` | `timestamp with time zone` | بله | زمان بازبینی | زمان UTC |  |
| `review_note` | `text` | بله | یادداشت بازبینی |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.borrower_status_events`

رویدادهای وضعیت وام‌گیرنده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `evidence_key` | `text` | خیر | کلید مستند |  |  |
| `evidence_mime` | `text` | خیر | نوع MIME مستند |  |  |
| `evidence_sha256` | `text` | خیر | SHA-256 مستند |  |  |
| `note` | `text` | خیر | یادداشت |  |  |
| `proposed_by` | `uuid` | خیر | حساب پیشنهاد |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `approved_by` | `uuid` | بله | حساب تأییدشده |  |  |
| `approved_at` | `timestamp with time zone` | بله | زمان تأییدشده | زمان UTC |  |

## `public.branches`

شعبه‌های مراکز: نشانی، موقعیت و دسترسی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `node_id` | `uuid` | خیر | شناسه گره سازمانی |  |  |
| `center_id` | `uuid` | خیر | شناسه مرکز |  |  |
| `name` | `text` | خیر | نام |  |  |
| `is_default` | `boolean` | خیر | آیا پیش‌فرض |  |  |
| `address` | `text` | بله | نشانی |  | شخصی |
| `latitude_e6` | `integer` | بله | عرض جغرافیایی | میلیونیم درجه |  |
| `longitude_e6` | `integer` | بله | طول جغرافیایی | میلیونیم درجه |  |
| `phone` | `text` | بله | تلفن |  | شخصی |
| `parking` | `text` | بله | پارکینگ |  |  |
| `nearest_metro` | `text` | بله | ایستگاه مترو نزدیک‌ترین |  |  |
| `nearest_brt` | `text` | بله | ایستگاه اتوبوس تندرو نزدیک‌ترین |  |  |
| `route_note` | `text` | بله | یادداشت مسیر |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.case_assignments`

سابقه سپردن پرونده به کارشناس.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `weight_version_id` | `uuid` | بله | شناسه نسخه وزن |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.case_completion_alerts`

هشدارهای تکمیل‌نشدن پرونده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `status_at_settlement` | `text` | خیر | تسویه زمان وضعیت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.case_completions`

تکمیل پرونده پس از قرارداد.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `completed_by` | `uuid` | خیر | حساب تکمیل‌شده |  |  |
| `completed_at` | `timestamp with time zone` | خیر | زمان تکمیل‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.case_intakes`

ورودهای سرنخ به پرونده، با کانال و برچسب UTM.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `category` | `text` | خیر | دسته |  |  |
| `channel` | `text` | خیر | کانال |  |  |
| `mobile` | `text` | خیر | موبایل |  | شخصی |
| `name` | `text` | بله | نام |  | شخصی |
| `treatment_field_code` | `text` | خیر | کد رشته درمانی |  |  |
| `city_code` | `text` | بله | کد شهر |  |  |
| `sms_consent` | `boolean` | خیر | رضایت پیامک |  |  |
| `utm` | `jsonb` | بله | برچسب UTM |  |  |
| `page_url` | `text` | بله | نشانی وب صفحه |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `import_batch_id` | `uuid` | بله | شناسه دسته ورود گروهی |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `referrer` | `text` | بله | ارجاع‌دهنده |  |  |

## `public.case_overdue`

وضعیت معوق هر پرونده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `max_days_past_due` | `integer` | بله | سررسید گذشته روزها بیشینه |  |  |
| `overdue_installments` | `bigint` | بله | اقساط معوق |  |  |
| `overdue_rial` | `numeric` | بله | معوق | ریال |  |
| `as_of` | `date` | بله | از تا | روز |  |

## `public.case_status_changes`

سابقه وضعیت پرونده‌ها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `from_status` | `text` | بله | وضعیت از |  |  |
| `to_status` | `text` | خیر | وضعیت به |  |  |
| `reason_code` | `text` | بله | کد دلیل |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `actor_account_id` | `uuid` | بله | شناسه حساب کنشگر |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.cases`

پرونده‌های سرنخ و فروش: شخص، صف، رشته، شهر و وضعیت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `queue_code` | `text` | خیر | کد صف |  |  |
| `treatment_field_code` | `text` | خیر | کد رشته درمانی |  |  |
| `city_code` | `text` | بله | کد شهر |  |  |
| `channel` | `text` | خیر | کانال |  |  |
| `is_returning` | `boolean` | خیر | آیا بازگشتی |  |  |
| `previous_case_id` | `uuid` | بله | شناسه پرونده پیشین |  |  |
| `assignee_account_id` | `uuid` | بله | شناسه حساب کارشناس مسئول |  |  |
| `abandonment_reason_code` | `text` | بله | کد دلیل رهاشدن |  |  |
| `abandonment_note` | `text` | بله | یادداشت رهاشدن |  |  |
| `closed_at` | `timestamp with time zone` | بله | زمان بسته‌شده | زمان UTC |  |
| `import_batch_id` | `uuid` | بله | شناسه دسته ورود گروهی |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.cash_services`

خدمات نقدی (بی کیف اعتبار).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `referral_id` | `uuid` | خیر | شناسه معرفی |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `doctor_node_id` | `uuid` | خیر | شناسه گره سازمانی پزشک |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `center_node_id` | `uuid` | خیر | شناسه گره سازمانی مرکز |  |  |
| `treatment_field_code` | `text` | خیر | کد رشته درمانی |  |  |
| `service_date` | `date` | خیر | تاریخ خدمت | روز |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `source` | `text` | خیر | منبع |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `recorded_by` | `uuid` | خیر | حساب ثبت |  |  |
| `recorded_at` | `timestamp with time zone` | خیر | زمان ثبت | زمان UTC |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.catalog_import_batches`

دسته‌های ورود گروهی مراکز و پزشکان.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `created_by` | `uuid` | خیر | حساب ایجادکننده |  |  |
| `summary` | `jsonb` | خیر | خلاصه |  |  |
| `committed_at` | `timestamp with time zone` | بله | زمان قطعی‌شده | زمان UTC |  |
| `processed_at` | `timestamp with time zone` | بله | زمان پردازش‌شده | زمان UTC |  |
| `cancelled_at` | `timestamp with time zone` | بله | زمان لغوشده | زمان UTC |  |
| `cancel_reason` | `text` | بله | دلیل لغو |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.catalog_import_rows`

ردیف‌های ورود گروهی کاتالوگ.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `batch_id` | `uuid` | خیر | شناسه دسته |  |  |
| `sheet` | `text` | خیر | برگه |  |  |
| `row_number` | `integer` | خیر | شماره ردیف |  |  |
| `ref` | `text` | بله | مرجع |  |  |
| `center_ref` | `text` | بله | مرجع مرکز |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `problems` | `jsonb` | خیر | ایرادها |  |  |
| `data` | `jsonb` | بله | داده |  |  |
| `entity_id` | `uuid` | بله | شناسه شخص |  |  |
| `failure` | `text` | بله | شکست |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.center_change_requests`

درخواست‌های تغییر اطلاعات مرکز، با تأیید.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `center_id` | `uuid` | خیر | شناسه مرکز |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `sheba_enc` | `text` | بله | شبا |  | رمزگذاری‌شده، شخصی |
| `sheba_index` | `text` | بله | نمایه کور شبا |  | نمایه کور |
| `sheba_last4` | `text` | بله | چهار رقم آخر شبا |  | شخصی |
| `account_holder_name` | `text` | بله | نام دارنده حساب |  | شخصی |
| `reason` | `text` | خیر | دلیل |  |  |
| `proposed_by` | `uuid` | خیر | حساب پیشنهاد |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_note` | `text` | بله | یادداشت تصمیم |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.center_documents`

مدارک مراکز.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `center_id` | `uuid` | خیر | شناسه مرکز |  |  |
| `code` | `text` | خیر | کد |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `updated_by` | `uuid` | بله | حساب به‌روزرسانی |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.center_status_changes`

سابقه وضعیت مراکز.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `center_id` | `uuid` | خیر | شناسه مرکز |  |  |
| `from_status` | `text` | خیر | وضعیت از |  |  |
| `to_status` | `text` | خیر | وضعیت به |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `changed_by` | `uuid` | بله | حساب تغییریافته |  |  |
| `request_id` | `uuid` | بله | شناسه درخواست |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.center_treatment_fields`

رشته‌های درمانی هر مرکز.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `center_id` | `uuid` | خیر | شناسه مرکز |  |  |
| `field_code` | `text` | خیر | کد رشته |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.centers`

مراکز درمانی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `node_id` | `uuid` | خیر | شناسه گره سازمانی |  |  |
| `person_type` | `text` | خیر | نوع شخص |  |  |
| `name` | `text` | خیر | نام |  |  |
| `city_code` | `text` | خیر | کد شهر |  |  |
| `address` | `text` | بله | نشانی |  | شخصی |
| `latitude_e6` | `integer` | بله | عرض جغرافیایی | میلیونیم درجه |  |
| `longitude_e6` | `integer` | بله | طول جغرافیایی | میلیونیم درجه |  |
| `phone` | `text` | بله | تلفن |  | شخصی |
| `license_number` | `text` | بله | شماره پروانه |  |  |
| `identifier_enc` | `text` | خیر | شناسه |  | رمزگذاری‌شده |
| `identifier_index` | `text` | خیر | ردیف شناسه |  |  |
| `identifier_last4` | `text` | خیر | چهار رقم آخر شناسه |  |  |
| `sheba_enc` | `text` | بله | شبا |  | رمزگذاری‌شده، شخصی |
| `sheba_index` | `text` | بله | نمایه کور شبا |  | نمایه کور |
| `sheba_last4` | `text` | بله | چهار رقم آخر شبا |  | شخصی |
| `account_holder_name` | `text` | بله | نام دارنده حساب |  | شخصی |
| `status` | `text` | خیر | وضعیت |  |  |
| `checklist_config_version_id` | `uuid` | بله | شناسه نسخه پیکربندی فهرست بررسی |  |  |
| `first_activated_at` | `timestamp with time zone` | بله | زمان فعال‌شده نخستین | زمان UTC |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.cities`

شهرها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `name` | `text` | خیر | نام |  |  |
| `active` | `boolean` | خیر | فعال |  |  |
| `sort_order` | `integer` | خیر | ترتیب ترتیب |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.club_membership_revocations`

پایان زودتر یک عضویت باشگاه از یک روز به بعد، یک بار؛ فقط‌افزودنی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `membership_id` | `uuid` | خیر | شناسه عضویت |  |  |
| `revoked_on` | `date` | خیر | روز ابطال | روز |  |
| `recorded_by` | `uuid` | خیر | حساب ثبت |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.club_memberships`

عضویت باشگاه مشتریان با روز شروع و پایان، ثبت‌کننده و دلیل؛ فقط‌افزودنی (ADR-048).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `starts_on` | `date` | خیر | روز آغاز | روز |  |
| `ends_on` | `date` | بله | روز پایان | روز |  |
| `recorded_by` | `uuid` | خیر | حساب ثبت |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.collection_actions`

اقدام‌های وصول (تماس، پیامک، پیگیری).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `item_id` | `uuid` | خیر | شناسه قلم |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `actor_account_id` | `uuid` | بله | شناسه حساب کنشگر |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `outcome` | `text` | خیر | نتیجه |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `occurred_at` | `timestamp with time zone` | خیر | زمان رخ‌داده | زمان UTC |  |
| `next_follow_up_at` | `timestamp with time zone` | بله | زمان پیگیری بعدی | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.collection_assignments`

سپردن پرونده معوق به کارشناس وصول.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `item_id` | `uuid` | خیر | شناسه قلم |  |  |
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `weight_version_id` | `uuid` | بله | شناسه نسخه وزن |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.collection_items`

قلم‌های وصول.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `opened_at` | `timestamp with time zone` | خیر | زمان بازشده | زمان UTC |  |
| `assignee_account_id` | `uuid` | بله | شناسه حساب کارشناس مسئول |  |  |
| `closed_at` | `timestamp with time zone` | بله | زمان بسته‌شده | زمان UTC |  |
| `close_reason` | `text` | بله | دلیل بستن |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.collection_tasks`

کارهای وصول با تأیید.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `item_id` | `uuid` | خیر | شناسه قلم |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `stage` | `integer` | خیر | مرحله |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `promise_id` | `uuid` | بله | شناسه قول |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `proposed_by` | `uuid` | بله | حساب پیشنهاد |  |  |
| `proposed_at` | `timestamp with time zone` | بله | زمان پیشنهاد | زمان UTC |  |
| `proposal_note` | `text` | بله | یادداشت پیشنهاد |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_note` | `text` | بله | یادداشت تصمیم |  |  |

## `public.completion_receipts`

رسیدهای تکمیل پرونده (پیش‌پرداخت و مانند آن).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `expected_rial` | `bigint` | خیر | مورد انتظار | ریال |  |
| `paid_on` | `date` | خیر | روز پرداخت‌شده | روز |  |
| `reference` | `text` | خیر | مرجع |  |  |
| `storage_key` | `text` | خیر | کلید ذخیره‌ساز |  |  |
| `mime` | `text` | خیر | نوع MIME |  |  |
| `size_bytes` | `integer` | خیر | اندازه | بایت |  |
| `sha256` | `text` | خیر | SHA-256 |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `rejection_reason` | `text` | بله | دلیل رد |  |  |
| `journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری |  |  |
| `uploaded_by` | `uuid` | خیر | حساب بارگذاری |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.completion_refunds`

بازپرداخت‌های تکمیل پرونده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `receipt_id` | `uuid` | خیر | شناسه رسید |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `borrower_person_id` | `uuid` | خیر | شناسه شخص وام‌گیرنده |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `journal_entry_id` | `uuid` | خیر | شناسه ثبت سند حسابداری |  |  |
| `cancellation_id` | `uuid` | خیر | شناسه لغو |  |  |
| `created_by` | `uuid` | خیر | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.config_keys`

کلیدهای پیکربندی: نوع، واحد و حساسیت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `category` | `text` | خیر | دسته |  |  |
| `sensitive` | `boolean` | خیر | حساس |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.config_values`

مقادیر نسخه‌دار پیکربندی، با تغییر دونفره و دامنه.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `key` | `text` | خیر | کلید |  |  |
| `scope_level` | `text` | خیر | سطح دامنه |  |  |
| `scope_ref` | `text` | بله | مرجع دامنه |  |  |
| `value` | `jsonb` | بله | مقدار |  |  |
| `effective_at` | `timestamp with time zone` | بله | زمان مؤثر | زمان UTC |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `proposed_by` | `uuid` | بله | حساب پیشنهاد |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.contract_acceptances`

پذیرش قرارداد توسط وام‌گیرنده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `contract_id` | `uuid` | خیر | شناسه قرارداد |  |  |
| `role` | `text` | خیر | نقش |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `guarantor_id` | `uuid` | بله | شناسه ضامن |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `template_version_id` | `uuid` | خیر | شناسه نسخه الگو |  |  |
| `pdf_sha256` | `text` | خیر | SHA-256 PDF |  |  |
| `session_id` | `uuid` | بله | شناسه نشست |  |  |
| `ip` | `text` | بله | نشانی IP |  | شخصی |
| `device_id` | `text` | بله | شناسه دستگاه |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.contract_number_sequences`

دنباله شماره قرارداد.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `jalali_year` | `integer` | خیر | سال شمسی |  |  |
| `last_value` | `integer` | خیر | مقدار آخرین |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.contract_penalty_terms`

شرط‌های جریمه قفل‌شده روی قرارداد.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `contract_id` | `uuid` | خیر | شناسه قرارداد |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `penalty_bps` | `integer` | خیر | جریمه | صدم درصد |  |
| `source` | `text` | خیر | منبع |  |  |
| `config_version_id` | `uuid` | بله | شناسه نسخه پیکربندی |  |  |
| `override_id` | `uuid` | بله | شناسه استثنا |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.contracts`

قراردادهای وام به نام آرامش ثروت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `jalali_year` | `integer` | خیر | سال شمسی |  |  |
| `sequence` | `integer` | خیر | دنباله |  |  |
| `number` | `text` | خیر | شماره |  |  |
| `template_version_id` | `uuid` | خیر | شناسه نسخه الگو |  |  |
| `fields` | `jsonb` | خیر | رشته‌ها |  |  |
| `sample` | `boolean` | خیر | نمونه |  |  |
| `parties` | `jsonb` | خیر | طرفین |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `storage_key` | `text` | بله | کلید ذخیره‌ساز |  |  |
| `sha256` | `text` | بله | SHA-256 |  |  |
| `size_bytes` | `integer` | بله | اندازه | بایت |  |
| `failure` | `text` | بله | شکست |  |  |
| `generated_at` | `timestamp with time zone` | بله | زمان تولیدشده | زمان UTC |  |
| `accepted_at` | `timestamp with time zone` | بله | زمان پذیرفته‌شده | زمان UTC |  |
| `created_by` | `uuid` | خیر | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.credit_application_assignments`

سپردن پرونده اعتباری به کارشناس.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `queue_code` | `text` | خیر | کد صف |  |  |
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `weight_version_id` | `uuid` | بله | شناسه نسخه وزن |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.credit_application_cancellations`

درخواست‌های لغو پرونده اعتباری.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `requested_at` | `timestamp with time zone` | خیر | زمان درخواست | زمان UTC |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `result` | `jsonb` | بله | نتیجه |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.credit_application_status_changes`

سابقه وضعیت پرونده‌های اعتباری.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `from_status` | `text` | بله | وضعیت از |  |  |
| `to_status` | `text` | خیر | وضعیت به |  |  |
| `actor_account_id` | `uuid` | بله | شناسه حساب کنشگر |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.credit_applications`

پرونده‌های اعتباری (درخواست وام): طرح، مبالغ و وضعیت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `proforma_id` | `uuid` | خیر | شناسه پیش‌فاکتور |  |  |
| `patient_person_id` | `uuid` | خیر | شناسه شخص بیمار |  |  |
| `borrower_person_id` | `uuid` | خیر | شناسه شخص وام‌گیرنده |  |  |
| `created_by` | `uuid` | خیر | حساب ایجادکننده |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `plan_code` | `text` | خیر | کد طرح |  |  |
| `plan_title` | `text` | خیر | عنوان طرح |  |  |
| `plans_version_id` | `uuid` | خیر | شناسه نسخه طرح‌ها |  |  |
| `rounding_version_id` | `uuid` | خیر | شناسه نسخه گردکردن |  |  |
| `reduction_version_id` | `uuid` | خیر | شناسه نسخه کاهش |  |  |
| `installment_count` | `integer` | خیر | شمار قسط |  |  |
| `proforma_total_rial` | `bigint` | خیر | جمع پیش‌فاکتور | ریال |  |
| `down_payment_rial` | `bigint` | خیر | پیش‌پرداخت | ریال |  |
| `loan_rial` | `bigint` | خیر | وام | ریال |  |
| `cash_top_up_rial` | `bigint` | خیر | افزایش نقدی | ریال |  |
| `plan_fee_rial` | `bigint` | خیر | کارمزد طرح | ریال |  |
| `plan_fee_timing` | `text` | خیر | زمان‌بندی کارمزد طرح |  |  |
| `origination_fee_rial` | `bigint` | خیر | کارمزد تشکیل | ریال |  |
| `total_obligation_rial` | `bigint` | خیر | تعهد جمع | ریال |  |
| `needs_more_guarantors` | `boolean` | خیر | ضامن‌ها بیشتر نیازمند |  |  |
| `submitted_at` | `timestamp with time zone` | بله | زمان ارسال | زمان UTC |  |
| `sla_due_at` | `timestamp with time zone` | بله | زمان سررسید مهلت پاسخ | زمان UTC |  |
| `sla_breached_at` | `timestamp with time zone` | بله | زمان گذشته از مهلت مهلت پاسخ | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |
| `ruleset_version_id` | `uuid` | بله | شناسه نسخه مجموعه قاعده |  |  |
| `borrower_grade` | `text` | بله | رتبه وام‌گیرنده |  |  |
| `amount_level` | `text` | بله | سطح مبلغ |  |  |
| `checklist_version_id` | `uuid` | بله | شناسه نسخه فهرست بررسی |  |  |
| `decision_authority` | `text` | بله | مرجع تصمیم |  |  |
| `guarantee_requirement` | `text` | بله | الزام ضمانت |  |  |
| `sufficiency` | `text` | بله | کفایت |  |  |
| `approved_amount_rial` | `bigint` | بله | مبلغ تأییدشده | ریال |  |
| `decision` | `text` | بله | تصمیم |  |  |
| `conditions` | `jsonb` | بله | شرط‌ها |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `case_group_id` | `uuid` | بله | شناسه گروه پرونده |  |  |
| `approved_cash_top_up_rial` | `bigint` | بله | افزایش نقدی تأییدشده | ریال |  |
| `shortfall_kind` | `text` | بله | نوع کسری |  |  |
| `shift_version_id` | `uuid` | خیر | شناسه نسخه جابه‌جایی سررسید |  |  |
| `grace_version_id` | `uuid` | خیر | شناسه نسخه مهلت ارفاق |  |  |
| `club_membership_id` | `uuid` | بله | شناسه عضویت باشگاه |  |  |
| `wage_rial` | `bigint` | بله | دستمزد | ریال |  |
| `material_cash_rial` | `bigint` | خیر | نقدی مواد | ریال |  |

## `public.credit_committee_votes`

رأی اعضای کمیته اعتبار.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_decision_id` | `uuid` | خیر | شناسه تصمیم اعتبار |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `unit_code` | `text` | خیر | کد واحد |  |  |
| `vote` | `text` | خیر | رأی |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.credit_condition_checks`

بررسی شرط‌های تصمیم اعتباری.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `condition_index` | `integer` | خیر | ردیف شرط |  |  |
| `condition_text` | `text` | خیر | متن شرط |  |  |
| `checked_by` | `uuid` | خیر | حساب بررسی‌شده |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.credit_consents`

رضایت‌های استعلام اعتباری.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `role` | `text` | خیر | نقش |  |  |
| `consent_text_version_id` | `uuid` | خیر | شناسه نسخه متن رضایت |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `session_id` | `uuid` | بله | شناسه نشست |  |  |
| `ip` | `text` | بله | نشانی IP |  | شخصی |
| `device_id` | `text` | بله | شناسه دستگاه |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.credit_cost_split_reviews`

بررسی تفکیک دستمزد و مواد درخواست طرح فقط دستمزد پیش از تصمیم، یک بار؛ فقط‌افزودنی (ADR-050).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `reviewed_by` | `uuid` | خیر | حساب بازبینی |  |  |
| `note` | `text` | خیر | یادداشت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.credit_decisions`

تصمیم‌های اعتباری: نتیجه، رتبه و شرط‌ها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `outcome` | `text` | خیر | نتیجه |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `authority` | `text` | خیر | مرجع |  |  |
| `ruleset_version_id` | `uuid` | خیر | شناسه نسخه مجموعه قاعده |  |  |
| `out_of_matrix` | `boolean` | خیر | ماتریس از خارج |  |  |
| `approved_amount_rial` | `bigint` | بله | مبلغ تأییدشده | ریال |  |
| `amount_level` | `text` | بله | سطح مبلغ |  |  |
| `quote` | `jsonb` | بله | قیمت |  |  |
| `conditions` | `jsonb` | بله | شرط‌ها |  |  |
| `missing` | `jsonb` | بله | ناموجود |  |  |
| `reason_code` | `text` | بله | کد دلیل |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `minutes_number` | `text` | بله | شماره دقیقه |  |  |
| `meeting_at` | `timestamp with time zone` | بله | زمان جلسه | زمان UTC |  |
| `attendee_account_ids` | `uuid[]` | بله | شناسه‌های حساب حاضر |  |  |
| `proposed_by` | `uuid` | خیر | حساب پیشنهاد |  |  |
| `checked_by` | `uuid` | بله | حساب بررسی‌شده |  |  |
| `checked_at` | `timestamp with time zone` | بله | زمان بررسی‌شده | زمان UTC |  |
| `closed_by` | `uuid` | بله | حساب بسته‌شده |  |  |
| `close_reason` | `text` | بله | دلیل بستن |  |  |
| `closed_at` | `timestamp with time zone` | بله | زمان بسته‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.credit_documents`

مدارک پرونده اعتباری.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `role` | `text` | خیر | نقش |  |  |
| `guarantor_id` | `uuid` | بله | شناسه ضامن |  |  |
| `item_code` | `text` | خیر | کد قلم |  |  |
| `checklist_version_id` | `uuid` | خیر | شناسه نسخه فهرست بررسی |  |  |
| `storage_key` | `text` | خیر | کلید ذخیره‌ساز |  |  |
| `mime` | `text` | خیر | نوع MIME |  |  |
| `size_bytes` | `integer` | خیر | اندازه | بایت |  |
| `sha256` | `text` | خیر | SHA-256 |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `uploaded_by` | `uuid` | خیر | حساب بارگذاری |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.credit_exposure_checks`

هر بررسی سقف مانده فعال وام‌گیرنده در تصمیم یا شارژ: مانده، مبلغ، سقف، مبنا، نسخه پیکربندی و نتیجه؛ فقط‌افزودنی (ADR-051).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `step` | `text` | خیر | گام |  |  |
| `exposure_rial` | `bigint` | خیر | مانده فعال | ریال |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `cap_rial` | `bigint` | خیر | سقف | ریال |  |
| `basis` | `text` | خیر | مبنا |  |  |
| `include_approved_unfunded` | `boolean` | خیر | شارژنشده تأییدشده شامل |  |  |
| `config_version_id` | `uuid` | خیر | شناسه نسخه پیکربندی |  |  |
| `allowed` | `boolean` | خیر | مجاز |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.credit_formation_deposits`

مشخصات بیعانه تشکیل هر درخواست اعتبار و برگشت آن پیش از معرفی‌نامه؛ بی ردیف دفتر کل در پایلوت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `config_version_id` | `uuid` | خیر | شناسه نسخه پیکربندی |  |  |
| `paid_on` | `date` | خیر | روز پرداخت‌شده | روز |  |
| `bank_reference` | `text` | خیر | مرجع بانک |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `recorded_by` | `uuid` | خیر | حساب ثبت |  |  |
| `refunded_on` | `date` | بله | روز برگشت‌داده‌شده | روز |  |
| `refund_reference` | `text` | بله | مرجع برگشت |  |  |
| `refund_reason` | `text` | بله | دلیل برگشت |  |  |
| `refunded_by` | `uuid` | بله | حساب برگشت‌داده‌شده |  |  |
| `refunded_at` | `timestamp with time zone` | بله | زمان برگشت‌داده‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.credit_guarantors`

ضامن‌های پرونده اعتباری.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `invited_by` | `uuid` | خیر | حساب دعوت‌شده |  |  |
| `consent_at` | `timestamp with time zone` | بله | زمان رضایت | زمان UTC |  |
| `grade` | `text` | بله | رتبه |  |  |
| `weight` | `integer` | بله | وزن |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.credit_penalty_overrides`

استثنای جریمه با تأیید.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `penalty_bps` | `integer` | خیر | جریمه | صدم درصد |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `requested_at` | `timestamp with time zone` | خیر | زمان درخواست | زمان UTC |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.credit_purses`

کیف‌های اعتبار.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `credit_application_id` | `uuid` | بله | شناسه پرونده اعتباری اعتبار |  |  |
| `borrower_person_id` | `uuid` | خیر | شناسه شخص وام‌گیرنده |  |  |
| `approved_amount_rial` | `bigint` | خیر | مبلغ تأییدشده | ریال |  |
| `center_node_id` | `uuid` | خیر | شناسه گره سازمانی مرکز |  |  |
| `doctor_node_id` | `uuid` | خیر | شناسه گره سازمانی پزشک |  |  |
| `treatment_field_code` | `text` | خیر | کد رشته درمانی |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `funded_at` | `timestamp with time zone` | بله | زمان شارژشده | زمان UTC |  |
| `closed_at` | `timestamp with time zone` | بله | زمان بسته‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `down_payment_rial` | `bigint` | خیر | پیش‌پرداخت | ریال |  |

## `public.credit_transfer_paper_receipts`

دریافت سند کاغذی امضاشده انتقال‌دهنده برای هر انتقال اعتبار، ثبت‌شده هنگام تأیید حسابداری؛ فقط‌افزودنی (ADR-047).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `transfer_id` | `uuid` | خیر | شناسه انتقال |  |  |
| `received_by` | `uuid` | خیر | حساب دریافت‌شده |  |  |
| `received_at` | `timestamp with time zone` | خیر | زمان دریافت‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.credit_transfers`

انتقال اعتبار میان کیف‌ها، با تأیید.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `recipient_person_id` | `uuid` | خیر | شناسه شخص گیرنده |  |  |
| `recipient_mobile` | `text` | خیر | موبایل گیرنده |  | شخصی |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `requested_at` | `timestamp with time zone` | خیر | زمان درخواست | زمان UTC |  |
| `recipient_verified_at` | `timestamp with time zone` | بله | زمان تأییدشده گیرنده | زمان UTC |  |
| `borrower_consented_at` | `timestamp with time zone` | بله | زمان رضایت‌داده وام‌گیرنده | زمان UTC |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `revoke_requested_by` | `uuid` | بله | حساب درخواست ابطال |  |  |
| `revoke_requested_at` | `timestamp with time zone` | بله | زمان درخواست ابطال | زمان UTC |  |
| `revoke_reason` | `text` | بله | دلیل ابطال |  |  |
| `revoked_by` | `uuid` | بله | حساب ابطال |  |  |
| `revoked_at` | `timestamp with time zone` | بله | زمان ابطال | زمان UTC |  |
| `revoked_via` | `text` | بله | از راه ابطال |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `paper_document_number` | `text` | بله | شماره سند کاغذی |  |  |

## `public.doctor_payables`

بستانکاری پزشک از خدمات ثبت‌شده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `service_delivery_id` | `uuid` | خیر | شناسه تحویل خدمت |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `doctor_node_id` | `uuid` | خیر | شناسه گره سازمانی پزشک |  |  |
| `center_id` | `uuid` | بله | شناسه مرکز |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `finalized_at` | `timestamp with time zone` | خیر | زمان نهایی‌شده | زمان UTC |  |
| `contract_cycle_months` | `integer` | خیر | ماه‌ها چرخه قرارداد |  |  |
| `cycle_config_version_id` | `uuid` | خیر | شناسه نسخه پیکربندی چرخه |  |  |
| `due_at` | `timestamp with time zone` | خیر | زمان سررسید | زمان UTC |  |
| `wallet_operation_id` | `uuid` | خیر | شناسه عملیات کیف |  |  |
| `journal_entry_id` | `uuid` | خیر | شناسه ثبت سند حسابداری |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `statement_id` | `uuid` | بله | شناسه صورت‌وضعیت |  |  |
| `hold_reason` | `text` | بله | دلیل نگه‌داشت |  |  |
| `dispute_id` | `uuid` | بله | شناسه اعتراض |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.doctor_profile_slugs`

نشانک‌های صفحه عمومی پزشکان.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `profile_id` | `uuid` | خیر | شناسه پروفایل |  |  |
| `slug` | `text` | خیر | نشانک |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.doctor_profile_versions`

نسخه‌های پروفایل عمومی پزشک، با بازبینی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `profile_id` | `uuid` | خیر | شناسه پروفایل |  |  |
| `version_no` | `integer` | خیر | شماره نسخه |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `content` | `jsonb` | خیر | محتوا |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `submitted_by` | `uuid` | بله | حساب ارسال |  |  |
| `submitted_at` | `timestamp with time zone` | بله | زمان ارسال | زمان UTC |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.doctor_profiles`

پروفایل عمومی پزشک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `slug` | `text` | خیر | نشانک |  |  |
| `published_version_id` | `uuid` | بله | شناسه نسخه منتشرشده |  |  |
| `first_published_at` | `timestamp with time zone` | بله | زمان منتشرشده نخستین | زمان UTC |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.doctor_secretaries`

منشی‌های هر پزشک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `node_id` | `uuid` | خیر | شناسه گره سازمانی |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `name` | `text` | خیر | نام |  | شخصی |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.doctor_treatment_fields`

رشته‌های درمانی هر پزشک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `field_code` | `text` | خیر | کد رشته |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.doctor_workplaces`

محل‌های کار پزشک در مراکز.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `node_id` | `uuid` | خیر | شناسه گره سازمانی |  |  |
| `node_path` | `text` | خیر | مسیر گره سازمانی |  |  |
| `center_id` | `uuid` | بله | شناسه مرکز |  |  |
| `branch_id` | `uuid` | بله | شناسه شعبه |  |  |
| `city_code` | `text` | خیر | کد شهر |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |
| `credit_enabled` | `boolean` | خیر | فعال اعتبار |  |  |

## `public.doctors`

پزشکان: نام، شماره نظام پزشکی و وضعیت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `name` | `text` | خیر | نام |  | شخصی |
| `medical_council_number` | `text` | خیر | شماره نظام پزشکی |  |  |
| `national_id_enc` | `text` | بله | کد ملی |  | رمزگذاری‌شده، شخصی |
| `national_id_index` | `text` | بله | نمایه کور کد ملی |  | نمایه کور |
| `national_id_last4` | `text` | بله | چهار رقم آخر کد ملی |  | شخصی |
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.down_payment_postings`

ثبت پیش‌پرداخت‌ها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `receipt_id` | `uuid` | خیر | شناسه رسید |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `borrower_person_id` | `uuid` | خیر | شناسه شخص وام‌گیرنده |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `journal_entry_id` | `uuid` | خیر | شناسه ثبت سند حسابداری |  |  |
| `funded_purse_id` | `uuid` | بله | شناسه کیف اعتبار شارژشده |  |  |
| `funded_at` | `timestamp with time zone` | بله | زمان شارژشده | زمان UTC |  |
| `reversal_journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری معکوس |  |  |
| `reversal_reason` | `text` | بله | دلیل معکوس |  |  |
| `reversed_by` | `uuid` | بله | حساب معکوس‌شده |  |  |
| `reversed_at` | `timestamp with time zone` | بله | زمان معکوس‌شده | زمان UTC |  |
| `created_by` | `uuid` | خیر | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.factor_change_notices`

اعلان‌های پیامکی تغییر عامل ورود (گذرواژه، TOTP، موبایل)، با گیرنده همان لحظه؛ فقط‌افزودنی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `event` | `text` | خیر | رویداد |  |  |
| `audience` | `text` | خیر | مخاطب |  |  |
| `mobile` | `text` | خیر | موبایل |  | شخصی |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.field_reencryption_runs`

اجراهای ابزار بازرمزگذاری فیلدها: نسخه تأیید دونفره، پشتیبان پیش از اجرا، نتیجه و شمار ردیف‌ها (بی مقدار).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `authorization_version_id` | `uuid` | خیر | شناسه نسخه مجوز |  |  |
| `outcome` | `text` | خیر | نتیجه |  |  |
| `backup_file` | `text` | خیر | فایل پشتیبان |  |  |
| `counts` | `jsonb` | بله | شمارها |  |  |
| `started_at` | `timestamp with time zone` | خیر | زمان آغازشده | زمان UTC |  |
| `finished_at` | `timestamp with time zone` | بله | زمان پایان‌یافته | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.financial_dispute_items`

قلم‌های اعتراض مالی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `dispute_id` | `uuid` | خیر | شناسه اعتراض |  |  |
| `item_type` | `text` | خیر | نوع قلم |  |  |
| `item_id` | `uuid` | خیر | شناسه قلم |  |  |
| `held_from_status` | `text` | خیر | وضعیت از نگه‌داشته |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.financial_disputes`

اعتراض‌های مالی به صورت‌وضعیت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `subject_type` | `text` | خیر | نوع موضوع |  |  |
| `subject_id` | `uuid` | خیر | شناسه موضوع |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `opened_by` | `uuid` | خیر | حساب بازشده |  |  |
| `opened_at` | `timestamp with time zone` | خیر | زمان بازشده | زمان UTC |  |
| `resolved_by` | `uuid` | بله | حساب حل‌شده |  |  |
| `resolved_at` | `timestamp with time zone` | بله | زمان حل‌شده | زمان UTC |  |
| `resolution_note` | `text` | بله | یادداشت حل |  |  |
| `correction_journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری اصلاح |  |  |
| `ticket_id` | `uuid` | بله | شناسه تیکت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.funding_requests`

درخواست‌های شارژ کیف اعتبار.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `requested_at` | `timestamp with time zone` | خیر | زمان درخواست | زمان UTC |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `purse_id` | `uuid` | بله | شناسه کیف اعتبار |  |  |
| `schedule_id` | `uuid` | بله | شناسه جدول اقساط |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.holiday_batches`

درخواست ذخیره دسته‌ای تعطیلات رسمی یک سال، با تأیید دونفره؛ همه یا هیچ، بی بازنویسی روز موجود.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `year` | `integer` | خیر | سال |  |  |
| `days` | `jsonb` | خیر | days | روز |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `affected_contracts` | `integer` | خیر | قراردادها اثرپذیر |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `saved_count` | `integer` | بله | شمار ذخیره‌شده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.holiday_removals`

درخواست برداشتن یک تعطیلی از تقویم، با تأیید دونفره؛ تأیید آن را حذف منطقی می‌کند.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `holiday_id` | `uuid` | خیر | شناسه تعطیل |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `affected_contracts` | `integer` | خیر | قراردادها اثرپذیر |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.holidays`

تعطیلات رسمی و مرکز.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `holiday_on` | `date` | خیر | روز تعطیل | روز |  |
| `title` | `text` | خیر | عنوان |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `city_code` | `text` | بله | کد شهر |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `deleted_by` | `uuid` | بله | حساب حذف‌کننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.installment_cycle_events`

رویدادهای چرخه قسط.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `installment_id` | `uuid` | خیر | شناسه قسط |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `as_of` | `date` | خیر | از تا | روز |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.installment_reminders`

یادآوری‌های قسط.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `installment_id` | `uuid` | خیر | شناسه قسط |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `offset_days` | `integer` | خیر | جابه‌جایی | روز |  |
| `dispatch_id` | `uuid` | خیر | شناسه ارسال |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.installment_revision_amounts`

مبالغ بازنگری جدول اقساط.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `revision_id` | `uuid` | خیر | شناسه بازنگری |  |  |
| `installment_id` | `uuid` | خیر | شناسه قسط |  |  |
| `from_rial` | `bigint` | خیر | از | ریال |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |

## `public.installment_schedule_revisions`

بازنگری‌های جدول اقساط.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `schedule_id` | `uuid` | خیر | شناسه جدول اقساط |  |  |
| `revision_no` | `integer` | خیر | شماره بازنگری |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `change_rial` | `bigint` | خیر | تغییر | ریال |  |
| `reverts_revision_id` | `uuid` | بله | شناسه بازنگری بازگرداننده |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `request_hash` | `text` | خیر | درهم‌سازی درخواست |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.installment_schedule_terms`

شرط‌های قفل‌شده جدول اقساط.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `schedule_id` | `uuid` | خیر | شناسه جدول اقساط |  |  |
| `grace_days` | `integer` | خیر | مهلت ارفاق | روز |  |
| `grace_config_version_id` | `uuid` | خیر | شناسه نسخه پیکربندی مهلت ارفاق |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.installment_schedules`

جدول‌های اقساط.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `principal_rial` | `bigint` | خیر | اصل | ریال |  |
| `plan_fee_rial` | `bigint` | خیر | کارمزد طرح | ریال |  |
| `total_rial` | `bigint` | خیر | جمع | ریال |  |
| `installment_count` | `integer` | خیر | شمار قسط |  |  |
| `funded_at` | `timestamp with time zone` | خیر | زمان شارژشده | زمان UTC |  |
| `rounding_unit_rial` | `bigint` | خیر | واحد گردکردن | ریال |  |
| `rounding_config_version_id` | `uuid` | خیر | شناسه نسخه پیکربندی گردکردن |  |  |
| `plan_fee_journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری کارمزد طرح |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `request_hash` | `text` | خیر | درهم‌سازی درخواست |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `due_dates_shifted` | `boolean` | خیر | جابه‌جاشده تاریخ‌ها سررسید |  |  |
| `shift_config_version_id` | `uuid` | بله | شناسه نسخه پیکربندی جابه‌جایی سررسید |  |  |
| `weekly_days_off_config_version_id` | `uuid` | بله | شناسه نسخه پیکربندی تعطیل روزها هفتگی |  |  |

## `public.installment_states`

وضعیت روزانه هر قسط.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `installment_id` | `uuid` | بله | شناسه قسط |  |  |
| `schedule_id` | `uuid` | بله | شناسه جدول اقساط |  |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `index` | `integer` | بله | ردیف |  |  |
| `due_on` | `date` | بله | روز سررسید | روز |  |
| `amount_rial` | `bigint` | بله | مبلغ | ریال |  |
| `paid_rial` | `bigint` | بله | پرداخت‌شده | ریال |  |
| `outstanding_rial` | `bigint` | بله | مانده | ریال |  |
| `grace_days` | `integer` | بله | مهلت ارفاق | روز |  |
| `as_of` | `date` | بله | از تا | روز |  |
| `status` | `text` | بله | وضعیت |  |  |
| `days_past_due` | `integer` | بله | سررسید گذشته روزها |  |  |

## `public.installments`

اقساط: سررسید و مبلغ.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `schedule_id` | `uuid` | خیر | شناسه جدول اقساط |  |  |
| `index` | `integer` | خیر | ردیف |  |  |
| `due_on` | `date` | خیر | روز سررسید | روز |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.instrument_executions`

اجرای چک و سفته با تأیید دونفره.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `instrument_id` | `uuid` | خیر | شناسه سند تضمین |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `schedule_id` | `uuid` | خیر | شناسه جدول اقساط |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `proposed_by` | `uuid` | خیر | حساب پیشنهاد |  |  |
| `proposal_reason` | `text` | خیر | دلیل پیشنهاد |  |  |
| `proposed_at` | `timestamp with time zone` | خیر | زمان پیشنهاد | زمان UTC |  |
| `collection_approved_by` | `uuid` | بله | حساب تأییدشده وصول |  |  |
| `collection_approved_at` | `timestamp with time zone` | بله | زمان تأییدشده وصول | زمان UTC |  |
| `finance_approved_by` | `uuid` | بله | حساب تأییدشده مالی |  |  |
| `finance_approved_at` | `timestamp with time zone` | بله | زمان تأییدشده مالی | زمان UTC |  |
| `rejected_by` | `uuid` | بله | حساب ردشده |  |  |
| `reject_reason` | `text` | بله | دلیل رد |  |  |
| `outcome_by` | `uuid` | بله | حساب نتیجه |  |  |
| `outcome_on` | `date` | بله | روز نتیجه | روز |  |
| `bank_ref` | `text` | بله | مرجع بانک |  |  |
| `bounce_reason` | `text` | بله | دلیل برگشت |  |  |
| `bounce_note` | `text` | بله | یادداشت برگشت |  |  |
| `payment_id` | `uuid` | بله | شناسه پرداخت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.instrument_release_decisions`

تصمیم نفر دوم (یا انصراف درخواست‌کننده) درباره درخواست آزادسازی چک یا سفته.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `request_id` | `uuid` | خیر | شناسه درخواست |  |  |
| `outcome` | `text` | خیر | نتیجه |  |  |
| `decided_by` | `uuid` | خیر | حساب تصمیم |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.instrument_release_requests`

درخواست آزادسازی چک یا سفته (ADR-052)، که نفر دوم تأیید یا رد می‌کند.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `instrument_id` | `uuid` | خیر | شناسه سند تضمین |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.instrument_releases`

آزادسازی اسناد تضمین.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `instrument_id` | `uuid` | خیر | شناسه سند تضمین |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `approved_by` | `uuid` | خیر | حساب تأییدشده |  |  |
| `approved_at` | `timestamp with time zone` | خیر | زمان تأییدشده | زمان UTC |  |
| `sms_dispatch_id` | `uuid` | بله | شناسه ارسال پیامک |  |  |

## `public.instruments`

اسناد تضمین (چک و سفته).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `delivery_id` | `uuid` | بله | شناسه تحویل |  |  |
| `item_id` | `uuid` | بله | شناسه قلم |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `issuer_person_id` | `uuid` | خیر | شناسه شخص صادرکننده |  |  |
| `role` | `text` | خیر | نقش |  |  |
| `guarantor_id` | `uuid` | بله | شناسه ضامن |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `due_on` | `date` | بله | روز سررسید | روز |  |
| `bank_name` | `text` | بله | نام بانک |  |  |
| `number_enc` | `text` | خیر | شماره |  | رمزگذاری‌شده |
| `number_bidx` | `text` | خیر | شماره |  | نمایه کور |
| `number_last4` | `text` | خیر | چهار رقم آخر شماره |  |  |
| `sayad_registered_confirmed` | `boolean` | خیر | تأییدشده ثبت‌شده صیاد |  |  |
| `sayad_confirmed_at` | `timestamp with time zone` | بله | زمان تأییدشده صیاد | زمان UTC |  |
| `sayad_confirmed_by` | `uuid` | بله | حساب تأییدشده صیاد |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `notes` | `text` | بله | یادداشت‌ها |  |  |
| `created_by` | `uuid` | خیر | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.journal_entries`

اسناد حسابداری فقط‌افزودنی، با کلید عدم تکرار.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `event_type` | `text` | خیر | نوع رویداد |  |  |
| `occurred_at` | `timestamp with time zone` | خیر | زمان رخ‌داده | زمان UTC |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `credit_application_id` | `uuid` | بله | شناسه پرونده اعتباری اعتبار |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `request_hash` | `text` | خیر | درهم‌سازی درخواست |  |  |
| `reverses_journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری معکوسِ |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.lead_import_batches`

دسته‌های ورود گروهی سرنخ.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `file_name` | `text` | خیر | نام فایل |  |  |
| `row_count` | `integer` | خیر | شمار ردیف |  |  |
| `valid_count` | `integer` | خیر | شمار معتبر |  |  |
| `error_count` | `integer` | خیر | شمار خطا |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `committed_at` | `timestamp with time zone` | بله | زمان قطعی‌شده | زمان UTC |  |
| `committed_by` | `uuid` | بله | حساب قطعی‌شده |  |  |
| `processed_at` | `timestamp with time zone` | بله | زمان پردازش‌شده | زمان UTC |  |
| `cancelled_at` | `timestamp with time zone` | بله | زمان لغوشده | زمان UTC |  |
| `cancelled_by` | `uuid` | بله | حساب لغوشده |  |  |
| `cancel_reason` | `text` | بله | دلیل لغو |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.lead_import_rows`

ردیف‌های ورود گروهی سرنخ.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `batch_id` | `uuid` | خیر | شناسه دسته |  |  |
| `row_number` | `integer` | خیر | شماره ردیف |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `errors` | `text[]` | خیر | خطاها |  |  |
| `mobile` | `text` | بله | موبایل |  | شخصی |
| `name` | `text` | بله | نام |  | شخصی |
| `national_id_enc` | `text` | بله | کد ملی |  | رمزگذاری‌شده، شخصی |
| `treatment_field_code` | `text` | بله | کد رشته درمانی |  |  |
| `city_code` | `text` | بله | کد شهر |  |  |
| `sms_consent` | `boolean` | خیر | رضایت پیامک |  |  |
| `intake_id` | `uuid` | بله | شناسه ورود |  |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `person_id` | `uuid` | بله | شناسه شخص |  |  |
| `created_person` | `boolean` | خیر | شخص ایجاد |  |  |
| `processed_at` | `timestamp with time zone` | بله | زمان پردازش‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.ledger_accounts`

حساب‌های دفتر کل.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `code` | `text` | خیر | کد |  |  |
| `name` | `text` | خیر | نام |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `owner_type` | `text` | خیر | نوع مالک |  |  |
| `owner_id` | `uuid` | بله | شناسه مالک |  |  |
| `currency` | `text` | خیر | ارز |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.ledger_balance_applications`

اعمال ثبت‌ها روی مانده حساب‌ها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `journal_entry_id` | `uuid` | خیر | شناسه ثبت سند حسابداری |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ledger_daily_reports`

گزارش روزانه دفتر کل.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `run_id` | `uuid` | خیر | شناسه اجرا |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `report_date` | `date` | خیر | تاریخ گزارش | روز |  |
| `day_debit_rial` | `bigint` | خیر | بدهکار روز | ریال |  |
| `day_credit_rial` | `bigint` | خیر | اعتبار روز | ریال |  |
| `total_debit_rial` | `bigint` | خیر | بدهکار جمع | ریال |  |
| `total_credit_rial` | `bigint` | خیر | اعتبار جمع | ریال |  |
| `balanced` | `boolean` | خیر | تراز |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ledger_discrepancies`

ناهمخوانی‌های یافته در تطبیق دفتر کل.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `run_id` | `uuid` | خیر | شناسه اجرا |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `expected_debit_rial` | `bigint` | خیر | بدهکار مورد انتظار | ریال |  |
| `expected_credit_rial` | `bigint` | خیر | اعتبار مورد انتظار | ریال |  |
| `actual_debit_rial` | `bigint` | خیر | بدهکار واقعی | ریال |  |
| `actual_credit_rial` | `bigint` | خیر | اعتبار واقعی | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ledger_entries`

ثبت‌های بدهکار و بستانکار دفتر کل؛ فقط‌افزودنی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `journal_entry_id` | `uuid` | خیر | شناسه ثبت سند حسابداری |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `direction` | `text` | خیر | جهت |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ledger_reconciliation_runs`

اجراهای تطبیق دفتر کل.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `started_at` | `timestamp with time zone` | خیر | زمان آغازشده | زمان UTC |  |
| `finished_at` | `timestamp with time zone` | خیر | زمان پایان‌یافته | زمان UTC |  |
| `accounts_checked` | `integer` | خیر | بررسی‌شده حساب‌ها |  |  |
| `journals_applied` | `integer` | خیر | اعمال‌شده اسناد حسابداری |  |  |
| `mismatches` | `integer` | خیر | ناهمخوانی‌ها |  |  |
| `invariant_violations` | `integer` | خیر | نقض‌ها ثابت |  |  |
| `unbalanced_entities` | `integer` | خیر | اشخاص ناتراز |  |  |
| `overdue_unapplied` | `integer` | خیر | اعمال‌نشده معوق |  |  |
| `clean` | `boolean` | خیر | پاک |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.legal_entities`

اشخاص حقوقی (آرامش ثروت و سپهر سلامتی).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `name` | `text` | خیر | نام |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.loan_settlements`

تسویه زودهنگام وام.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `schedule_id` | `uuid` | خیر | شناسه جدول اقساط |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `payment_id` | `uuid` | خیر | شناسه پرداخت |  |  |
| `settled_at` | `timestamp with time zone` | خیر | زمان تسویه‌شده | زمان UTC |  |

## `public.media_assets`

فایل‌های رسانه (تصویر پروفایل و مرکز) در ذخیره‌ساز خصوصی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `rejection` | `text` | بله | رد |  |  |
| `detected_mime` | `text` | خیر | نوع MIME شناسایی‌شده |  |  |
| `size_bytes` | `integer` | خیر | اندازه | بایت |  |
| `original_key` | `text` | خیر | کلید اصلی |  |  |
| `variants` | `jsonb` | بله | گونه‌ها |  |  |
| `published_at` | `timestamp with time zone` | بله | زمان منتشرشده | زمان UTC |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.no_show_disputes`

اعتراض به «نیامدن» در نوبت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `appointment_id` | `uuid` | خیر | شناسه نوبت |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `outcome` | `text` | بله | نتیجه |  |  |
| `resolution_reason` | `text` | بله | دلیل حل |  |  |
| `resolved_by` | `uuid` | بله | حساب حل‌شده |  |  |
| `resolved_at` | `timestamp with time zone` | بله | زمان حل‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.odoo_account_mappings`

نگاشت حساب‌های دفتر کل به اودو.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `internal_code` | `text` | خیر | کد داخلی |  |  |
| `odoo_account_code` | `text` | خیر | کد حساب اودو |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `set_by` | `uuid` | بله | حساب تعیین |  |  |
| `set_at` | `timestamp with time zone` | خیر | زمان تعیین | زمان UTC |  |

## `public.odoo_exports`

خروجی‌های اسناد برای اودو.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `period_year` | `integer` | خیر | سال دوره |  |  |
| `period_month` | `integer` | خیر | ماه دوره |  |  |
| `documents` | `integer` | خیر | مدارک |  |  |
| `debit_total_rial` | `bigint` | خیر | جمع بدهکار | ریال |  |
| `credit_total_rial` | `bigint` | خیر | جمع اعتبار | ریال |  |
| `sha256` | `text` | خیر | SHA-256 |  |  |
| `generated_by` | `uuid` | بله | حساب تولیدشده |  |  |
| `generated_at` | `timestamp with time zone` | خیر | زمان تولیدشده | زمان UTC |  |

## `public.org_nodes`

درخت سازمانی: واحدها، شعبه‌ها، مراکز و محل‌های کار، با مسیر.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `parent_id` | `uuid` | بله | شناسه والد |  |  |
| `path` | `ltree` | خیر | مسیر |  |  |
| `name` | `text` | خیر | نام |  |  |
| `city_code` | `text` | خیر | کد شهر |  |  |
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.origination_discounts`

تخفیف مسئول تکمیل یا باشگاه بر هزینه تشکیل پرونده با فایل امضاشده؛ بی نفر دوم؛ فقط‌افزودنی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `discount_bps` | `integer` | خیر | تخفیف | صدم درصد |  |
| `granted_by` | `uuid` | خیر | حساب اعطاشده |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `storage_key` | `text` | خیر | کلید ذخیره‌ساز |  |  |
| `mime` | `text` | خیر | نوع MIME |  |  |
| `size_bytes` | `integer` | خیر | اندازه | بایت |  |
| `sha256` | `text` | خیر | SHA-256 |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.origination_fee_reductions`

هزینه تشکیل قفل‌شده با رسید یا هنگام تکمیل: مبنا، چک‌ها، بخشودگی، تخفیف و مبلغ خالص؛ بی ردیف دفتر کل.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `receipt_id` | `uuid` | بله | شناسه رسید |  |  |
| `plans_version_id` | `uuid` | خیر | شناسه نسخه طرح‌ها |  |  |
| `fee_rial` | `bigint` | خیر | کارمزد | ریال |  |
| `base_rial` | `bigint` | خیر | پایه | ریال |  |
| `cheque_count` | `integer` | خیر | شمار چک |  |  |
| `waiver_bps` | `integer` | خیر | بخشودگی | صدم درصد |  |
| `discount_id` | `uuid` | بله | شناسه تخفیف |  |  |
| `discount_bps` | `integer` | خیر | تخفیف | صدم درصد |  |
| `net_rial` | `bigint` | خیر | خالص | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.outbox_events`

رویدادهای دامنه در outbox تراکنشی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `event_type` | `text` | خیر | نوع رویداد |  |  |
| `aggregate_type` | `text` | خیر | نوع موجودیت |  |  |
| `aggregate_id` | `text` | خیر | شناسه موجودیت |  |  |
| `payload` | `jsonb` | خیر | محتوا |  |  |
| `available_at` | `timestamp with time zone` | خیر | زمان در دسترس | زمان UTC |  |
| `published_at` | `timestamp with time zone` | بله | زمان منتشرشده | زمان UTC |  |
| `attempts` | `integer` | خیر | تلاش‌ها |  |  |
| `last_error` | `text` | بله | خطا آخرین |  |  |

## `public.patient_mobile_change_requests`

درخواست‌های تغییر شماره ورود بیماری که شماره قبلی را ندارد، با پیشنهاد و تأیید دونفره کارکنان (ف۱۲ ب۲).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `target_account_id` | `uuid` | خیر | شناسه حساب هدف |  |  |
| `from_mobile` | `text` | خیر | موبایل از |  | شخصی |
| `to_mobile` | `text` | خیر | موبایل به |  | شخصی |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `evidence` | `text` | خیر | مستند |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `sessions_ended` | `integer` | بله | بسته‌شده نشست‌ها |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.payment_allocations`

تخصیص پرداخت‌ها به اقساط و هزینه‌ها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `payment_id` | `uuid` | خیر | شناسه پرداخت |  |  |
| `installment_id` | `uuid` | خیر | شناسه قسط |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.payment_promises`

قول‌های پرداخت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `item_id` | `uuid` | خیر | شناسه قلم |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `promised_amount_rial` | `bigint` | خیر | مبلغ قول‌داده | ریال |  |
| `promised_on` | `date` | خیر | روز قول‌داده | روز |  |
| `note` | `text` | بله | یادداشت |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `evaluated_at` | `timestamp with time zone` | بله | زمان ارزیابی‌شده | زمان UTC |  |
| `allocated_rial` | `bigint` | بله | تخصیص‌یافته | ریال |  |
| `cancelled_by` | `uuid` | بله | حساب لغوشده |  |  |
| `cancel_reason` | `text` | بله | دلیل لغو |  |  |

## `public.payments`

فیش‌ها و پرداخت‌های وام‌گیرنده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `schedule_id` | `uuid` | خیر | شناسه جدول اقساط |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `received_at` | `timestamp with time zone` | خیر | زمان دریافت‌شده | زمان UTC |  |
| `reference` | `text` | بله | مرجع |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `receipt_journal_entry_id` | `uuid` | خیر | شناسه ثبت سند حسابداری رسید |  |  |
| `allocation_journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری تخصیص |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `request_hash` | `text` | خیر | درهم‌سازی درخواست |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `channel` | `text` | خیر | کانال |  |  |
| `paid_on` | `date` | بله | روز پرداخت‌شده | روز |  |
| `bank_ref_norm` | `text` | بله | یکسان‌شده مرجع بانک |  |  |
| `payer_name` | `text` | بله | نام پرداخت‌کننده |  | شخصی |
| `submitted_by_account_id` | `uuid` | بله | شناسه حساب کاربر ارسال |  |  |
| `image_key` | `text` | بله | کلید تصویر |  |  |
| `image_mime` | `text` | بله | نوع MIME تصویر |  |  |
| `image_sha256` | `text` | بله | SHA-256 تصویر |  |  |
| `suspected_duplicate_of` | `uuid` | بله | از تکراری مشکوک |  |  |
| `duplicate_cleared_reason` | `text` | بله | دلیل پاک‌شده تکراری |  |  |
| `reject_kind` | `text` | بله | نوع رد |  |  |
| `reject_journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری رد |  |  |

## `public.payout_order_nodes`

گره‌های سازمانی هر دستور پرداخت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `payout_id` | `uuid` | خیر | شناسه پرداخت تسویه |  |  |
| `doctor_node_id` | `uuid` | خیر | شناسه گره سازمانی پزشک |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.payout_orders`

دستورهای پرداخت تسویه به پزشک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `statement_id` | `uuid` | خیر | شناسه صورت‌وضعیت |  |  |
| `center_id` | `uuid` | خیر | شناسه مرکز |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `iban_enc` | `text` | خیر | شبا |  | رمزگذاری‌شده، شخصی |
| `iban_last4` | `text` | خیر | چهار رقم آخر شبا |  | شخصی |
| `account_holder` | `text` | بله | دارنده حساب |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `issued_by` | `uuid` | بله | حساب صادرشده |  |  |
| `issued_at` | `timestamp with time zone` | خیر | زمان صادرشده | زمان UTC |  |
| `export_batch_id` | `uuid` | بله | شناسه دسته خروجی |  |  |
| `exported_by` | `uuid` | بله | حساب خروجی‌گرفته |  |  |
| `exported_at` | `timestamp with time zone` | بله | زمان خروجی‌گرفته | زمان UTC |  |
| `bank_tracking_ref` | `text` | بله | مرجع پیگیری بانک |  |  |
| `paid_on` | `date` | بله | روز پرداخت‌شده | روز |  |
| `tracking_recorded_by` | `uuid` | بله | حساب ثبت پیگیری |  |  |
| `tracking_recorded_at` | `timestamp with time zone` | بله | زمان ثبت پیگیری | زمان UTC |  |
| `confirmed_by` | `uuid` | بله | حساب تأییدشده |  |  |
| `confirmed_at` | `timestamp with time zone` | بله | زمان تأییدشده | زمان UTC |  |
| `journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری |  |  |
| `fail_requested_by` | `uuid` | بله | حساب درخواست ناموفق |  |  |
| `fail_requested_at` | `timestamp with time zone` | بله | زمان درخواست ناموفق | زمان UTC |  |
| `failure_reason` | `text` | بله | دلیل شکست |  |  |
| `failed_by` | `uuid` | بله | حساب ناموفق |  |  |
| `failed_at` | `timestamp with time zone` | بله | زمان ناموفق | زمان UTC |  |
| `replaces_payout_id` | `uuid` | بله | شناسه پرداخت تسویه جایگزینِ |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.permissions`

کدهای مجوز (ماژول.عمل).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.person_backfill_runs`

اجراهای پرکردن شخص برای سرنخ‌های قدیمی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `mode` | `text` | خیر | حالت |  |  |
| `candidates` | `integer` | خیر | نامزدها |  |  |
| `filled` | `integer` | خیر | پرشده |  |  |
| `manual_review` | `jsonb` | خیر | بازبینی دستی |  |  |
| `started_at` | `timestamp with time zone` | خیر | زمان آغازشده | زمان UTC |  |
| `finished_at` | `timestamp with time zone` | خیر | زمان پایان‌یافته | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.person_merges`

ادغام اشخاص تکراری، برگشت‌پذیر.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `survivor_id` | `uuid` | خیر | شناسه باقی‌مانده |  |  |
| `merged_id` | `uuid` | خیر | شناسه ادغام‌شده |  |  |
| `moved_case_ids` | `uuid[]` | خیر | شناسه‌های پرونده جابه‌جاشده |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `reverted_at` | `timestamp with time zone` | بله | زمان بازگردانده | زمان UTC |  |
| `reverted_by` | `uuid` | بله | حساب بازگردانده |  |  |
| `revert_reason` | `text` | بله | دلیل بازگردانی |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.person_mobile_decisions`

تصمیم‌های تأیید یا رد موبایل در انتظار (صاحب موبایل تأییدشده، کارمند با مستند، پایان مهلت یا لغو دسته ورود از اکسل)؛ فقط‌افزودنی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `person_mobile_id` | `uuid` | خیر | شناسه موبایل شخص |  | شخصی |
| `decision` | `text` | خیر | تصمیم |  |  |
| `method` | `text` | خیر | روش |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `evidence` | `text` | بله | مستند |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `proposal_id` | `uuid` | بله | شناسه پیشنهاد |  |  |

## `public.person_mobile_proposals`

پیشنهاد نفر اول برای تأیید دونفره موبایل در انتظار (کارمند با مستند دیده‌شده؛ نفر دوم تأیید می‌کند)؛ یکی برای هر موبایل؛ فقط‌افزودنی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `person_mobile_id` | `uuid` | خیر | شناسه موبایل شخص |  | شخصی |
| `proposed_by` | `uuid` | خیر | حساب پیشنهاد |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `evidence` | `text` | خیر | مستند |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.person_mobiles`

شماره‌های موبایل هر شخص، به شکل یکسان‌شده؛ شماره افزوده به شخص موجود یا جابه‌جاشده با ادغام تا تأیید در انتظار است و به هیچ داده‌ای دسترسی نمی‌دهد.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `mobile` | `text` | خیر | موبایل |  | شخصی |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `proved_at` | `timestamp with time zone` | بله | زمان اثبات‌شده | زمان UTC |  |
| `added_via` | `text` | بله | از راه افزوده |  |  |
| `added_by` | `uuid` | بله | حساب افزوده |  |  |
| `pending_expires_at` | `timestamp with time zone` | بله | زمان انقضا در انتظار | زمان UTC |  |
| `import_batch_id` | `uuid` | بله | شناسه دسته ورود گروهی |  |  |

## `public.persons`

اشخاص (بیمار، وام‌گیرنده، ضامن): نام، کد ملی رمزگذاری‌شده و وضعیت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `display_name` | `text` | بله | نام نمایش |  | شخصی |
| `national_id_enc` | `text` | بله | کد ملی |  | رمزگذاری‌شده، شخصی |
| `national_id_index` | `text` | بله | نمایه کور کد ملی |  | نمایه کور |
| `national_id_last4` | `text` | بله | چهار رقم آخر کد ملی |  | شخصی |
| `blocked_kind` | `text` | بله | نوع مسدود |  |  |
| `blocked_at` | `timestamp with time zone` | بله | زمان مسدود | زمان UTC |  |
| `blocked_reason` | `text` | بله | دلیل مسدود |  |  |
| `merged_into_id` | `uuid` | بله | شناسه ادغام‌شده در |  |  |
| `account_linked_at` | `timestamp with time zone` | بله | زمان پیوندخورده حساب | زمان UTC |  |
| `sms_opted_out_at` | `timestamp with time zone` | بله | زمان لغو اشتراک پیامک | زمان UTC |  |
| `import_batch_id` | `uuid` | بله | شناسه دسته ورود گروهی |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.physical_deliveries`

تحویل فیزیکی مدارک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `method` | `text` | بله | روش |  |  |
| `tracking_code` | `text` | بله | کد پیگیری |  |  |
| `sent_at` | `timestamp with time zone` | بله | زمان ارسال‌شده | زمان UTC |  |
| `received_by` | `uuid` | بله | حساب دریافت‌شده |  |  |
| `received_at` | `timestamp with time zone` | بله | زمان دریافت‌شده | زمان UTC |  |
| `archive_location` | `text` | بله | موقعیت بایگانی |  |  |
| `return_reason` | `text` | بله | دلیل بازگشت |  |  |
| `created_by` | `uuid` | خیر | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.physical_delivery_items`

قلم‌های تحویل فیزیکی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `delivery_id` | `uuid` | خیر | شناسه تحویل |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `label` | `text` | خیر | برچسب |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.processed_events`

رویدادهای پردازش‌شده هر مصرف‌کننده (عدم تکرار).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `event_id` | `uuid` | خیر | شناسه رویداد |  |  |
| `consumer` | `text` | خیر | مصرف‌کننده |  |  |
| `event_created_at` | `timestamp with time zone` | خیر | زمان ایجاد رویداد | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.proforma_deviation_reviews`

بازبینی انحراف پیش‌فاکتور از تعرفه.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `proforma_id` | `uuid` | خیر | شناسه پیش‌فاکتور |  |  |
| `reviewed_by` | `uuid` | خیر | حساب بازبینی |  |  |
| `note` | `text` | خیر | یادداشت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.proforma_lines`

سطرهای پیش‌فاکتور: خدمت، تعداد و مبلغ.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `proforma_id` | `uuid` | خیر | شناسه پیش‌فاکتور |  |  |
| `line_no` | `integer` | خیر | شماره سطر |  |  |
| `service_id` | `uuid` | خیر | شناسه خدمت |  |  |
| `service_code` | `text` | خیر | کد خدمت |  |  |
| `tariff_version_id` | `uuid` | خیر | شناسه نسخه تعرفه |  |  |
| `tariff_min_rial` | `bigint` | خیر | کمینه تعرفه | ریال |  |
| `tariff_max_rial` | `bigint` | خیر | بیشینه تعرفه | ریال |  |
| `quantity` | `integer` | خیر | تعداد |  |  |
| `unit_rial` | `bigint` | خیر | واحد | ریال |  |
| `deviation_reason` | `text` | بله | دلیل انحراف |  |  |
| `line_total_rial` | `bigint` | خیر | جمع سطر | ریال |  |
| `tooth_or_site` | `text` | بله | ناحیه یا دندان |  |  |
| `note` | `text` | بله | یادداشت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `cost_kind` | `text` | خیر | نوع هزینه |  |  |
| `cost_kind_reason` | `text` | بله | دلیل نوع هزینه |  |  |

## `public.proformas`

پیش‌فاکتورهای پزشک برای بیمار.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `case_id` | `uuid` | خیر | شناسه پرونده |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `referral_id` | `uuid` | خیر | شناسه معرفی |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `center_id` | `uuid` | بله | شناسه مرکز |  |  |
| `city_code` | `text` | خیر | کد شهر |  |  |
| `version` | `integer` | خیر | نسخه |  |  |
| `supersedes_id` | `uuid` | بله | شناسه جایگزینِ |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `total_rial` | `bigint` | خیر | جمع | ریال |  |
| `tariff_snapshot_at` | `timestamp with time zone` | خیر | زمان تصویر لحظه‌ای تعرفه | زمان UTC |  |
| `issued_by` | `uuid` | بله | حساب صادرشده |  |  |
| `issued_at` | `timestamp with time zone` | بله | زمان صادرشده | زمان UTC |  |
| `expires_at` | `timestamp with time zone` | بله | زمان انقضا | زمان UTC |  |
| `validity_config_version_id` | `uuid` | بله | شناسه نسخه پیکربندی اعتبار |  |  |
| `patient_responded_at` | `timestamp with time zone` | بله | زمان پاسخ‌داده بیمار | زمان UTC |  |
| `patient_response_note` | `text` | بله | یادداشت پاسخ بیمار |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `discard_reason` | `text` | بله | دلیل کنارگذاشتن |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.purse_operation_requests`

درخواست‌های عملیات ویژه کیف، با تأیید.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `payload` | `jsonb` | خیر | محتوا |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `requested_at` | `timestamp with time zone` | خیر | زمان درخواست | زمان UTC |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `result` | `jsonb` | بله | نتیجه |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.purse_operations`

عملیات کیف اعتبار، با کلید عدم تکرار.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `authorization_id` | `text` | بله | شناسه مجوز |  |  |
| `doctor_node_id` | `uuid` | بله | شناسه گره سازمانی پزشک |  |  |
| `amount_rial` | `bigint` | بله | مبلغ | ریال |  |
| `journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری |  |  |
| `reverses_operation_id` | `uuid` | بله | شناسه عملیات معکوسِ |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `request_hash` | `text` | خیر | درهم‌سازی درخواست |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.purse_scope_versions`

نسخه‌های دامنه مصرف کیف.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `center_node_id` | `uuid` | خیر | شناسه گره سازمانی مرکز |  |  |
| `doctor_node_id` | `uuid` | خیر | شناسه گره سازمانی پزشک |  |  |
| `treatment_field_code` | `text` | خیر | کد رشته درمانی |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.referrals`

معرفی بیمار به پزشک یا مرکز.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `appointment_id` | `uuid` | خیر | شناسه نوبت |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `channel` | `text` | خیر | کانال |  |  |
| `referred_at` | `timestamp with time zone` | خیر | زمان معرفی‌شده | زمان UTC |  |
| `supersedes_referral_id` | `uuid` | بله | شناسه معرفی جایگزینِ |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.refresh_tokens`

توکن‌های تازه‌سازی چرخشی موبایل، درهم‌سازی‌شده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `session_id` | `uuid` | خیر | شناسه نشست |  |  |
| `token_hash` | `text` | خیر | درهم‌سازی توکن |  | راز |
| `parent_id` | `uuid` | بله | شناسه والد |  |  |
| `expires_at` | `timestamp with time zone` | خیر | زمان انقضا | زمان UTC |  |
| `used_at` | `timestamp with time zone` | بله | زمان استفاده‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.refund_payments`

بازپرداخت اضافه‌پرداخت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `borrower_person_id` | `uuid` | خیر | شناسه شخص وام‌گیرنده |  |  |
| `account_code` | `text` | خیر | کد حساب |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `bank_reference` | `text` | خیر | مرجع بانک |  |  |
| `paid_on` | `date` | خیر | روز پرداخت‌شده | روز |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `requested_at` | `timestamp with time zone` | خیر | زمان درخواست | زمان UTC |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.repayment_charges`

هزینه‌ها و جریمه‌های بازپرداخت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `schedule_id` | `uuid` | خیر | شناسه جدول اقساط |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `due_on` | `date` | خیر | روز سررسید | روز |  |
| `rate_bps` | `integer` | خیر | نرخ | صدم درصد |  |
| `base_rial` | `bigint` | خیر | پایه | ریال |  |
| `journal_entry_id` | `uuid` | خیر | شناسه ثبت سند حسابداری |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.report_assignments`

نمای مادی‌شده سپردن کارها برای گزارش.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | بله | شناسه (UUIDv7) |  |  |
| `queue_code` | `text` | بله | کد صف |  |  |
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `auto` | `boolean` | بله | خودکار |  |  |
| `assigned_at` | `timestamp with time zone` | بله | زمان سپرده‌شده | زمان UTC |  |
| `item_kind` | `text` | بله | نوع قلم |  |  |
| `item_id` | `uuid` | بله | شناسه قلم |  |  |
| `first_response_at` | `timestamp with time zone` | بله | زمان پاسخ نخستین | زمان UTC |  |
| `open_now` | `boolean` | بله | اکنون باز |  |  |

## `public.report_case_stages`

نمای مادی‌شده مراحل پرونده برای قیف فروش.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | بله | شناسه (UUIDv7) |  |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |
| `stage` | `text` | بله | مرحله |  |  |
| `entered_at` | `timestamp with time zone` | بله | زمان واردشده | زمان UTC |  |
| `left_at` | `timestamp with time zone` | بله | زمان خروج | زمان UTC |  |
| `channel` | `text` | بله | کانال |  |  |
| `treatment_field_code` | `text` | بله | کد رشته درمانی |  |  |
| `city_code` | `text` | بله | کد شهر |  |  |
| `assignee_account_id` | `uuid` | بله | شناسه حساب کارشناس مسئول |  |  |
| `case_created_at` | `timestamp with time zone` | بله | زمان ایجاد پرونده | زمان UTC |  |
| `abandonment_reason_code` | `text` | بله | کد دلیل رهاشدن |  |  |
| `current_status` | `text` | بله | وضعیت جاری |  |  |

## `public.report_centers`

نمای مادی‌شده نام مراکز برای گزارش.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | بله | شناسه (UUIDv7) |  |  |
| `name` | `text` | بله | نام |  |  |

## `public.report_credit_applications`

نمای مادی‌شده پرونده‌های اعتباری برای گزارش.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | بله | شناسه (UUIDv7) |  |  |
| `submitted_at` | `timestamp with time zone` | بله | زمان ارسال | زمان UTC |  |
| `sla_due_at` | `timestamp with time zone` | بله | زمان سررسید مهلت پاسخ | زمان UTC |  |
| `sla_breached_at` | `timestamp with time zone` | بله | زمان گذشته از مهلت مهلت پاسخ | زمان UTC |  |
| `final_outcome` | `text` | بله | نتیجه نهایی |  |  |
| `out_of_matrix` | `boolean` | بله | ماتریس از خارج |  |  |
| `grade` | `text` | بله | رتبه |  |  |

## `public.report_exports`

خروجی‌های گزارش، ثبت‌شده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `account_name` | `text` | خیر | نام حساب |  | شخصی |
| `report_code` | `text` | خیر | کد گزارش |  |  |
| `params` | `jsonb` | خیر | پارامترها |  |  |
| `format` | `text` | خیر | قالب |  |  |
| `money_unit` | `text` | خیر | واحد پول |  |  |
| `sensitive` | `boolean` | خیر | حساس |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `row_count` | `integer` | بله | شمار ردیف |  |  |
| `object_key` | `text` | بله | کلید شیء |  |  |
| `error` | `text` | بله | خطا |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `finished_at` | `timestamp with time zone` | بله | زمان پایان‌یافته | زمان UTC |  |

## `public.report_ledger_daily`

نمای مادی‌شده جمع روزانه دفتر کل.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `code` | `text` | بله | کد |  |  |
| `owner_type` | `text` | بله | نوع مالک |  |  |
| `owner_id` | `uuid` | بله | شناسه مالک |  |  |
| `entity_id` | `text` | بله | شناسه شخص |  |  |
| `event_type` | `text` | بله | نوع رویداد |  |  |
| `reversed_event_type` | `text` | بله | نوع رویداد معکوس‌شده |  |  |
| `day` | `date` | بله | روز | روز |  |
| `debit_rial` | `bigint` | بله | بدهکار | ریال |  |
| `credit_rial` | `bigint` | بله | اعتبار | ریال |  |
| `entries` | `integer` | بله | ثبت‌ها |  |  |

## `public.report_purses`

نمای مادی‌شده کیف‌ها برای گزارش.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | بله | شناسه (UUIDv7) |  |  |
| `center_node_id` | `uuid` | بله | شناسه گره سازمانی مرکز |  |  |
| `treatment_field_code` | `text` | بله | کد رشته درمانی |  |  |
| `case_id` | `uuid` | بله | شناسه پرونده |  |  |

## `public.report_refreshes`

سابقه تازه‌سازی نماهای گزارش.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `view_name` | `text` | خیر | نام نما |  |  |
| `refreshed_at` | `timestamp with time zone` | خیر | زمان تازه‌شده | زمان UTC |  |
| `duration_ms` | `integer` | خیر | مدت | میلی‌ثانیه |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.report_saved_filters`

فیلترهای ذخیره‌شده گزارش.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `owner_account_id` | `uuid` | خیر | شناسه حساب مالک |  |  |
| `report_code` | `text` | خیر | کد گزارش |  |  |
| `name` | `text` | خیر | نام |  |  |
| `conditions` | `jsonb` | خیر | شرط‌ها |  |  |
| `shared_unit` | `text` | بله | واحد مشترک |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |
| `deleted_by` | `uuid` | بله | حساب حذف‌کننده |  |  |

## `public.role_assignments`

نقش‌های سپرده‌شده به حساب‌ها، با دامنه سازمانی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `role_id` | `uuid` | خیر | شناسه نقش |  |  |
| `scope_kind` | `text` | خیر | نوع دامنه |  |  |
| `scope_node_id` | `uuid` | بله | شناسه گره سازمانی دامنه |  |  |
| `scope_code` | `text` | بله | کد دامنه |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `granted_by` | `uuid` | بله | حساب اعطاشده |  |  |
| `revoked_at` | `timestamp with time zone` | بله | زمان ابطال | زمان UTC |  |
| `revoked_by` | `uuid` | بله | حساب ابطال |  |  |
| `revoke_reason` | `text` | بله | دلیل ابطال |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.role_permissions`

مجوزهای هر نقش.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `role_id` | `uuid` | خیر | شناسه نقش |  |  |
| `permission_code` | `text` | خیر | کد مجوز |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.roles`

نقش‌ها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `name` | `text` | خیر | نام |  |  |
| `is_system` | `boolean` | خیر | آیا سامانه |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.schedule_templates`

الگوهای هفتگی تقویم کاری.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `weekday` | `text` | خیر | روز هفته |  |  |
| `start_minute` | `integer` | خیر | دقیقه آغاز |  |  |
| `end_minute` | `integer` | خیر | دقیقه پایان |  |  |
| `slot_minutes` | `integer` | خیر | زمان آزاد | دقیقه |  |
| `service_codes` | `text[]` | خیر | کدها خدمت |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `deleted_by` | `uuid` | بله | حساب حذف‌کننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.score_sheets`

برگه‌های امتیازدهی پلکانی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `subject` | `text` | خیر | موضوع |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `guarantor_id` | `uuid` | بله | شناسه ضامن |  |  |
| `ruleset_version_id` | `uuid` | خیر | شناسه نسخه مجموعه قاعده |  |  |
| `raw_inputs` | `jsonb` | خیر | ورودی‌ها خام |  |  |
| `answers` | `jsonb` | خیر | پاسخ‌ها |  |  |
| `criteria_scores` | `jsonb` | خیر | امتیازها معیارها |  |  |
| `total` | `integer` | بله | جمع |  |  |
| `grade` | `text` | بله | رتبه |  |  |
| `stop` | `boolean` | بله | توقف |  |  |
| `computed_by` | `uuid` | خیر | حساب محاسبه‌شده |  |  |
| `superseded_by` | `uuid` | بله | حساب جایگزین‌شده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.search_entries`

نمایه جست‌وجوی عمومی: هر محل کار فهرست‌شده با رشته‌ها، خدمات و نوبت آزاد.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `center_id` | `uuid` | بله | شناسه مرکز |  |  |
| `city_code` | `text` | خیر | کد شهر |  |  |
| `doctor_name` | `text` | خیر | نام پزشک |  | شخصی |
| `place_name` | `text` | بله | نام محل |  |  |
| `search_key` | `text` | خیر | کلید جست‌وجو |  |  |
| `doctor_name_key` | `text` | خیر | کلید نام پزشک |  | شخصی |
| `place_name_key` | `text` | بله | کلید نام محل |  |  |
| `treatment_fields` | `jsonb` | خیر | رشته‌ها درمانی |  |  |
| `treatment_field_codes` | `text[]` | خیر | کدها رشته درمانی |  |  |
| `service_codes` | `text[]` | خیر | کدها خدمت |  |  |
| `credit_enabled` | `boolean` | خیر | فعال اعتبار |  |  |
| `listed` | `boolean` | خیر | فهرست‌شده |  |  |
| `next_free_slot_at` | `timestamp with time zone` | بله | زمان آزاد بعدی | زمان UTC |  |
| `refresh_due_at` | `timestamp with time zone` | خیر | زمان سررسید تازه‌سازی | زمان UTC |  |
| `pending_changes` | `integer` | خیر | تغییرها در انتظار |  |  |
| `refreshed_at` | `timestamp with time zone` | خیر | زمان تازه‌شده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.search_entry_prices`

بازه قیمت هر خدمت در نمایه جست‌وجو.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `entry_id` | `uuid` | خیر | شناسه ثبت |  |  |
| `service_code` | `text` | خیر | کد خدمت |  |  |
| `is_visit` | `boolean` | خیر | آیا ویزیت |  |  |
| `offered` | `boolean` | خیر | ارائه‌شده |  |  |
| `is_free` | `boolean` | خیر | آیا آزاد |  |  |
| `min_amount_rial` | `bigint` | خیر | مبلغ کمینه | ریال |  |
| `max_amount_rial` | `bigint` | خیر | مبلغ بیشینه | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.search_query_log`

لاگ جست‌وجوی عمومی (۷-۶): فیلترها، شمار و زمان پاسخ، بی عبارت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `audience` | `text` | خیر | مخاطب |  |  |
| `order_by` | `text` | خیر | حساب ترتیب |  |  |
| `filters` | `text[]` | خیر | فیلترها |  |  |
| `filter_combo` | `text` | خیر | ترکیب فیلتر |  |  |
| `has_term` | `boolean` | خیر | دارای عبارت |  |  |
| `page` | `integer` | خیر | صفحه |  |  |
| `page_size` | `integer` | خیر | اندازه صفحه |  |  |
| `total` | `integer` | خیر | جمع |  |  |
| `returned` | `integer` | خیر | بازگشتی |  |  |
| `duration_ms` | `integer` | خیر | مدت | میلی‌ثانیه |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.search_rebuild_runs`

اجراهای بازسازی نمایه جست‌وجو.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `mode` | `text` | خیر | حالت |  |  |
| `workplaces` | `integer` | خیر | محل‌های کار |  |  |
| `inserted` | `integer` | خیر | درج‌شده |  |  |
| `updated` | `integer` | خیر | به‌روزرسانی |  |  |
| `unchanged` | `integer` | خیر | بی‌تغییر |  |  |
| `listed` | `integer` | خیر | فهرست‌شده |  |  |
| `unlisted` | `integer` | خیر | خارج از فهرست |  |  |
| `started_at` | `timestamp with time zone` | خیر | زمان آغازشده | زمان UTC |  |
| `finished_at` | `timestamp with time zone` | خیر | زمان پایان‌یافته | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.service_authorization_lines`

سطرهای مجوز خدمت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `authorization_id` | `uuid` | خیر | شناسه مجوز |  |  |
| `proforma_line_id` | `uuid` | خیر | شناسه سطر پیش‌فاکتور |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `released_at` | `timestamp with time zone` | بله | زمان آزادشده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.service_authorizations`

مجوزهای خدمت با کد یک‌بارمصرف.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `doctor_node_id` | `uuid` | خیر | شناسه گره سازمانی پزشک |  |  |
| `center_node_id` | `uuid` | خیر | شناسه گره سازمانی مرکز |  |  |
| `treatment_field_code` | `text` | خیر | کد رشته درمانی |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `issued_by` | `uuid` | خیر | حساب صادرشده |  |  |
| `issued_at` | `timestamp with time zone` | خیر | زمان صادرشده | زمان UTC |  |
| `expires_at` | `timestamp with time zone` | خیر | زمان انقضا | زمان UTC |  |
| `finalize_after_hours` | `integer` | خیر | پس از نهایی‌کردن | ساعت |  |
| `max_code_attempts` | `integer` | خیر | تلاش‌ها کد بیشینه |  |  |
| `max_code_sends` | `integer` | خیر | ارسال‌ها کد بیشینه |  |  |
| `resend_cooldown_seconds` | `integer` | خیر | فاصله انتظار ارسال دوباره | ثانیه |  |
| `code_ttl_minutes` | `integer` | خیر | عمر کد | دقیقه |  |
| `config_version_ids` | `jsonb` | خیر | شناسه‌های نسخه پیکربندی |  |  |
| `code_attempts` | `integer` | خیر | تلاش‌ها کد |  |  |
| `code_sends` | `integer` | خیر | ارسال‌ها کد |  |  |
| `delivered_at` | `timestamp with time zone` | بله | زمان تحویل‌شده | زمان UTC |  |
| `register_operation_id` | `uuid` | بله | شناسه عملیات ثبت |  |  |
| `finalize_due_at` | `timestamp with time zone` | بله | زمان سررسید نهایی‌کردن | زمان UTC |  |
| `finalized_at` | `timestamp with time zone` | بله | زمان نهایی‌شده | زمان UTC |  |
| `expired_at` | `timestamp with time zone` | بله | زمان منقضی | زمان UTC |  |
| `cancelled_at` | `timestamp with time zone` | بله | زمان لغوشده | زمان UTC |  |
| `cancelled_by` | `uuid` | بله | حساب لغوشده |  |  |
| `cancel_reason` | `text` | بله | دلیل لغو |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `reversed_at` | `timestamp with time zone` | بله | زمان معکوس‌شده | زمان UTC |  |

## `public.service_codes`

کدهای یک‌بارمصرف مجوز خدمت، درهم‌سازی‌شده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `authorization_id` | `uuid` | خیر | شناسه مجوز |  |  |
| `code_hash` | `text` | خیر | درهم‌سازی کد |  |  |
| `sent_at` | `timestamp with time zone` | خیر | زمان ارسال‌شده | زمان UTC |  |
| `expires_at` | `timestamp with time zone` | خیر | زمان انقضا | زمان UTC |  |
| `consumed_at` | `timestamp with time zone` | بله | زمان مصرف‌شده | زمان UTC |  |
| `voided_at` | `timestamp with time zone` | بله | زمان باطل‌شده | زمان UTC |  |

## `public.service_doctor_patients`

رابطه پزشک و بیمار برای ثبت خدمت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `credit_application_id` | `uuid` | خیر | شناسه پرونده اعتباری اعتبار |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `workplace_node_path` | `text` | خیر | مسیر گره سازمانی محل کار |  |  |
| `patient_person_id` | `uuid` | خیر | شناسه شخص بیمار |  |  |
| `funded_at` | `timestamp with time zone` | خیر | زمان شارژشده | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.service_fees`

کارمزدهای خدمت قفل‌شده روی رکورد.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `doctor_payable_id` | `uuid` | بله | شناسه بستانکاری پزشک |  |  |
| `cash_service_id` | `uuid` | بله | شناسه خدمت نقدی |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `doctor_node_id` | `uuid` | خیر | شناسه گره سازمانی پزشک |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `basis` | `text` | خیر | مبنا |  |  |
| `rate_value` | `text` | خیر | مقدار نرخ |  |  |
| `config_version_id` | `uuid` | خیر | شناسه نسخه پیکربندی |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `due_at` | `timestamp with time zone` | خیر | زمان سررسید | زمان UTC |  |
| `journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `statement_id` | `uuid` | بله | شناسه صورت‌وضعیت |  |  |
| `dispute_id` | `uuid` | بله | شناسه اعتراض |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.service_purse_workplaces`

محل‌های کار مجاز هر کیف.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `purse_id` | `uuid` | خیر | شناسه کیف اعتبار |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `workplace_node_path` | `text` | خیر | مسیر گره سازمانی محل کار |  |  |
| `event_id` | `uuid` | خیر | شناسه رویداد |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.services`

خدمات درمانی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `field_id` | `uuid` | بله | شناسه رشته |  |  |
| `code` | `text` | خیر | کد |  |  |
| `name` | `text` | خیر | نام |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |
| `cost_kind` | `text` | خیر | نوع هزینه |  |  |

## `public.sessions`

نشست‌های ورود، با توکن درهم‌سازی‌شده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `client` | `text` | خیر | کارخواه |  |  |
| `stage` | `text` | خیر | مرحله |  |  |
| `token_hash` | `text` | خیر | درهم‌سازی توکن |  | راز |
| `token_expires_at` | `timestamp with time zone` | خیر | زمان انقضا توکن | زمان UTC |  |
| `device_id` | `text` | بله | شناسه دستگاه |  |  |
| `device_label` | `text` | بله | برچسب دستگاه |  |  |
| `ip` | `text` | بله | نشانی IP |  | شخصی |
| `authenticated_at` | `timestamp with time zone` | خیر | زمان احرازشده | زمان UTC |  |
| `last_seen_at` | `timestamp with time zone` | خیر | زمان دیده‌شده آخرین | زمان UTC |  |
| `revoked_at` | `timestamp with time zone` | بله | زمان ابطال | زمان UTC |  |
| `revoke_reason` | `text` | بله | دلیل ابطال |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |
| `reauthenticated_at` | `timestamp with time zone` | بله | زمان بازاحراز‌شده | زمان UTC |  |

## `public.settlement_dispute_postings`

ثبت‌های حل اعتراض تسویه.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `dispute_id` | `uuid` | خیر | شناسه اعتراض |  |  |
| `step` | `text` | خیر | گام |  |  |
| `purse_operation_id` | `uuid` | بله | شناسه عملیات کیف اعتبار |  |  |
| `journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری |  |  |
| `revision_id` | `uuid` | بله | شناسه بازنگری |  |  |
| `amount_rial` | `bigint` | بله | مبلغ | ریال |  |
| `down_payment_rial` | `bigint` | بله | پیش‌پرداخت | ریال |  |
| `entity_id` | `text` | بله | شناسه شخص |  |  |
| `borrower_person_id` | `uuid` | بله | شناسه شخص وام‌گیرنده |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.settlement_statement_lines`

سطرهای صورت‌وضعیت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `statement_id` | `uuid` | خیر | شناسه صورت‌وضعیت |  |  |
| `line_type` | `text` | خیر | نوع سطر |  |  |
| `ref_type` | `text` | خیر | نوع مرجع |  |  |
| `ref_id` | `uuid` | خیر | شناسه مرجع |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.settlement_statements`

صورت‌وضعیت‌های دوره‌ای پزشک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `doctor_id` | `uuid` | خیر | شناسه پزشک |  |  |
| `entity_id` | `text` | خیر | شناسه شخص |  |  |
| `period_year` | `integer` | خیر | سال دوره |  |  |
| `period_month` | `integer` | خیر | ماه دوره |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `gross_credit_services_rial` | `bigint` | خیر | خدمات اعتبار ناخالص | ریال |  |
| `credit_fees_rial` | `bigint` | خیر | کارمزدها اعتبار | ریال |  |
| `cash_fees_rial` | `bigint` | خیر | کارمزدها نقدی | ریال |  |
| `carried_in_rial` | `bigint` | خیر | ورودی منتقل‌شده | ریال |  |
| `other_deductions_rial` | `bigint` | خیر | کسورات دیگر | ریال |  |
| `payable_rial` | `bigint` | خیر | بستانکاری | ریال |  |
| `carried_out_rial` | `bigint` | خیر | خارج منتقل‌شده | ریال |  |
| `offset_rial` | `bigint` | خیر | جابه‌جایی | ریال |  |
| `offset_journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری جابه‌جایی |  |  |
| `previous_statement_id` | `uuid` | بله | شناسه صورت‌وضعیت پیشین |  |  |
| `generated_at` | `timestamp with time zone` | خیر | زمان تولیدشده | زمان UTC |  |
| `reviewed_by` | `uuid` | بله | حساب بازبینی |  |  |
| `reviewed_at` | `timestamp with time zone` | بله | زمان بازبینی | زمان UTC |  |
| `approved_by` | `uuid` | بله | حساب تأییدشده |  |  |
| `approved_at` | `timestamp with time zone` | بله | زمان تأییدشده | زمان UTC |  |
| `pdf_hash` | `text` | بله | درهم‌سازی PDF |  |  |
| `cancel_requested_by` | `uuid` | بله | حساب درخواست لغو |  |  |
| `cancel_requested_at` | `timestamp with time zone` | بله | زمان درخواست لغو | زمان UTC |  |
| `cancel_reason` | `text` | بله | دلیل لغو |  |  |
| `cancelled_by` | `uuid` | بله | حساب لغوشده |  |  |
| `cancelled_at` | `timestamp with time zone` | بله | زمان لغوشده | زمان UTC |  |
| `cancel_journal_entry_id` | `uuid` | بله | شناسه ثبت سند حسابداری لغو |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.sms_campaign_recipients`

گیرندگان کارزار پیامکی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `campaign_id` | `uuid` | خیر | شناسه کارزار |  |  |
| `person_id` | `uuid` | بله | شناسه شخص |  |  |
| `mobile` | `text` | خیر | موبایل |  | شخصی |
| `values` | `jsonb` | خیر | مقادیر |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `cancel_reason` | `text` | بله | دلیل لغو |  |  |
| `dispatch_id` | `uuid` | بله | شناسه ارسال |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.sms_campaigns`

کارزارهای پیامک گروهی با تأیید.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `name` | `text` | خیر | نام |  |  |
| `audience` | `text` | خیر | مخاطب |  |  |
| `filter_code` | `text` | خیر | کد فیلتر |  |  |
| `filter_params` | `jsonb` | خیر | پارامترها فیلتر |  |  |
| `template_id` | `uuid` | خیر | شناسه الگو |  |  |
| `category` | `text` | خیر | دسته |  |  |
| `two_person_threshold` | `integer` | خیر | آستانه شخص دو |  |  |
| `send_from` | `timestamp with time zone` | خیر | از ارسال | زمان UTC |  |
| `created_by` | `uuid` | خیر | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `recipient_count` | `integer` | بله | شمار گیرنده |  |  |
| `excluded` | `jsonb` | بله | کنارگذاشته |  |  |
| `cost_estimate_rial` | `bigint` | بله | برآورد هزینه | ریال |  |
| `approved_by` | `uuid` | بله | حساب تأییدشده |  |  |
| `approved_at` | `timestamp with time zone` | بله | زمان تأییدشده | زمان UTC |  |
| `last_batch_at` | `timestamp with time zone` | بله | زمان دسته آخرین | زمان UTC |  |
| `stopped_by` | `uuid` | بله | حساب متوقف |  |  |
| `stopped_at` | `timestamp with time zone` | بله | زمان متوقف | زمان UTC |  |
| `stop_reason` | `text` | بله | دلیل توقف |  |  |
| `completed_at` | `timestamp with time zone` | بله | زمان تکمیل‌شده | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.sms_consents`

رضایت دریافت پیامک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `mobile` | `text` | خیر | موبایل |  | شخصی |
| `person_id` | `uuid` | بله | شناسه شخص |  |  |
| `action` | `text` | خیر | اقدام |  |  |
| `source` | `text` | خیر | منبع |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `recorded_by` | `uuid` | بله | حساب ثبت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.sms_dispatches`

ارسال‌های پیامک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `template_id` | `uuid` | خیر | شناسه الگو |  |  |
| `category` | `text` | خیر | دسته |  |  |
| `audience` | `text` | خیر | مخاطب |  |  |
| `person_id` | `uuid` | بله | شناسه شخص |  |  |
| `mobile` | `text` | خیر | موبایل |  | شخصی |
| `text` | `text` | خیر | متن |  |  |
| `segments` | `integer` | خیر | بخش‌ها |  |  |
| `cost_estimate_rial` | `bigint` | خیر | برآورد هزینه | ریال |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `suppressed_reason` | `text` | بله | دلیل سرکوب‌شده |  |  |
| `send_after` | `timestamp with time zone` | خیر | پس از ارسال | زمان UTC |  |
| `not_after` | `timestamp with time zone` | خیر | پس از نه | زمان UTC |  |
| `queued_at` | `timestamp with time zone` | بله | زمان در صف | زمان UTC |  |
| `sent_at` | `timestamp with time zone` | بله | زمان ارسال‌شده | زمان UTC |  |
| `provider_message_id` | `text` | بله | شناسه پیام ارائه‌دهنده |  |  |
| `delivery_status` | `text` | بله | وضعیت تحویل |  |  |
| `delivery_checked_at` | `timestamp with time zone` | بله | زمان بررسی‌شده تحویل | زمان UTC |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |

## `public.sms_templates`

الگوهای متن پیامک.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `version` | `integer` | خیر | نسخه |  |  |
| `audience` | `text` | خیر | مخاطب |  |  |
| `category` | `text` | خیر | دسته |  |  |
| `body` | `text` | خیر | متن |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.staff_mobile_change_events`

تأیید، رد، انصراف یا اعمال درخواست تغییر شماره همراه کارکنان؛ هر تصمیم یک ردیف.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `change_id` | `uuid` | خیر | شناسه تغییر |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `by_account_id` | `uuid` | بله | شناسه حساب کاربر |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.staff_mobile_changes`

درخواست تغییر شماره همراه امضاکننده مالی کارکنان (ADR-052): با تأیید دو نفر دیگر و ۲۴ ساعت فاصله.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `account_id` | `uuid` | خیر | شناسه حساب |  |  |
| `new_mobile` | `text` | خیر | موبایل تازه |  | شخصی |
| `reason` | `text` | خیر | دلیل |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.staff_offboarding_requests`

درخواست‌های خروج کارمند (غیرفعال کردن حساب، لغو نقش‌ها و نشست‌ها)، با تأیید دونفره.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `target_account_id` | `uuid` | خیر | شناسه حساب هدف |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `roles_revoked` | `integer` | بله | ابطال نقش‌ها |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.support_requests`

درخواست‌های پشتیبانی پیش از پرونده.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `subject_type` | `text` | خیر | نوع موضوع |  |  |
| `subject_id` | `uuid` | خیر | شناسه موضوع |  |  |
| `person_id` | `uuid` | خیر | شناسه شخص |  |  |
| `account_id` | `uuid` | بله | شناسه حساب |  |  |
| `note` | `text` | خیر | یادداشت |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.tariff_versions`

نسخه‌های تعرفه.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `tariff_id` | `uuid` | خیر | شناسه تعرفه |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `is_free` | `boolean` | خیر | آیا آزاد |  |  |
| `min_amount_rial` | `bigint` | بله | مبلغ کمینه | ریال |  |
| `max_amount_rial` | `bigint` | بله | مبلغ بیشینه | ریال |  |
| `effective_at` | `timestamp with time zone` | خیر | زمان مؤثر | زمان UTC |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `cancelled_at` | `timestamp with time zone` | بله | زمان لغوشده | زمان UTC |  |
| `cancelled_by` | `uuid` | بله | حساب لغوشده |  |  |
| `cancel_reason` | `text` | بله | دلیل لغو |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.tariffs`

تعرفه خدمات در هر محل کار.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `service_id` | `uuid` | خیر | شناسه خدمت |  |  |
| `owner_kind` | `text` | خیر | نوع مالک |  |  |
| `workplace_id` | `uuid` | بله | شناسه محل کار |  |  |
| `center_id` | `uuid` | بله | شناسه مرکز |  |  |
| `node_path` | `text` | خیر | مسیر گره سازمانی |  |  |
| `city_code` | `text` | خیر | کد شهر |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ticket_attachments`

پیوست‌های تیکت در ذخیره‌ساز خصوصی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `ticket_id` | `uuid` | خیر | شناسه تیکت |  |  |
| `message_id` | `uuid` | بله | شناسه پیام |  |  |
| `visibility` | `text` | خیر | نمایانی |  |  |
| `object_key` | `text` | خیر | کلید شیء |  |  |
| `content_type` | `text` | خیر | نوع محتوا |  |  |
| `size_bytes` | `integer` | خیر | اندازه | بایت |  |
| `sha256` | `text` | خیر | SHA-256 |  |  |
| `contains_treatment` | `boolean` | خیر | درمانی شامل |  |  |
| `uploaded_by` | `uuid` | بله | حساب بارگذاری |  |  |
| `uploader_side` | `text` | خیر | طرف بارگذارنده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ticket_events`

رویدادهای تیکت (وضعیت، واحد، مهلت).

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `ticket_id` | `uuid` | خیر | شناسه تیکت |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `from_status` | `text` | بله | وضعیت از |  |  |
| `to_status` | `text` | بله | وضعیت به |  |  |
| `from_unit` | `text` | بله | واحد از |  |  |
| `to_unit` | `text` | بله | واحد به |  |  |
| `assignee_account_id` | `uuid` | بله | شناسه حساب کارشناس مسئول |  |  |
| `reason` | `text` | بله | دلیل |  |  |
| `due_at` | `timestamp with time zone` | بله | زمان سررسید | زمان UTC |  |
| `actor_account_id` | `uuid` | بله | شناسه حساب کنشگر |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ticket_links`

پیوند تیکت به نوبت، پیش‌فاکتور، خدمت، قسط یا تسویه.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `ticket_id` | `uuid` | خیر | شناسه تیکت |  |  |
| `entity_type` | `text` | خیر | نوع شخص |  |  |
| `entity_id` | `uuid` | خیر | شناسه شخص |  |  |
| `label` | `text` | خیر | برچسب |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ticket_message_flags`

علامت‌گذاری پیام‌های تیکت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `ticket_id` | `uuid` | خیر | شناسه تیکت |  |  |
| `message_id` | `uuid` | خیر | شناسه پیام |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `flagged_by` | `uuid` | بله | حساب علامت‌خورده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.ticket_messages`

پیام‌های تیکت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `ticket_id` | `uuid` | خیر | شناسه تیکت |  |  |
| `author_account_id` | `uuid` | بله | شناسه حساب نویسنده |  |  |
| `author_side` | `text` | خیر | طرف نویسنده |  |  |
| `visibility` | `text` | خیر | نمایانی |  |  |
| `body` | `text` | خیر | متن |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `contains_treatment` | `boolean` | خیر | درمانی شامل |  |  |

## `public.tickets`

تیکت‌ها و شکایت‌ها.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `number` | `bigint` | خیر | شماره |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `topic_code` | `text` | خیر | کد موضوع |  |  |
| `unit` | `text` | خیر | واحد |  |  |
| `subject` | `text` | خیر | موضوع |  |  |
| `requester_channel` | `text` | خیر | کانال درخواست‌کننده |  |  |
| `requester_account_id` | `uuid` | بله | شناسه حساب درخواست‌کننده |  |  |
| `requester_person_id` | `uuid` | بله | شناسه شخص درخواست‌کننده |  |  |
| `requester_node_id` | `uuid` | بله | شناسه گره سازمانی درخواست‌کننده |  |  |
| `requester_node_path` | `ltree` | بله | مسیر گره سازمانی درخواست‌کننده |  |  |
| `opened_by` | `uuid` | بله | حساب بازشده |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `assignee_account_id` | `uuid` | بله | شناسه حساب کارشناس مسئول |  |  |
| `response_hours` | `integer` | خیر | پاسخ | ساعت |  |
| `config_version_id` | `uuid` | خیر | شناسه نسخه پیکربندی |  |  |
| `due_at` | `timestamp with time zone` | بله | زمان سررسید | زمان UTC |  |
| `paused_at` | `timestamp with time zone` | بله | زمان متوقف‌موقت | زمان UTC |  |
| `resolved_at` | `timestamp with time zone` | بله | زمان حل‌شده | زمان UTC |  |
| `closed_at` | `timestamp with time zone` | بله | زمان بسته‌شده | زمان UTC |  |
| `reopened_count` | `integer` | خیر | شمار بازگشایی‌شده |  |  |
| `source` | `text` | بله | منبع |  |  |
| `source_id` | `uuid` | بله | شناسه منبع |  |  |
| `legacy_support_request_id` | `uuid` | بله | شناسه درخواست پشتیبانی قدیمی |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `financial_dispute_id` | `uuid` | بله | شناسه اعتراض مالی |  |  |
| `respondent_node_path` | `ltree` | بله | مسیر گره سازمانی پاسخ‌گو |  |  |

## `public.totp_reset_requests`

درخواست‌های بازنشانی احراز دومرحله‌ای، با تأیید دونفره.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `target_account_id` | `uuid` | خیر | شناسه حساب هدف |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.treatment_fields`

رشته‌های درمانی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `code` | `text` | خیر | کد |  |  |
| `name` | `text` | خیر | نام |  |  |
| `sort_order` | `integer` | خیر | ترتیب ترتیب |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.user_accounts`

حساب‌های کاربری کارکنان، پزشکان و بیماران.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `kind` | `text` | خیر | نوع |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `mobile` | `text` | بله | موبایل |  | شخصی |
| `username` | `text` | بله | نام کاربری |  | شخصی |
| `display_name` | `text` | بله | نام نمایش |  | شخصی |
| `person_id` | `uuid` | بله | شناسه شخص |  |  |
| `password_hash` | `text` | بله | درهم‌سازی گذرواژه |  | راز |
| `totp_secret_encrypted` | `text` | بله | راز TOTP |  | راز، رمزگذاری‌شده |
| `totp_confirmed_at` | `timestamp with time zone` | بله | زمان تأییدشده TOTP | زمان UTC |  |
| `totp_last_step` | `integer` | بله | گام آخرین TOTP |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |
| `mobile_verified_at` | `timestamp with time zone` | بله | زمان تأییدشده موبایل | زمان UTC | شخصی |

## `public.visit_payments`

پرداخت ویزیت نوبت.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `appointment_id` | `uuid` | خیر | شناسه نوبت |  |  |
| `amount_rial` | `bigint` | خیر | مبلغ | ریال |  |
| `reason` | `text` | بله | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.visit_tariff_proposals`

پیشنهاد تعرفه ویزیت پزشک از پنل داخلی با تأیید دونفره؛ تأیید نسخه تعرفه را می‌سازد.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `is_free` | `boolean` | خیر | آیا آزاد |  |  |
| `min_amount_rial` | `bigint` | خیر | مبلغ کمینه | ریال |  |
| `max_amount_rial` | `bigint` | خیر | مبلغ بیشینه | ریال |  |
| `effective_at` | `timestamp with time zone` | بله | زمان مؤثر | زمان UTC |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `requested_by` | `uuid` | خیر | حساب درخواست |  |  |
| `decided_by` | `uuid` | بله | حساب تصمیم |  |  |
| `decided_at` | `timestamp with time zone` | بله | زمان تصمیم | زمان UTC |  |
| `decision_reason` | `text` | بله | دلیل تصمیم |  |  |
| `tariff_version_id` | `uuid` | بله | شناسه نسخه تعرفه |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
| `updated_at` | `timestamp with time zone` | خیر | زمان آخرین به‌روزرسانی | زمان UTC |  |
| `deleted_at` | `timestamp with time zone` | بله | زمان حذف منطقی | زمان UTC |  |

## `public.webhook_deliveries`

تحویل وب‌هوک‌های ورودی.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `source` | `text` | خیر | منبع |  |  |
| `idempotency_key` | `text` | خیر | کلید عدم تکرار |  |  |
| `status` | `text` | خیر | وضعیت |  |  |
| `intake_id` | `uuid` | بله | شناسه ورود |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |

## `public.workplace_approval_modes`

حالت تأیید نوبت در هر محل کار.

| ستون | نوع | تهی‌پذیر | توضیح | واحد | حساسیت |
|---|---|---|---|---|---|
| `id` | `uuid` | خیر | شناسه (UUIDv7) |  |  |
| `workplace_id` | `uuid` | خیر | شناسه محل کار |  |  |
| `mode` | `text` | خیر | حالت |  |  |
| `reason` | `text` | خیر | دلیل |  |  |
| `created_by` | `uuid` | بله | حساب ایجادکننده |  |  |
| `created_at` | `timestamp with time zone` | خیر | زمان ایجاد | زمان UTC |  |
