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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  announcementProposalSchema,
  announcementViewSchema,
  BANNER_AUDIENCES,
  bannerProposalFieldsSchema,
  bannerProposalSchema,
  bannerViewSchema,
  CONTENT_SLUGS,
  type ContentSlug,
  contentDecisionSchema,
  deskBannerListSchema,
  pageProposalSchema,
  pageViewSchema,
  publicPageSchema,
} from '@sepehr/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CurrentActor } from '../../common/auth/actor';
import {
  CurrentAccess,
  Public,
  RequireAnyPermission,
  RequirePermission,
} from '../../common/auth/auth.decorators';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { BANNER_IMAGE_MAX_BYTES, ContentService } from './content.service';

const slugSchema = z.enum(CONTENT_SLUGS);
const audienceQuery = z.object({ audience: z.enum(BANNER_AUDIENCES) });
type Decision = z.output<typeof contentDecisionSchema>;

/** What anyone may read (owner 1405/08/10): the desk's banners and the text pages in force. */
@Controller('config')
export class PublicContentController {
  constructor(private readonly content: ContentService) {}

  @Public()
  @Get('banners')
  @ZodResponse(deskBannerListSchema)
  banners(@Query(new ZodBody(audienceQuery)) query: z.output<typeof audienceQuery>) {
    return this.content.deskBanners(query.audience);
  }

  /** An approved banner's picture: bytes, cached a day by the browser. */
  @Public()
  @Get('banners/:id/image')
  async bannerImage(@Param('id', new ParseUUIDPipe()) id: string, @Res() res: Response) {
    const image = await this.content.bannerImage(id, null);
    res
      .set({
        'content-type': image.contentType,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      })
      .send(image.body);
  }

  @Public()
  @Get('pages/:slug')
  @ZodResponse(publicPageSchema)
  page(@Param('slug', new ZodBody(slugSchema)) slug: string) {
    // Checked by the pipe; typed `string` so both builds document the path alike.
    return this.content.publicPage(slug as ContentSlug);
  }
}

/** The internal panel's «مدیریت محتوای پیشخوان»: proposals and the second person's decision. */
@Controller('config/content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  // --- banners ---

  @RequireAnyPermission('config.propose_content', 'config.approve_content')
  @Get('banners')
  @ZodResponse(z.array(bannerViewSchema))
  banners(@CurrentAccess() access: EffectiveAccess) {
    return this.content.banners(access);
  }

  /** A version: the proposal as JSON in `proposal`, its picture (optional) in `image`. */
  @RequirePermission('config.propose_content')
  @Post('banners')
  @ZodResponse(bannerViewSchema)
  @UseInterceptors(
    FileInterceptor('image', { limits: { fileSize: BANNER_IMAGE_MAX_BYTES, files: 1 } }),
  )
  proposeBanner(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(bannerProposalFieldsSchema))
    body: z.output<typeof bannerProposalFieldsSchema>,
    @UploadedFile() image: { buffer: Buffer } | undefined,
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.proposal);
    } catch {
      parsed = null;
    }
    const proposal = new ZodBody(bannerProposalSchema).transform(parsed);
    return this.content.proposeBanner(actor, access, proposal, image?.buffer ?? null);
  }

  @RequirePermission('config.approve_content')
  @Post('banners/:id/decision')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(bannerViewSchema)
  decideBanner(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(contentDecisionSchema)) body: Decision,
  ) {
    return this.content.decideBanner(actor, access, id, body.approve, body.reason);
  }

  /** Any version's picture, for who manages the content (a pending one included). */
  @RequireAnyPermission('config.propose_content', 'config.approve_content')
  @Get('banners/:id/image')
  async bannerImage(
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ) {
    const image = await this.content.bannerImage(id, access);
    res
      .set({
        'content-type': image.contentType,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      })
      .send(image.body);
  }

  // --- pages ---

  @RequireAnyPermission('config.propose_content', 'config.approve_content')
  @Get('pages')
  @ZodResponse(z.array(pageViewSchema))
  pages(@CurrentAccess() access: EffectiveAccess) {
    return this.content.pages(access);
  }

  @RequirePermission('config.propose_content')
  @Post('pages/:slug')
  @ZodResponse(pageViewSchema)
  proposePage(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('slug', new ZodBody(slugSchema)) slug: string,
    @Body(new ZodBody(pageProposalSchema)) body: z.output<typeof pageProposalSchema>,
  ) {
    return this.content.proposePage(actor, access, slug as ContentSlug, body);
  }

  @RequirePermission('config.approve_content')
  @Post('pages/versions/:id/decision')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(pageViewSchema)
  decidePage(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(contentDecisionSchema)) body: Decision,
  ) {
    return this.content.decidePage(actor, access, id, body.approve, body.reason);
  }

  // --- announcements ---

  @RequireAnyPermission('config.propose_content', 'config.approve_content')
  @Get('announcements')
  @ZodResponse(z.array(announcementViewSchema))
  announcements(@CurrentAccess() access: EffectiveAccess) {
    return this.content.announcements(access);
  }

  @RequirePermission('config.propose_content')
  @Post('announcements')
  @ZodResponse(announcementViewSchema)
  proposeAnnouncement(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Body(new ZodBody(announcementProposalSchema))
    body: z.output<typeof announcementProposalSchema>,
  ) {
    return this.content.proposeAnnouncement(actor, access, body);
  }

  @RequirePermission('config.approve_content')
  @Post('announcements/:id/decision')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(announcementViewSchema)
  decideAnnouncement(
    @CurrentActor() actor: Actor,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(contentDecisionSchema)) body: Decision,
  ) {
    return this.content.decideAnnouncement(actor, access, id, body.approve, body.reason);
  }
}
