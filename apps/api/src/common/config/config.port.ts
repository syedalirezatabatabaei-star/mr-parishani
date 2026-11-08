import type {
  ConfigKey,
  ConfigLevel,
  ConfigScope,
  ConfigScopeRef,
  ConfigValue,
} from '@sepehr/contracts';
import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the config module (ADR-006, task 0-6): the only way to read configuration.
 * No module reads the config tables itself. The config module provides it under
 * {@link CONFIG}.
 */

/** The value in effect, and exactly which version it came from. */
export interface ResolvedConfig<K extends ConfigKey> {
  readonly key: K;
  readonly value: ConfigValue<K>;
  /**
   * Lock a record to this (rule 16): store it on the case or contract and read the value
   * back with getVersion(), which returns the same value forever.
   */
  readonly versionId: string;
  readonly level: ConfigLevel;
  readonly effectiveFrom: Date;
}

export interface ConfigPort {
  /**
   * The value of `key` for a record about `scope`, as in effect at `at` (default now):
   * the most specific level with a value wins, doctor → center → treatment field →
   * city → global. Values never change retroactively, so the same arguments always give
   * the same answer for a past `at`.
   */
  resolve<K extends ConfigKey>(key: K, scope?: ConfigScope, at?: Date): Promise<ResolvedConfig<K>>;
  /** The value of one version, e.g. the one a record was locked to. */
  getVersion<K extends ConfigKey>(key: K, versionId: string): Promise<ResolvedConfig<K>>;
  /**
   * Owner 1405/07/27: a value proposed as part of a record's own registration (a doctor's or
   * center's contract term), in the caller's transaction, by whoever registers it under that
   * record's permission. Never in force by itself: a holder of the key's manage permission,
   * never the proposer, approves it as any proposal (two people). Validated as `propose`.
   */
  proposeForRecord<K extends ConfigKey>(
    actor: Actor,
    input: { key: K; scope: ConfigScopeRef; value: ConfigValue<K>; reason: string },
    tx: SqlExecutor,
  ): Promise<{ versionId: string }>;
}

export const CONFIG = Symbol('CONFIG');
