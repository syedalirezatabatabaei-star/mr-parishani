import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  PERMISSIONS,
  type assignRoleSchema,
  type createOrgNodeSchema,
  type PermissionCode,
} from '@sepehr/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import type { AccessPort, EffectiveAccess, ResolvedScope } from '../../common/auth/access.port';
import type { NewTreeNode, OrgTreeNode, OrgTreePort } from '../../common/auth/org-tree.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { orgNodes, permissions, roleAssignments, rolePermissions, roles } from './access.schema';
import { internalPanelAllows, internalPanelCidrsFromEnv } from './internal-network';
import { capByDoctor, rlsSettingsOf, scopeWithin } from './scope';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Role code whose holders never see the treatment, whatever else they hold (doc 04 §3:
 * «شرح درمان را نمی‌بیند»). A hard rule, so it lives in code, not in role data.
 */
const COLLECTION_ROLE = 'collection';
/** A doctor's role on their own node; also the cap of a secretary whose doctor has no account. */
const DOCTOR_ROLE = 'doctor';
/** Roles whose new grants need the account's mobile verified (task 4-6). */
const MOBILE_REQUIRED_ROLES: ReadonlySet<string> = new Set(['center_manager']);
/**
 * Roles that act only on what is their own (owner 1405/07/18, R18 of task 9-3): granted with
 * the `own` scope only, and read as `own` whatever an older grant says.
 */
const OWN_ONLY_ROLES: ReadonlySet<string> = new Set(['advisor']);
const TREATMENT_PERMISSION: PermissionCode = 'access.view_treatment';

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && 'cause' in error
    ? (error.cause as { code?: string } | undefined)?.code === UNIQUE_VIOLATION
    : (error as { code?: string } | null)?.code === UNIQUE_VIOLATION;

export interface OrgNodeView {
  readonly id: string;
  readonly kind: 'center' | 'branch' | 'doctor' | 'secretary';
  readonly parentId: string | null;
  readonly name: string;
  readonly cityCode: string;
  readonly accountId: string | null;
}

/** The node without its internal path. */
const toView = (row: OrgNodeView): OrgNodeView => ({
  id: row.id,
  kind: row.kind,
  parentId: row.parentId,
  name: row.name,
  cityCode: row.cityCode,
  accountId: row.accountId,
});

const orgNodeColumns = {
  id: orgNodes.id,
  kind: orgNodes.kind,
  parentId: orgNodes.parentId,
  name: orgNodes.name,
  cityCode: orgNodes.cityCode,
  accountId: orgNodes.accountId,
};

/**
 * Roles, scopes and the center tree (task 0-5, doc 04). Access is resolved from the
 * database on every request and never cached, so a changed role applies to active
 * sessions at once (doc 04 §8 test 6).
 */
@Injectable()
export class AccessService implements AccessPort, OrgTreePort, OnApplicationBootstrap {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  /** Read once: a malformed range stops the API at start (R10). */
  private readonly internalPanelCidrs = internalPanelCidrsFromEnv(process.env);

  /** Refuses to start while the permissions table and PERMISSIONS differ. */
  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.db
      .select({ code: permissions.code })
      .from(permissions)
      .where(isNull(permissions.deletedAt));
    const inDb = new Set(rows.map((r) => r.code));
    const inCode = new Set<string>(PERMISSIONS);
    const missing = [...inCode].filter((c) => !inDb.has(c));
    const extra = [...inDb].filter((c) => !inCode.has(c));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `permissions table out of sync with PERMISSIONS; missing: [${missing.join(', ')}], unknown: [${extra.join(', ')}]. A migration must add them.`,
      );
    }
  }

  // --- row-level security -------------------------------------------------------------

  /**
   * A transaction in which org_nodes is visible as a whole: the module's bookkeeping. With
   * `outer`, runs in that transaction instead (another module's change, through ORG_TREE);
   * the setting lasts until it ends.
   */
  private asSystem<T>(fn: (tx: Tx) => Promise<T>, outer?: SqlExecutor): Promise<T> {
    if (outer) {
      return outer
        .execute(sql`SELECT set_config('app.rls_mode', 'system', true)`)
        .then(() => fn(outer as Tx));
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.rls_mode', 'system', true)`);
      return fn(tx);
    });
  }

  /**
   * A transaction in which org_nodes shows only what `access` covers. With `outer`, runs
   * in that transaction (another module's change, through ORG_TREE); the settings last
   * until it ends or the next asSystem/asUser in it.
   */
  private asUser<T>(
    access: EffectiveAccess,
    fn: (tx: Tx) => Promise<T>,
    outer?: SqlExecutor,
  ): Promise<T> {
    const rls = rlsSettingsOf(access);
    const scoped = async (tx: SqlExecutor) => {
      await tx.execute(sql`
        SELECT set_config('app.rls_mode', 'scoped', true),
               set_config('app.scope_all', ${rls.all ? 'on' : 'off'}, true),
               set_config('app.scope_paths', ${rls.paths}, true),
               set_config('app.scope_cities', ${rls.cities}, true)
      `);
      return fn(tx as Tx);
    };
    return outer ? scoped(outer) : this.db.transaction(scoped);
  }

  // --- resolving access ---------------------------------------------------------------

  async holdersOf(roleCode: string): Promise<string[]> {
    return this.asSystem(async (tx) => {
      const rows = await tx
        .selectDistinct({ accountId: roleAssignments.accountId })
        .from(roleAssignments)
        .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), isNull(roles.deletedAt)))
        .where(
          and(
            eq(roles.code, roleCode),
            isNull(roleAssignments.revokedAt),
            isNull(roleAssignments.deletedAt),
          ),
        );
      return rows.map((r) => r.accountId);
    });
  }

  async holdersOfPermission(permission: PermissionCode): Promise<string[]> {
    return this.asSystem(async (tx) => {
      const rows = await tx
        .selectDistinct({ accountId: roleAssignments.accountId })
        .from(roleAssignments)
        .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), isNull(roles.deletedAt)))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .where(
          and(
            eq(rolePermissions.permissionCode, permission),
            isNull(rolePermissions.deletedAt),
            isNull(roleAssignments.revokedAt),
            isNull(roleAssignments.deletedAt),
          ),
        );
      return rows.map((r) => r.accountId);
    });
  }

  async revokeAllOf(
    accountId: string,
    actor: Actor,
    reason: string,
    tx: SqlExecutor,
    now = new Date(),
  ): Promise<number> {
    return this.asSystem(async (ex) => {
      const live = await ex
        .select({ id: roleAssignments.id, roleCode: roles.code })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(
          and(
            eq(roleAssignments.accountId, accountId),
            isNull(roleAssignments.revokedAt),
            isNull(roleAssignments.deletedAt),
          ),
        )
        .for('update', { of: roleAssignments });
      for (const assignment of live) {
        await ex
          .update(roleAssignments)
          .set({ revokedAt: now, revokedBy: actor.accountId, revokeReason: reason })
          .where(eq(roleAssignments.id, assignment.id));
        await this.audit.record(
          {
            actor,
            action: 'access.role_revoked',
            entityType: 'user_account',
            entityId: accountId,
            before: { assignmentId: assignment.id, role: assignment.roleCode },
            reason,
          },
          ex,
        );
      }
      return live.length;
    }, tx);
  }

  async resolve(accountId: string): Promise<EffectiveAccess> {
    return this.asSystem(async (tx) => {
      const own = await this.grantsOf(tx, accountId);
      const [secretaryNode] = await tx
        .select({ parentId: orgNodes.parentId })
        .from(orgNodes)
        .where(
          and(
            eq(orgNodes.accountId, accountId),
            eq(orgNodes.kind, 'secretary'),
            isNull(orgNodes.deletedAt),
          ),
        );
      if (!secretaryNode?.parentId) return own;

      // A secretary: capped by their doctor, whose own grants are read the same way. A
      // doctor without an account caps them by the doctor role on that doctor's node
      // (task 2-3 decision).
      const [doctorNode] = await tx
        .select({
          id: orgNodes.id,
          accountId: orgNodes.accountId,
          path: orgNodes.path,
          cityCode: orgNodes.cityCode,
        })
        .from(orgNodes)
        .where(and(eq(orgNodes.id, secretaryNode.parentId), isNull(orgNodes.deletedAt)));
      if (!doctorNode) {
        return capByDoctor(own, { accountId: '', roles: [], permissions: new Set(), scopes: [] });
      }
      const doctor: EffectiveAccess = doctorNode.accountId
        ? await this.grantsOf(tx, doctorNode.accountId)
        : {
            accountId: '',
            roles: [DOCTOR_ROLE],
            permissions: new Set(await this.permissionsOfRole(DOCTOR_ROLE, tx)),
            scopes: [
              {
                kind: 'doctor',
                nodeId: doctorNode.id,
                path: doctorNode.path,
                cityCode: doctorNode.cityCode,
              },
            ],
          };
      return capByDoctor(own, doctor);
    });
  }

  /** Active role assignments of one account, with their permissions and scopes. */
  private async grantsOf(tx: Tx, accountId: string): Promise<EffectiveAccess> {
    const rows = await tx
      .select({
        assignmentId: roleAssignments.id,
        roleCode: roles.code,
        permission: rolePermissions.permissionCode,
        scopeKind: roleAssignments.scopeKind,
        scopeCode: roleAssignments.scopeCode,
        nodeId: orgNodes.id,
        nodeKind: orgNodes.kind,
        nodePath: orgNodes.path,
        nodeCity: orgNodes.cityCode,
      })
      .from(roleAssignments)
      .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), isNull(roles.deletedAt)))
      .leftJoin(
        rolePermissions,
        and(eq(rolePermissions.roleId, roles.id), isNull(rolePermissions.deletedAt)),
      )
      .leftJoin(
        orgNodes,
        and(eq(orgNodes.id, roleAssignments.scopeNodeId), isNull(orgNodes.deletedAt)),
      )
      .where(
        and(
          eq(roleAssignments.accountId, accountId),
          isNull(roleAssignments.revokedAt),
          isNull(roleAssignments.deletedAt),
        ),
      );

    const roleCodes = new Set<string>();
    const granted = new Set<PermissionCode>();
    const scopes = new Map<string, ResolvedScope>();
    for (const row of rows) {
      const scope: ResolvedScope | null = OWN_ONLY_ROLES.has(row.roleCode)
        ? { kind: 'own' }
        : this.scopeOfRow(row);
      // A scope whose node was soft-deleted grants nothing.
      if (!scope) continue;
      roleCodes.add(row.roleCode);
      if (row.permission) granted.add(row.permission as PermissionCode);
      scopes.set(row.assignmentId, scope);
    }
    if (roleCodes.has(COLLECTION_ROLE)) granted.delete(TREATMENT_PERMISSION);
    return {
      accountId,
      roles: [...roleCodes].sort(),
      permissions: granted,
      scopes: [...scopes.values()],
    };
  }

  private scopeOfRow(row: {
    scopeKind: 'global' | 'city' | 'center' | 'branch' | 'doctor' | 'queue' | 'own';
    scopeCode: string | null;
    nodeId: string | null;
    nodeKind: string | null;
    nodePath: string | null;
    nodeCity: string | null;
  }): ResolvedScope | null {
    switch (row.scopeKind) {
      case 'global':
      case 'own':
        return { kind: row.scopeKind };
      case 'city':
      case 'queue':
        return row.scopeCode ? { kind: row.scopeKind, code: row.scopeCode } : null;
      case 'center':
      case 'branch':
      case 'doctor':
        return row.nodeId && row.nodePath
          ? { kind: row.scopeKind, nodeId: row.nodeId, path: row.nodePath, cityCode: row.nodeCity }
          : null;
    }
  }

  // --- the center tree ----------------------------------------------------------------

  /** ORG_TREE: a center or branch of the catalog module, in its transaction. */
  async createNode(
    actor: Actor,
    access: EffectiveAccess,
    node: NewTreeNode,
    tx: SqlExecutor,
  ): Promise<OrgTreeNode> {
    const created = await this.insertOrgNode(
      actor,
      access,
      { ...node, accountId: node.accountId ?? null },
      tx,
    );
    return {
      id: created.id,
      kind: created.kind,
      parentId: created.parentId,
      name: created.name,
      cityCode: created.cityCode,
      path: created.path,
    };
  }

  async attachDoctorAccount(
    actor: Actor,
    doctorNodeId: string,
    accountId: string,
    reason: string,
    tx: SqlExecutor,
  ): Promise<void> {
    const account = await this.accounts.find(accountId);
    if (!account || account.status !== 'active' || account.kind !== 'center') {
      throw new BadRequestException({ error: 'center_account_required' });
    }
    // The doctor is told of funded patients by SMS (task 4-5): a new link needs the
    // account's mobile verified by a code (task 4-6, owner 1405/07/12).
    if (!account.mobileVerified) {
      throw new ConflictException({ error: 'account_mobile_unverified' });
    }
    await this.asSystem(async (sys) => {
      const [node] = await sys
        .select({ kind: orgNodes.kind, accountId: orgNodes.accountId })
        .from(orgNodes)
        .where(and(eq(orgNodes.id, doctorNodeId), isNull(orgNodes.deletedAt)))
        .for('update');
      if (node?.kind !== 'doctor') throw new NotFoundException();
      if (node.accountId !== null) throw new ConflictException({ error: 'node_has_account' });
      await sys.update(orgNodes).set({ accountId }).where(eq(orgNodes.id, doctorNodeId));
      await this.audit.record(
        {
          actor,
          action: 'access.org_node_account_attached',
          entityType: 'org_node',
          entityId: doctorNodeId,
          before: { accountId: null },
          after: { accountId },
          reason,
        },
        sys,
      );
    }, tx);
    await this.insertAssignment(
      actor,
      { accountId, roleCode: DOCTOR_ROLE, scope: { kind: 'doctor', nodeId: doctorNodeId }, reason },
      tx,
    );
  }

  async assignSecretaryRoleForDoctor(
    actor: Actor,
    access: EffectiveAccess,
    secretaryNodeId: string,
    input: { roleCode: string; reason: string },
    tx: SqlExecutor,
  ): Promise<{ id: string }> {
    const nodes = await this.secretaryAndDoctor(secretaryNodeId, tx);
    // Out of the caller's scope, the secretary does not exist (rule 13).
    if (!nodes || !this.covers(access, nodes.doctor)) throw new NotFoundException();
    if (nodes.doctor.accountId !== null) {
      throw new ConflictException({ error: 'doctor_decides' });
    }
    const granted = await this.permissionsOfRole(input.roleCode, tx);
    const cap = new Set(await this.permissionsOfRole(DOCTOR_ROLE, tx));
    if (granted.some((code) => !cap.has(code))) {
      throw new ForbiddenException({ error: 'role_exceeds_doctor_access' });
    }
    // Nobody hands on what they do not hold themselves.
    if (granted.some((code) => !access.permissions.has(code))) {
      throw new ForbiddenException({ error: 'role_exceeds_own_access' });
    }
    return this.insertAssignment(
      actor,
      {
        accountId: nodes.secretary.accountId,
        roleCode: input.roleCode,
        scope: { kind: 'doctor', nodeId: nodes.doctor.id },
        reason: input.reason,
      },
      tx,
    );
  }

  /** A secretary node with an account and its doctor node, or null. */
  private secretaryAndDoctor(secretaryNodeId: string, outer?: SqlExecutor) {
    return this.asSystem(async (tx) => {
      const [secretary] = await tx
        .select({ kind: orgNodes.kind, accountId: orgNodes.accountId, parentId: orgNodes.parentId })
        .from(orgNodes)
        .where(and(eq(orgNodes.id, secretaryNodeId), isNull(orgNodes.deletedAt)));
      if (!secretary?.parentId || secretary.kind !== 'secretary' || !secretary.accountId) {
        return null;
      }
      const [doctor] = await tx
        .select({
          id: orgNodes.id,
          accountId: orgNodes.accountId,
          path: orgNodes.path,
          cityCode: orgNodes.cityCode,
        })
        .from(orgNodes)
        .where(and(eq(orgNodes.id, secretary.parentId), isNull(orgNodes.deletedAt)));
      return doctor ? { secretary: { accountId: secretary.accountId }, doctor } : null;
    }, outer);
  }

  async renameNode(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    name: string,
    reason: string,
    tx: SqlExecutor,
  ): Promise<void> {
    const before = await this.getOrgNode(access, id, tx);
    if (before.name === name) return;
    await this.asSystem(async (sys) => {
      await sys.update(orgNodes).set({ name }).where(eq(orgNodes.id, id));
      await this.audit.record(
        {
          actor,
          action: 'access.org_node_renamed',
          entityType: 'org_node',
          entityId: id,
          before: { name: before.name },
          after: { name },
          reason,
        },
        sys,
      );
    }, tx);
  }

  /**
   * Retires nodes nobody works on (task 2-9: undoing an import): each one the caller's scope
   * covers, with no live role assignment and no live child outside the set. A soft delete
   * (rule 7), audited one by one; access then ignores them like every deleted node.
   */
  async retireNodes(
    actor: Actor,
    access: EffectiveAccess,
    ids: readonly string[],
    reason: string,
    tx: SqlExecutor,
  ): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) await this.getOrgNode(access, id, tx);
    await this.asSystem(async (sys) => {
      const nodes = await sys
        .select()
        .from(orgNodes)
        .where(and(inArray(orgNodes.id, [...ids]), isNull(orgNodes.deletedAt)))
        .for('update');
      const children = await sys
        .select({ id: orgNodes.id })
        .from(orgNodes)
        .where(and(inArray(orgNodes.parentId, [...ids]), isNull(orgNodes.deletedAt)));
      if (children.some((c) => !ids.includes(c.id))) {
        throw new ConflictException({ error: 'node_has_children' });
      }
      const assigned = await sys
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .where(
          and(inArray(roleAssignments.scopeNodeId, [...ids]), isNull(roleAssignments.deletedAt)),
        );
      if (assigned.length > 0) throw new ConflictException({ error: 'node_has_assignments' });
      if (nodes.length === 0) return;
      await sys
        .update(orgNodes)
        .set({ deletedAt: new Date() })
        .where(
          inArray(
            orgNodes.id,
            nodes.map((n) => n.id),
          ),
        );
      for (const node of nodes) {
        await this.audit.record(
          {
            actor,
            action: 'access.org_node_retired',
            entityType: 'org_node',
            entityId: node.id,
            before: { kind: node.kind, name: node.name },
            reason,
          },
          sys,
        );
      }
    }, tx);
  }

  async createOrgNode(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof createOrgNodeSchema>,
  ): Promise<OrgNodeView> {
    return toView(await this.insertOrgNode(actor, access, input));
  }

  private async insertOrgNode(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof createOrgNodeSchema>,
    tx?: SqlExecutor,
  ): Promise<OrgNodeView & { path: string }> {
    if (input.kind === 'secretary' && input.accountId === null) {
      throw new BadRequestException({ error: 'account_required' });
    }
    // A center or branch is run through role assignments on its node, not by one account.
    if ((input.kind === 'center' || input.kind === 'branch') && input.accountId !== null) {
      throw new BadRequestException({ error: 'center_takes_no_account' });
    }
    if (input.accountId !== null) {
      const account = await this.accounts.find(input.accountId);
      if (!account || account.kind !== 'center') {
        throw new BadRequestException({ error: 'center_account_required' });
      }
    }

    let cityCode: string;
    if (input.parentId === null) {
      if (input.kind === 'secretary') throw new BadRequestException({ error: 'parent_required' });
      if (input.cityCode === null) throw new BadRequestException({ error: 'city_required' });
      cityCode = input.cityCode;
      // A new root must fall inside the creator's scope: global, or that city.
      const probe: ResolvedScope = { kind: 'city', code: cityCode };
      if (!access.scopes.some((by) => scopeWithin(probe, by))) throw new ForbiddenException();
    } else {
      // The parent must be visible to the creator; otherwise it "does not exist" (IDOR).
      const parent = await this.getOrgNode(access, input.parentId, tx);
      cityCode = parent.cityCode;
    }

    try {
      return await this.asSystem(async (tx) => {
        const [node] = await tx
          .insert(orgNodes)
          .values({
            kind: input.kind,
            parentId: input.parentId,
            name: input.name,
            cityCode,
            accountId: input.accountId,
          })
          .returning({ ...orgNodeColumns, path: orgNodes.path });
        if (!node) throw new Error('org node insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'access.org_node_created',
            entityType: 'org_node',
            entityId: node.id,
            after: toView(node),
            reason: input.reason,
          },
          tx,
        );
        return node;
      }, tx);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException({ error: 'account_has_node' });
      throw error;
    }
  }

  /**
   * One node, if the caller's scope covers it; otherwise 404, never 403, so that an id
   * guessed from another doctor reveals nothing (rule 13). Checked twice: by row-level
   * security in the query and by the scope in code.
   */
  async getOrgNode(access: EffectiveAccess, id: string, outer?: SqlExecutor): Promise<OrgNodeView> {
    const row = await this.asUser(
      access,
      async (tx) => {
        const [found] = await tx
          .select({ ...orgNodeColumns, path: orgNodes.path })
          .from(orgNodes)
          .where(and(eq(orgNodes.id, id), isNull(orgNodes.deletedAt)));
        return found;
      },
      outer,
    );
    if (!row || !this.covers(access, row)) throw new NotFoundException();
    return toView(row);
  }

  /** {@link getOrgNode}, recorded in the access log (doc 04 §7). */
  async viewOrgNode(actor: Actor, access: EffectiveAccess, id: string): Promise<OrgNodeView> {
    const node = await this.getOrgNode(access, id);
    await this.audit.recordView(actor, 'org_node', id);
    return node;
  }

  /** Every node the caller's scope covers. */
  async listOrgNodes(access: EffectiveAccess): Promise<OrgNodeView[]> {
    const rows = await this.asUser(access, (tx) =>
      tx
        .select({ ...orgNodeColumns, path: orgNodes.path })
        .from(orgNodes)
        .where(isNull(orgNodes.deletedAt))
        .orderBy(asc(orgNodes.path)),
    );
    return rows.filter((row) => this.covers(access, row)).map(toView);
  }

  private covers(access: EffectiveAccess, node: { path: string; cityCode: string }): boolean {
    const asScope: ResolvedScope = {
      kind: 'center',
      nodeId: '',
      path: node.path,
      cityCode: node.cityCode,
    };
    return access.scopes.some((by) => scopeWithin(asScope, by));
  }

  // --- roles --------------------------------------------------------------------------

  async listRoles() {
    const rows = await this.db
      .select({
        id: roles.id,
        code: roles.code,
        name: roles.name,
        isSystem: roles.isSystem,
        permission: rolePermissions.permissionCode,
      })
      .from(roles)
      .leftJoin(
        rolePermissions,
        and(eq(rolePermissions.roleId, roles.id), isNull(rolePermissions.deletedAt)),
      )
      .where(isNull(roles.deletedAt))
      .orderBy(asc(roles.code), asc(rolePermissions.permissionCode));
    const byId = new Map<
      string,
      { id: string; code: string; name: string; isSystem: boolean; permissions: string[] }
    >();
    for (const row of rows) {
      let role = byId.get(row.id);
      if (!role) {
        role = {
          id: row.id,
          code: row.code,
          name: row.name,
          isSystem: row.isSystem,
          permissions: [],
        };
        byId.set(row.id, role);
      }
      if (row.permission) role.permissions.push(row.permission);
    }
    return [...byId.values()];
  }

  async createRole(
    actor: Actor,
    input: { code: string; name: string; permissions: readonly PermissionCode[]; reason: string },
  ): Promise<{ id: string }> {
    await assertFreshMfa(this.config, actor);
    const codes = [...new Set(input.permissions)].sort();
    try {
      return await this.db.transaction(async (tx) => {
        const [role] = await tx
          .insert(roles)
          .values({ code: input.code, name: input.name })
          .returning({ id: roles.id });
        if (!role) throw new Error('role insert returned nothing');
        if (codes.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(codes.map((permissionCode) => ({ roleId: role.id, permissionCode })));
        }
        await this.audit.record(
          {
            actor,
            action: 'access.role_created',
            entityType: 'role',
            entityId: role.id,
            after: { code: input.code, name: input.name, permissions: codes },
            reason: input.reason,
          },
          tx,
        );
        return role;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException({ error: 'role_exists' });
      throw error;
    }
  }

  /** Replaces a custom role's permissions. System roles change only by migration. */
  async setRolePermissions(
    actor: Actor,
    roleId: string,
    input: { permissions: readonly PermissionCode[]; reason: string },
  ): Promise<void> {
    await assertFreshMfa(this.config, actor);
    const wanted = new Set(input.permissions);
    await this.db.transaction(async (tx) => {
      const [role] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
        .for('update');
      if (!role) throw new NotFoundException();
      if (role.isSystem) throw new ConflictException({ error: 'system_role_locked' });

      const current = await tx
        .select({ id: rolePermissions.id, code: rolePermissions.permissionCode })
        .from(rolePermissions)
        .where(and(eq(rolePermissions.roleId, roleId), isNull(rolePermissions.deletedAt)));
      const before = current.map((p) => p.code).sort();
      const removed = current.filter((p) => !wanted.has(p.code as PermissionCode));
      const added = [...wanted].filter((code) => !before.includes(code));
      if (removed.length > 0) {
        await tx
          .update(rolePermissions)
          .set({ deletedAt: new Date() })
          .where(
            inArray(
              rolePermissions.id,
              removed.map((p) => p.id),
            ),
          );
      }
      if (added.length > 0) {
        await tx
          .insert(rolePermissions)
          .values(added.map((permissionCode) => ({ roleId, permissionCode })));
      }
      await this.audit.record(
        {
          actor,
          action: 'access.role_permissions_changed',
          entityType: 'role',
          entityId: roleId,
          before: { permissions: before },
          after: { permissions: [...wanted].sort() },
          reason: input.reason,
        },
        tx,
      );
    });
  }

  // --- role assignments ---------------------------------------------------------------

  async assignRole(
    actor: Actor,
    input: z.output<typeof assignRoleSchema>,
  ): Promise<{ id: string }> {
    await assertFreshMfa(this.config, actor);
    if (actor.accountId === input.accountId) {
      throw new ForbiddenException({ error: 'cannot_assign_own_roles' });
    }
    const account = await this.accounts.find(input.accountId);
    if (!account || account.status !== 'active') {
      throw new NotFoundException({ error: 'account_not_found' });
    }
    // Roles are for people who log in with password + TOTP; a patient's OTP login is
    // not strong enough to carry them (doc 04 §6).
    if (account.kind === 'patient') throw new BadRequestException({ error: 'patient_account' });
    // A center manager is told of its center by SMS: a new grant needs a verified mobile
    // (task 4-6, owner 1405/07/12); grants made before stay.
    if (MOBILE_REQUIRED_ROLES.has(input.roleCode) && !account.mobileVerified) {
      throw new ConflictException({ error: 'account_mobile_unverified' });
    }
    return this.insertAssignment(actor, input);
  }

  async grantCenterManager(
    actor: Actor,
    input: { accountId: string; centerNodeId: string; reason: string },
  ): Promise<{ id: string }> {
    const account = await this.accounts.find(input.accountId);
    if (account?.kind !== 'center' || account.status !== 'active') {
      throw new NotFoundException({ error: 'account_not_found' });
    }
    if (!account.mobileVerified)
      throw new ConflictException({ error: 'account_mobile_unverified' });
    return this.insertAssignment(actor, {
      accountId: input.accountId,
      roleCode: 'center_manager',
      scope: { kind: 'center', nodeId: input.centerNodeId },
      reason: input.reason,
    });
  }

  /**
   * A doctor grants a role to one of their own secretaries (doc 04 §2). The scope is the
   * doctor's node, and the role may hold nothing the doctor lacks; resolve() caps the
   * secretary by the doctor again on every request, whatever the data says.
   */
  async assignSecretaryRole(
    actor: Actor,
    access: EffectiveAccess,
    secretaryNodeId: string,
    input: { roleCode: string; reason: string },
  ): Promise<{ id: string }> {
    await assertFreshMfa(this.config, actor);
    const nodes = await this.secretaryAndDoctor(secretaryNodeId);
    // Only the doctor of this very secretary; anyone else learns nothing.
    if (!nodes || nodes.doctor.accountId === null || nodes.doctor.accountId !== actor.accountId) {
      throw new NotFoundException();
    }
    const rolePermissionCodes = await this.permissionsOfRole(input.roleCode);
    if (rolePermissionCodes.some((code) => !access.permissions.has(code))) {
      throw new ForbiddenException({ error: 'role_exceeds_doctor_access' });
    }
    return this.insertAssignment(actor, {
      accountId: nodes.secretary.accountId,
      roleCode: input.roleCode,
      scope: { kind: 'doctor', nodeId: nodes.doctor.id },
      reason: input.reason,
    });
  }

  private async permissionsOfRole(roleCode: string, tx?: SqlExecutor): Promise<PermissionCode[]> {
    const rows = await ((tx as Tx | undefined) ?? this.db)
      .select({ id: roles.id, permission: rolePermissions.permissionCode })
      .from(roles)
      .leftJoin(
        rolePermissions,
        and(eq(rolePermissions.roleId, roles.id), isNull(rolePermissions.deletedAt)),
      )
      .where(and(eq(roles.code, roleCode), isNull(roles.deletedAt)));
    if (rows.length === 0) throw new NotFoundException({ error: 'role_not_found' });
    return rows.flatMap((r) => (r.permission ? [r.permission as PermissionCode] : []));
  }

  private async insertAssignment(
    actor: Actor,
    input: z.output<typeof assignRoleSchema>,
    outer?: SqlExecutor,
  ): Promise<{ id: string }> {
    return this.asSystem(async (tx) => {
      const [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.code, input.roleCode), isNull(roles.deletedAt)));
      if (!role) throw new NotFoundException({ error: 'role_not_found' });

      const scope = input.scope;
      if (OWN_ONLY_ROLES.has(input.roleCode) && scope.kind !== 'own') {
        throw new BadRequestException({ error: 'scope_not_allowed_for_role' });
      }
      let scopeNodeId: string | null = null;
      let scopeCode: string | null = null;
      if (scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') {
        const [node] = await tx
          .select({ kind: orgNodes.kind })
          .from(orgNodes)
          .where(and(eq(orgNodes.id, scope.nodeId), isNull(orgNodes.deletedAt)));
        if (node?.kind !== scope.kind)
          throw new BadRequestException({ error: 'invalid_scope_node' });
        scopeNodeId = scope.nodeId;
      } else if (scope.kind === 'city' || scope.kind === 'queue') {
        scopeCode = scope.code;
      }

      const [assignment] = await tx
        .insert(roleAssignments)
        .values({
          accountId: input.accountId,
          roleId: role.id,
          scopeKind: scope.kind,
          scopeNodeId,
          scopeCode,
          reason: input.reason,
          grantedBy: actor.accountId,
        })
        .returning({ id: roleAssignments.id });
      if (!assignment) throw new Error('role assignment insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'access.role_assigned',
          entityType: 'user_account',
          entityId: input.accountId,
          after: { assignmentId: assignment.id, role: input.roleCode, scope },
          reason: input.reason,
        },
        tx,
      );
      return assignment;
    }, outer);
  }

  async revokeAssignment(actor: Actor, assignmentId: string, reason: string, now = new Date()) {
    await assertFreshMfa(this.config, actor, now);
    await this.db.transaction(async (tx) => {
      const [assignment] = await tx
        .select({
          id: roleAssignments.id,
          accountId: roleAssignments.accountId,
          roleCode: roles.code,
          revokedAt: roleAssignments.revokedAt,
        })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(and(eq(roleAssignments.id, assignmentId), isNull(roleAssignments.deletedAt)))
        .for('update', { of: roleAssignments });
      if (!assignment) throw new NotFoundException();
      if (assignment.revokedAt) throw new ConflictException({ error: 'already_revoked' });
      await tx
        .update(roleAssignments)
        .set({ revokedAt: now, revokedBy: actor.accountId, revokeReason: reason })
        .where(eq(roleAssignments.id, assignmentId));
      await this.audit.record(
        {
          actor,
          action: 'access.role_revoked',
          entityType: 'user_account',
          entityId: assignment.accountId,
          before: { assignmentId, role: assignment.roleCode },
          reason,
        },
        tx,
      );
    });
  }

  /**
   * The roles page (owner 1405/07/24, م۱۰): a staff or center account by username, to grant,
   * revoke or offboard. A patient is never found here; roles are not for them (doc 04 §6).
   */
  async findStaffAccount(username: string) {
    const found = await this.accounts.findStaffByUsername?.(username);
    if (!found) throw new NotFoundException({ error: 'account_not_found' });
    return found;
  }

  async listAssignments(accountId: string) {
    return this.asSystem((tx) =>
      tx
        .select({
          id: roleAssignments.id,
          roleCode: roles.code,
          scopeKind: roleAssignments.scopeKind,
          scopeNodeId: roleAssignments.scopeNodeId,
          scopeCode: roleAssignments.scopeCode,
          reason: roleAssignments.reason,
          grantedBy: roleAssignments.grantedBy,
          createdAt: roleAssignments.createdAt,
        })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(
          and(
            eq(roleAssignments.accountId, accountId),
            isNull(roleAssignments.revokedAt),
            isNull(roleAssignments.deletedAt),
          ),
        )
        .orderBy(asc(roleAssignments.createdAt)),
    );
  }

  // --- internal panel network ---------------------------------------------------------

  /**
   * The VPN or office networks (R10): the server's INTERNAL_PANEL_CIDRS and the versioned
   * `access.internal_panel_ip_allowlist`; closed when neither lists one (internal-network.ts).
   */
  async isInternalPanelIpAllowed(ip: string | null): Promise<boolean> {
    const { value: policy } = await this.config.resolve('access.internal_panel_ip_allowlist');
    return internalPanelAllows({
      policy,
      serverCidrs: this.internalPanelCidrs,
      production: process.env['NODE_ENV'] === 'production',
      ip,
    });
  }
}
