import { Global, Module } from '@nestjs/common';
import { PERSON_DIRECTORY } from '@sepehr/contracts';
import { ASSIGNMENT_ENGINE } from '../../common/lead/assignment-engine.port';
import { LEAD_CASES } from '../../common/lead/lead-cases.port';
import { PERSON_MOBILE_CHANGE } from '../../common/lead/person-mobile-change.port';
import { AssignmentAdminService } from './assignment-admin.service';
import { AssignmentService } from './assignment.service';
import { CaseFunnelConsumer } from './case-funnel.consumer';
import { CaseService } from './case.service';
import { ClubMembershipController } from './club-membership.controller';
import { ClubMembershipService } from './club-membership.service';
import { LeadImportProcessor } from './import-processor';
import { LeadImportService } from './import.service';
import { LeadIntakeService } from './intake.service';
import { LeadCasesAdapter } from './lead-cases.adapter';
import { LeadController, LeadImportController, LeadWebhookController } from './lead.controller';
import { LEAD_CRYPTO, leadCryptoFromEnv } from './lead.crypto';
import { PersonMobileController } from './person-mobile.controller';
import { PersonMobileApprovalService } from './person-mobile-approval.service';
import { PersonMobileChangeAdapter } from './person-mobile-change.adapter';
import { PersonService } from './person.service';
import { AbandonmentReasonService } from './reason.service';
import { LeadWebhookService } from './webhook.service';
import { LeadReencryption } from './lead.reencryption';

/**
 * The lead module's core (task 2-5b, doc 05, ADR-026): persons, the one intake, automatic
 * assignment and the import processor, which the worker runs too (ADR-016). Global: it
 * provides PERSON_DIRECTORY, the task 0-4 port through which identity links a patient
 * account to its Person, and LEAD_CASES, through which booking opens a case (task 2-6).
 * Needs FIELD_ENCRYPTION_KEY and BLIND_INDEX_KEY.
 */
@Global()
@Module({
  providers: [
    LeadReencryption,
    PersonService,
    AssignmentService,
    LeadIntakeService,
    LeadImportProcessor,
    ClubMembershipService,
    { provide: PERSON_DIRECTORY, useExisting: PersonService },
    LeadCasesAdapter,
    { provide: LEAD_CASES, useExisting: LeadCasesAdapter },
    PersonMobileChangeAdapter,
    { provide: PERSON_MOBILE_CHANGE, useExisting: PersonMobileChangeAdapter },
    { provide: LEAD_CRYPTO, useFactory: leadCryptoFromEnv },
    // The engine for other modules' queues (task 3-5).
    { provide: ASSIGNMENT_ENGINE, useExisting: AssignmentService },
  ],
  exports: [
    PERSON_DIRECTORY,
    LEAD_CASES,
    PERSON_MOBILE_CHANGE,
    ASSIGNMENT_ENGINE,
    PersonService,
    AssignmentService,
    LeadIntakeService,
    ClubMembershipService,
    LEAD_CRYPTO,
  ],
})
export class LeadCoreModule {}

/**
 * The lead module as the API serves it: the panel's endpoints, the WordPress webhook
 * (Redis rate limits) and the Excel upload, on top of the core.
 */
@Module({
  imports: [LeadCoreModule],
  controllers: [
    LeadController,
    LeadImportController,
    LeadWebhookController,
    PersonMobileController,
    ClubMembershipController,
  ],
  providers: [
    CaseService,
    // The case funnel (owner 1405/07/23, question 8); the worker has its own.
    CaseFunnelConsumer,
    AbandonmentReasonService,
    AssignmentAdminService,
    LeadWebhookService,
    LeadImportService,
    // Task 9-3: pending mobiles decided (the worker has its own, for the deadline).
    PersonMobileApprovalService,
  ],
})
export class LeadModule {}
