import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import { createHash } from 'node:crypto';
import { ModuleRef } from '@nestjs/core';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  CONFIG_KEYS,
  type ConfigKey,
  type ConfigLevel,
  type ConfigScope,
  type ConfigScopeRef,
  type ConfigValue,
  type KeyDefinition,
  type PermissionCode,
} from '@sepehr/contracts';
import { and, desc, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import type { ConfigGuardRegistry, ConfigValueGuard } from '../../common/config/config-guards.port';
import type { ConfigPort, ResolvedConfig } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { configKeys, configValues } from './config.schema';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';

/** Most specific first (ADR-010). */
const RESOLUTION_ORDER: readonly ConfigLevel[] = [
  'doctor',
  'center',
  'treatment_field',
  'city',
  'global',
];

/**
 * Replaces CONFIG_KEYS, for tests that need keys of their own (e.g. one settable at every
 * level). Never provided in the application.
 */
export const CONFIG_KEY_REGISTRY = Symbol('CONFIG_KEY_REGISTRY');
export type ConfigKeyRegistry = Readonly<Record<string, KeyDefinition>>;

const MANAGE_PERMISSION: Record<'business' | 'technical', PermissionCode> = {
  business: 'config.manage_business',
  technical: 'config.manage_technical',
};

/** Owner 1405/08/03 (0107): a technical setting proposed by one role and decided by another. */
const NARROW_TECHNICAL: Record<'propose' | 'decide', PermissionCode> = {
  propose: 'config.propose_technical',
  decide: 'config.approve_technical',
};

type VersionRow = typeof configValues.$inferSelect;

export interface ConfigVersionView {
  readonly id: string;
  readonly key: string;
  readonly scopeLevel: ConfigLevel;
  readonly scopeRef: string | null;
  readonly value: unknown;
  readonly effectiveAt: string | null;
  readonly status: VersionRow['status'];
  readonly reason: string;
  readonly proposedBy: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
}

const view = (row: VersionRow): ConfigVersionView => ({
  id: row.id,
  key: row.key,
  scopeLevel: row.scopeLevel,
  scopeRef: row.scopeRef,
  value: row.value,
  effectiveAt: row.effectiveAt?.toISOString() ?? null,
  status: row.status,
  reason: row.reason,
  proposedBy: row.proposedBy,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** The reference a record's scope gives for one level, or undefined if it has none. */
function refFor(level: ConfigLevel, scope: ConfigScope): string | null | undefined {
  switch (level) {
    case 'global':
      return null;
    case 'city':
      return scope.cityCode;
    case 'treatment_field':
      return scope.treatmentFieldCode;
    case 'center':
      return scope.centerNodeId;
    case 'doctor':
      return scope.doctorNodeId;
  }
}

/**
 * Versioned configuration (task 0-6, ADR-006). The only reader of config_keys and
 * config_values; every other module goes through the CONFIG port.
 */
/** ADR-052: the configuration keys whose changes are financial. */
const FINANCIAL_PREFIXES = [
  'credit.',
  'settlement.',
  'repayment.',
  'instrument.',
  'wallet.',
  'contract.',
];

/** A stable UUID for a key, as the record a proposal not yet made is about. */
function keyUuid(key: string): string {
  const h = createHash('sha256').update(`config-key:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class ConfigService implements ConfigPort, ConfigGuardRegistry, OnApplicationBootstrap {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Optional() @Inject(CONFIG_KEY_REGISTRY) registry?: ConfigKeyRegistry,
    // ADR-052: read when needed (FINANCIAL_STEP_UP itself reads configuration).
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    this.registry = registry ?? CONFIG_KEYS;
  }

  /**
   * ADR-052 (owner 1405/08/02): a change to a financial setting (plans, fees, rates, caps,
   * cheque rule, penalties, the contract) is signed by both people with their own SMS code.
   */
  private async financialStepUp(
    actor: Actor,
    key: ConfigKey,
    id: string,
    step: 'request' | 'approve',
  ): Promise<void> {
    if (!FINANCIAL_PREFIXES.some((prefix) => key.startsWith(prefix))) return;
    const stepUp = this.moduleRef?.get<FinancialStepUp>(FINANCIAL_STEP_UP, { strict: false });
    await stepUp?.assert(actor, { type: 'financial_config', id, amountRial: null, step });
  }

  private readonly registry: ConfigKeyRegistry;
  private readonly guards = new Map<
    string,
    (value: unknown) => ReturnType<ConfigValueGuard<ConfigKey>>
  >();

  /** A module's own check on the values of a key it owns (task 3-2). */
  register<K extends ConfigKey>(key: K, guard: ConfigValueGuard<K>): void {
    this.def(key);
    if (this.guards.has(key)) throw new Error(`configuration ${key} already has a guard`);
    this.guards.set(key, (value) => guard(value as ConfigValue<K>));
  }

  /** The key's guard on a value that passed its schema; null when it has none or agrees. */
  private async guard(key: string, value: unknown) {
    return (await this.guards.get(key)?.(value)) ?? null;
  }

  private def(key: string): KeyDefinition {
    const def = this.registry[key];
    if (!def) throw new Error(`unknown configuration key ${key}`);
    return def;
  }

  private get keyNames(): ConfigKey[] {
    return Object.keys(this.registry) as ConfigKey[];
  }

  /**
   * Refuses to start while config_keys and CONFIG_KEYS differ (name, category or
   * sensitivity), or while a key has no global value to fall back on.
   */
  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.db
      .select({
        code: configKeys.code,
        category: configKeys.category,
        sensitive: configKeys.sensitive,
      })
      .from(configKeys)
      .where(isNull(configKeys.deletedAt));
    const inDb = new Map(rows.map((r) => [r.code, r]));
    const problems: string[] = [];
    for (const key of this.keyNames) {
      const row = inDb.get(key);
      const def = this.def(key);
      if (!row) problems.push(`${key}: missing`);
      else if (row.category !== def.category || row.sensitive !== def.sensitive) {
        problems.push(`${key}: category or sensitivity differs`);
      }
    }
    for (const code of inDb.keys()) {
      if (!(this.keyNames as readonly string[]).includes(code)) problems.push(`${code}: unknown`);
    }
    if (problems.length === 0) {
      for (const key of this.keyNames) {
        const found = await this.latestAt(key, [{ level: 'global', ref: null }], new Date());
        if (!found.some((row) => row.value !== null)) problems.push(`${key}: no global value`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `config_keys out of sync with CONFIG_KEYS; a migration must fix: ${problems.join('; ')}`,
      );
    }
  }

  // --- reading ------------------------------------------------------------------------

  async resolve<K extends ConfigKey>(
    key: K,
    scope: ConfigScope = {},
    at: Date = new Date(),
  ): Promise<ResolvedConfig<K>> {
    const allowed = this.def(key).levels;
    const candidates = RESOLUTION_ORDER.filter((level) => allowed.includes(level)).flatMap(
      (level) => {
        const ref = refFor(level, scope);
        return ref === undefined ? [] : [{ level, ref }];
      },
    );
    const rows = await this.latestAt(key, candidates, at);
    for (const { level } of candidates) {
      const row = rows.find((r) => r.scopeLevel === level);
      // null withdraws the level: fall through to the one above.
      if (row && row.value !== null) return this.toResolved(key, row);
    }
    throw new Error(`configuration ${key} has no value at ${at.toISOString()}`);
  }

  async getVersion<K extends ConfigKey>(key: K, versionId: string): Promise<ResolvedConfig<K>> {
    const [row] = await this.db
      .select()
      .from(configValues)
      .where(
        and(
          eq(configValues.id, versionId),
          eq(configValues.key, key),
          eq(configValues.status, 'approved'),
          isNull(configValues.deletedAt),
        ),
      );
    if (!row || row.value === null)
      throw new NotFoundException({ error: 'config_version_not_found' });
    return this.toResolved(key, row);
  }

  /** Per level, the approved version in effect at `at`. */
  private async latestAt(
    key: ConfigKey,
    candidates: readonly { level: ConfigLevel; ref: string | null }[],
    at: Date,
  ): Promise<VersionRow[]> {
    if (candidates.length === 0) return [];
    const matches: SQL[] = candidates.map(({ level, ref }) =>
      ref === null
        ? sql`(${configValues.scopeLevel} = ${level} AND ${configValues.scopeRef} IS NULL)`
        : sql`(${configValues.scopeLevel} = ${level} AND ${configValues.scopeRef} = ${ref})`,
    );
    return this.db
      .selectDistinctOn([configValues.scopeLevel])
      .from(configValues)
      .where(
        and(
          eq(configValues.key, key),
          eq(configValues.status, 'approved'),
          isNull(configValues.deletedAt),
          lte(configValues.effectiveAt, at),
          or(...matches),
        ),
      )
      .orderBy(
        configValues.scopeLevel,
        desc(configValues.effectiveAt),
        desc(configValues.decidedAt),
        desc(configValues.id),
      );
  }

  private toResolved<K extends ConfigKey>(key: K, row: VersionRow): ResolvedConfig<K> {
    const value = this.def(key).schema.parse(row.value) as ConfigValue<K>;
    if (!row.effectiveAt) throw new Error(`approved configuration ${row.id} has no start`);
    return { key, value, versionId: row.id, level: row.scopeLevel, effectiveFrom: row.effectiveAt };
  }

  /** Every version of a key, newest first: proposals, decisions and history. */
  async history(key: ConfigKey): Promise<ConfigVersionView[]> {
    const rows = await this.db
      .select()
      .from(configValues)
      .where(and(eq(configValues.key, key), isNull(configValues.deletedAt)))
      .orderBy(desc(configValues.createdAt), desc(configValues.id));
    return rows.map(view);
  }

  keys() {
    return this.keyNames.map((key) => {
      const { category, sensitive, levels } = this.def(key);
      return { key, category, sensitive, levels };
    });
  }

  // --- changing -----------------------------------------------------------------------

  /**
   * Who may propose or decide a key: its category's permission; for a technical key also the
   * narrow one of that step (owner 1405/08/03, 0107): `config.propose_technical` proposes,
   * `config.approve_technical` decides. The second-person rule is unchanged.
   */
  private assertMayManage(access: EffectiveAccess, key: ConfigKey, step: 'propose' | 'decide') {
    const category = this.def(key).category;
    const narrow = category === 'technical' ? NARROW_TECHNICAL[step] : null;
    if (
      !access.permissions.has(MANAGE_PERMISSION[category]) &&
      !(narrow && access.permissions.has(narrow))
    ) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
  }

  async proposeForRecord<K extends ConfigKey>(
    actor: Actor,
    input: { key: K; scope: ConfigScopeRef; value: ConfigValue<K>; reason: string },
    executor: SqlExecutor,
  ): Promise<{ versionId: string }> {
    const def = this.def(input.key);
    if (!def.levels.includes(input.scope.level)) {
      throw new BadRequestException({ error: 'level_not_allowed', allowed: def.levels });
    }
    const parsed = def.schema.safeParse(input.value);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_value' });
    const tx = executor as Parameters<Parameters<Database['transaction']>[0]>[0];
    const [row] = await tx
      .insert(configValues)
      .values({
        key: input.key,
        scopeLevel: input.scope.level,
        scopeRef: input.scope.level === 'global' ? null : input.scope.ref,
        value: parsed.data,
        effectiveAt: null,
        reason: input.reason,
        proposedBy: actor.accountId,
      })
      .returning();
    if (!row) throw new Error('config insert returned nothing');
    await this.audit.record(
      {
        actor,
        action: 'config.proposed',
        entityType: 'config',
        entityId: input.key,
        after: { versionId: row.id, scope: input.scope, value: row.value, effectiveAt: null },
        reason: input.reason,
      },
      tx,
    );
    return { versionId: row.id };
  }

  /** Step one of a change. A sensitive key then needs a second person's approval. */
  async propose(
    actor: Actor,
    access: EffectiveAccess,
    input: {
      key: ConfigKey;
      scope: ConfigScopeRef;
      value: unknown;
      effectiveFrom?: string | undefined;
      reason: string;
    },
    now = new Date(),
  ): Promise<ConfigVersionView> {
    await assertFreshMfa(this, actor, now);
    const { key, scope } = input;
    this.assertMayManage(access, key, 'propose');
    await this.financialStepUp(actor, key, keyUuid(key), 'request');
    const def = this.def(key);
    if (!def.levels.includes(scope.level)) {
      throw new BadRequestException({ error: 'level_not_allowed', allowed: def.levels });
    }
    if (input.value === null && scope.level === 'global') {
      throw new BadRequestException({ error: 'global_value_required' });
    }
    if (input.value !== null) {
      const parsed = def.schema.safeParse(input.value);
      if (!parsed.success) {
        throw new BadRequestException({
          error: 'invalid_value',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const objection = await this.guard(key, parsed.data);
      if (objection)
        throw new BadRequestException({ error: objection.error, ...objection.details });
    }
    const effectiveAt = input.effectiveFrom === undefined ? null : new Date(input.effectiveFrom);
    if (effectiveAt !== null && effectiveAt.getTime() < now.getTime()) {
      throw new BadRequestException({ error: 'effective_date_in_past' });
    }

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(configValues)
        .values({
          key,
          scopeLevel: scope.level,
          scopeRef: scope.level === 'global' ? null : scope.ref,
          value: input.value === null ? sql`NULL` : input.value,
          effectiveAt,
          reason: input.reason,
          proposedBy: actor.accountId,
        })
        .returning();
      if (!row) throw new Error('config insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'config.proposed',
          entityType: 'config',
          entityId: key,
          after: { versionId: row.id, scope, value: row.value, effectiveAt: view(row).effectiveAt },
          reason: input.reason,
        },
        tx,
      );
      return view(row);
    });
  }

  /**
   * Approves or rejects a proposal. For a sensitive key the decider must not be the
   * proposer (the database checks it too). A proposal whose start has passed expires
   * instead: approving it now would change the past.
   *
   * TODO(decision): how recent the approver's login must be (doc 04 §6); not enforced
   * until decided.
   */
  async decide(
    actor: Actor,
    access: EffectiveAccess,
    versionId: string,
    approve: boolean,
    now = new Date(),
  ): Promise<ConfigVersionView> {
    await assertFreshMfa(this, actor, now);
    if (actor.accountId === null) throw new ForbiddenException();
    const outcome = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(configValues)
        .where(and(eq(configValues.id, versionId), isNull(configValues.deletedAt)))
        .for('update');
      if (!row) throw new NotFoundException();
      const key = row.key as ConfigKey;
      this.assertMayManage(access, key, 'decide');
      if (row.status !== 'proposed') throw new ConflictException({ error: 'already_decided' });
      if (this.def(key).sensitive && row.proposedBy === actor.accountId) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }
      if (approve) await this.financialStepUp(actor, key, versionId, 'approve');

      // The key's guard again at approval: what it checks against may have changed since
      // the proposal (task 3-2: the golden cases of the scoring rules).
      if (approve && row.value !== null) {
        const objection = await this.guard(key, this.def(key).schema.parse(row.value));
        if (objection)
          throw new ConflictException({ error: objection.error, ...objection.details });
      }

      const expired = approve && row.effectiveAt !== null && row.effectiveAt < now;
      const status = expired ? 'expired' : approve ? 'approved' : 'rejected';
      // Read before the decision is written, so it is the value being replaced.
      const before =
        status === 'approved'
          ? await this.valueAtLevel(tx, key, row.scopeLevel, row.scopeRef, now)
          : undefined;
      const [decided] = await tx
        .update(configValues)
        .set({
          status,
          decidedBy: actor.accountId,
          decidedAt: now,
          ...(status === 'approved' && row.effectiveAt === null ? { effectiveAt: now } : {}),
        })
        .where(eq(configValues.id, versionId))
        .returning();
      if (!decided) throw new Error('config decision returned nothing');

      const scope = { level: row.scopeLevel, ref: row.scopeRef };
      await this.audit.record(
        {
          actor,
          action: `config.${status}`,
          entityType: 'config',
          entityId: key,
          before: before === undefined ? undefined : { value: before },
          after: {
            versionId,
            scope,
            value: row.value,
            effectiveAt: view(decided).effectiveAt,
          },
          reason: row.reason,
        },
        tx,
      );
      return { expired, view: view(decided) };
    });
    if (outcome.expired) throw new GoneException({ error: 'effective_date_passed' });
    return outcome.view;
  }

  /** The value in effect at one level (for the audit trail's "before"), or null. */
  private async valueAtLevel(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    key: ConfigKey,
    level: ConfigLevel,
    ref: string | null,
    at: Date,
  ): Promise<unknown> {
    const [row] = await tx
      .select({ value: configValues.value })
      .from(configValues)
      .where(
        and(
          eq(configValues.key, key),
          eq(configValues.scopeLevel, level),
          ref === null ? isNull(configValues.scopeRef) : eq(configValues.scopeRef, ref),
          eq(configValues.status, 'approved'),
          isNull(configValues.deletedAt),
          lte(configValues.effectiveAt, at),
        ),
      )
      .orderBy(desc(configValues.effectiveAt), desc(configValues.decidedAt), desc(configValues.id))
      .limit(1);
    return row?.value ?? null;
  }
}
