import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  changeProfileSlugSchema,
  createProfileSchema,
  MEDIA_UPLOAD_HARD_LIMIT_BYTES,
  profileDecisionSchema,
  saveProfileDraftSchema,
  publicProfileSchema,
  publishedProfileLinkSchema,
  publicWorkplaceSchema,
  profileReviewQueueSchema,
  profileMediaDetailSchema,
  profileMediaViewSchema,
  profileSlugViewSchema,
  profileVersionViewSchema,
  profileCreatedSchema,
  profileEditorViewSchema,
} from '@sepehr/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import { CurrentAccess, Public, RequirePermission } from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { ProfileService, type UploadedMedia } from './profile.service';

/**
 * Doctors' public profiles and their media (task 2-8). The guard checks the endpoint's
 * permission; the service checks it again with the doctor's workplaces (rules 12 and 13).
 */
@Controller('catalog')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @RequirePermission('catalog.manage_doctors')
  @Post('doctors/:id/profile')
  @ZodResponse(profileCreatedSchema)
  create(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(createProfileSchema)) body: z.output<typeof createProfileSchema>,
  ) {
    return this.profiles.create(actor, access, id, body);
  }

  /** Task 8-3: every published profile's address, to link them by hand from WordPress. */
  @RequirePermission('catalog.review_profiles')
  @Get('profile-links')
  @ZodResponse(z.array(publishedProfileLinkSchema))
  links() {
    return this.profiles.publishedLinks(false);
  }

  @RequirePermission('catalog.manage_doctors')
  @Get('doctors/:id/profile')
  @ZodResponse(profileEditorViewSchema)
  get(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.profiles.get(actor, access, id);
  }

  @RequirePermission('catalog.manage_doctors')
  @Put('doctors/:id/profile/draft')
  @ZodResponse(profileVersionViewSchema)
  saveDraft(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(saveProfileDraftSchema)) body: z.output<typeof saveProfileDraftSchema>,
  ) {
    return this.profiles.saveDraft(actor, access, id, body);
  }

  @RequirePermission('catalog.manage_doctors')
  @Post('doctors/:id/profile/submit')
  @ZodResponse(profileVersionViewSchema)
  submit(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(profileDecisionSchema)) body: z.output<typeof profileDecisionSchema>,
  ) {
    return this.profiles.submit(actor, access, id, body.reason);
  }

  @RequirePermission('catalog.review_profiles')
  @Put('doctors/:id/profile/slug')
  @ZodResponse(profileSlugViewSchema)
  changeSlug(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(changeProfileSlugSchema)) body: z.output<typeof changeProfileSlugSchema>,
  ) {
    return this.profiles.changeSlug(actor, access, id, body);
  }

  @RequirePermission('catalog.review_profiles')
  @Get('profile-reviews')
  @ZodResponse(profileReviewQueueSchema)
  reviewQueue(@CurrentAccess() access: EffectiveAccess) {
    return this.profiles.reviewQueue(access);
  }

  @RequirePermission('catalog.review_profiles')
  @Post('profile-versions/:id/approve')
  @ZodResponse(profileVersionViewSchema)
  approve(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(profileDecisionSchema)) body: z.output<typeof profileDecisionSchema>,
  ) {
    return this.profiles.decide(actor, access, id, 'approve', body.reason);
  }

  @RequirePermission('catalog.review_profiles')
  @Post('profile-versions/:id/reject')
  @ZodResponse(profileVersionViewSchema)
  reject(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(profileDecisionSchema)) body: z.output<typeof profileDecisionSchema>,
  ) {
    return this.profiles.decide(actor, access, id, 'reject', body.reason);
  }

  /** A photo or (self-hosted) video, kept private until a published version shows it. */
  @RequirePermission('catalog.manage_doctors')
  @Post('doctors/:id/media')
  @ZodResponse(profileMediaViewSchema)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MEDIA_UPLOAD_HARD_LIMIT_BYTES, files: 1 } }),
  )
  upload(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: UploadedMedia | undefined,
  ) {
    return this.profiles.upload(actor, access, id, file);
  }

  @RequirePermission('catalog.manage_doctors')
  @Get('media/:id')
  @ZodResponse(profileMediaDetailSchema)
  media(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.profiles.media(actor, access, id);
  }
}

/**
 * The public profile's data (doc 08 §10); the page itself, rendered on the server with
 * `noindex` rules and structured data, is task 2-11. Published versions only: anything
 * else is 404 (doc 08 §15 test 10); an old address answers 301 to the current one.
 */
@Controller('public/doctors')
export class PublicProfileController {
  constructor(private readonly profiles: ProfileService) {}

  /** Task 8-3: the indexable profiles' addresses, for the site's sitemap. */
  @Public()
  @Get()
  @ZodResponse(z.array(publishedProfileLinkSchema))
  index() {
    return this.profiles.publishedLinks(true);
  }

  @Public()
  @Get(':slug')
  @ZodResponse(publicProfileSchema)
  async profile(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const found = await this.profiles.publicProfile(slug.toLowerCase());
    if (!found) throw new NotFoundException({ error: 'profile_not_found' });
    if ('redirect' in found) {
      // The same path with the current slug in place of the old one.
      const path = req.originalUrl.split('?')[0] ?? '';
      res.redirect(301, `${path.slice(0, path.lastIndexOf('/') + 1)}${found.redirect}`);
      return undefined;
    }
    return found.profile;
  }
}

/**
 * One workplace for the public booking page (task 2-11): what search already shows of it,
 * with all its priced services; not found unless it takes new appointments.
 */
@Controller('public/workplaces')
export class PublicWorkplaceController {
  constructor(private readonly profiles: ProfileService) {}

  @Public()
  @Get(':id')
  @ZodResponse(publicWorkplaceSchema)
  async workplace(@Param('id', new ParseUUIDPipe()) id: string) {
    const found = await this.profiles.publicWorkplace(id);
    if (!found) throw new NotFoundException({ error: 'workplace_not_found' });
    return found;
  }
}
