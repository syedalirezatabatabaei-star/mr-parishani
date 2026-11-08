import { resolve } from 'node:path';

/**
 * Ports of the end-to-end stack: apart from the development servers (3000–3002). The demo
 * (docs/decisions/demo-mode-decisions.md) reuses these helpers on its own ports and folder.
 */
const apiPort = Number(process.env['E2E_API_PORT'] ?? 3100);
const webPort = Number(process.env['E2E_WEB_PORT'] ?? 3101);
const adminPort = Number(process.env['E2E_ADMIN_PORT'] ?? 3102);

export const STACK = {
  apiPort,
  webPort,
  adminPort,
  apiUrl: `http://127.0.0.1:${String(apiPort)}`,
  // localhost, not 127.0.0.1: the origin the API allows and the browser's __Host- cookies.
  webUrl: `http://localhost:${String(webPort)}`,
  adminUrl: `http://localhost:${String(adminPort)}`,
} as const;

export const STACK_DIR = process.env['E2E_STACK_DIR'] ?? resolve(import.meta.dirname, '../.stack');

/** The staff password of every seeded account (a throwaway test database only). */
export const STAFF_PASSWORD = 'e2e stack password, long enough';

export interface SeededStaff {
  readonly username: string;
  readonly accountId: string;
  readonly totpSecret: string;
  /** The last TOTP step used; the next login takes a later one (replay is refused). */
  readonly lastStep: number;
}

export interface Fixture {
  readonly centerId: string;
  readonly centerName: string;
  readonly doctorName: string;
  readonly workplaceId: string;
  readonly profileSlug: string;
  readonly manager: SeededStaff;
  readonly specialist: SeededStaff;
  /** The system administrator (holidays). */
  readonly admin: SeededStaff;
  /** Owner 1405/07/27: the second holder of config.manage_holidays. */
  readonly admin2: SeededStaff;
  /** Network managers: one proposes an activation, the other approves it. */
  readonly approver: SeededStaff;
  readonly networkManager: SeededStaff;
  /** Phase 3: the doctor's own account, and the credit units (task 3-8). */
  readonly doctor: SeededStaff;
  readonly completion: SeededStaff;
  readonly creditSpecialist: SeededStaff;
  readonly creditManager: SeededStaff;
  /** Phase 4: finance (accounting), who approves completion receipts (task 4-4). */
  readonly finance: SeededStaff;
  /** Task 4-7: one person holding both case completion and finance (funding's maker-checker). */
  readonly completionFinance: SeededStaff;
  /** A center submitted for review, documents received but not yet checked. */
  readonly reviewCenterId: string;
  readonly reviewCenterName: string;
  /** A doctor whose profile is submitted and waits for the specialist. */
  readonly reviewDoctorId: string;
  readonly reviewDoctorName: string;
  readonly reviewSlug: string;
  /** Task 4-8: a funded application whose purse is wholly unused (special operations). */
  readonly fundedApplicationId: string;
  /** Task 5-6: a funded purse of the doctor's, and its borrower's mobile (9XXXXXXXXX). */
  readonly settlementPurseId: string;
  readonly settlementPatientMobile: string;
  /** Task 7-7: a funded purse of the doctor's for the financial complaint path, and its borrower. */
  readonly complaintPurseId: string;
  readonly complaintPatientMobile: string;
  /** Task 5-1: two strategy managers: one proposes a rate, the other approves it. */
  readonly strategyA: SeededStaff;
  readonly strategyB: SeededStaff;
  /** Task 6-9: a funded loan for the slip path, and its borrower's mobile (9XXXXXXXXX). */
  readonly repaymentApplicationId: string;
  readonly repaymentPatientMobile: string;
  /** Task 6-9: a funded loan with a guarantor, for the collection path. */
  readonly collectionApplicationId: string;
  readonly collectionPatientMobile: string;
  readonly collectionGuarantorMobile: string;
  readonly collectionAgent: SeededStaff;
  readonly collectionManager: SeededStaff;
  readonly support: SeededStaff;
  /** Owner 1405/07/24 (م۹): an advisor (scope own) who takes every advisory lead. */
  readonly advisor: SeededStaff;
  /** Task 7-5: the CEO (the CEO's dashboard). */
  readonly ceo: SeededStaff;
  /** ADR-048: the customer club's officer (memberships and the origination discount). */
  readonly clubOfficer: SeededStaff;
  /**
   * The owner's visual approval (1405/07/23): the owner of a Person (9XXXXXXXXX), two mobiles
   * an advisor added to it and waiting for them, three holders of lead.approve_person_mobile,
   * and a credit application left as a draft with its borrower's mobile.
   */
  readonly pendingOwnerMobile: string;
  readonly pendingMobiles: readonly string[];
  readonly mobileApprovers: readonly SeededStaff[];
  /** ف۱۲ ب۲ (owner 1405/07/26): two holders of identity.change_patient_mobile. */
  readonly mobileChangers: readonly SeededStaff[];
  readonly draftApplicationId: string;
  readonly draftPatientMobile: string;
  /**
   * Owner 1405/07/24: a funded loan whose 2nd and 3rd due days moved off holidays at funding,
   * its borrower's mobile, and those nominal days.
   */
  readonly movedPatientMobile: string;
  readonly movedNominalDays: readonly { year: number; month: number; day: number }[];
}

/** The stack's test-only control (127.0.0.1): runs the API's CLIs with the stack's own env. */
export const CONTROL_URL = 'http://127.0.0.1:3109';
