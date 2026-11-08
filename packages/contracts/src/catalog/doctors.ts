import * as z from 'zod';
import { normalizeMedicalCouncilNumber } from '../text/medical-council.js';
import { normalizeNationalId } from '../text/national-id.js';
import { normalizePersianText } from '../text/persian.js';
import { providerContractTermSchema } from '../settlement/fees.js';

/**
 * Doctors and their secretaries (task 2-3, doc 08 §2). Every doctor has one provider
 * profile, with or without a user account, and one workplace per center branch (or a
 * private practice) where they work.
 */

const code = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 500);

export const medicalCouncilNumberSchema = z.string().transform((v, ctx) => {
  const number = normalizeMedicalCouncilNumber(v);
  if (number === null) {
    ctx.addIssue({ code: 'custom', message: 'invalid medical council number' });
    return z.NEVER;
  }
  return number;
});

export const nationalIdSchema = z.string().transform((v, ctx) => {
  const id = normalizeNationalId(v);
  if (id === null) {
    ctx.addIssue({ code: 'custom', message: 'invalid national ID' });
    return z.NEVER;
  }
  return id;
});

const treatmentFieldCodes = z
  .array(code)
  .max(30)
  .refine((codes) => new Set(codes).size === codes.length, { message: 'repeated field' });

/** Where a doctor works: a branch of an active center, or their own private practice. */
export const workplaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), branchId: z.uuid() }),
  z.object({ kind: z.literal('private_practice'), cityCode: code }),
]);
export type WorkplaceInput = z.input<typeof workplaceSchema>;

export const createDoctorSchema = z.object({
  name: text(2, 200),
  medicalCouncilNumber: medicalCouncilNumberSchema,
  nationalId: nationalIdSchema.optional(),
  treatmentFieldCodes: treatmentFieldCodes.optional(),
  /** The first workplace; a profile always has at least one. */
  workplace: workplaceSchema,
  reason,
  /** Owner 1405/07/27 (ADR-046): the doctor's contract term at this first workplace. */
  contractTerm: providerContractTermSchema.optional(),
});
export type CreateDoctor = z.input<typeof createDoctorSchema>;

/** The registration form (owner 1405/07/27): never saved without the contract term. */
export const registerDoctorSchema = createDoctorSchema.extend({
  contractTerm: providerContractTermSchema,
});

/**
 * Editing a profile. The name and fields: whoever manages the doctor; the council number
 * and national ID: the network only (checked by the service).
 */
export const updateDoctorSchema = z.object({
  name: text(2, 200).optional(),
  treatmentFieldCodes: treatmentFieldCodes.optional(),
  medicalCouncilNumber: medicalCouncilNumberSchema.optional(),
  nationalId: nationalIdSchema.optional(),
  reason,
});
export type UpdateDoctor = z.input<typeof updateDoctorSchema>;

export const addWorkplaceSchema = z.object({ workplace: workplaceSchema, reason });
export type AddWorkplace = z.input<typeof addWorkplaceSchema>;

/** Links an existing center-kind user account to a doctor who had none. */
export const linkDoctorAccountSchema = z.object({ accountId: z.uuid(), reason });
export type LinkDoctorAccount = z.input<typeof linkDoctorAccountSchema>;

/** A secretary of one doctor at one workplace, operating an existing center-kind account. */
export const createSecretarySchema = z.object({
  workplaceId: z.uuid(),
  accountId: z.uuid(),
  name: text(2, 200),
  reason,
});
export type CreateSecretary = z.input<typeof createSecretarySchema>;

/** What the secretary may do: a role, never more than the doctor has. */
export const delegateSecretarySchema = z.object({ roleCode: code, reason });
export type DelegateSecretary = z.input<typeof delegateSecretarySchema>;

/**
 * Whether a workplace takes Sepehr credit (task 2-7 decision 2), which the public search
 * filters on. TODO(decision): at which level (center, doctor or service) it belongs, and
 * whether the contract module derives it later.
 */
export const setWorkplaceCreditSchema = z.object({ enabled: z.boolean(), reason });
export type SetWorkplaceCredit = z.input<typeof setWorkplaceCreditSchema>;

/**
 * `GET /catalog/workplaces` (task 2-11, the center panel): every workplace the caller
 * covers (their center, branch or own practice; the network: their cities), with what the
 * panel shows of it.
 */
export const scopedWorkplaceListSchema = z.array(
  z.object({
    workplaceId: z.uuid(),
    doctor: z.object({ id: z.uuid(), name: z.string() }),
    centerId: z.uuid().nullable(),
    /** The center's name; null for a private practice. */
    placeName: z.string().nullable(),
    branchId: z.uuid().nullable(),
    branchName: z.string().nullable(),
    cityCode: z.string(),
  }),
);
export type ScopedWorkplace = z.infer<typeof scopedWorkplaceListSchema>[number];

/** A doctor as the panel lists them; only the national ID's last four digits (rule 27). */
export const doctorViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  medicalCouncilNumber: z.string(),
  nationalIdLast4: z.string().nullable(),
  hasAccount: z.boolean(),
});
export const doctorListSchema = z.array(doctorViewSchema);

/** A doctor's workplace: `POST /catalog/doctors/:id/workplaces`, `PUT …/credit`. */
export const workplaceViewSchema = z.object({
  id: z.uuid(),
  nodeId: z.uuid(),
  centerId: z.uuid().nullable(),
  branchId: z.uuid().nullable(),
  cityCode: z.string(),
  creditEnabled: z.boolean(),
});

/** A secretary: `POST /catalog/secretaries`. */
export const secretaryViewSchema = z.object({
  id: z.uuid(),
  workplaceId: z.uuid(),
  nodeId: z.uuid(),
  name: z.string(),
});

/** `POST /catalog/secretaries/:id/assignments`: the role assignment made. */
export const delegationViewSchema = z.object({ id: z.uuid() });

/** `GET /catalog/doctors/:id`: every workplace, and the secretaries of those the caller covers. */
export const doctorDetailSchema = doctorViewSchema.extend({
  treatmentFieldCodes: z.array(z.string()),
  workplaces: z.array(workplaceViewSchema),
  secretaries: z.array(secretaryViewSchema),
});
export type DoctorDetail = z.infer<typeof doctorDetailSchema>;
