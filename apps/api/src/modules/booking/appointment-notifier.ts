import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  formatJalaliDate,
  toJalaliDateTime,
  toPersianDigits,
  type EventEnvelope,
} from '@sepehr/contracts';
import { eq } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  EVENT_CONSUMERS,
  type EventConsumer,
  type EventConsumerRegistry,
} from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import type { TextSmsSender } from '../../infra/sms-queue';
import type { Tx } from './appointment-lifecycle';
import { appointments } from './booking.schema';

export const APPOINTMENT_SMS_SENDER = Symbol('APPOINTMENT_SMS_SENDER');

/** Private practices have no center name. */
const PRIVATE_PRACTICE = 'مطب';

type TemplateKey = 'confirmed' | 'reminder' | 'cancelledByCenter' | 'approvalOverdue';

/** Fills {name} placeholders; unknown ones stay as written. */
export function renderSms(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/**
 * The appointment SMS (task 2-6, doc 08 §7), from the outbox: confirmed, reminder,
 * cancelled by the center, and the center's overdue answer to the supporting advisor. The
 * texts are `booking.sms_templates`, edited from the panel. Each is enqueued with the event's
 * id as the job id, so a redelivered event sends nothing twice.
 *
 * All four are transactional: they go to a person who asked not to be contacted too (task
 * 2-6 decision 2). TODO(decision): where «contact» ends and a service SMS begins. Nothing
 * promotional is sent from here.
 */
@Injectable()
export class AppointmentNotifier implements EventConsumer, OnModuleInit, OnApplicationShutdown {
  readonly name = 'booking.appointment_sms';
  readonly eventTypes = [
    'booking.appointment_confirmed',
    'booking.appointment_cancelled',
    'booking.appointment_reminder_due',
    'booking.appointment_approval_overdue',
  ];
  private readonly logger = new Logger(AppointmentNotifier.name);

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumerRegistry,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(WORKPLACE_DIRECTORY) private readonly directory: WorkplaceDirectory,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(APPOINTMENT_SMS_SENDER) private readonly sender: TextSmsSender,
  ) {}

  onModuleInit() {
    this.consumers.register(this);
  }

  async onApplicationShutdown() {
    await this.sender.close?.();
  }

  async handle(event: EventEnvelope, executor: SqlExecutor): Promise<void> {
    const tx = executor as Tx;
    const payload = event.payload as { appointmentId: string; by?: string };
    const [row] = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, payload.appointmentId));
    if (!row) return;

    let key: TemplateKey;
    let mobile: string | null = row.mobile;
    switch (event.type) {
      case 'booking.appointment_confirmed':
        key = 'confirmed';
        break;
      case 'booking.appointment_cancelled':
        if (payload.by !== 'center') return;
        key = 'cancelledByCenter';
        break;
      case 'booking.appointment_reminder_due':
        // Cancelled or moved since it was due: nothing to remind.
        if (row.status !== 'confirmed') return;
        key = 'reminder';
        break;
      case 'booking.appointment_approval_overdue': {
        if (row.status !== 'requested') return;
        key = 'approvalOverdue';
        const advisor = row.caseId ? await this.leads.assigneeOf(row.caseId, tx) : null;
        mobile = advisor ? ((await this.accounts.find(advisor))?.mobile ?? null) : null;
        break;
      }
      default:
        return;
    }
    if (mobile === null) {
      // Ids only (rule 30); the panel still lists the overdue request.
      this.logger.warn(`no mobile for ${event.type} of appointment ${row.id}; not sent`);
      return;
    }
    const [templates, workplace] = await Promise.all([
      this.config.resolve('booking.sms_templates'),
      this.directory.workplace(row.workplaceId, tx),
    ]);
    const at = toJalaliDateTime(row.startsAt);
    const text = renderSms(templates.value[key], {
      doctor: workplace?.doctorName ?? '',
      place: workplace?.placeName ?? PRIVATE_PRACTICE,
      date: formatJalaliDate(at),
      time: toPersianDigits(
        `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`,
      ),
      code: toPersianDigits(row.checkInCode ?? ''),
    });
    await this.sender.sendText(
      { mobile, text, notAfter: row.startsAt.toISOString() },
      `booking-${event.id}`,
    );
  }
}
