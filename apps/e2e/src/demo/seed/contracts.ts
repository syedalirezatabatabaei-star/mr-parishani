/**
 * The contract term of every center and every doctor's workplace (launch check item 15,
 * ADR-046): proposed by one and approved by another from /config/proposals, at the center's
 * and the workplace's own scope. The global default of the settings phase is not enough there.
 */
import { as, person, saveState, type Body, type SeedState } from './context.ts';
import type { DemoWorkplace } from './catalog.ts';
import { DEMO } from './settings.ts';

const KEY = 'settlement.provider_contract';

export async function seedContracts(state: SeedState) {
  const proposer = person(state, 'strat1');
  const approver = person(state, 'strat2');
  const network = person(state, 'netspec1');
  const places = (state.data['places'] as DemoWorkplace[] | undefined) ?? [];
  const done = ((state.data['contracts'] as string[] | undefined) ??= []);
  const value = { months: 12, startsOn: new Date().toISOString().slice(0, 10) };
  const scopes: { level: 'center' | 'doctor'; ref: string; note: string }[] = [];
  for (const p of places) {
    if (!scopes.some((s) => s.ref === p.centerNodeId))
      scopes.push({ level: 'center', ref: p.centerNodeId, note: `مرکز «${p.centerName}»` });
    const detail = await as(network, 'GET', `/catalog/doctors/${p.doctorId}`);
    const workplace = (detail['workplaces'] as { id: string; nodeId: string }[]).find(
      (w) => w.id === p.workplaceId,
    );
    if (workplace)
      scopes.push({ level: 'doctor', ref: workplace.nodeId, note: `پزشک «${p.doctorName}»` });
  }
  for (const s of scopes) {
    if (done.includes(s.ref)) continue;
    const made = await as(proposer, 'POST', '/config/proposals', {
      key: KEY,
      scope: { level: s.level, ref: s.ref },
      value,
      reason: `${DEMO}: مدت قرارداد ${s.note}`,
    } satisfies Body);
    await as(approver, 'POST', `/config/proposals/${String(made['id'])}/approve`);
    done.push(s.ref);
    saveState(state);
  }
}
