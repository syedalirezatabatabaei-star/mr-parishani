import type { ConfigKey, ConfigValue } from '@sepehr/contracts';

/**
 * A check a module adds to the values of one configuration key, beyond its schema
 * (task 3-2): the config module runs it when a value is proposed and again when it is
 * approved, and refuses the value if it objects. The config module knows no module's
 * rules; the owner of the key registers them (the credit module registers the golden
 * cases of the scoring rules).
 */
export type ConfigGuardObjection = {
  readonly error: string;
  readonly details: Readonly<Record<string, unknown>>;
} | null;

/**
 * May answer at once, or after reading what it needs (task 4-5, ADR-035: the plans guard
 * compares a proposal with the plans in force).
 */
export type ConfigValueGuard<K extends ConfigKey> = (
  value: ConfigValue<K>,
) => ConfigGuardObjection | Promise<ConfigGuardObjection>;

export interface ConfigGuardRegistry {
  /** One guard per key; registering a second one for the same key is a programming error. */
  register<K extends ConfigKey>(key: K, guard: ConfigValueGuard<K>): void;
}

export const CONFIG_GUARDS = Symbol('CONFIG_GUARDS');
