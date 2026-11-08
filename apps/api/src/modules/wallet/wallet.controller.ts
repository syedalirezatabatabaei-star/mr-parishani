import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { purseViewSchema } from '@sepehr/contracts';
import { RequirePermission } from '../../common/auth/auth.decorators';
import { ZodResponse } from '../../common/zod-response';
import { WalletService } from './wallet.service';

/**
 * Reading credit purses (کیف اعتبار; task 1-2): accounting and the auditor. Nothing writes
 * through the API: the credit, service and settlement modules use the WALLET port.
 * Amounts leave as strings of rials.
 */
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @RequirePermission('wallet.read')
  @Get('purses/:id')
  @ZodResponse(purseViewSchema)
  async purse(@Param('id', new ParseUUIDPipe()) id: string) {
    const p = await this.wallet.summary(id);
    return {
      id: p.id,
      caseId: p.caseId,
      status: p.status,
      approvedAmountRial: p.approvedAmountRial.toString(),
      fundedAt: p.fundedAt?.toISOString() ?? null,
      scope: p.scope,
      balances: {
        approvedRial: p.balances.approvedRial.toString(),
        availableRial: p.balances.availableRial.toString(),
        reservedRial: p.balances.reservedRial.toString(),
        consumedPendingRial: p.balances.consumedPendingRial.toString(),
        borrowerDebtRial: p.balances.borrowerDebtRial.toString(),
      },
      reservations: p.reservations.map((r) => ({
        authorizationId: r.authorizationId,
        doctorNodeId: r.doctorNodeId,
        reservedRial: r.reservedRial.toString(),
        openRial: r.openRial.toString(),
        pendingRial: r.pendingRial.toString(),
        finalizedRial: r.finalizedRial.toString(),
        held: r.held,
      })),
    };
  }
}
