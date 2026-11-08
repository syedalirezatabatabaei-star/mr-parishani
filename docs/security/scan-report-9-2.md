# گزارش یکپارچه اسکن خودکار (تسک ۹-۲)

> **تاریخ:** ۱۴۰۵/۰۷/۱۸.
>
> **محیط:** staging محلی، همان stack e2e (`apps/e2e/src/stack.ts`)، با داده ساختگی seed.
>
> **ابزارها** (خودمیزبان، تصویر Docker با digest ثابت؛ دریافت ZAP و trivy با اجازه مالک، ۱۴۰۵/۰۷/۱۸):
>
> | ابزار | تصویر | فرمان |
> |---|---|---|
> | semgrep | `semgrep/semgrep:1.177.0` | `scripts/ci/sast.sh` |
> | osv-scanner | `ghcr.io/google/osv-scanner:v2.6.0` | `scripts/ci/deps.sh` |
> | gitleaks (کل تاریخچه، ۱۸۲ commit) | `zricethezav/gitleaks:v8.30.1` | `scripts/ci/secrets.sh` |
> | trivy (vuln، secret، misconfig) | `aquasec/trivy:0.58.1@sha256:ab70a022…` | روی `sepehr-api:local` و `sepehr-worker:local` |
> | OWASP ZAP | `ghcr.io/zaproxy/zaproxy:stable@sha256:7aaa659b…` | `pnpm --filter @sepehr/e2e security:zap` |
>
> **پوشش ZAP:**
> - **baseline:** سایت بیمار و پنل داخلی.
> - **اسکن فعال API از روی OpenAPI:** ناشناس، و هر نقش با توکن همان نقش: بیمار، پزشک، حسابداری، پشتیبانی و مدیر سامانه.
> - **گزارش‌های خام:** `apps/e2e/.stack/zap/` (ردیابی‌نشده).
>
> **شدت:**
> - **بحرانی:** CVSS ≥ ۹.
> - **بالا:** ۷ تا ۸٫۹.
> - **متوسط:** ۴ تا ۶٫۹.
> - **کم.**
>
> **پذیرش:** هیچ یافته «بحرانی» یا «بالا» بی تسک رفع نماند. همه در «فهرست اقدام» پایین تسک دارند.

## خلاصه

| ابزار | بحرانی | بالا | متوسط | کم | نتیجه |
|---|---|---|---|---|---|
| osv-scanner (lockfile) | ۱ | ۴ | ۵ | — | **باید رفع شود:** next، sharp و source-map-js |
| trivy (ایمیج‌ها) | ۰ | ۸ در هر ایمیج | ۱۳ در هر ایمیج | — | همه بالاها در npm همراه ایمیج پایه است، نه کد سامانه |
| semgrep | ۰ | ۰ | ۱۱۷ هشدار و اطلاع | — | پالایش لازم است (پایین) |
| gitleaks | ۰ | ۰ | ۰ | — | دو هشدار، هر دو مثبت کاذب و رفع‌شده |
| ZAP (۲ baseline و ۶ اسکن API) | ۰ | ۰ | ۰ | ۶ نوع | فقط سرآیندها |
| سرآیندها و TLS | — | — | — | ۴ | TLS محلی ندارد (لبه در ۱۰-۱) |

## ۱. osv-scanner: وابستگی‌ها

| بسته | نسخه | رفع در | CVSS | شناسه | دامنه | اقدام |
|---|---|---|---|---|---|---|
| next | 16.3.5 | 16.3.6 | **۹٫۵** | GHSA-vcvr-r3jv-pc5j | زمان اجرا (وب و ادمین) | **R15، بحرانی** |
| next | 16.3.5 | 16.3.8 | ۸٫۳ | GHSA-cjq9-62q9-8jv4 | زمان اجرا | **R15** |
| next | 16.3.5 | 16.3.8 | ۵٫۴ تا ۶٫۳ | GHSA-39w2، 3w37، 4jqv، f87g، mcj8 | زمان اجرا | **R15** |
| sharp | 0.35.4 | 0.35.5 | ۸٫۹ | GHSA-wq5f-xc86-pv6w | زمان اجرا (پردازش تصویر worker) | **R15** |
| source-map-js | 1.2.1 | 1.2.2 | ۸٫۷ | GHSA-68fv-2mgg-jv7q | build | **R15** (override) |
| braces | 3.0.3 | — | ۸٫۷ | GHSA-vfj7-8cjw-p6xm | فقط توسعه (`@next/eslint-plugin-next` ← fast-glob ← micromatch) | **R15:** پذیرش با دلیل تا انتشار رفع؛ بیرون از ایمیج تولید (trivy تأیید) |

## ۲. trivy: ایمیج‌های `api` و `worker`

- **شمار:** ۸ «بالا» و ۱۳ «متوسط» در هر ایمیج.
- **بالاها:** همه در `/usr/local/lib/node_modules/npm/` (npm همراه `node:24-alpine`).
  - **بسته‌ها:** brace-expansion، http-cache-semantics، ip-address، tar و undici.
  - **پیامد:** سامانه در زمان اجرا npm را صدا نمی‌زند (`CMD node dist/main.js`).
  - **اقدام R16:** npm و corepack از مرحله نهایی Dockerfile حذف شوند. سطح حمله کمتر می‌شود.
- **متوسط سیستم‌عامل:** `zlib 1.3.2-r0` (رفع r1).
  - **اقدام R16:** `apk upgrade` در مرحله نهایی، یا digest تازه پایه.
- **misconfig و secret:** یافته‌ای نیست.
- **مسدودی شبکه:** پایگاه داده trivy از `mirror.gcr.io` با ۴۰۳ مسدود است (تحریم).
  - **چاره:** `--db-repository ghcr.io/aquasecurity/trivy-db:2` و همتای java.
  - **اقدام:** در اسکریپت CI ثبت شود.
- **کمبود:** ایمیج وب و ادمین ساخته نمی‌شود (Dockerfile فقط Node API و worker). در ۱۰-۱ (R11).

## ۳. semgrep: ۱۱۷ یافته (هیچ «ERROR»)

**یافته فرایندی (مهم):**
- **چرا انباشته شد:** semgrep، osv-scanner و gitleaks فقط در CI اجرا می‌شوند. از تسک ۰-۵ (رویه موقت گیت، بی push) CI اجرا نشده است. یافته‌ها در فاز ۲ تا ۸ انباشته شدند و دیده نشدند.
- **اقدام R17:** این سه اسکریپت پیش از هر commit محلی تسک، کنار turbo، اجرا شوند. در RESUME به‌عنوان قاعده ثبت شود.

| قاعده | شمار | ارزیابی | اقدام |
|---|---|---|---|
| html-in-template-string | ۳۲ | تولید HTML برای PDF (قرارداد، صورت‌وضعیت، گزارش) و XML برای xlsx | **R14:** هر مقدار درج‌شده با `escapeHtml` یا گریز XML بررسی شود. اگر برقرار است، `nosemgrep` با دلیل؛ وگرنه رفع |
| missing-template-string-indicator | ۲۳ | `${…}` در رشته معمولی، بیشتر SQL پارامتری `$1` در آزمون‌ها | R14: بررسی، و رفع هر رشته‌ای که قالب می‌خواست |
| react-props-spreading | ۱۴ | best-practice؛ spread شرطی برای `exactOptionalPropertyTypes` | R14: پذیرش با دلیل (قاعده best-practice، نه امنیتی) |
| javascript-confirm | ۱۴ | مثبت کاذب: متد `confirm()` سرویس، نه `window.confirm` | R14: `nosemgrep` با دلیل |
| no-stringify-keys | ۱۳ | `JSON.stringify` برای کلید idempotency و مقایسه | R14: بررسی ترتیب کلید (پایداری)، رفع در صورت لزوم |
| react-props-in-state | ۶ | مقدار اولیه state از prop در کامپوننت‌های کنترل‌نشده تقویم | R14: پذیرش با دلیل |
| detect-non-literal-regexp | ۵ | regex از ثابت کد، نه ورودی کاربر (بی ReDoS) | R14: `nosemgrep` با دلیل |
| jsx-label-not-i18n | ۴ | ابزار ترجمه نداریم (رابط فقط فارسی) | R14: پذیرش با دلیل |
| no-replaceall | ۴ | Node 24 `replaceAll` دارد | R14: پذیرش با دلیل |
| react-href-var | ۱ | `href` از origin ثابت و slug سامانه | R14: `nosemgrep` با دلیل |
| unsafe-dynamic-method | ۱ | `calendar.tsx:216` | R14: بررسی و رفع |

## ۴. gitleaks (کل تاریخچه)

- **یافته:** دو `generic-api-key`، هر دو در commitهای قدیمی (`680120e` و `ec5dc8a`).
- **ماهیت:** کلید ثابت ظرف آزمون SeaweedFS («test-secret-key» و «e2e-secret-key»)، نه راز واقعی. **مثبت کاذب.**
- **رفع‌شده در ۹-۲:**
  - **از این پس:** کلیدهای آزمون در هر اجرا تصادفی‌اند (`apps/api/test/support/files.ts`، `apps/e2e/src/files.ts`).
  - **commitهای قدیمی:** فقط با fingerprint در `.gitleaksignore`، با دلیل، و هرگز با الگو.
- **اسکن دوباره:** «no leaks found».

## ۵. OWASP ZAP

- **دسترس‌پذیری:**
  - API در هیچ اسکن فعالی از کار نیفتاد (بررسی پیش از هر اسکن).
  - **گزارش نادرست در اجرای نخست:** «API down» گزارش شد.
  - **علت:** اتصال keep-alive کهنه در خود اسکن‌کننده بود، نه سامانه.
  - **اصلاح:** در `security-scan.ts`، تلاش دوباره روی اتصال تازه.
- **یافته بالا و متوسط:** هیچ، در هیچ نقش.

| هشدار | خطر | کجا | اقدام |
|---|---|---|---|
| X-Content-Type-Options Header Missing (10021) | کم | همه پاسخ‌های API؛ فایل‌های `/_next/static` وب و ادمین | **R9:** `nosniff` روی API، و گسترش matcher proxy به فایل‌های ایستا (یا سرآیند در `next.config`) |
| Cross-Origin-Opener-Policy / Embedder / Resource-Policy (90004) | کم | وب و ادمین | **R9:** `Cross-Origin-Opener-Policy: same-origin` و `Cross-Origin-Resource-Policy: same-origin`. COEP فقط اگر iframe آپارات را نشکند |
| Permissions Policy Header Not Set (10063) | کم | فایل‌های ایستای Next | **R9:** همان گسترش matcher |
| Unexpected Content-Type (100001) | کم | ریشه API (`/`)، ۴۰۴ HTML پیش‌فرض | **R9:** پاسخ ۴۰۴ JSON برای مسیرهای بیرون از `/api/v1` |
| Information Disclosure - Sensitive Information in URL (10024)، اطلاعاتی | — | `password=ZAP` در query: خود ZAP فرم ورود را با GET پر کرد | بی اقدام. فرم ورود POST است و query را نمی‌خواند |
| User Controllable HTML Element Attribute (10031)، اطلاعاتی | — | `/search` (پارامترهای فیلتر در `value` فیلدها) | بی اقدام. React مقدار را گریز می‌دهد. بررسی دستی در R3 |

## ۶. سرآیندها و TLS

| مورد | وضعیت | اقدام |
|---|---|---|
| CSP با nonce، `frame-ancestors 'none'`، `upgrade-insecure-requests` | ✅ وب و ادمین (آزمون `csp.test.ts`) | — |
| `nosniff`، `Referrer-Policy` و `Permissions-Policy` | ✅ صفحه‌های وب و ادمین؛ ⚠️ فایل ایستا و API | R9 |
| `Cache-Control: no-store` برای پاسخ‌های داده‌دار API | ⚠️ نیست | R9 |
| HSTS | ⚠️ نیست؛ لبه TLS | R9 و R11 (۱۰-۱) |
| پیکربندی TLS (نسخه، رمزها، گواهی) | — محلی TLS ندارد | R11 (۱۰-۱ و ۱۰-۴؛ گواهی در دوره اینترنت ملی ۱۰.۳) |

## فهرست اقدام (ورودی ۹-۳؛ ادامه R1 تا R13 خودارزیابی)

| # | اقدام | شدت بالاترین یافته | جای انجام |
|---|---|---|---|
| **R14** | پالایش ۱۱۷ یافته semgrep: رفع واقعی‌ها و `nosemgrep` با دلیل برای کاذب‌ها، تا `sast.sh` سبز شود | متوسط | ۹-۳ |
| **R15** | به‌روزرسانی next به 16.3.8 یا تازه‌تر، sharp به 0.35.5، و override برای source-map-js 1.2.2؛ braces با دلیل پذیرفته، فقط توسعه | **بحرانی** (next) | ۹-۳، **اول از همه** |
| **R16** | حذف npm و corepack از مرحله نهایی Dockerfile و `apk upgrade`؛ trivy با `--db-repository` ghcr در اسکریپت CI تازه `scripts/ci/image-scan.sh` | بالا | ۹-۳ |
| **R17** | اجرای `sast.sh`، `deps.sh` و `secrets.sh` پیش از هر commit محلی (قاعده RESUME) | فرایندی | ۹-۳ |
| R9 (گسترش) | `nosniff` و `no-store` روی API، ۴۰۴ JSON، COOP و CORP، و سرآیندها روی فایل‌های ایستای Next | کم | ۹-۳ |

**پذیرش ۹-۲:** هر یافته بحرانی (next) و بالا (next، sharp، source-map-js، braces و npm ایمیج) تسک رفع دارد: R15 و R16.

## اسکن دوباره پس از ۹-۳ (۱۴۰۵/۰۷/۱۸)

| ابزار | بحرانی | بالا | نتیجه |
|---|---|---|---|
| osv-scanner | ۰ | ۰ | سبز (braces پذیرفته تا ۲۰۲۷-۰۱-۱۰، فقط توسعه) |
| trivy (`api` و `worker`) | ۰ | ۰ | سبز |
| semgrep | ۰ | ۰ | سبز |
| gitleaks | ۰ | ۰ | سبز |
| ZAP | ۰ | ۱ نوع، ۶ نمونه: **مثبت کاذب** (پایین) | دو هشدار کم باقی (ریشه API و COEP، با دلیل) |

**«SQL Injection» (ZAP 40018، بولی)، مثبت کاذب:**

- **نمونه‌ها:**
  - `POST /auth/staff/login` (password): حسابداری و پشتیبانی.
  - `POST /auth/otp/verify` (mobile و code): بیمار و پشتیبانی.
  - `GET /calendar/holidays` (from): ناشناس.
  - `GET /search/doctors` (cityCode): بیمار.
- **چرا در اسکن نخست نبود:** پاسخ متفاوت از قفل حساب (پنج شکست، ۴۲۹ `locked`)، شمارنده تلاش OTP و سقف نرخ عمومی تازه ۹-۳ (R5) می‌آید. ZAP همه درخواست‌ها را از یک نشانی و پشت‌سرهم می‌فرستد، پس جفت `AND 1=1` / `AND 1=2` گاهی یکی ۴۰۱ و دیگری ۴۲۹ می‌گیرد.
- **بازتولید:** `apps/api/test/security/injection.int.test.ts` (۱۶ آزمون). همان جفت‌های ZAP برای هر پارامتر، هر درخواست از نشانی تازه.
  - **نتیجه:** پاسخ هر جفت یکسان است (وضعیت و بدنه).
  - **قفل حساب:** آزمون نخست با یک نام کاربری برای همه جفت‌ها قرمز شد (۴۰۱ در برابر ۴۲۹ `locked`)، یعنی همان چیزی که ZAP دید. با نام کاربری تازه برای هر جفت سبز است.
- **بررسی کد:** همه پرس‌وجوها پارامتری‌اند (drizzle و الگوی `sql`). هر `sql.raw` در `src` فقط ثابت کد را می‌گیرد: فهرست ستون، نام نمای مادی، `to_char` و ستونی با نوع اتحادی بسته. هیچ‌کدام مقدار درخواست را نمی‌گیرد.
- **ورودی‌ها پیش از پایگاه داده اعتبارسنجی می‌شوند:** `from` با Zod تاریخ، `cityCode` با الگوی کد، `mobile` یکسان‌سازی به `9XXXXXXXXX`، و `code` شش رقم.
