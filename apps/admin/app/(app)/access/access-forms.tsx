'use client';

import { unwrap } from '@sepehr/api-client';
import type {
  PermissionCode,
  RoleAssignmentView,
  ScopeInput,
  StaffAccountView,
} from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  faDigits,
  formText,
  Notice,
  SelectField,
  showInstant,
  StatusBadge,
  TextField,
  useApi,
  type SelectOption,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const SECTION = 'space-y-3 rounded-lg border border-border bg-surface p-4';
const HEADING = 'text-[length:var(--text-lg)] font-bold';

/** Where a grant applies (doc 04 §1), as the form offers it. */
const SCOPES: readonly SelectOption[] = [
  { value: 'global', label: 'همه‌جا' },
  { value: 'own', label: 'فقط رکوردهای خودش' },
  { value: 'city', label: 'یک شهر (کد شهر)' },
  { value: 'queue', label: 'یک صف کار (کد صف)' },
  { value: 'center', label: 'یک مرکز (شناسه گره)' },
  { value: 'branch', label: 'یک شعبه (شناسه گره)' },
  { value: 'doctor', label: 'یک پزشک (شناسه گره)' },
];
export const SCOPE_LABEL: Record<string, string> = Object.fromEntries(
  SCOPES.map((s) => [s.value, s.label]),
);

/** The permissions grouped by module, for the checkboxes. */
function grouped(permissions: readonly string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const p of permissions) {
    const group = p.split('.')[0] ?? p;
    groups.set(group, [...(groups.get(group) ?? []), p]);
  }
  return [...groups.entries()];
}

function PermissionChecks({
  idPrefix,
  all,
  checked,
}: {
  idPrefix: string;
  all: readonly string[];
  checked: ReadonlySet<string>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {grouped(all).map(([module, codes]) => (
        <fieldset key={module} className="space-y-1 rounded-md border border-border p-2">
          <legend className="px-1 text-[length:var(--text-sm)] font-medium" dir="ltr">
            {module}
          </legend>
          {codes.map((code) => (
            <label key={code} className="flex items-center gap-2 text-[length:var(--text-xs)]">
              <input
                type="checkbox"
                id={`${idPrefix}-${code}`}
                name="permission"
                value={code}
                defaultChecked={checked.has(code)}
              />
              <span dir="ltr">{code}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

const checkedPermissions = (form: HTMLFormElement) =>
  new FormData(form).getAll('permission').filter((v): v is string => typeof v === 'string');

/** A new role with its permissions (access.manage_roles; TOTP again if identity.reauth). */
export function CreateRoleForm({ permissions }: { permissions: readonly string[] }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <section aria-labelledby="new-role" className={SECTION}>
      <h2 id="new-role" className={HEADING}>
        نقش تازه
      </h2>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          setBusy(true);
          setError(null);
          setDone(null);
          void unwrap(
            api.POST('/api/v1/access/roles', {
              body: {
                code: formText(form, 'code').trim(),
                name: formText(form, 'name'),
                permissions: checkedPermissions(form) as PermissionCode[],
                reason: formText(form, 'reason'),
              },
            }),
          )
            .then(() => {
              setDone('نقش ساخته شد.');
              form.reset();
              router.refresh();
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <TextField
            id="role-code"
            name="code"
            label="کد نقش"
            hint="حروف کوچک لاتین، رقم و _؛ مثل mobile_approver"
            dir="ltr"
            required
            className="min-w-56"
          />
          <TextField
            id="role-name"
            name="name"
            label="نام نقش"
            required
            className="min-w-56 grow"
          />
        </div>
        <PermissionChecks idPrefix="new-role" all={permissions} checked={new Set()} />
        <TextField id="role-reason" name="reason" label="دلیل" required />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ساخت نقش
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </section>
  );
}

/** A role's permissions replaced; system roles are set by migrations only. */
export function RolePermissionsForm({
  roleId,
  roleCode,
  permissions,
  current,
}: {
  roleId: string;
  roleCode: string;
  permissions: readonly string[];
  current: readonly string[];
}) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button
        type="button"
        className={buttonClass('quiet', 'min-h-9 px-2')}
        onClick={() => {
          setOpen(true);
        }}
      >
        ویرایش مجوزها
      </button>
    );
  }
  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        setBusy(true);
        setError(null);
        void unwrap(
          api.PUT('/api/v1/access/roles/{id}/permissions', {
            params: { path: { id: roleId } },
            body: {
              permissions: checkedPermissions(form) as PermissionCode[],
              reason: formText(form, 'reason'),
            },
          }),
        )
          .then(() => {
            setOpen(false);
            router.refresh();
          })
          .catch((err: unknown) => {
            setError(errorMessage(err));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <PermissionChecks
        idPrefix={`role-${roleCode}`}
        all={permissions}
        checked={new Set(current)}
      />
      <TextField id={`role-${roleCode}-reason`} name="reason" label="دلیل" required />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ذخیره مجوزها
        </button>
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setOpen(false);
          }}
        >
          انصراف
        </button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/**
 * An account by username: its roles in force, a new grant, a revoke, and the request to
 * offboard it (two people). What shows follows the viewer's permissions; the API checks
 * each again (rule 12).
 */
export function AccountAccess({
  roles,
  mayAssign,
  mayOffboard,
}: {
  roles: readonly SelectOption[];
  mayAssign: boolean;
  mayOffboard: boolean;
}) {
  const api = useApi();
  const [account, setAccount] = useState<StaffAccountView | null>(null);
  const [assignments, setAssignments] = useState<readonly RoleAssignmentView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = async (username: string) => {
    const found = await unwrap(
      api.GET('/api/v1/access/accounts/by-username/{username}', {
        params: { path: { username } },
      }),
    );
    setAccount(found);
    setAssignments(
      mayAssign
        ? await unwrap(
            api.GET('/api/v1/access/accounts/{accountId}/assignments', {
              params: { path: { accountId: found.id } },
            }),
          )
        : [],
    );
  };
  const run = (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    void work()
      .then(() => {
        setDone(message);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-labelledby="account-access" className={SECTION}>
      <h2 id="account-access" className={HEADING}>
        دسترسی یک حساب
      </h2>
      <form
        className="flex flex-wrap items-end gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const username = formText(e.currentTarget, 'username').trim();
          setAccount(null);
          run(() => load(username), '');
        }}
      >
        <TextField
          id="account-username"
          name="username"
          label="نام کاربری کارمند یا مرکز"
          dir="ltr"
          required
          className="min-w-64"
        />
        <button type="submit" disabled={busy} className={buttonClass('secondary')}>
          یافتن
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
      {account && (
        <div className="space-y-4">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium" dir="ltr">
              {account.username}
            </span>
            {account.displayName && <span>{account.displayName}</span>}
            <StatusBadge tone="neutral">{account.kind === 'staff' ? 'کارمند' : 'مرکز'}</StatusBadge>
            {account.status === 'active' ? (
              <StatusBadge tone="success">فعال</StatusBadge>
            ) : (
              <StatusBadge tone="danger">غیرفعال</StatusBadge>
            )}
          </p>

          {mayAssign && (
            <>
              <h3 className="font-bold">نقش‌های فعلی</h3>
              {assignments.length === 0 ? (
                <p className="text-ink-subtle">نقشی ندارد.</p>
              ) : (
                <ul className="space-y-2">
                  {assignments.map((a) => (
                    <li key={a.id} className="space-y-1 rounded-md border border-border p-2">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium" dir="ltr">
                          {a.roleCode}
                        </span>
                        <span>{SCOPE_LABEL[a.scopeKind] ?? a.scopeKind}</span>
                        {(a.scopeCode ?? a.scopeNodeId) && (
                          <span dir="ltr">{faDigits(a.scopeCode ?? a.scopeNodeId ?? '')}</span>
                        )}
                        <time dateTime={a.createdAt} className="text-ink-subtle">
                          {showInstant(a.createdAt)}
                        </time>
                      </p>
                      <form
                        className="flex flex-wrap items-end gap-2"
                        noValidate
                        onSubmit={(e) => {
                          e.preventDefault();
                          const reason = formText(e.currentTarget, 'reason');
                          run(async () => {
                            await unwrap(
                              api.POST('/api/v1/access/assignments/{id}/revoke', {
                                params: { path: { id: a.id } },
                                body: { reason },
                              }),
                            );
                            await load(account.username);
                          }, 'نقش لغو شد.');
                        }}
                      >
                        <TextField
                          id={`revoke-${a.id}`}
                          name="reason"
                          label="دلیل لغو"
                          required
                          className="min-w-56 grow"
                        />
                        <button type="submit" disabled={busy} className={buttonClass('danger')}>
                          لغو نقش
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="font-bold">دادن نقش</h3>
              <form
                className="space-y-3"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const kind = formText(form, 'scopeKind');
                  const target = formText(form, 'scopeTarget').trim();
                  const scope =
                    kind === 'city' || kind === 'queue'
                      ? { kind, code: target }
                      : kind === 'center' || kind === 'branch' || kind === 'doctor'
                        ? { kind, nodeId: target }
                        : { kind };
                  run(async () => {
                    await unwrap(
                      api.POST('/api/v1/access/assignments', {
                        body: {
                          accountId: account.id,
                          roleCode: formText(form, 'roleCode'),
                          scope: scope as ScopeInput,
                          reason: formText(form, 'reason'),
                        },
                      }),
                    );
                    await load(account.username);
                  }, 'نقش داده شد.');
                }}
              >
                <div className="flex flex-wrap items-end gap-3">
                  <SelectField id="grant-role" name="roleCode" label="نقش" options={roles} />
                  <SelectField id="grant-scope" name="scopeKind" label="دامنه" options={SCOPES} />
                  <TextField
                    id="grant-target"
                    name="scopeTarget"
                    label="کد یا شناسه دامنه"
                    hint="برای همه‌جا و رکوردهای خودش خالی بماند"
                    dir="ltr"
                    className="min-w-64"
                  />
                </div>
                <TextField id="grant-reason" name="reason" label="دلیل" required />
                <button type="submit" disabled={busy} className={buttonClass('primary')}>
                  دادن نقش
                </button>
              </form>
            </>
          )}

          {mayOffboard && account.status === 'active' && (
            <>
              <h3 className="font-bold">خروج کارمند</h3>
              <p className="text-[length:var(--text-sm)] text-ink-subtle">
                با تأیید نفر دوم، حساب غیرفعال، همه نقش‌ها لغو و همه نشست‌ها بسته می‌شوند. حساب حذف
                نمی‌شود.
              </p>
              <form
                className="flex flex-wrap items-end gap-2"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  const reason = formText(e.currentTarget, 'reason');
                  run(
                    () =>
                      unwrap(
                        api.POST('/api/v1/identity/staff-offboardings', {
                          body: { targetAccountId: account.id, reason },
                        }),
                      ),
                    'درخواست خروج ثبت شد؛ منتظر نفر دوم.',
                  );
                }}
              >
                <TextField
                  id="offboard-reason"
                  name="reason"
                  label="دلیل خروج"
                  required
                  className="min-w-64 grow"
                />
                <button type="submit" disabled={busy} className={buttonClass('danger')}>
                  درخواست خروج
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** A pending offboarding approved or rejected by a second person. */
export function OffboardingDecision({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    const path =
      decision === 'approve'
        ? ('/api/v1/identity/staff-offboardings/{id}/approve' as const)
        : ('/api/v1/identity/staff-offboardings/{id}/reject' as const);
    void unwrap(api.POST(path, { params: { path: { id } } }))
      .then(() => {
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          className={buttonClass('danger', 'min-h-9 px-3')}
          onClick={() => {
            decide('approve');
          }}
        >
          تأیید خروج
        </button>
        <button
          type="button"
          disabled={busy}
          className={buttonClass('secondary', 'min-h-9 px-3')}
          onClick={() => {
            decide('reject');
          }}
        >
          رد
        </button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
