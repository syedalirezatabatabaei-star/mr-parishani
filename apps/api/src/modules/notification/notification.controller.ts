import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  createSmsTemplateSchema,
  smsConsentSchema,
  smsDispatchQuerySchema,
  smsDispatchViewSchema,
  smsTemplateViewSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { NotificationService } from './notification.service';

/** SMS templates, what was sent, and consent to promotional SMS (task 6-4). */
@Controller('notification')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @RequirePermission('notification.manage_templates')
  @Get('sms-templates')
  @ZodResponse(z.array(smsTemplateViewSchema))
  templates(@CurrentAccess() access: EffectiveAccess) {
    return this.notifications.templates(access);
  }

  @RequirePermission('notification.manage_templates')
  @Post('sms-templates')
  @ZodResponse(smsTemplateViewSchema)
  saveTemplate(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createSmsTemplateSchema)) body: z.output<typeof createSmsTemplateSchema>,
  ) {
    return this.notifications.saveTemplate(actor, access, body);
  }

  @RequirePermission('notification.read_dispatches')
  @Get('sms-dispatches')
  @ZodResponse(z.array(smsDispatchViewSchema))
  dispatches(
    @CurrentAccess() access: EffectiveAccess,
    @Query(new ZodBody(smsDispatchQuerySchema)) query: z.output<typeof smsDispatchQuerySchema>,
  ) {
    return this.notifications.dispatches(access, query);
  }

  @RequirePermission('notification.manage_consent')
  @Post('sms-consents')
  @ZodResponse(z.object({ mobileMasked: z.string(), consent: z.enum(['consent', 'withdraw']) }))
  consent(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(smsConsentSchema)) body: z.output<typeof smsConsentSchema>,
  ) {
    return this.notifications.setConsent(actor, access, body);
  }
}
