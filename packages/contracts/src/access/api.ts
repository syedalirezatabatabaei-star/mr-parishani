import * as z from 'zod';
import { normalizePersianText } from '../text/persian.js';
import { PERMISSIONS } from './permissions.js';

/**
 * Where a role assignment applies (doc 04 §1): everywhere, one city, a center, branch
 * (task 2-2) or doctor node with everything under it, one team work queue, or only the user's own
 * records. Work queues belong to teams (e.g. `case_completion`), never to a person;
 * who inside the team gets which record is decided by the queue's percentages (doc 05).
 */
export const SCOPE_KINDS = [
  'global',
  'city',
  'center',
  'branch',
  'doctor',
  'queue',
  'own',
] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** A city or work-queue code: lowercase snake_case, never an id of a person. */
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);

export const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('own') }),
  z.object({ kind: z.literal('city'), code: codeSchema }),
  z.object({ kind: z.literal('queue'), code: codeSchema }),
  z.object({ kind: z.literal('center'), nodeId: z.uuid() }),
  z.object({ kind: z.literal('branch'), nodeId: z.uuid() }),
  z.object({ kind: z.literal('doctor'), nodeId: z.uuid() }),
]);
export type ScopeInput = z.infer<typeof scopeSchema>;

/** Why: every change to access is recorded with its reason (rule 9). */
const reasonSchema = z.string().transform(normalizePersianText).pipe(z.string().min(3).max(500));

const permissionListSchema = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

export const createRoleSchema = z.object({
  code: codeSchema,
  name: z.string().transform(normalizePersianText).pipe(z.string().min(2).max(100)),
  permissions: permissionListSchema,
  reason: reasonSchema,
});
export type CreateRole = z.input<typeof createRoleSchema>;

export const setRolePermissionsSchema = z.object({
  permissions: permissionListSchema,
  reason: reasonSchema,
});
export type SetRolePermissions = z.input<typeof setRolePermissionsSchema>;

export const assignRoleSchema = z.object({
  accountId: z.uuid(),
  roleCode: codeSchema,
  scope: scopeSchema,
  reason: reasonSchema,
});
export type AssignRole = z.input<typeof assignRoleSchema>;

/** A doctor granting a role to one of their secretaries; the scope is always the doctor. */
export const assignSecretaryRoleSchema = z.object({
  roleCode: codeSchema,
  reason: reasonSchema,
});
export type AssignSecretaryRole = z.input<typeof assignSecretaryRoleSchema>;

export const revokeSchema = z.object({ reason: reasonSchema });
export type Revoke = z.input<typeof revokeSchema>;

export const ORG_NODE_KINDS = ['center', 'branch', 'doctor', 'secretary'] as const;
export type OrgNodeKind = (typeof ORG_NODE_KINDS)[number];

/**
 * A node of the center tree (doc 04 §2, doc 08 §2): Center → Branch → Doctor → Secretary.
 * A doctor may also sit directly under a center (task 0-5 data); new doctors go under a
 * branch (task 2-2). A private practice has no center: its doctor is a root.
 */
export const createOrgNodeSchema = z.object({
  kind: z.enum(ORG_NODE_KINDS),
  parentId: z.uuid().nullable(),
  name: z.string().transform(normalizePersianText).pipe(z.string().min(2).max(200)),
  /** Required on a root; children inherit their parent's city. */
  cityCode: codeSchema.nullable(),
  /** The user account operating a doctor or secretary node. */
  accountId: z.uuid().nullable(),
  reason: reasonSchema,
});
export type CreateOrgNode = z.input<typeof createOrgNodeSchema>;

/** A node as the API shows it: `GET /access/org-nodes[/:id]`, `POST /access/org-nodes`. */
export const orgNodeViewSchema = z.object({
  id: z.uuid(),
  kind: z.enum(ORG_NODE_KINDS),
  parentId: z.uuid().nullable(),
  name: z.string(),
  cityCode: z.string(),
  accountId: z.uuid().nullable(),
});

/** `GET /access/permissions`: every permission code the system knows. */
export const permissionListViewSchema = z.array(z.enum(PERMISSIONS));

export const requestTotpResetSchema = z.object({
  targetAccountId: z.uuid(),
  reason: reasonSchema,
});
export type RequestTotpReset = z.input<typeof requestTotpResetSchema>;

/** Asking to offboard a staff or center account (owner 1405/07/23, plan 4). */
export const requestStaffOffboardingSchema = z.object({
  targetAccountId: z.uuid(),
  reason: reasonSchema,
});
export type RequestStaffOffboarding = z.input<typeof requestStaffOffboardingSchema>;

export const staffOffboardingViewSchema = z.object({
  id: z.uuid(),
  targetAccountId: z.uuid(),
  /** Whom it is about, for the second person to see (owner 1405/07/24, the roles page). */
  targetUsername: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected']),
  reason: z.string(),
  requestedAt: z.iso.datetime({ offset: true }),
  /** A request is never decided by who asked it, nor by its target. */
  requestedByMe: z.boolean(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Approved: the role assignments it revoked. */
  rolesRevoked: z.int().min(0).nullable(),
});
export type StaffOffboardingView = z.infer<typeof staffOffboardingViewSchema>;

/** A scope as the API resolves it: a node scope carries its tree path and city. */
export const resolvedScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('own') }),
  z.object({ kind: z.literal('city'), code: z.string() }),
  z.object({ kind: z.literal('queue'), code: z.string() }),
  z.object({
    kind: z.enum(['center', 'branch', 'doctor']),
    nodeId: z.uuid(),
    path: z.string(),
    cityCode: z.string().nullable(),
  }),
]);

/** `GET /access/me`: my roles, permissions and scopes, for the UI to hide what I cannot use. */
export const myAccessSchema = z.object({
  roles: z.array(z.string()),
  permissions: z.array(z.enum(PERMISSIONS)),
  scopes: z.array(resolvedScopeSchema),
});

/** `GET /access/roles`: every role with its permissions (owner 1405/07/24, م۱۰). */
export const roleViewSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** A system role's permissions are set by migrations only. */
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
});
export type RoleView = z.infer<typeof roleViewSchema>;

/** `GET /access/accounts/:id/assignments`: an account's roles in force. */
export const roleAssignmentViewSchema = z.object({
  id: z.uuid(),
  roleCode: z.string(),
  scopeKind: z.enum(SCOPE_KINDS),
  scopeNodeId: z.uuid().nullable(),
  scopeCode: z.string().nullable(),
  reason: z.string().nullable(),
  grantedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type RoleAssignmentView = z.infer<typeof roleAssignmentViewSchema>;

/**
 * `GET /access/accounts/by-username/:username`: a staff or center account found by its
 * username, to grant or revoke its roles or to offboard it. Never a patient; no mobile.
 */
export const staffAccountViewSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string().nullable(),
  kind: z.enum(['staff', 'center']),
  status: z.enum(['active', 'disabled']),
});
export type StaffAccountView = z.infer<typeof staffAccountViewSchema>;

/** What creating a role or an assignment answers. */
export const accessIdSchema = z.object({ id: z.uuid() });
