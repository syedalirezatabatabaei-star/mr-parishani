import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  configKeyListSchema,
  configVersionViewSchema,
  resolvedConfigViewSchema,
  isConfigKey,
  proposeConfigSchema,
  resolveConfigQuerySchema,
  type ConfigKey,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { ConfigService } from './config.service';

const keyParamSchema = z.string().refine(isConfigKey, { message: 'unknown configuration key' });

/**
 * Versioned configuration from the admin panel (task 0-6). Reading needs config.read;
 * changing a key also needs the permission of its category, which the service checks
 * (config.manage_business or config.manage_technical).
 */
@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @RequirePermission('config.read')
  @Get('keys')
  @ZodResponse(configKeyListSchema)
  keys() {
    return this.config.keys();
  }

  @RequirePermission('config.read')
  @Get('keys/:key/versions')
  @ZodResponse(z.array(configVersionViewSchema))
  history(@Param('key', new ZodBody(keyParamSchema)) key: ConfigKey) {
    return this.config.history(key);
  }

  /** The value in effect for a scope at a moment (default now), and its version. */
  @RequirePermission('config.read')
  @Get('resolve')
  @ZodResponse(resolvedConfigViewSchema)
  resolve(
    @Query(new ZodBody(resolveConfigQuerySchema)) query: z.output<typeof resolveConfigQuerySchema>,
  ) {
    const { key, at, ...scope } = query;
    return this.config.resolve(key, scope, at === undefined ? undefined : new Date(at));
  }

  @RequirePermission('config.read')
  @Post('proposals')
  @ZodResponse(configVersionViewSchema)
  propose(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(proposeConfigSchema)) body: z.output<typeof proposeConfigSchema>,
  ) {
    return this.config.propose(actor, access, { ...body, key: body.key });
  }

  @RequirePermission('config.read')
  @Post('proposals/:id/approve')
  @ZodResponse(configVersionViewSchema)
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.config.decide(actor, access, id, true);
  }

  @RequirePermission('config.read')
  @Post('proposals/:id/reject')
  @ZodResponse(configVersionViewSchema)
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.config.decide(actor, access, id, false);
  }
}
