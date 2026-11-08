import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../lib/server-api';
import {
  AccountAccess,
  CreateRoleForm,
  OffboardingDecision,
  RolePermissionsForm,
} from './access-forms';

export const metadata: Metadata = { title: 'نقش‌ها و دسترسی‌ها | پنل داخلی سپهر' };

/**
 * Roles and access (owner 1405/07/24, go-live blocker م۱۰): the roles and their permissions,
 * a new role, an account's grants and revokes, and staff offboarding by two people. Each
 * part shows by its permission; the API checks every one again (rule 12), and asks for the
 * TOTP code again where identity.reauth is on (R1).
 */
export default async function AccessPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const mayReadRoles = can(session, 'access.read_roles');
  const mayManageRoles = can(session, 'access.manage_roles');
  const mayAssign = can(session, 'access.assign_roles');
  const mayOffboard = can(session, 'identity.request_staff_offboarding');
  const mayApproveOffboarding = can(session, 'identity.approve_staff_offboarding');
  const [roles, permissions, offboardings] = await Promise.allSettled([
    mayReadRoles || mayAssign ? unwrap(api.GET('/api/v1/access/roles')) : Promise.resolve([]),
    mayManageRoles ? unwrap(api.GET('/api/v1/access/permissions')) : Promise.resolve([]),
    mayOffboard || mayApproveOffboarding
      ? unwrap(api.GET('/api/v1/identity/staff-offboardings'))
      : Promise.resolve([]),
  ]);
  const allPermissions = permissions.status === 'fulfilled' ? (permissions.value as string[]) : [];
  const roleOptions =
    roles.status === 'fulfilled' ? roles.value.map((r) => ({ value: r.code, label: r.name })) : [];

  return (
    <>
      <PageHeader
        title="نقش‌ها و دسترسی‌ها"
        description="نقش‌ها و مجوزهایشان، دادن و لغو نقش با دلیل، و خروج کارمند با تأیید نفر دوم. هر تغییر در سابقه ثبت می‌شود."
      />
      <div className="space-y-6">
        {(mayAssign || mayOffboard) && (
          <AccountAccess roles={roleOptions} mayAssign={mayAssign} mayOffboard={mayOffboard} />
        )}

        {(mayOffboard || mayApproveOffboarding) &&
          (offboardings.status === 'rejected' ? (
            <Notice tone="danger">{errorMessage(offboardings.reason)}</Notice>
          ) : (
            <DataTable
              caption="درخواست‌های خروج در انتظار نفر دوم"
              rows={offboardings.value}
              rowKey={(o) => o.id}
              empty={<EmptyState title="درخواست خروجی در انتظار نیست." />}
              columns={[
                {
                  key: 'target',
                  header: 'حساب',
                  cell: (o) => <span dir="ltr">{o.targetUsername ?? '—'}</span>,
                },
                { key: 'reason', header: 'دلیل', cell: (o) => o.reason },
                {
                  key: 'requested',
                  header: 'درخواست در',
                  cell: (o) => <time dateTime={o.requestedAt}>{showInstant(o.requestedAt)}</time>,
                },
                {
                  key: 'decide',
                  header: 'تصمیم',
                  cell: (o) =>
                    o.requestedByMe ? (
                      <StatusBadge tone="info">درخواست خودتان؛ منتظر نفر دوم</StatusBadge>
                    ) : mayApproveOffboarding ? (
                      <OffboardingDecision id={o.id} />
                    ) : (
                      <StatusBadge tone="neutral">منتظر نفر دوم</StatusBadge>
                    ),
                },
              ]}
            />
          ))}

        {mayReadRoles &&
          (roles.status === 'rejected' ? (
            <Notice tone="danger">{errorMessage(roles.reason)}</Notice>
          ) : (
            <DataTable
              caption="نقش‌ها"
              rows={roles.value}
              rowKey={(r) => r.id}
              empty={<EmptyState title="نقشی نیست." />}
              columns={[
                {
                  key: 'name',
                  header: 'نقش',
                  cell: (r) => (
                    <span className="space-y-1">
                      <span className="block font-medium">{r.name}</span>
                      <span className="block text-ink-subtle" dir="ltr">
                        {r.code}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'kind',
                  header: 'نوع',
                  cell: (r) =>
                    r.isSystem ? (
                      <StatusBadge tone="neutral">سیستمی؛ فقط با مهاجرت</StatusBadge>
                    ) : (
                      <StatusBadge tone="info">ساخته‌شده در پنل</StatusBadge>
                    ),
                },
                {
                  key: 'permissions',
                  header: 'مجوزها',
                  cell: (r) => (
                    <details>
                      <summary>{faDigits(String(r.permissions.length))} مجوز</summary>
                      <ul className="mt-1 space-y-0.5 text-[length:var(--text-xs)]" dir="ltr">
                        {r.permissions.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    </details>
                  ),
                },
                {
                  key: 'edit',
                  header: 'ویرایش',
                  cell: (r) =>
                    mayManageRoles && !r.isSystem ? (
                      <RolePermissionsForm
                        roleId={r.id}
                        roleCode={r.code}
                        permissions={allPermissions}
                        current={r.permissions}
                      />
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          ))}

        {mayManageRoles && <CreateRoleForm permissions={allPermissions} />}
      </div>
    </>
  );
}
