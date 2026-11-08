import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  formatJalaliDate,
  formatToman,
  gregorianToJalali,
  toPersianDigits,
  type EventEnvelope,
} from '@sepehr/contracts';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { ADMIN_NOTICES, type AdminNotices } from '../../common/config/admin-notices.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { REPAYMENT, type RepaymentPort } from '../../common/repayment/repayment.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import type { TextSmsSender } from '../../infra/sms-queue';

export const FUNDING_SMS_SENDER = Symbol('FUNDING_SMS_SENDER');

/** Open while a funded patient's doctor could not be told (task 4-6). */
export const DOCTOR_NOT_TOLD_NOTICE = 'funded_doctor_not_told';

/** Not worth telling after two days. */
const TTL_MS = 2 * 86_400_000;

/** A `YYYY-MM-DD` day as the patient reads it: Jalali, Persian digits. */
function jalaliDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return formatJalaliDate(gregorianToJalali({ year: y ?? 0, month: m ?? 1, day: d ?? 1 }));
}

/**
 * Funding's SMS (doc 12 §5; task 4-5), run by the worker after the funding commits:
 *   - the patient: the amount usable now and the first installment, Jalali, exact;
 *   - the doctor: «a patient is ready», with no amount and nothing of the patient's
 *     finances (doc 12 §9 test 10; the template is refused with one, walletSmsTemplates).
 * Mobiles are read when sending, never logged (rule 30).
 */
@Injectable()
export class FundingNotifier implements EventConsumer, OnModuleInit, OnApplicationShutdown {
  readonly name = 'wallet.funding_sms';
  readonly eventTypes = ['wallet.funded'];
  private readonly logger = new Logger(FundingNotifier.name);

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(REPAYMENT) private readonly repayment: RepaymentPort,
    @Inject(FUNDING_SMS_SENDER) private readonly sender: TextSmsSender,
    // Task 4-6 (technical task ف۴): a doctor who cannot be told is a notice, not only a log.
    @Optional() @Inject(ADMIN_NOTICES) private readonly notices?: AdminNotices,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async onApplicationShutdown() {
    await this.sender.close?.();
  }

  async handle(event: EventEnvelope, tx: SqlExecutor): Promise<void> {
    const p = event.payload as {
      creditApplicationId: string;
      purseId: string;
      scheduleId: string;
      doctorAccountId: string | null;
    };
    const facts = await this.credit.facts(p.creditApplicationId);
    if (!facts) return;
    const templates = (await this.config.resolve('wallet.sms_templates')).value;
    const notAfter = new Date(Date.parse(event.occurredAt) + TTL_MS).toISOString();

    const purse = await this.wallet.summary(p.purseId, tx);
    const schedule = await this.repayment.schedule(p.scheduleId, new Date(), tx);
    const first = schedule.installments[0];
    const patient = await this.leads.mobileOf(facts.patientPersonId, tx);
    if (patient === null) {
      this.logger.warn(`no mobile for the patient of funding ${event.aggregateId}; not sent`);
    } else if (first) {
      const text = templates.patientFunded
        .replace('{amount}', formatToman(purse.approvedAmountRial + purse.downPaymentRial))
        .replace('{count}', toPersianDigits(String(schedule.installments.length)))
        .replace('{firstAmount}', formatToman(first.amountRial))
        .replace('{firstDue}', jalaliDay(first.dueOn));
      await this.sender.sendText(
        { mobile: patient, text, notAfter },
        `funding-patient-${event.id}`,
      );
    }

    const doctor = p.doctorAccountId === null ? null : await this.accounts.find(p.doctorAccountId);
    if (!doctor?.mobile) {
      this.logger.warn(`no mobile for the doctor of funding ${event.aggregateId}; not sent`);
      await this.notices?.raise(
        DOCTOR_NOT_TOLD_NOTICE,
        'access.assign_roles',
        'پیامک «بیمار آماده است» به پزشکی که حساب یا موبایل ندارد فرستاده نشد. ' +
          'حساب و موبایل تأییدشده پزشکان را کامل کنید.',
        new Date(),
        tx,
      );
      return;
    }
    await this.sender.sendText(
      { mobile: doctor.mobile, text: templates.doctorPatientReady, notAfter },
      `funding-doctor-${event.id}`,
    );
  }
}
