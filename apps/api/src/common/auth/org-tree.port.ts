import type { Actor, SqlExecutor } from '../audit/audit.port';
import type { EffectiveAccess } from './access.port';

/**
 * Port to the center tree of the access module (tasks 2-2 and 2-3): the catalog module
 * places its centers, branches, doctors and secretaries on org_nodes through it, in its
 * own transaction, and never touches the table. The access module provides it under
 * {@link ORG_TREE}.
 */
export interface OrgTreeNode {
  readonly id: string;
  readonly kind: 'center' | 'branch' | 'doctor' | 'secretary';
  readonly parentId: string | null;
  readonly name: string;
  readonly cityCode: string;
  /** ltree path: what a center, branch or doctor scope covers is this and all below it. */
  readonly path: string;
}

export interface NewTreeNode {
  readonly kind: 'center' | 'branch' | 'doctor' | 'secretary';
  /** Null for a root (a center or a private practice's doctor); else the parent node. */
  readonly parentId: string | null;
  readonly name: string;
  /** Required for a root; a child takes its parent's city. */
  readonly cityCode: string | null;
  /** The center-kind account operating a doctor or secretary node; a secretary needs one. */
  readonly accountId?: string | null;
  readonly reason: string;
}

export interface OrgTreePort {
  /** Checks the caller's scope like the access API does (404 for a parent out of scope). */
  createNode(
    actor: Actor,
    access: EffectiveAccess,
    node: NewTreeNode,
    tx: SqlExecutor,
  ): Promise<OrgTreeNode>;
  /** Renames a node the caller's scope covers; audited. Nothing else about a node changes. */
  renameNode(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    name: string,
    reason: string,
    tx: SqlExecutor,
  ): Promise<void>;
  /**
   * Retires nodes nobody works on (task 2-9: undoing an import): each one in the caller's
   * scope, with no live role assignment and no live child outside `ids`; a soft delete,
   * audited. 409 otherwise.
   */
  retireNodes(
    actor: Actor,
    access: EffectiveAccess,
    ids: readonly string[],
    reason: string,
    tx: SqlExecutor,
  ): Promise<void>;
  /**
   * A doctor's account at one workplace (task 2-3): sets it on a doctor node that had none
   * and grants the `doctor` role scoped to that node. The caller has checked who may.
   */
  attachDoctorAccount(
    actor: Actor,
    doctorNodeId: string,
    accountId: string,
    reason: string,
    tx: SqlExecutor,
  ): Promise<void>;
  /**
   * The role of a secretary whose doctor has no account (task 2-3 decision): granted by
   * someone whose scope covers the doctor's node, and never more than the `doctor` role
   * nor than the granter holds. A doctor with an account decides alone (access API).
   */
  assignSecretaryRoleForDoctor(
    actor: Actor,
    access: EffectiveAccess,
    secretaryNodeId: string,
    input: { roleCode: string; reason: string },
    tx: SqlExecutor,
  ): Promise<{ id: string }>;
}

export const ORG_TREE = Symbol('ORG_TREE');
