import { Global, Module } from '@nestjs/common';
import { DELIVERY_STATUS } from '../../common/instrument/delivery-status.port';
import { INSTRUMENT_LEGAL } from '../../common/instrument/instrument-legal.port';
import { InstrumentExecutionController, InstrumentReleaseController } from './execution.controller';
import { InstrumentExecutionService } from './execution.service';
import { INSTRUMENT_CRYPTO, instrumentCryptoFromEnv } from './instrument.crypto';
import {
  DeliveryController,
  InstrumentController,
  MyDeliveryController,
  MyInstrumentController,
} from './instrument.controller';
import { InstrumentReencryption } from './instrument.reencryption';
import { InstrumentService } from './instrument.service';

/**
 * Physical deliveries and guarantee instruments (doc 12 §3; task 4-2). Reads the credit
 * application through CREDIT_CONTRACT_FACTS. Needs FIELD_ENCRYPTION_KEY and
 * BLIND_INDEX_KEY (rule 27). The worker sends the shortage SMS (InstrumentNotifier).
 */
@Global()
@Module({
  controllers: [
    DeliveryController,
    InstrumentController,
    MyDeliveryController,
    // Task 6-9: the owner's own instruments.
    MyInstrumentController,
    // Task 6-8: executing a cheque, and releasing instruments after full settlement.
    InstrumentExecutionController,
    InstrumentReleaseController,
  ],
  providers: [
    InstrumentService,
    { provide: INSTRUMENT_CRYPTO, useFactory: instrumentCryptoFromEnv },
    // Whether a delivery is done, for completion (task 4-3).
    { provide: DELIVERY_STATUS, useExisting: InstrumentService },
    InstrumentExecutionService,
    // A legal referral decided in the collection unit (task 6-8).
    { provide: INSTRUMENT_LEGAL, useExisting: InstrumentExecutionService },
    // R4 (ADR-040): every number under the active key, its index rebuilt; by hand only.
    InstrumentReencryption,
  ],
  exports: [DELIVERY_STATUS, INSTRUMENT_LEGAL],
})
export class InstrumentModule {}
