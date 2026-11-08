import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { id, timestamps, timestamptz } from '../../db/columns';

/** Postgres `ltree` (extension, migration 0002): a materialized path of labels. */
const ltree = customType<{ data: string }>({ dataType: () => 'ltree' });

/**
 * Mirror of PERMISSIONS in @sepehr/contracts, filled by migrations only. Role permissions
 * reference it, so a role can never hold a code the API does not know; the API refuses
 * to start while the two differ.
 */
export const permissions = pgTable(
  'permissions',
  {
    id: id(),
    code: text('code').notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('permissions_code_key').on(t.code)],
);

/**
 * A named set of permissions (doc 04 §1). System roles (doc 04 §3 and the center roles
 * of §2) come from migrations and cannot be edited through the API; administrators build
 * their own roles next to them.
 */
export const roles = pgTable(
  'roles',
  {
    id: id(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('roles_code_key')
      .on(t.code)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** A permission of a role. Removing it soft-deletes the row (rule 7). */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: id(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('role_permissions_role_permission_key')
      .on(t.roleId, t.permissionCode)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * The center tree (doc 04 §2): Center → Doctor → Secretary; a private practice's doctor
 * is a root. `path` is maintained by a trigger from the parent's path, so "everything
 * under this node" is one indexed `<@` query. Row-level security on this table is the
 * second line of defense behind the service checks.
 */
export const orgNodes = pgTable(
  'org_nodes',
  {
    id: id(),
    kind: text('kind', { enum: ['center', 'branch', 'doctor', 'secretary'] }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => orgNodes.id),
    /** Set by the org_nodes_set_path trigger; never written by the application. */
    path: ltree('path')
      .notNull()
      .default(sql`''`),
    name: text('name').notNull(),
    cityCode: text('city_code').notNull(),
    /** The user account operating a doctor or secretary node (identity module). */
    accountId: uuid('account_id'),
    ...timestamps(),
  },
  (t) => [
    index('org_nodes_path_idx').using('gist', t.path),
    index('org_nodes_parent_id_idx').on(t.parentId),
    // One node per account, except a doctor: one node per workplace (task 2-3), so one
    // under each parent and one private practice. A secretary serves one doctor at one
    // workplace (task 2-3 decision); serving several later only relaxes this index.
    uniqueIndex('org_nodes_account_id_key')
      .on(t.accountId)
      .where(sql`${t.accountId} IS NOT NULL AND ${t.deletedAt} IS NULL AND ${t.kind} <> 'doctor'`),
    uniqueIndex('org_nodes_doctor_account_key')
      .on(t.accountId, t.parentId)
      .where(
        sql`${t.kind} = 'doctor' AND ${t.accountId} IS NOT NULL AND ${t.parentId} IS NOT NULL AND ${t.deletedAt} IS NULL`,
      ),
    uniqueIndex('org_nodes_doctor_root_account_key')
      .on(t.accountId)
      .where(
        sql`${t.kind} = 'doctor' AND ${t.accountId} IS NOT NULL AND ${t.parentId} IS NULL AND ${t.deletedAt} IS NULL`,
      ),
  ],
);

/**
 * A role held by an account within a scope. Revoking sets revoked_at; rows stay.
 * `scope_node_id` is set for center and doctor scopes, `scope_code` for city and queue.
 */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: id(),
    /** A user account (identity module); checked through the AccountDirectory port. */
    accountId: uuid('account_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    scopeKind: text('scope_kind', {
      enum: ['global', 'city', 'center', 'branch', 'doctor', 'queue', 'own'],
    }).notNull(),
    scopeNodeId: uuid('scope_node_id').references(() => orgNodes.id),
    scopeCode: text('scope_code'),
    reason: text('reason').notNull(),
    /** Null when granted from the command line. */
    grantedBy: uuid('granted_by'),
    revokedAt: timestamptz('revoked_at'),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
    ...timestamps(),
  },
  (t) => [
    index('role_assignments_account_id_idx')
      .on(t.accountId)
      .where(sql`${t.revokedAt} IS NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * Versioned access policies (ADR-006): the internal panel's IP allow-list and the audit
 * retention. A change is a new row, `proposed` by one person and `approved` by another;
 * the effective value is the latest approved row. Rows are never edited except for that
 * one decision.
 *
 * No longer used: since migration 0003 both policies are versioned configuration
 * (`access.internal_panel_ip_allowlist`, `audit.retention`), and the table is frozen.
 * TODO(contract): drop it, with this definition, in a later migration (expand/contract).
 */
export const accessPolicyVersions = pgTable(
  'access_policy_versions',
  {
    id: id(),
    policyKey: text('policy_key', {
      enum: ['internal_panel_ip_allowlist', 'audit_retention'],
    }).notNull(),
    value: jsonb('value').notNull(),
    status: text('status', { enum: ['proposed', 'approved', 'rejected'] })
      .notNull()
      .default('proposed'),
    reason: text('reason').notNull(),
    /** Null only for the initial values seeded by the migration. */
    proposedBy: uuid('proposed_by'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    ...timestamps(),
  },
  (t) => [index('access_policy_versions_key_idx').on(t.policyKey, t.decidedAt)],
);
