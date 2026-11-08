import { Module } from '@nestjs/common';
import { BankStatementController } from './bank-statement.controller';
import { BankStatementService } from './bank-statement.service';
import { ReceiptUploadController } from './receipt-upload.controller';
import { ReceiptUploadService } from './receipt-upload.service';
import { InstallmentTicketLink, PaymentTicketLink } from './ticket-link';

/**
 * The borrower's slip upload (task 6-2) and bank statements (task 6-3): the API only (the
 * worker has no uploads), apart
 * from RepaymentModule so the worker need not know the payment provider.
 */
@Module({
  controllers: [ReceiptUploadController, BankStatementController],
  // A ticket's links to an installment and a payment (task 7-1), read only.
  providers: [ReceiptUploadService, BankStatementService, InstallmentTicketLink, PaymentTicketLink],
})
export class ReceiptUploadModule {}
