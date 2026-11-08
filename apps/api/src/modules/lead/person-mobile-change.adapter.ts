import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import type { PersonMobileChange } from '../../common/lead/person-mobile-change.port';
import { lockKey, type Tx } from './lead.shared';
import { PersonMobiles } from './person-mobiles';
import { PersonService } from './person.service';

/** The lead side of a patient's own mobile change (ف۱۲, owner 1405/07/26, option «ب»). */
@Injectable()
export class PersonMobileChangeAdapter implements PersonMobileChange {
  constructor(
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly persons: PersonService,
  ) {}

  async replaceLoginMobile(
    executor: SqlExecutor,
    actor: Actor,
    input: {
      readonly personId: string | null;
      readonly from: string;
      readonly to: string;
      readonly accountId: string;
      readonly at: Date;
    },
  ): Promise<void> {
    const tx = executor as Tx;
    // Both mobiles' locks, in one order, so two changes never deadlock; the same lock an
    // intake takes, so no intake makes a Person of `to` meanwhile.
    for (const mobile of [input.from, input.to].sort()) {
      await lockKey(tx, `lead.mobile:${mobile}`);
    }
    const person =
      input.personId === null
        ? null
        : await this.persons.canonical(tx, (await this.persons.lockPerson(tx, input.personId)).id);
    const held = await PersonMobiles.holder(tx, input.to);
    if (held) {
      const holder = await this.persons.canonical(tx, held.personId);
      if (person === null || holder.id !== person.id) {
        throw new ConflictException({ error: 'mobile_taken' });
      }
      if (held.status === 'pending') throw new ConflictException({ error: 'mobile_pending' });
    }
    if (person === null) return;

    const mergedIds = await this.persons.mergedIds(tx, person.id);
    const previous = await PersonMobiles.holder(tx, input.from);
    const retired = previous !== null && mergedIds.includes(previous.personId) ? previous : null;
    if (retired) await PersonMobiles.retire(tx, retired.id, input.at);
    const added =
      held ??
      (await PersonMobiles.add(tx, {
        personId: person.id,
        mobile: input.to,
        status: 'active',
        addedVia: 'mobile_change',
        addedBy: input.accountId,
        provedAt: input.at,
      }));
    if (held) await PersonMobiles.markProved(tx, input.to, input.at);
    await this.audit.record(
      {
        actor,
        action: 'lead.person_mobile_replaced',
        entityType: 'person',
        entityId: person.id,
        // Row ids only, never the numbers (rule 30).
        before: { personMobileId: retired?.id ?? null },
        after: { personMobileId: added.id, addedVia: held ? 'existing' : 'mobile_change' },
      },
      tx,
    );
  }
}
