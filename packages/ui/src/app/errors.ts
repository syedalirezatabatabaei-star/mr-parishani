import { ApiError } from '@sepehr/api-client';
import { toPersianDigits } from '@sepehr/contracts';

/**
 * What the visitor reads when a request fails: plain Persian, never the code or the server's
 * words. Codes not listed fall back to a general message.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  // Owner 1405/08/10: the partnership form, the one-time link and the portal's content.
  setup_link_not_found: 'این پیوند معتبر نیست؛ پیوند پیامک‌شده را کامل باز کنید.',
  setup_link_expired: 'این پیوند به‌کار رفته یا منقضی شده است؛ با پشتیبانی سپهر تماس بگیرید.',
  username_taken: 'این نام کاربری پیش‌تر ساخته شده است.',
  proof_of_work_invalid: 'بررسی امنیتی صفحه کامل نشد؛ صفحه را تازه کنید و دوباره بفرستید.',
  request_refused: 'درخواست پذیرفته نشد.',
  document_required: 'مدارک لازم کامل نیست.',
  unexpected_file: 'فایلی بیش از مدارک خواسته‌شده فرستاده شد.',
  file_too_large: 'حجم فایل بیش از حد مجاز است.',
  unknown_treatment_field: 'رشته درمانی انتخاب‌شده معتبر نیست.',
  request_not_pending: 'این درخواست دیگر در انتظار بررسی نیست.',
  request_not_reviewed: 'این درخواست هنوز تأیید اولیه نگرفته است.',
  request_without_center: 'مرکز این درخواست ساخته نشده است.',
  invalid_identifier: 'شناسه یا کد ملی درست نیست.',
  version_decided: 'درباره این نسخه پیش‌تر تصمیم گرفته شده است.',
  too_many_active_banners: 'برای این مخاطب پنج بنر فعال هست؛ اول یکی را غیرفعال کنید.',
  link_and_label_together: 'لینک و متن دکمه با هم پر یا با هم خالی باشند.',
  ends_before_start: 'پایان باید پس از شروع باشد.',
  reason_required: 'دلیل رد را بنویسید.',
  // Task 9-3: the password rules (R2, R13).
  password_too_short: 'گذرواژه کوتاه است؛ دست‌کم ۱۲ نویسه بنویسید.',
  password_has_username: 'گذرواژه نباید نام کاربری شما را داشته باشد.',
  password_repeated: 'گذرواژه نباید فقط یک نویسه تکراری باشد.',
  password_digits_only: 'گذرواژه نباید فقط رقم باشد.',
  password_common: 'این گذرواژه بسیار رایج است؛ عبارت دیگری بنویسید.',
  password_unchanged: 'گذرواژه تازه با گذرواژه فعلی یکی است.',
  // Task 9-3 (R1, question 3): a fresh TOTP code, and a proved mobile, before the rest.
  reauth_required: 'برای این کار، کد ورود دومرحله‌ای را دوباره وارد کنید.',
  step_up_required: 'برای این کار، کد تأیید پیامکی لازم است.',
  step_up_invalid: 'کد پیامکی نادرست یا منقضی است؛ کد تازه بگیرید.',
  step_up_mobile_missing:
    'شماره همراه تأییدشده‌ای برای حساب شما ثبت نیست؛ با مدیر سامانه تماس بگیرید.',
  step_up_unavailable: 'ارسال پیامک الان ممکن نیست؛ کمی بعد دوباره تلاش کنید.',
  // ADR-052: a signer's mobile, changed by two others.
  cannot_change_own_mobile: 'تغییر شماره خودتان را دیگران درخواست می‌کنند.',
  cannot_decide_own_mobile: 'درباره تغییر شماره خودتان تصمیم نمی‌گیرید.',
  mobile_change_open: 'برای این شماره یک درخواست باز هست.',
  mobile_change_closed: 'این درخواست بسته شده است.',
  mobile_unchanged: 'این همان شماره فعلی است.',
  already_approved: 'پیش‌تر تأیید کرده‌اید؛ تأیید دوم با نفر دیگر است.',
  mobile_change_needs_approval:
    'شماره تأییدشده امضاکننده را خودتان عوض نمی‌کنید؛ با مدیرعامل یا مدیر سیستم تماس بگیرید.',
  mobile_change_not_found: 'درخواست تغییر شماره پیدا نشد.',
  signer_mobile_needs_approval:
    'شماره امضاکننده مالی از صفحه «شماره امضاکنندگان» و با تأیید مدیرعامل و مدیر سیستم ثبت می‌شود.',
  // ADR-052: a release asked by one, decided by another.
  release_requested: 'برای این مدرک یک درخواست استرداد در انتظار است.',
  release_request_closed: 'درباره این درخواست استرداد پیش‌تر تصمیم گرفته شده است.',
  release_request_not_found: 'درخواست استرداد پیدا نشد.',
  not_your_request: 'فقط درخواست‌دهنده آن را پس می‌گیرد.',
  not_settled: 'وام هنوز کامل تسویه نشده است.',
  instrument_not_held: 'این مدرک در وضعیت نگهداری نیست.',
  mobile_required: 'پیش از ادامه، موبایل حساب خود را تأیید کنید.',
  // Phase 7 (task 7-7): tickets and complaints.
  dispute_open: 'برای این قلم اعتراضی باز است و تا تعیین تکلیف آن، اعتراض تازه پذیرفته نمی‌شود.',
  not_holdable: 'این قلم دیگر قابل اعتراض نیست؛ در صورت‌وضعیت آمده یا پرداخت شده است.',
  financial_link_required: 'برای شکایت مالی، قلم مورد اعتراض را انتخاب کنید.',
  dispute_pending: 'شکایت مالی فقط با تعیین تکلیف اختلاف حل‌شده می‌شود.',
  assignee_not_in_unit: 'این کارشناس در واحد این تیکت کار نمی‌کند.',
  unknown_topic: 'این موضوع دیگر فعال نیست؛ موضوع دیگری انتخاب کنید.',
  not_your_unit: 'این صف مال واحد شما نیست.',
  complaint_not_reopenable: 'شکایت مالی بازگشایی نمی‌شود؛ برای اعتراض دوباره شکایت تازه ثبت کنید.',
  ticket_not_open: 'این تیکت بسته شده است.',
  not_resolved: 'فقط تیکت حل‌شده بسته می‌شود.',
  reopen_window_closed: 'مهلت بازگشایی این تیکت گذشته است؛ تیکت تازه ثبت کنید.',
  same_unit: 'تیکت همین حالا در همین واحد است.',
  network_error: 'ارتباط با سامانه برقرار نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.',
  invalid_request: 'بعضی از اطلاعات واردشده درست نیست.',
  not_authenticated: 'نشست شما پایان یافته است. لطفاً دوباره وارد شوید.',
  mfa_required: 'ورود دومرحله‌ای کامل نشده است.',
  csrf_check_failed: 'نشست شما تازه نیست. صفحه را دوباره بارگذاری کنید.',
  origin_not_allowed: 'این درخواست از نشانی مجاز نیامده است.',
  network_not_allowed: 'ورود به پنل از این شبکه مجاز نیست.',
  forbidden: 'اجازه این کار را ندارید.',
  invalid_code: 'کد واردشده درست نیست یا منقضی شده است.',
  // ف۱۲: a patient's own mobile change.
  same_mobile: 'این همان شماره فعلی شماست.',
  mobile_taken: 'این شماره به حساب دیگری وصل است. برای پیگیری با پشتیبانی تماس بگیرید.',
  mobile_pending: 'این شماره در انتظار تأیید کارشناس است.',
  recent_login_required: 'برای تغییر شماره، یک بار خارج شوید و دوباره وارد شوید.',
  mobile_change_too_soon: 'شماره را به‌تازگی تغییر داده‌اید. بعداً دوباره تلاش کنید.',
  // ف۱۲ ب۲: staff replace a lost patient mobile, by two people.
  patient_not_found: 'هیچ حساب بیمار فعالی با این شماره نیست.',
  patient_mobile_change_stale:
    'شماره بیمار پس از این پیشنهاد عوض شده است. این درخواست را رد کنید و در صورت نیاز از نو پیشنهاد دهید.',
  already_decided: 'درباره این درخواست پیش‌تر تصمیم گرفته شده است.',
  // Owner 1405/07/29, answers f and i: the formation deposit; a visit price by two people.
  formation_deposit_off: 'مبلغ بیعانه تشکیل در تنظیمات صفر است؛ ثبت بیعانه خاموش است.',
  deposit_exists: 'بیعانه این پرونده پیش‌تر ثبت شده است.',
  deposit_not_found: 'برای این پرونده بیعانه‌ای ثبت نشده است.',
  deposit_non_refundable: 'کیف اعتبار این پرونده شارژ شده است؛ بیعانه پس از معرفی‌نامه برنمی‌گردد.',
  already_refunded: 'برگشت این بیعانه پیش‌تر ثبت شده است.',
  refund_before_payment: 'روز برگشت نمی‌تواند پیش از روز پرداخت بیعانه باشد.',
  // ADR-048: the origination fee's discount and the customer club.
  discount_not_in_plan: 'طرح این پرونده چنین تخفیفی ندارد (حداکثر تخفیف طرح را ببینید).',
  discount_exists: 'تخفیف این پرونده پیش‌تر ثبت شده است.',
  origination_already_locked:
    'رسید هزینه تشکیل پرونده بارگذاری شده و مبلغ آن قفل است؛ تخفیف دیگر ثبت نمی‌شود.',
  club_membership_required: 'این طرح فقط برای اعضای باشگاه مشتریان است.',
  membership_not_found: 'این عضویت پیدا نشد.',
  revoked_before_start: 'روز لغو نمی‌تواند پیش از روز شروع عضویت باشد.',
  revoked_after_end: 'روز لغو نمی‌تواند پس از روز پایان عضویت باشد.',
  already_revoked: 'لغو این عضویت پیش‌تر ثبت شده است.',
  // ADR-050: a loan on the doctor's wage only.
  cost_kind_reason_required: 'برای نوع هزینه‌ای جز نوع خدمت، دلیل بنویسید.',
  down_payment_exceeds_wage:
    'پیش‌پرداخت این پرونده از دستمزد پزشک بیشتر است؛ این طرح برای این پیش‌فاکتور نیست.',
  wage_required: 'دستمزد پیش‌فاکتور معلوم نیست.',
  wage_plan_not_for_groups: 'طرح فقط دستمزد برای پرونده گروهی یا کسری نیست.',
  not_wage_only: 'این پرونده طرح فقط دستمزد ندارد؛ تفکیکی برای بررسی نیست.',
  already_reviewed: 'تفکیک این پرونده پیش‌تر بررسی شده است.',
  // ADR-051: the cap on a borrower's whole active balance.
  borrower_exposure_cap_exceeded:
    'با این وام، مانده فعال وام‌های این وام‌گیرنده از سقف مجاز بیشتر می‌شود؛ تأیید یا شارژ انجام نشد.',
  reviewer_is_issuer:
    'سازنده یا صادرکننده پیش‌فاکتور نمی‌تواند تفکیک آن را بررسی کند؛ نفر دیگری بررسی کند.',
  application_decided: 'درباره این پرونده تصمیم گرفته شده است.',
  line_is_material:
    'این ردیف هزینه مواد است و از کیف اعتبار پرداخت نمی‌شود؛ بیمار آن را نقد به پزشک می‌دهد.',
  proposal_open: 'برای این محل کار پیشنهاد بازی در انتظار تأیید است.',
  proposal_not_found: 'این پیشنهاد پیدا نشد.',
  visit_tariff_internal_only: 'تعرفه ویزیت فقط از پنل داخلی و با تأیید دونفره ثبت می‌شود.',
  effective_in_past:
    'زمان شروع این تعرفه گذشته است. پیشنهاد را رد کنید و با زمان تازه دوباره ثبت کنید.',
  request_not_found: 'این درخواست پیدا نشد.',
  request_expired: 'مهلت این درخواست گذشته است. در صورت نیاز، درخواست تازه ثبت کنید.',
  promissory_disabled: 'سفته دریافت نمی‌شود؛ ضمانت با چک صیادی یا ضامن است.',
  too_many_guarantors: 'هر پرونده حداکثر سه ضامن دارد.',
  guarantor_not_scored:
    'ضامن سوم ثبت می‌شود ولی امتیاز نمی‌گیرد؛ برگه امتیاز فقط برای دو ضامن اول است.',
  paper_receipt_required: 'پیش از تأیید انتقال، دریافت سند امضاشده انتقال‌دهنده را تأیید کنید.',
  provider_contract_ended:
    'مدت قرارداد این پزشک یا مرکز پایان یافته است؛ تا تمدید قرارداد، خدمت تازه ثبت نمی‌شود.',
  resend_too_soon: 'کد قبلی هنوز معتبر است؛ کمی صبر کنید.',
  rate_limited: 'تعداد درخواست‌ها زیاد بود؛ کمی بعد دوباره تلاش کنید.',
  locked: 'به دلیل تلاش‌های نادرست، ورود موقتاً بسته است.',
  invalid_credentials: 'نام کاربری یا رمز عبور درست نیست.',
  account_disabled: 'این حساب غیرفعال است.',
  totp_already_enrolled: 'ورود دومرحله‌ای این حساب قبلاً فعال شده است.',
  slot_taken: 'این زمان همین حالا گرفته شد. لطفاً زمان دیگری انتخاب کنید.',
  slot_not_available: 'این زمان دیگر آزاد نیست. لطفاً زمان دیگری انتخاب کنید.',
  hold_expired: 'مهلت نگه‌داشتن این زمان تمام شد. دوباره انتخاب کنید.',
  booking_unavailable: 'نوبت‌دهی این پزشک فعلاً ممکن نیست.',
  too_late_to_change: 'مهلت تغییر یا لغو این نوبت گذشته است.',
  invalid_transition: 'این کار با وضعیت فعلی نوبت ممکن نیست. صفحه را تازه کنید.',
  wrong_check_in_code: 'کد پذیرش درست نیست.',
  permission_required: 'اجازه این کار را ندارید.',
  documents_not_verified: 'همه مدارک باید پیش از فعال‌سازی تأیید شده باشند.',
  second_person_required: 'این درخواست را باید شخص دیگری جز پیشنهاددهنده تأیید کند.',
  slug_taken: 'این نشانی پیش‌تر استفاده شده است.',
  profile_incomplete: 'پروفایل هنوز کامل نیست.',
  not_xlsx: 'فایل اکسل (xlsx) نیست.',
  file_infected: 'فایل آلوده تشخیص داده شد و پذیرفته نشد.',
  invalid_workbook: 'ساختار فایل با الگو یکی نیست.',
  feature_disabled: 'این بخش هنوز فعال نشده است.',
  // Contract, physical delivery and completion (tasks 4-1 to 4-4).
  not_approved: 'پرونده اعتباری هنوز تأیید نشده است.',
  contract_exists: 'برای این پرونده پیش‌تر قرارداد ساخته شده است.',
  not_ready: 'قرارداد هنوز آماده پذیرش نیست. کمی بعد دوباره تلاش کنید.',
  already_accepted: 'این قرارداد را پیش‌تر پذیرفته‌اید.',
  unsupported_type: 'فقط فایل PDF، JPEG یا PNG پذیرفته می‌شود.',
  file_required: 'فایل را انتخاب کنید.',
  not_owed: 'این پرونده چنین پرداختی بدهکار نیست.',
  receipt_exists: 'فیش دیگری از همین نوع در انتظار بررسی است.',
  receipt_decided: 'درباره این فیش پیش‌تر تصمیم گرفته شده است.',
  receipt_rejected: 'این فیش رد شده است و تأیید نمی‌شود.',
  amount_mismatch: 'مبلغ فیش با مبلغ مورد انتظار برابر نیست؛ فیش را با دلیل رد کنید.',
  same_person: 'فیش را کسی جز بارگذارنده‌اش باید تأیید کند.',
  entity_not_allowed: 'این پرداخت فقط به نام آرامش ثروت ثبت می‌شود.',
  lender_not_allowed: 'وام‌دهنده فقط آرامش ثروت می‌تواند باشد.',
  contract_template_invalid: 'قالب قرارداد کامل نیست؛ فیلد درصد خسارت انصراف لازم است.',
  not_complete: 'هنوز همه شرط‌های تکمیل برقرار نیست.',
  already_completed: 'این پرونده پیش‌تر تکمیل شده است.',
  already_confirmed: 'این مورد پیش‌تر تأیید شده است.',
  instrument_exists: 'ابزاری با همین شماره پیش‌تر ثبت شده است.',
  instruments_not_registered: 'همه چک‌ها و سفته‌های رسیده باید ثبت شوند.',
  instruments_not_verified: 'همه چک‌ها و سفته‌ها باید بررسی شده باشند.',
  item_is_not_that_instrument: 'نوع ابزار با قلم تحویل یکی نیست.',
  not_a_cheque: 'تأیید صیاد فقط برای چک است.',
  sayad_not_confirmed: 'ثبت چک در سامانه صیاد هنوز تأیید نشده است.',
  unknown_guarantor: 'این ضامن از ضامن‌های این پرونده نیست.',
  wrong_status: 'این کار با وضعیت فعلی ممکن نیست. صفحه را تازه کنید.',
  // Funding (task 4-5) and services (task 4-6), on the pages of task 4-7.
  not_completed: 'پرونده هنوز تکمیل نشده است.',
  funding_exists: 'برای این پرونده پیش‌تر درخواست شارژ ثبت شده است.',
  request_decided: 'درباره این درخواست پیش‌تر تصمیم گرفته شده است.',
  no_contract: 'این پرونده قرارداد معتبر ندارد.',
  down_payment_missing: 'پیش‌پرداخت این پرونده هنوز تأیید و ثبت نشده است.',
  down_payment_differs: 'پیش‌پرداخت ثبت‌شده با پیش‌پرداخت مورد انتظار برابر نیست.',
  down_payment_reversed: 'پیش‌پرداخت این پرونده برگشت خورده است؛ فیش تازه لازم است.',
  schedule_differs_from_contract:
    'برنامه اقساط با قرارداد یکی نشد؛ شارژ انجام نشد. موضوع را به واحد مالی اطلاع دهید.',
  purse_not_found: 'این بیمار پیدا نشد یا به شما معرفی نشده است.',
  purse_not_funded: 'کیف اعتبار این بیمار هنوز شارژ نشده است.',
  amount_exceeds_available:
    'مبلغ ردیف‌های انتخاب‌شده از اعتبار قابل استفاده بیمار بیشتر است؛ ردیف‌های کمتری انتخاب کنید.',
  line_already_authorized: 'یکی از ردیف‌ها پیش‌تر در مجوز دیگری آمده است.',
  line_not_in_proforma: 'این ردیف از پیش‌فاکتور همین پرونده نیست.',
  // Owner 1405/07/23: a proforma only after the appointment's examination is recorded.
  appointment_not_examined:
    'پیش‌فاکتور فقط پس از ثبت معاینه همین نوبت صادر می‌شود. اول معاینه را در نوبت ثبت کنید.',
  line_without_amount: 'ردیف بی‌مبلغ را نمی‌توان مجوز داد.',
  center_suspended: 'مرکز معلق است؛ مجوز خدمت تازه صادر نمی‌شود.',
  center_not_active: 'مرکز فعال نیست؛ مجوز خدمت تازه صادر نمی‌شود.',
  code_invalid: 'کد واردشده درست نیست.',
  authorization_expired:
    'مهلت این مجوز تمام شده یا تلاش‌ها به پایان رسیده است؛ مبلغ آن آزاد شد. مجوز تازه صادر کنید.',
  not_awaiting_code: 'این مجوز دیگر منتظر کد نیست. صفحه را تازه کنید.',
  code_resend_too_soon: 'کد تازه را کمی بعد می‌توان فرستاد.',
  code_send_limit: 'سقف ارسال کد برای این مجوز پر شده است.',
  service_final:
    'این خدمت قطعی شده است و در این مرحله لغو نمی‌شود؛ اعتراض به آن در تسویه بررسی می‌شود.',
  service_authorization_not_found: 'این مجوز خدمت پیدا نشد.',
  account_mobile_unverified:
    'موبایل این حساب هنوز با کد تأیید نشده است؛ صاحب حساب باید آن را در «حساب من» تأیید کند.',
  staff_or_center_only: 'موبایل بیمار همان شماره ورود اوست و از اینجا تغییر نمی‌کند.',
  // Special operations on a purse (task 4-8).
  special_operation_not_found: 'این درخواست پیدا نشد.',
  request_open: 'برای همین مورد درخواست بازی در انتظار تصمیم است.',
  exceeds_unused: 'مبلغ از مانده مصرف‌نشده کیف اعتبار بیشتر است.',
  purse_closed: 'کیف اعتبار بسته است.',
  not_a_done_cancellation: 'فقط ابطالِ انجام‌شده را می‌توان برگرداند.',
  refund_paid: 'پیش‌پرداخت این ابطال به وام‌گیرنده پرداخت شده است؛ ابطال برگشت داده نمی‌شود.',
  same_doctor: 'پزشک تازه همان پزشک فعلی است.',
  needs_new_credit_decision:
    'این پزشک رشته درمانی این پرونده را ندارد؛ تصمیم اعتباری تازه لازم است.',
  workplace_not_found: 'محل کار پزشک پیدا نشد.',
  service_not_final:
    'خدمتی ثبت شده و هنوز قطعی نشده است؛ تا قطعی شدن یا لغو آن، این کار انجام نمی‌شود.',
  open_reservations: 'مجوز خدمت بازی روی کیف هست؛ صفحه را تازه کنید.',
  // Cancelling before funding and refunds (task 4-8).
  cancellation_not_found: 'این درخواست انصراف پیدا نشد.',
  application_ended: 'این پرونده رد یا منقضی شده است.',
  already_cancelled: 'این پرونده پیش‌تر باطل شده است.',
  already_funded:
    'کیف اعتبار این پرونده شارژ شده است؛ انصراف پس از شارژ از مسیر عملیات کیف انجام می‌شود.',
  application_cancelled: 'این پرونده باطل شده است.',
  refunded: 'این فیش به وام‌گیرنده مسترد شده است.',
  refund_payment_not_found: 'این پرداخت پیدا نشد.',
  exceeds_owed: 'مبلغ از مانده قابل استرداد بیشتر است.',
  bank_reference_used: 'این شماره پیگیری بانک پیش‌تر ثبت شده است.',
  idempotency_key_reused: 'این درخواست با محتوای دیگری پیش‌تر ثبت شده است؛ صفحه را تازه کنید.',
  // Credit transfer to an AuthorizedRecipient (task 4-8).
  credit_transfer_not_found: 'این انتقال اعتبار پیدا نشد.',
  invalid_national_id: 'کد ملی درست نیست.',
  invalid_mobile: 'شماره موبایل درست نیست.',
  borrower_without_mobile: 'وام‌گیرنده موبایل ثبت‌شده ندارد.',
  recipient_is_borrower: 'گیرنده نمی‌تواند خود وام‌گیرنده باشد.',
  national_id_mismatch: 'این کد ملی با صاحب این شماره موبایل یکی نیست.',
  // Task 9-3 (م۵): a mobile added to a Person who already existed.
  recipient_mobile_mismatch:
    'این کد ملی از آنِ شخصی با شماره دیگری است؛ گیرنده باید با شماره خودش ثبت شود.',
  recipient_mobile_pending: 'این شماره در انتظار تأیید است و نمی‌تواند گیرنده باشد.',
  person_mobile_pending: 'این شماره در انتظار تأیید است و هنوز به کسی تعلق ندارد.',
  person_mobile_not_found: 'این درخواست پیدا نشد یا پیش‌تر درباره‌اش تصمیم گرفته شده است.',
  person_mobile_expired: 'مهلت تأیید این شماره گذشته است.',
  added_by_same_account: 'کسی که این شماره را افزوده نمی‌تواند خودش آن را تأیید کند.',
  proposed_by_same_account: 'تأیید دونفره است: کسی که پیشنهاد داده نمی‌تواند خودش آن را تأیید کند.',
  person_mobile_not_proposed:
    'تأیید دونفره است: اول یک نفر با مدرک پیشنهاد می‌دهد، سپس نفر دوم تأیید می‌کند.',
  person_mobile_already_proposed:
    'برای این شماره پیش‌تر پیشنهاد ثبت شده است؛ نفر دوم تأیید یا رد می‌کند.',
  not_awaiting_codes: 'این درخواست دیگر منتظر کد نیست. صفحه را تازه کنید.',
  not_requested: 'این درخواست در انتظار تصمیم نیست. صفحه را تازه کنید.',
  codes_expired: 'مهلت کدهای تأییدشده گذشته است؛ درخواست را رد و دوباره ثبت کنید.',
  exceeds_transfer_cap: 'مبلغ از سقف انتقال اعتبار بیشتر است.',
  exceeds_available: 'مبلغ از اعتبار قابل استفاده کیف بیشتر است.',
  transfer_limit_reached: 'سقف تعداد انتقال برای این کیف پر شده است.',
  not_active: 'این انتقال فعال نیست.',
  not_revoke_requested: 'برای این انتقال درخواست ابطالی در انتظار نیست.',
  recipient_limit_reached: 'مبلغ از سقف استفاده گیرنده مجاز بیشتر است.',
  // Cancelling after funding and the penalty rate (task 4-8, part 7).
  purse_not_settled: 'روی کیف مانده یا رزرو باز هست؛ بسته نمی‌شود.',
  charge_exists: 'خسارت این پرونده پیش‌تر ثبت شده است.',
  penalty_out_of_range: 'نرخ خسارت باید بین ۰ تا ۱۸ درصد باشد.',
  penalty_override_not_found: 'این درخواست نرخ خسارت پیدا نشد.',
  // Bulk SMS campaigns (task 6-5; pages 6-9).
  template_field_unavailable:
    'این قالب فیلدی دارد که این فیلتر برای گیرندگانش ندارد؛ قالب دیگری انتخاب کنید.',
  template_audience_differs: 'گیرنده قالب با گیرندگان این فیلتر یکی نیست.',
  campaign_category_not_allowed: 'قالب فوری برای ارسال گروهی مجاز نیست.',
  promotional_campaigns_off: 'ارسال گروهی تبلیغاتی فعلاً خاموش است.',
  no_recipients: 'این کمپین هیچ گیرنده‌ای ندارد.',
  campaign_not_draft: 'این کمپین دیگر پیش‌نویس نیست؛ صفحه را تازه کنید.',
  // Leads and cases in the internal panel (owner 1405/07/24: the strategy manager's tools).
  case_not_found: 'این پرونده پیدا نشد یا در دسترس شما نیست.',
  case_closed: 'این پرونده بسته است.',
  case_not_new: 'مشاوره این پرونده پیش‌تر شروع شده است؛ صفحه را تازه کنید.',
  unknown_abandonment_reason: 'این علت دیگر در فهرست نیست؛ علت دیگری انتخاب کنید.',
  agent_not_found: 'کارشناسی با این نام کاربری پیدا نشد.',
  not_an_active_staff_account: 'این حساب کارمند فعال نیست.',
  reason_code_taken: 'این کد پیش‌تر به کار رفته است و دوباره به کار نمی‌رود؛ کد دیگری بنویسید.',
  reason_not_found: 'این علت پیدا نشد یا کنار گذاشته شده است.',
  reason_not_retirable: '«پرداخت نقدی» کنار گذاشته نمی‌شود.',
  person_not_found: 'این شخص پیدا نشد.',
  person_blocked: 'این شخص پیش‌تر مسدود شده است.',
  person_not_blocked: 'این شخص مسدود نیست.',
  person_already_merged: 'یکی از این دو شخص پیش‌تر در شخص دیگری ادغام شده است.',
  national_id_conflict: 'کد ملی این دو شخص فرق دارد؛ دو نفرند و ادغام نمی‌شوند.',
  both_have_open_cases: 'هر دو شخص پرونده باز دارند؛ اول یکی را ببندید.',
  merge_not_found: 'این ادغام پیدا نشد.',
  merge_reverted: 'این ادغام پیش‌تر برگشت خورده است.',
  survivor_merged_again: 'شخص باقی‌مانده خودش در شخص دیگری ادغام شده است؛ اول آن را برگردانید.',
  // The credit committee's votes (owner 1405/08/01).
  proposer_cannot_vote: 'پیشنهاددهنده این پرونده رأی نمی‌دهد.',
  not_a_unit_member: 'شما عضو این واحد کمیته نیستید.',
  not_an_attendee: 'نام شما در حاضران این صورت‌جلسه نیست.',
  already_voted: 'شما پیش‌تر به این پیشنهاد رأی داده‌اید.',
  not_a_committee_decision: 'این پیشنهاد با مرجع کمیته نیست.',
  unknown_unit: 'این واحد در فهرست واحدهای کمیته نیست.',
};

/**
 * Funding's maker-checker refusal (task 4-7, owner): the API answers `same_person` as for
 * receipts, but on the funding pages it reads this.
 */
export const OWN_FUNDING_REQUEST = 'تأییدکننده نمی‌تواند درخواست خودش را تأیید کند.';

export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'خطای غیرمنتظره‌ای رخ داد. دوباره تلاش کنید.';
  const known = MESSAGES[error.code];
  if (known) {
    const wait = error.retryAfterSeconds;
    return wait ? `${known} (${toPersianDigits(String(wait))} ثانیه)` : known;
  }
  if (error.status === 403) return MESSAGES['forbidden'] ?? '';
  if (error.status === 404) return 'موردی که دنبالش بودید پیدا نشد.';
  if (error.status === 409) return 'این کار با وضعیت فعلی ممکن نیست. صفحه را تازه کنید.';
  if (error.status === 429) return MESSAGES['too_many_attempts'] ?? '';
  return 'خطای غیرمنتظره‌ای رخ داد. دوباره تلاش کنید.';
}
