import { Global, Module } from '@nestjs/common';
import { CENTER_DIRECTORY } from '../../common/catalog/center-directory.port';
import { TARIFF_BOOK } from '../../common/catalog/tariff-book.port';
import { WORKPLACE_DIRECTORY } from '../../common/catalog/workplace-directory.port';
import { BulkImportController, ProposedTariffController } from './bulk-import.controller';
import { BulkImportService } from './bulk-import.service';
import { BulkImportWorker } from './bulk-import-worker';
import { CATALOG_CRYPTO, catalogCryptoFromEnv } from './catalog.crypto';
import { CatalogItemService } from './catalog-item.service';
import { CenterController } from './center.controller';
import { CenterService } from './center.service';
import { DoctorController } from './doctor.controller';
import { DoctorService } from './doctor.service';
import { MediaWorker } from './media-worker';
import {
  ProfileController,
  PublicProfileController,
  PublicWorkplaceController,
} from './profile.controller';
import { ProfileService } from './profile.service';
import { SearchController } from './search.controller';
import { SearchIndex } from './search-index';
import { SearchService } from './search.service';
import { CatalogItemController, TariffController } from './tariff.controller';
import { TariffService } from './tariff.service';
import { ffmpegTranscoderFromEnv, VIDEO_TRANSCODER } from './video-transcoder';
import { VisitTariffProposalController } from './visit-tariff-proposal.controller';
import { VisitTariffProposalService } from './visit-tariff-proposal.service';
import { WorkplaceDirectoryService } from './workplace-directory.service';
import { CatalogReencryption } from './catalog.reencryption';
import { PartnershipController, PublicPartnershipController } from './partnership.controller';
import { PartnershipService } from './partnership.service';

/**
 * Centers and branches (task 2-2, doc 08 §2–3, ADR-022), doctors with their secretaries
 * (task 2-3, ADR-023), and treatment fields, services and tariffs (task 2-4, ADR-024), on
 * the access module's org_nodes tree through ORG_TREE. Global: booking (task 2-6) asks
 * CENTER_DIRECTORY whether a center takes new appointments and TARIFF_BOOK for prices;
 * booking (task 2-5) reads doctors' workplaces through WORKPLACE_DIRECTORY.
 * The public search of doctors and centers (task 2-7, ADR-028) reads its own index,
 * search_entries, and booking's BOOKABLE_SLOTS; the worker keeps the index current
 * (SearchIndexConsumer and the refresher), and `pnpm catalog:rebuild-search` rebuilds it.
 * Doctors' public profiles and their media (task 2-8, ADR-029) use OBJECT_STORAGE and
 * MALWARE_SCANNER; the worker runs MediaWorker. The bulk import of centers and doctors (task
 * 2-9, ADR-030) runs in the worker too (BulkImportWorker), through booking's
 * WORKPLACE_CALENDAR for schedules.
 * Needs FIELD_ENCRYPTION_KEY and BLIND_INDEX_KEY.
 */
@Global()
@Module({
  controllers: [
    CenterController,
    DoctorController,
    CatalogItemController,
    TariffController,
    SearchController,
    ProfileController,
    PublicProfileController,
    PublicWorkplaceController,
    BulkImportController,
    ProposedTariffController,
    VisitTariffProposalController,
    // Owner 1405/08/10: a center's or a doctor's request to join, and its two-person queue.
    PublicPartnershipController,
    PartnershipController,
  ],
  providers: [
    CatalogReencryption,
    CenterService,
    DoctorService,
    CatalogItemService,
    TariffService,
    // Owner 1405/07/29: a visit's price from the internal panel, by two people.
    VisitTariffProposalService,
    PartnershipService,
    WorkplaceDirectoryService,
    SearchService,
    SearchIndex,
    ProfileService,
    MediaWorker,
    BulkImportService,
    BulkImportWorker,
    { provide: VIDEO_TRANSCODER, useFactory: ffmpegTranscoderFromEnv },
    { provide: CENTER_DIRECTORY, useExisting: CenterService },
    { provide: TARIFF_BOOK, useExisting: TariffService },
    { provide: WORKPLACE_DIRECTORY, useExisting: WorkplaceDirectoryService },
    { provide: CATALOG_CRYPTO, useFactory: catalogCryptoFromEnv },
  ],
  exports: [CENTER_DIRECTORY, TARIFF_BOOK, WORKPLACE_DIRECTORY],
})
export class CatalogModule {}
