/**
 * `pnpm contract:post-down-payments`: ADR-034's retroactive posting. Every down payment
 * approved before it (task 4-3, owner's answer پ۳: no ledger entry then) is posted once:
 * Dr bank.collection, Cr the borrower's downpayment.held, with the receipt's own key
 * (`contract:receipt:<id>`). Running it again posts nothing. On a real database only with
 * the owner's permission, like db:migrate. Prints counts only, never a name (rule 30).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { CLI_ACTOR } from '../../../common/auth/actor';
import { DownPaymentService } from '../down-payment.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const service = app.get(DownPaymentService);
    const { posted, seen } = await service.postMissing(CLI_ACTOR);
    console.log(`down payments without a posting: ${String(seen)}; posted now: ${String(posted)}`);
    const left = await service.receiptsWithoutPosting();
    console.log(`approved receipts still without a posting: ${String(left.length)}`);
    if (left.length > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('posting failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
