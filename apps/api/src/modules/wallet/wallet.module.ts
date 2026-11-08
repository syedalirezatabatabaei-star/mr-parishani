import { Global, Module } from '@nestjs/common';
import { WALLET } from '../../common/wallet/wallet.port';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * The credit purse (کیف اعتبار; task 1-2, doc 02 §3–4, ADR-018). Global: the credit,
 * service and settlement modules use the WALLET port.
 */
@Global()
@Module({
  controllers: [WalletController],
  providers: [WalletService, { provide: WALLET, useExisting: WalletService }],
  exports: [WALLET],
})
export class WalletModule {}
