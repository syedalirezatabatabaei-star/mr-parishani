import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { eventEnvelopeSchema, OUTBOX_QUEUE, SMS_QUEUE } from '@sepehr/contracts';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { DATABASE, type Database } from '../../db/database.module';
import { requiredEnv } from '../env';
import { PartitionMaintenance } from '../ops/partition-maintenance';
import { AppointmentSweeper } from '../../modules/booking/appointment-sweeper';
import { BulkImportWorker } from '../../modules/catalog/bulk-import-worker';
import { MediaWorker } from '../../modules/catalog/media-worker';
import { SearchIndex } from '../../modules/catalog/search-index';
import { HolidayCoverageCheck } from '../../modules/config/holiday-coverage';
import { ProviderContractCheck } from '../../modules/config/provider-contract-check';
import { LedgerReconciliation } from '../../modules/ledger/reconciliation';
import { CreditApplicationSweeper } from '../../modules/credit/credit-application-sweeper';
import { PersonMobileApprovalService } from '../../modules/lead/person-mobile-approval.service';
import { ProformaService } from '../../modules/proforma/proforma.service';
import { AccountMobileCheck } from '../../modules/access/account-mobile-check';
import { DownPaymentReconciliation } from '../../modules/contract/down-payment-reconciliation';
import { SettlementReconciliation } from '../../modules/settlement/settlement-reconciliation';
import { SETTLEMENT_ACTOR, SettlementService } from '../../modules/settlement/settlement.service';
import { CLI_ACTOR } from '../../common/auth/actor';
import { CollectionService } from '../../modules/collection/collection.service';
import { TicketService } from '../../modules/ticket/ticket.service';
import { AuditChainCheck } from '../../modules/audit/audit-chain-check';
import { ReportService } from '../../modules/reporting/report.service';
import { StatementService } from '../../modules/settlement/statement.service';
import { CampaignService } from '../../modules/notification/campaign.service';
import { NotificationService } from '../../modules/notification/notification.service';
import { RepaymentService } from '../../modules/repayment/repayment.service';
import { ServiceAuthorizationService } from '../../modules/service/service-authorization.service';
import { QueueMonitor } from '../ops/queue-monitor';
import { EventDispatcher } from './event-dispatcher';
import { relayOnce, type RelayFaults } from './outbox-relay';

/** Scheduled jobs of the worker (BullMQ job schedulers: one run per tick, cluster-wide). */
export const MAINTENANCE_QUEUE = 'maintenance';
export const PARTITION_MAINTENANCE_JOB = 'partition-maintenance';
export const QUEUE_MONITOR_JOB = 'queue-monitor';
export const LEDGER_RECONCILIATION_JOB = 'ledger-reconciliation';
export const HOLIDAY_COVERAGE_JOB = 'holiday-coverage';
export const BOOKING_SWEEP_JOB = 'booking-sweep';
export const SEARCH_REFRESH_JOB = 'search-refresh';
export const MEDIA_PROCESS_JOB = 'media-process';
export const CATALOG_IMPORT_JOB = 'catalog-import';
export const PROFORMA_EXPIRY_JOB = 'proforma-expiry';
export const CREDIT_SWEEP_JOB = 'credit-sweep';
export const SERVICE_SWEEP_JOB = 'service-sweep';
export const ACCOUNT_MOBILE_CHECK_JOB = 'account-mobile-check';
/** ADR-046: doctors' and centers' contract terms ending or ended; daily. */
export const PROVIDER_CONTRACT_CHECK_JOB = 'provider-contract-check';
export const DOWN_PAYMENT_RECONCILIATION_JOB = 'down-payment-reconciliation';
export const SETTLEMENT_DUE_JOB = 'settlement-due';
export const SETTLEMENT_RECONCILIATION_JOB = 'settlement-reconciliation';
export const SETTLEMENT_STATEMENTS_JOB = 'settlement-statements';
export const SMS_RELEASE_JOB = 'sms-release';
export const REPAYMENT_CYCLE_JOB = 'repayment-cycle';
export const REPAYMENT_REMINDERS_JOB = 'repayment-reminders';
export const COLLECTION_CYCLE_JOB = 'collection-cycle';
export const SMS_DELIVERY_JOB = 'sms-delivery';
export const SMS_CAMPAIGN_JOB = 'sms-campaign';
/** Tickets (task 7-1): assignment, deadline alerts, closing after the reopening window. */
export const TICKET_SWEEP_JOB = 'ticket-sweep';
/** Exports above the threshold, and every PDF (task 7-3). */
export const REPORT_EXPORT_JOB = 'report-export';
/** The reports' materialized views (task 7-4; 7.6: every fifteen minutes). */
export const REPORT_REFRESH_JOB = 'report-refresh';
/** The audit trail's hash chain checked (task 9-3, R6): nightly. */
export const AUDIT_CHAIN_JOB = 'audit-chain';
/** Pending mobiles past their deadline refused (task 9-3, م۵): every 15 minutes. */
export const PERSON_MOBILE_EXPIRY_JOB = 'person-mobile-expiry';

const RELAY_INTERVAL_MS = 1_000;
const RELAY_BATCH = 100;

export interface WorkerRuntimeOptions {
  /** Test hooks that simulate crashes; never set in the application. */
  readonly relayFaults?: RelayFaults;
  readonly afterDispatch?: (job: Job) => void;
  /** Whether to run the relay loop (tests drive relayOnce() themselves). Default true. */
  readonly relayLoop?: boolean;
}

export const WORKER_RUNTIME_OPTIONS = Symbol('WORKER_RUNTIME_OPTIONS');

/**
 * Everything the worker process runs besides SMS delivery (task 0-7):
 *
 * - the outbox relay, every second and at once again while batches are full;
 * - the outbox consumer, which hands each event to the dispatcher;
 * - scheduled jobs: partition maintenance daily at 03:00 UTC, the queue monitor every
 *   minute, the ledger reconciliation nightly at 02:00 Tehran time (task 1-4), and the
 *   holiday-calendar check daily at 09:00 Tehran time (task 2-1), and the appointment
 *   scheduler every minute (task 2-6), and the search index refresher every 15 seconds
 *   (task 2-7), the profile media job every 10 seconds (task 2-8), and the import of centers
 *   and doctors every 10 seconds (task 2-9), and expiring proformas every 15 minutes (task 3-4). Job schedulers run
 *   each tick once however many workers there are.
 */
@Injectable()
export class WorkerRuntime implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRuntime.name);
  private readonly connection: ConnectionOptions;
  readonly outboxQueue: Queue;
  readonly maintenanceQueue: Queue;
  /** Watched only; the SMS worker of apps/worker consumes it. */
  readonly smsQueue: Queue;
  private workers: Worker[] = [];
  private relayTimer: NodeJS.Timeout | null = null;
  private relaying: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly dispatcher: EventDispatcher,
    private readonly maintenance: PartitionMaintenance,
    private readonly monitor: QueueMonitor,
    private readonly reconciliation: LedgerReconciliation,
    private readonly holidayCoverage: HolidayCoverageCheck,
    private readonly bookingSweeper: AppointmentSweeper,
    private readonly searchIndex: SearchIndex,
    private readonly mediaWorker: MediaWorker,
    private readonly importWorker: BulkImportWorker,
    private readonly proformas: ProformaService,
    private readonly creditSweeper: CreditApplicationSweeper,
    private readonly services: ServiceAuthorizationService,
    private readonly accountMobiles: AccountMobileCheck,
    private readonly downPayments: DownPaymentReconciliation,
    private readonly settlement: SettlementService,
    private readonly settlementReconciliation: SettlementReconciliation,
    private readonly statements: StatementService,
    private readonly notifications: NotificationService,
    private readonly campaigns: CampaignService,
    private readonly repayment: RepaymentService,
    private readonly collection: CollectionService,
    private readonly tickets: TicketService,
    private readonly reports: ReportService,
    private readonly auditChain: AuditChainCheck,
    private readonly mobileApprovals: PersonMobileApprovalService,
    private readonly providerContracts: ProviderContractCheck,
    @Inject(WORKER_RUNTIME_OPTIONS) private readonly options: WorkerRuntimeOptions,
  ) {
    // Fail fast while Redis is away: the relay leaves the rows in place and retries.
    this.connection = {
      url: requiredEnv('REDIS_URL'),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    };
    this.outboxQueue = new Queue(OUTBOX_QUEUE, { connection: this.connection });
    this.maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: this.connection });
    this.smsQueue = new Queue(SMS_QUEUE, { connection: this.connection });
  }

  get watchedQueues(): Queue[] {
    return [this.outboxQueue, this.smsQueue, this.maintenanceQueue];
  }

  async start(): Promise<void> {
    const consumerConnection = { url: requiredEnv('REDIS_URL') } as ConnectionOptions;
    this.workers.push(
      new Worker(
        OUTBOX_QUEUE,
        async (job: Job) => {
          const parsed = eventEnvelopeSchema.safeParse(job.data);
          if (!parsed.success) throw new UnrecoverableError('malformed event envelope');
          const applied = await this.dispatcher.dispatch(parsed.data);
          this.options.afterDispatch?.(job);
          return applied;
        },
        { connection: consumerConnection, concurrency: 10 },
      ),
      new Worker(
        MAINTENANCE_QUEUE,
        async (job: Job) => {
          if (job.name === PARTITION_MAINTENANCE_JOB) return this.maintenance.run();
          if (job.name === QUEUE_MONITOR_JOB) {
            const snapshot = await this.monitor.check(this.watchedQueues);
            return { alerts: snapshot.alerts.map((a) => a.code) };
          }
          if (job.name === LEDGER_RECONCILIATION_JOB) {
            const result = await this.reconciliation.run();
            return { runId: result.runId, clean: result.clean };
          }
          if (job.name === HOLIDAY_COVERAGE_JOB) return this.holidayCoverage.run();
          if (job.name === BOOKING_SWEEP_JOB) return this.bookingSweeper.run();
          if (job.name === SEARCH_REFRESH_JOB) return this.searchIndex.refreshDue();
          if (job.name === MEDIA_PROCESS_JOB) return this.mediaWorker.run();
          if (job.name === CATALOG_IMPORT_JOB) return this.importWorker.run();
          if (job.name === PROFORMA_EXPIRY_JOB) return this.proformas.expireOverdue();
          if (job.name === CREDIT_SWEEP_JOB) return this.creditSweeper.run();
          if (job.name === ACCOUNT_MOBILE_CHECK_JOB) return this.accountMobiles.run();
          if (job.name === PROVIDER_CONTRACT_CHECK_JOB) return this.providerContracts.run();
          if (job.name === SETTLEMENT_DUE_JOB) return this.settlement.markDue();
          if (job.name === REPAYMENT_CYCLE_JOB) return this.repayment.runCycle();
          if (job.name === REPAYMENT_REMINDERS_JOB) return this.repayment.runReminders();
          if (job.name === COLLECTION_CYCLE_JOB) return this.collection.runCycle(CLI_ACTOR);
          if (job.name === SMS_RELEASE_JOB) return this.notifications.release();
          if (job.name === SMS_DELIVERY_JOB) return this.notifications.pollDelivery();
          if (job.name === SMS_CAMPAIGN_JOB) return this.campaigns.run();
          if (job.name === TICKET_SWEEP_JOB) return this.tickets.sweep(CLI_ACTOR);
          if (job.name === REPORT_EXPORT_JOB) return this.reports.processQueued();
          if (job.name === REPORT_REFRESH_JOB) return this.reports.refreshViews();
          if (job.name === AUDIT_CHAIN_JOB) return this.auditChain.run();
          if (job.name === PERSON_MOBILE_EXPIRY_JOB) return this.mobileApprovals.expireOverdue();
          if (job.name === SETTLEMENT_STATEMENTS_JOB) {
            return this.statements.generateDue(SETTLEMENT_ACTOR);
          }
          if (job.name === SETTLEMENT_RECONCILIATION_JOB) {
            const result = await this.settlementReconciliation.run();
            return { clean: result.clean, issues: result.issues.length };
          }
          if (job.name === DOWN_PAYMENT_RECONCILIATION_JOB) {
            const result = await this.downPayments.run();
            return { clean: result.clean, issues: result.issues.length };
          }
          if (job.name === SERVICE_SWEEP_JOB) {
            return {
              expired: await this.services.expireOverdue(),
              finalized: await this.services.finalizeDue(),
            };
          }
          throw new UnrecoverableError(`unknown maintenance job ${job.name}`);
        },
        { connection: consumerConnection, concurrency: 1 },
      ),
    );
    for (const worker of this.workers) {
      // Job ids and error text only: event payloads never reach a log (rule 30).
      worker.on('failed', (job, error) => {
        this.logger.error(
          `${worker.name} job ${job?.id ?? '?'} failed (attempt ${String(job?.attemptsMade ?? 0)}): ${error.message}`,
        );
      });
    }
    await this.maintenanceQueue.upsertJobScheduler(
      PARTITION_MAINTENANCE_JOB,
      { pattern: '0 3 * * *', tz: 'UTC' },
      { name: PARTITION_MAINTENANCE_JOB, opts: { removeOnComplete: 30, removeOnFail: 100 } },
    );
    await this.maintenanceQueue.upsertJobScheduler(
      QUEUE_MONITOR_JOB,
      { every: 60_000 },
      { name: QUEUE_MONITOR_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Nightly at 02:00 Tehran time (task 1-4 decision), when traffic is lowest.
    await this.maintenanceQueue.upsertJobScheduler(
      LEDGER_RECONCILIATION_JOB,
      { pattern: '0 2 * * *', tz: 'Asia/Tehran' },
      { name: LEDGER_RECONCILIATION_JOB, opts: { removeOnComplete: 60, removeOnFail: 100 } },
    );
    // Daily, so that it starts on 1 Bahman itself; the notice repeats weekly (task 2-1).
    await this.maintenanceQueue.upsertJobScheduler(
      HOLIDAY_COVERAGE_JOB,
      { pattern: '0 9 * * *', tz: 'Asia/Tehran' },
      { name: HOLIDAY_COVERAGE_JOB, opts: { removeOnComplete: 30, removeOnFail: 100 } },
    );
    // Every minute (task 2-6): holds lapse in minutes, and reminders are due by the minute.
    await this.maintenanceQueue.upsertJobScheduler(
      BOOKING_SWEEP_JOB,
      { every: 60_000 },
      { name: BOOKING_SWEEP_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Every 15 seconds (task 2-7): events only mark entries due; this computes their free time.
    await this.maintenanceQueue.upsertJobScheduler(
      SEARCH_REFRESH_JOB,
      { every: 15_000 },
      { name: SEARCH_REFRESH_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Every 10 seconds (task 2-8): uploaded files are scanned and processed, and the public
    // space follows the published profiles.
    await this.maintenanceQueue.upsertJobScheduler(
      MEDIA_PROCESS_JOB,
      { every: 10_000 },
      { name: MEDIA_PROCESS_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Every 10 seconds (task 2-9): committed imports, and what waited for a center to open.
    await this.maintenanceQueue.upsertJobScheduler(
      CATALOG_IMPORT_JOB,
      { every: 10_000 },
      { name: CATALOG_IMPORT_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Every 15 minutes (task 3-4): an issued proforma past its deadline expires; a late
    // answer is refused at once anyway, so this only keeps the lists true.
    await this.maintenanceQueue.upsertJobScheduler(
      PROFORMA_EXPIRY_JOB,
      { every: 15 * 60_000 },
      { name: PROFORMA_EXPIRY_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Every 15 minutes (task 3-5): credit deadlines missed, and applications left too long.
    await this.maintenanceQueue.upsertJobScheduler(
      CREDIT_SWEEP_JOB,
      { every: 15 * 60_000 },
      { name: CREDIT_SWEEP_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Every minute (task 4-6): authorizations past their deadline expire and free their
    // reservation; delivered services past their window become final.
    await this.maintenanceQueue.upsertJobScheduler(
      SERVICE_SWEEP_JOB,
      { every: 60_000 },
      { name: SERVICE_SWEEP_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Nightly at 02:10 Tehran (task 4-6b), after the ledger's: down payments, read only.
    await this.maintenanceQueue.upsertJobScheduler(
      DOWN_PAYMENT_RECONCILIATION_JOB,
      { pattern: '10 2 * * *', tz: 'Asia/Tehran' },
      { name: DOWN_PAYMENT_RECONCILIATION_JOB, opts: { removeOnComplete: 60, removeOnFail: 100 } },
    );
    // Task 5-1: payables and fees fall due at the start of their Tehran day (hourly, so a
    // missed run is caught up); settlement reconciled nightly at 02:20 Tehran, read only.
    await this.maintenanceQueue.upsertJobScheduler(
      SETTLEMENT_DUE_JOB,
      { pattern: '5 * * * *', tz: 'Asia/Tehran' },
      { name: SETTLEMENT_DUE_JOB, opts: { removeOnComplete: 48, removeOnFail: 100 } },
    );
    await this.maintenanceQueue.upsertJobScheduler(
      SETTLEMENT_RECONCILIATION_JOB,
      { pattern: '20 2 * * *', tz: 'Asia/Tehran' },
      { name: SETTLEMENT_RECONCILIATION_JOB, opts: { removeOnComplete: 60, removeOnFail: 100 } },
    );
    // Daily at 00:30 Tehran (task 5-4): last month's statements, for whoever has none yet;
    // a missed day is caught up the next.
    await this.maintenanceQueue.upsertJobScheduler(
      SETTLEMENT_STATEMENTS_JOB,
      { pattern: '30 0 * * *', tz: 'Asia/Tehran' },
      { name: SETTLEMENT_STATEMENTS_JOB, opts: { removeOnComplete: 60, removeOnFail: 100 } },
    );
    // Nightly at 00:05 Tehran (task 6-1): installment states refreshed; due and overdue
    // announced once each.
    await this.maintenanceQueue.upsertJobScheduler(
      REPAYMENT_CYCLE_JOB,
      { pattern: '5 0 * * *', tz: 'Asia/Tehran' },
      { name: REPAYMENT_CYCLE_JOB, opts: { removeOnComplete: 60, removeOnFail: 100 } },
    );
    // Nightly at 00:20 Tehran, after the installment cycle (task 6-7): the overdue queue
    // kept, promises judged, escalation tasks made.
    await this.maintenanceQueue.upsertJobScheduler(
      COLLECTION_CYCLE_JOB,
      { pattern: '20 0 * * *', tz: 'Asia/Tehran' },
      { name: COLLECTION_CYCLE_JOB, opts: { removeOnComplete: 60, removeOnFail: 100 } },
    );
    // Every five minutes (task 7-1): the deadline alerts are as late as this at most.
    await this.maintenanceQueue.upsertJobScheduler(
      TICKET_SWEEP_JOB,
      { every: 300_000 },
      { name: TICKET_SWEEP_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Every ten seconds (task 7-3), like the profile media job: a queued export is soon ready.
    await this.maintenanceQueue.upsertJobScheduler(
      REPORT_EXPORT_JOB,
      { every: 10_000 },
      { name: REPORT_EXPORT_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    await this.maintenanceQueue.upsertJobScheduler(
      REPORT_REFRESH_JOB,
      { every: 900_000 },
      { name: REPORT_REFRESH_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Nightly at 03:30 Tehran (task 9-3, R6), when the trail is quietest.
    await this.maintenanceQueue.upsertJobScheduler(
      AUDIT_CHAIN_JOB,
      { pattern: '30 3 * * *', tz: 'Asia/Tehran' },
      { name: AUDIT_CHAIN_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Every 15 minutes (task 9-3, م۵): a pending mobile is refused soon after its deadline;
    // a late decision is refused at once anyway.
    await this.maintenanceQueue.upsertJobScheduler(
      PERSON_MOBILE_EXPIRY_JOB,
      { every: 15 * 60_000 },
      { name: PERSON_MOBILE_EXPIRY_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Daily at 08:00 Tehran (task 6-6): reminders and overdue notices, each step once; the
    // amount owed read then, so a slip approved overnight is not reminded.
    await this.maintenanceQueue.upsertJobScheduler(
      REPAYMENT_REMINDERS_JOB,
      { pattern: '0 8 * * *', tz: 'Asia/Tehran' },
      { name: REPAYMENT_REMINDERS_JOB, opts: { removeOnComplete: 60, removeOnFail: 100 } },
    );
    // Task 6-4: SMS due queued every 15 seconds; delivery reports read every 10 minutes.
    await this.maintenanceQueue.upsertJobScheduler(
      SMS_RELEASE_JOB,
      { every: 15_000 },
      { name: SMS_RELEASE_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Task 6-5: bulk SMS, gradually at the configured rate.
    await this.maintenanceQueue.upsertJobScheduler(
      SMS_CAMPAIGN_JOB,
      { every: 15_000 },
      { name: SMS_CAMPAIGN_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    await this.maintenanceQueue.upsertJobScheduler(
      SMS_DELIVERY_JOB,
      { every: 10 * 60_000 },
      { name: SMS_DELIVERY_JOB, opts: { removeOnComplete: 10, removeOnFail: 100 } },
    );
    // Daily at 09:00 Tehran (task 4-6): accounts that would silently miss an SMS.
    await this.maintenanceQueue.upsertJobScheduler(
      ACCOUNT_MOBILE_CHECK_JOB,
      { pattern: '0 9 * * *', tz: 'Asia/Tehran' },
      { name: ACCOUNT_MOBILE_CHECK_JOB, opts: { removeOnComplete: 30, removeOnFail: 100 } },
    );
    // Daily at 09:00 Tehran (ADR-046): contract terms ending within the warning days.
    await this.maintenanceQueue.upsertJobScheduler(
      PROVIDER_CONTRACT_CHECK_JOB,
      { pattern: '0 9 * * *', tz: 'Asia/Tehran' },
      { name: PROVIDER_CONTRACT_CHECK_JOB, opts: { removeOnComplete: 30, removeOnFail: 100 } },
    );
    if (this.options.relayLoop !== false) this.scheduleRelay(0);
  }

  /** One pass of the relay; exposed for tests and for draining at shutdown. */
  relayOnce(faults?: RelayFaults) {
    return relayOnce(this.db, this.outboxQueue, RELAY_BATCH, faults ?? this.options.relayFaults);
  }

  private scheduleRelay(delayMs: number) {
    if (this.stopped) return;
    this.relayTimer = setTimeout(() => {
      this.relaying = this.relayOnce()
        .then((result) => {
          this.scheduleRelay(result.published === RELAY_BATCH ? 0 : RELAY_INTERVAL_MS);
        })
        .catch((error: unknown) => {
          this.logger.error(
            `outbox relay failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
          this.scheduleRelay(RELAY_INTERVAL_MS);
        });
    }, delayMs);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.relayTimer) clearTimeout(this.relayTimer);
    await this.relaying?.catch(() => undefined);
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all(this.watchedQueues.map((q) => q.close()));
  }
}
