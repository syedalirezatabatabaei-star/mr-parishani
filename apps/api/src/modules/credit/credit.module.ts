import { Global, Module } from '@nestjs/common';
import { CREDIT_CONTRACT_FACTS } from '../../common/credit/credit-contract-facts.port';
import { CREDIT_FUNDING_FACTS } from '../../common/credit/credit-funding-facts.port';
import { CreditContractFactsAdapter } from './credit-contract-facts.adapter';
import { CreditFundingFactsAdapter } from './credit-funding-facts.adapter';
import {
  CreditApplicationController,
  CreditGroupController,
  PatientCreditController,
} from './credit-application.controller';
import { CreditApplicationService } from './credit-application.service';
import { CreditApplicationSweeper } from './credit-application-sweeper';
import { CreditCancellationController } from './credit-cancellation.controller';
import { CreditCancellationService } from './credit-cancellation.service';
import { BORROWER_EXPOSURE } from '../../common/credit/borrower-exposure.port';
import { BorrowerExposureService } from './borrower-exposure.service';
import { CostSplitReviewService } from './cost-split-review.service';
import {
  CostSplitReviewController,
  FormationDepositController,
} from './formation-deposit.controller';
import { FormationDepositService } from './formation-deposit.service';
import { PenaltyOverrideController } from './penalty-override.controller';
import { PenaltyOverrideService } from './penalty-override.service';
import { CreditCaseStatusController, CreditDecisionController } from './credit-decision.controller';
import { CreditDecisionService } from './credit-decision.service';
import {
  CreditDocumentController,
  PatientCreditDocumentController,
} from './credit-document.controller';
import { CreditDocumentService } from './credit-document.service';
import { CreditPlanService } from './credit-plan.service';
import { CreditQueueService } from './credit-queue.service';
import {
  CreditScoringController,
  PatientCreditScoringController,
} from './credit-scoring.controller';
import { CreditScoringService } from './credit-scoring.service';
import { CreditStatusService } from './credit-status.service';
import { ScoringRulesGuard } from './scoring-rules.guard';
import { CreditPlansGuard } from './credit-plans.guard';

/**
 * Credit applications, scoring and decisions (doc 10; phase 3). Task 3-2 brings the
 * scoring rules: the engine is pure, in @sepehr/contracts; the rules are the versioned
 * configuration key `credit.scoring_ruleset` (ADR-006), and this module keeps any
 * version that breaks the golden cases from being proposed or approved. Task 3-3 brings
 * the credit plans (configuration key `credit.plans`) and their preview. Task 3-5 brings
 * the applications; the worker runs their deadlines (CreditApplicationSweeper). Task
 * 3-6 brings decisions and the committee (CreditDecisionService).
 */
@Global()
@Module({
  controllers: [
    PatientCreditController,
    CreditApplicationController,
    CreditGroupController,
    PatientCreditScoringController,
    CreditScoringController,
    PatientCreditDocumentController,
    CreditDocumentController,
    CreditDecisionController,
    CreditCaseStatusController,
    CreditCancellationController,
    PenaltyOverrideController,
    FormationDepositController,
    CostSplitReviewController,
  ],
  providers: [
    ScoringRulesGuard,
    CreditPlansGuard,
    CreditPlanService,
    CreditApplicationService,
    CreditApplicationSweeper,
    CreditScoringService,
    CreditDocumentService,
    CreditQueueService,
    CreditDecisionService,
    CreditStatusService,
    // Task 4-8: cancelling an application before funding.
    CreditCancellationService,
    // Task 4-8: a case's own penalty rate (owner پ۱۳).
    PenaltyOverrideService,
    // Owner 1405/07/29: the formation deposit's details, no ledger row.
    FormationDepositService,
    CostSplitReviewService,
    CreditContractFactsAdapter,
    // What a contract states (task 4-1), for the contract module.
    { provide: CREDIT_CONTRACT_FACTS, useExisting: CreditContractFactsAdapter },
    CreditFundingFactsAdapter,
    { provide: CREDIT_FUNDING_FACTS, useExisting: CreditFundingFactsAdapter },
    // ADR-051: the borrower's cap, at the decision here and at funding in wallet.
    BorrowerExposureService,
    { provide: BORROWER_EXPOSURE, useExisting: BorrowerExposureService },
  ],
  exports: [CREDIT_CONTRACT_FACTS, CREDIT_FUNDING_FACTS, BORROWER_EXPOSURE],
})
export class CreditModule {}
