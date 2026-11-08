# ۰۱ — واژه‌نامه دامنه و نام‌گذاری

نام‌های انگلیسی این جدول **تنها** نام‌های مجاز در کد، جدول‌ها و API هستند. مترادف نسازید.

## قواعد نام‌گذاری

- جدول‌ها: `snake_case` جمع (`credit_applications`)
- ستون‌ها: `snake_case`
- کلاس و نوع: `PascalCase`
- متغیر و تابع: `camelCase`
- کد مجوز: `module.action` (`settlement.approve`)
- ستون مبلغ: همیشه پسوند `_rial` (`amount_rial`, `installment_rial`)
- ستون زمان: پسوند `_at` و نوع `timestamptz`

## اشخاص و سازمان

| فارسی | انگلیسی | توضیح |
|---|---|---|
| شخص | `Person` | رکورد یکتا برای هر انسان؛ کلید: موبایل یکسان‌شده و کد ملی |
| بیمار | `Patient` | نقش شخص در یک پرونده درمان |
| وام‌گیرنده | `Borrower` | نقش شخص در پرونده اعتباری؛ ممکن است با بیمار یکی نباشد |
| ضامن | `Guarantor` | |
| دریافت‌کننده مجاز خدمت | `AuthorizedRecipient` | در انتقال اعتبار؛ بدهی نزد وام‌گیرنده می‌ماند |
| مشاور / حامی | `Advisor` | کارشناس فروش که به بیمار تخصیص می‌یابد |
| مرکز درمانی | `Center` | کلینیک، بیمارستان یا مطب شخصی |
| شعبه | `Branch` | زیر مرکز؛ مرکز تک‌شعبه یک شعبه پیش‌فرض دارد |
| مدیر شبکه درمان | `NetworkManager` | تأییدکننده دوم فعال‌سازی مرکز |
| پزشک | `Doctor` | زیرمجموعه مرکز؛ در مطب شخصی خودش ریشه است |
| منشی | `Secretary` | دسترسی‌اش را پزشک تعیین می‌کند |
| شرکت حقوقی | `LegalEntity` | `aramesh` و `sepehr` |

## کاتالوگ و نوبت

| فارسی | انگلیسی |
|---|---|
| فیلد درمان | `TreatmentField` |
| خدمت | `Service` |
| تعرفه | `Tariff` |
| نسخه تعرفه | `TariffVersion` |
| خدمت ویژه ویزیت | `VisitService` |
| تقویم و ظرفیت | `Availability` |
| الگوی هفتگی | `ScheduleTemplate` |
| استثنای تقویم | `AvailabilityException` |
| اسلات (نوبت خالی محاسبه‌شده) | `Slot` |
| حالت تأیید نوبت | `ApprovalMode` |
| نوبت | `Appointment` |
| پذیرش / حضور | `CheckIn` |
| عدم حضور | `NoShow` |
| تعطیلی (سراسری یا شهری) | `Holiday` |
| روز کاری | `WorkingDay` |
| تعطیل هفتگی | `WeeklyDayOff` |
| پروفایل ارائه‌دهنده (پزشک) | `Doctor` |
| شماره نظام پزشکی | `MedicalCouncilNumber` |
| محل کار پزشک | `DoctorWorkplace` |
| منشی پزشک | `DoctorSecretary` |

## سرنخ و پرونده

| فارسی | انگلیسی | توضیح |
|---|---|---|
| سرنخ | `Lead` | ورودی خام |
| ورود سرنخ | `CaseIntake` | هر بار ورود، حتی تکراری یا مسدود؛ فقط افزودنی |
| ادغام شخص | `PersonMerge` | دو `Person` یک انسان؛ بازگردانی‌پذیر |
| دسته ورود اکسل | `LeadImportBatch` | یک بارگذاری؛ فایل نگه داشته نمی‌شود |
| نسخه درصدهای تخصیص | `AssignmentWeightVersion` | با هر تغییر، شمارش از نو |
| فرصت / پرونده درمان | `Case` | هر بار مراجعه یک `Case` جدید روی همان `Person` |
| معرفی به مرکز | `Referral` | مبنای کارمزد خدمت نقدی |
| پیش‌فاکتور | `Proforma` | نسخه‌دار؛ هر تغییر نسخه جدید |
| ردیف پیش‌فاکتور | `ProformaLine` |
| پرونده اعتباری | `CreditApplication` |
| برگه امتیاز | `ScoreSheet` |
| طرح وام | `CreditPlan` |
| قرارداد | `Contract` |
| مدرک | `Document` |
| رسید فیزیکی | `PhysicalDelivery` |

## مالی

| فارسی | انگلیسی | توضیح |
|---|---|---|
| کیف اعتبار | `CreditPurse` | در UI «کیف اعتبار»؛ هرگز «کیف پول» |
| عملیات کیف | `PurseOperation` | فقط افزودنی؛ وضعیت رزروها از آن محاسبه می‌شود |
| رزرو کیف | `PurseReservation` | مبلغ رزروشده برای یک مجوز خدمت؛ ذخیره نمی‌شود، از عملیات محاسبه می‌شود |
| نگه‌داشتن مصرف | `ConsumptionHold` | مصرف ثبت‌شده‌ای که تا رفع نگه‌داشت قطعی نمی‌شود |
| حساب دفتر کل | `LedgerAccount` |
| ثبت دفتر کل | `LedgerEntry` | فقط افزودنی |
| کلید عدم تکرار | `IdempotencyKey` | اجباری در هر سند؛ همان کلید همان سند را برمی‌گرداند |
| سند مالی | `JournalEntry` | مجموعه ثبت‌های یک رویداد؛ همیشه تراز |
| مجوز خدمت | `ServiceAuthorization` |
| ثبت خدمت | `ServiceDelivery` |
| بدهی به پزشک | `DoctorPayable` | با تاریخ سررسید خودش |
| کارمزد خدمت اعتباری | `CreditServiceFee` |
| خدمت نقدی | `CashService` |
| کارمزد خدمت نقدی | `CashServiceFee` |
| صورت‌وضعیت پزشک | `SettlementStatement` |
| دستور پرداخت | `PayoutOrder` |
| هزینه تشکیل پرونده | `OriginationFee` |
| کارمزد طرح | `PlanFee` |
| برنامه اقساط | `InstallmentSchedule` |
| قسط | `Installment` |
| تخصیص پرداخت | `PaymentAllocation` |
| پرداخت | `Payment` |
| فیش واریزی | `PaymentReceipt` |
| خسارت انصراف | `CancellationPenalty` |
| سند معکوس | `ReversalEntry` |
| مانده حساب (نمای مادی‌شده) | `AccountBalance` |
| اجرای تطبیق | `ReconciliationRun` |
| مغایرت دفتر کل | `LedgerDiscrepancy` |

## وصول و ابزار

| فارسی | انگلیسی |
|---|---|
| معوق | `Overdue` |
| صف وصول | `CollectionQueue` |
| اقدام وصول | `CollectionAction` |
| وعده پرداخت | `PaymentPromise` |
| چک | `Cheque` |
| سفته | `PromissoryNote` |
| ابزار تضمین | `Instrument` |

## پشتیبانی و سامانه

| فارسی | انگلیسی |
|---|---|
| تیکت | `Ticket` |
| شکایت مالی | `FinancialDispute` |
| سابقه اقدام | `AuditEvent` |
| کلید پیکربندی | `ConfigKey` |
| نسخه پیکربندی | `ConfigVersion` |
| قالب پیامک | `SmsTemplate` |
| ارسال پیامک | `SmsDispatch` |
| رویداد دامنه | `DomainEvent` |
| صندوق خروجی رویداد | `OutboxEvent` |
| صف کاری | `WorkQueue` |
| قاعده تخصیص | `AssignmentRule` |
| وضعیت مرکز | `CenterStatus` |
| مدرک مرکز | `CenterDocument` |
| درخواست دونفره مرکز | `CenterChangeRequest` |
| نمایه کور (جست‌وجوی داده رمزشده) | `BlindIndex` |
| شبا | `Sheba` |
| اعلان پنل مدیریت | `AdminNotice` |

## هویت و نشست

| فارسی | انگلیسی | توضیح |
|---|---|---|
| حساب کاربری | `UserAccount` | جدول `user_accounts`؛ نوع: بیمار، کارشناس یا مرکز. حساب بیمار در صورت وجود به `Person` وصل می‌شود |
| نشست | `Session` | یک دستگاه واردشده؛ خروج یعنی ابطال، نه حذف |
| توکن تازه‌سازی | `RefreshToken` | فقط موبایل؛ چرخشی و یک‌بارمصرف |
| چالش رمز یک‌بارمصرف | `OtpChallenge` | کد ورود بیمار؛ کوتاه‌عمر |
| درخواست ریست TOTP | `TotpResetRequest` | نیازمند تأیید دونفره |

## دسترسی و سابقه

| فارسی | انگلیسی | توضیح |
|---|---|---|
| مجوز | `Permission` | کد ثابت `module.action`؛ جدول `permissions` فقط آینه آن است |
| نقش | `Role` | مجموعه مجوز؛ داده است و مدیر می‌سازد. نقش‌های سیستمی از مهاجرت می‌آیند و قفل‌اند |
| تخصیص نقش | `RoleAssignment` | نقش یک حساب در یک حوزه؛ لغو یعنی `revoked_at`، نه حذف |
| حوزه | `Scope` | سراسری، شهر، مرکز، پزشک، صف کاری (تیمی)، پرونده‌های خودم |
| گره سازمانی | `OrgNode` | گره درخت مرکز ← پزشک ← منشی با مسیر `ltree` |
| لاگ دسترسی | `AccessLog` | چه کسی کدام رکورد یا فایل را دید؛ جدول `access_logs` |
| از طرف پزشک | `OnBehalfOfDoctor` | اقدام منشی یا مدیر مرکز برای پزشک؛ ستون `on_behalf_of_doctor_id` در `audit_events` |

جدول `AuditEvent` (بخش بعد) `audit_events` است: فقط افزودنی، با زنجیره هش و پارتیشن ماهانه.

## وضعیت‌ها (مقادیر ثابت)

`Case`: `new` → `advising` → `appointment_booked` → `examined` → `proforma_issued` → `credit_requested` → `credit_decided` → `contracted` → `funded` → `in_treatment` → `completed` | `cancelled`

`CreditApplication`: `draft` → `incomplete` → `ready_for_review` → `scoring` → `manual_review` → `approved` | `conditional` | `rejected` | `expired`

`Proforma`: `draft` → `issued` → `patient_confirmed` | `disputed` | `superseded` | `expired`

`DoctorPayable`: `accrued` → `due` → `in_statement` → `paid` | `on_hold` (شکایت مالی) | `reversed`

`Installment`: `scheduled` → `due` → `paid` | `partially_paid` | `overdue` | `written_off` | `cancelled`

`PhysicalDelivery`: `awaiting_send` → `sent` → `received` → `verified` | `incomplete` | `returned` → `archived` → `released` (استرداد چک پس از تسویه)

`Center`: `draft` → `under_review` → `needs_fix` → `active` → `suspended` | `terminated`
