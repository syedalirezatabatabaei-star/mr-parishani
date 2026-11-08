import { Global, Module } from '@nestjs/common';
import { PROFORMA_DIRECTORY } from '../../common/proforma/proforma-directory.port';
import { ProformaDirectoryService } from './proforma-directory.service';
import { PatientProformaController, ProformaController } from './proforma.controller';
import { ProformaService } from './proforma.service';
import { ProformaTicketLink } from './ticket-link';

/**
 * Proformas (doc 10 §2; task 3-4). Reads the referral (booking), the workplace and its
 * tariffs (catalog), the patient's account (identity) and persons (lead) through their
 * ports only. The worker expires overdue ones (ProformaService.expireOverdue). Others
 * read a proforma through PROFORMA_DIRECTORY (the credit application, task 3-5).
 */
@Global()
@Module({
  controllers: [ProformaController, PatientProformaController],
  providers: [
    ProformaService,
    ProformaDirectoryService,
    { provide: PROFORMA_DIRECTORY, useExisting: ProformaDirectoryService },
    // A ticket's link to a proforma (task 7-1), read only.
    ProformaTicketLink,
  ],
  exports: [PROFORMA_DIRECTORY],
})
export class ProformaModule {}
