import { Injectable, type OnModuleInit } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { isPermissionCode } from '@sepehr/contracts';
import { ACCESS_METADATA, type AccessRule } from './auth.decorators';

const SIMPLE_RULES = new Set<unknown>(['public', 'self-service', 'pending-mfa']);

function isValidRule(rule: unknown): rule is AccessRule {
  if (SIMPLE_RULES.has(rule)) return true;
  if (typeof rule !== 'object' || rule === null) return false;
  if ('anyPermission' in rule) {
    const codes: unknown = rule.anyPermission;
    return (
      Array.isArray(codes) &&
      codes.length > 0 &&
      codes.every((code) => typeof code === 'string' && isPermissionCode(code))
    );
  }
  if (!('permission' in rule)) return false;
  return typeof rule.permission === 'string' && isPermissionCode(rule.permission);
}

/**
 * Refuses to start the API if any endpoint lacks an explicit access marker or names an
 * unknown permission (rule 11, acceptance of task 0-5). Default deny in the guard stops
 * such an endpoint at run time; this stops it from being shipped at all.
 */
@Injectable()
export class RouteAccessAudit implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const problems = this.unmarkedRoutes();
    if (problems.length > 0) {
      throw new Error(`Endpoints without a valid access marker:\n  ${problems.join('\n  ')}`);
    }
  }

  /** `Controller.method` of every route handler without a valid marker. */
  unmarkedRoutes(): string[] {
    const problems: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) continue;
      const controller = instance.constructor as new (...args: never[]) => unknown;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const isRoute =
          Reflect.getMetadata(PATH_METADATA, handler) !== undefined &&
          Reflect.getMetadata(METHOD_METADATA, handler) !== undefined;
        if (!isRoute) continue;
        const rule = this.reflector.getAllAndOverride<unknown>(ACCESS_METADATA, [
          handler,
          controller,
        ]);
        if (!isValidRule(rule)) problems.push(`${controller.name}.${name}`);
      }
    }
    return problems.sort();
  }
}
