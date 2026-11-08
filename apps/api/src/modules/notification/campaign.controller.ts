import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  campaignPreviewSchema,
  campaignReasonSchema,
  campaignReportSchema,
  campaignViewSchema,
  createCampaignSchema,
  scheduledSmsViewSchema,
  scheduleSmsSchema,
} from '@sepehr/contracts';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  RequireAnyPermission,
  RequirePermission,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { CampaignService } from './campaign.service';

type Reason = z.output<typeof campaignReasonSchema>;

/** Scheduled and bulk SMS (task 6-5; doc 15 §7). */
@Controller('notification')
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  @RequirePermission('notification.schedule_sms')
  @Post('scheduled-sms')
  @ZodResponse(scheduledSmsViewSchema)
  schedule(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(scheduleSmsSchema)) body: z.output<typeof scheduleSmsSchema>,
  ) {
    return this.campaigns.schedule(actor, access, body);
  }

  @RequirePermission('notification.schedule_sms')
  @Post('scheduled-sms/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(z.object({ dispatchId: z.uuid(), status: z.literal('cancelled') }))
  cancelScheduled(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(campaignReasonSchema)) body: Reason,
  ) {
    return this.campaigns.cancelScheduledSms(actor, access, id, body.reason);
  }

  @RequirePermission('notification.manage_campaigns')
  @Post('campaigns')
  @ZodResponse(campaignViewSchema)
  create(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(createCampaignSchema)) body: z.output<typeof createCampaignSchema>,
  ) {
    return this.campaigns.create(actor, access, body);
  }

  @RequireAnyPermission('notification.manage_campaigns', 'notification.approve_campaigns')
  @Get('campaigns')
  @ZodResponse(z.array(campaignViewSchema))
  list(@CurrentAccess() access: EffectiveAccess) {
    return this.campaigns.list(access);
  }

  @RequireAnyPermission('notification.manage_campaigns', 'notification.approve_campaigns')
  @Get('campaigns/:id/preview')
  @ZodResponse(campaignPreviewSchema)
  preview(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.campaigns.preview(access, id);
  }

  @RequireAnyPermission('notification.manage_campaigns', 'notification.approve_campaigns')
  @Post('campaigns/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(campaignViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.campaigns.approve(actor, access, id);
  }

  @RequirePermission('notification.manage_campaigns')
  @Post('campaigns/:id/pause')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(campaignViewSchema)
  pause(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(campaignReasonSchema)) body: Reason,
  ) {
    return this.campaigns.pause(actor, access, id, body.reason);
  }

  @RequirePermission('notification.manage_campaigns')
  @Post('campaigns/:id/resume')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(campaignViewSchema)
  resume(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(campaignReasonSchema)) body: Reason,
  ) {
    return this.campaigns.resume(actor, access, id, body.reason);
  }

  @RequirePermission('notification.manage_campaigns')
  @Post('campaigns/:id/stop')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(campaignViewSchema)
  stop(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(campaignReasonSchema)) body: Reason,
  ) {
    return this.campaigns.stop(actor, access, id, body.reason);
  }

  @RequirePermission('notification.manage_campaigns')
  @Post('campaigns/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(campaignViewSchema)
  cancel(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(campaignReasonSchema)) body: Reason,
  ) {
    return this.campaigns.cancel(actor, access, id, body.reason);
  }

  @RequireAnyPermission('notification.manage_campaigns', 'notification.approve_campaigns')
  @Get('campaigns/:id/report')
  @ZodResponse(campaignReportSchema)
  report(@CurrentAccess() access: EffectiveAccess, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.campaigns.report(access, id);
  }
}
