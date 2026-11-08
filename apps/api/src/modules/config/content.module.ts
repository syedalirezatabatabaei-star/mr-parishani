import { Global, Module } from '@nestjs/common';
import { ANNOUNCEMENTS } from '../../common/config/announcements.port';
import { ContentController, PublicContentController } from './content.controller';
import { ContentService } from './content.service';

/**
 * The portal's content (owner 1405/08/10): banners, text pages and announcements. Apart from
 * ConfigModule, which the command-line tools and the worker load without files or the bell:
 * this one is the API's only. Global for ANNOUNCEMENTS, which the bell reads.
 */
@Global()
@Module({
  controllers: [PublicContentController, ContentController],
  providers: [ContentService, { provide: ANNOUNCEMENTS, useExisting: ContentService }],
  exports: [ANNOUNCEMENTS],
})
export class ContentModule {}
