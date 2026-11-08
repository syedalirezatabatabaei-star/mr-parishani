import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ACCOUNT_DIRECTORY } from '../../common/auth/account-directory.port';
import { requiredEnv, secretKeyFromEnv } from '../../infra/env';
import { keyRingFromEnv } from '../../security/key-ring';
import { QueueOtpSender, QueueStepUpSender, STEP_UP_SENDER } from '../../infra/sms-queue';
import { FINANCIAL_STEP_UP } from '../../common/auth/step-up.port';
import { StepUpController } from './step-up.controller';
import { SmsOtpStepUp } from './step-up.service';
import { StaffMobileChangeController } from './staff-mobile-change.controller';
import { StaffMobileChangeService } from './staff-mobile-change.service';
import { StaffMobileChanges } from './staff-mobile-changes';
import { FirstApproverMobile } from './first-approver-mobile';
import { FieldCrypto } from '../../security/field-crypto';
import { IdentityAccountDirectory } from './account-directory';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { IDENTITY_CONSTANTS } from './identity.policy';
import { IDENTITY_SECRETS, type IdentitySecrets } from './identity.tokens';
import { OTP_CHALLENGE } from '../../common/auth/otp-challenge.port';
import { OtpChallengeService } from './otp-challenge.service';
import { AccountMobileController } from './account-mobile.controller';
import { AccountMobileService } from './account-mobile.service';
import { PatientMobileStaffController } from './patient-mobile-staff.controller';
import { PatientMobileStaffService } from './patient-mobile-staff.service';
import { PatientMobileController } from './patient-mobile.controller';
import { PatientMobileService } from './patient-mobile.service';
import { OTP_SENDER, OtpLoginService } from './otp-login.service';
import { PersonBackfill } from './person-backfill';
import { SessionService } from './session.service';
import { StaffAuthService } from './staff-auth.service';
import { StaffOffboardingController } from './staff-offboarding.controller';
import { StaffOffboardingService } from './staff-offboarding.service';
import { TotpResetController } from './totp-reset.controller';
import { TotpResetService } from './totp-reset.service';
import { webOriginsFromEnv } from './web-origins';
import { IdentityReencryption } from './identity.reencryption';
import { FactorNotices } from './factor-notices';
import { CENTER_ACCOUNTS } from '../../common/auth/center-accounts.port';
import { AccountSetupController } from './account-setup.controller';
import { AccountSetupService, SETUP_LINK_SENDER } from './account-setup.service';
import { QueueTextSmsSender } from '../../infra/sms-queue';

@Injectable()
class OtpSenderShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(OTP_SENDER) private readonly sender: { close?: () => Promise<void> },
    @Inject(STEP_UP_SENDER) private readonly stepUpSender: { close?: () => Promise<void> },
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.sender.close?.();
    await this.stepUpSender.close?.();
  }
}

/**
 * Identity and sessions (task 0-4, doc 04 §6): patient OTP login, staff and center login
 * with password + TOTP, web cookies with CSRF protection, rotating mobile refresh tokens,
 * device management, two-person TOTP reset. Registers the global guard that denies by
 * default. Global: other modules look accounts up through ACCOUNT_DIRECTORY.
 *
 * Needs AUTH_SECRET, FIELD_ENCRYPTION_KEY, WEB_ORIGINS and REDIS_URL; refuses to start
 * without them.
 */
@Global()
@Module({
  controllers: [
    AuthController,
    TotpResetController,
    StaffOffboardingController,
    AccountMobileController,
    PatientMobileController,
    PatientMobileStaffController,
    // ADR-052: the one-time code for a financial signature.
    StepUpController,
    StaffMobileChangeController,
    // Owner 1405/08/10: a new center user's one-time link.
    AccountSetupController,
  ],
  providers: [
    IdentityReencryption,
    {
      provide: IDENTITY_SECRETS,
      useFactory: (): IdentitySecrets => ({
        authSecret: secretKeyFromEnv('AUTH_SECRET'),
        fieldCrypto: new FieldCrypto(keyRingFromEnv('FIELD_ENCRYPTION_KEY')),
        webOrigins: webOriginsFromEnv(),
      }),
    },
    {
      provide: OTP_SENDER,
      useFactory: () => new QueueOtpSender(requiredEnv('REDIS_URL'), IDENTITY_CONSTANTS.sms),
    },
    {
      provide: STEP_UP_SENDER,
      useFactory: () => new QueueStepUpSender(requiredEnv('REDIS_URL'), IDENTITY_CONSTANTS.sms),
    },
    OtpSenderShutdown,
    // ADR-052: SMS today; a TOTP provider can take FINANCIAL_STEP_UP's place later.
    SmsOtpStepUp,
    { provide: FINANCIAL_STEP_UP, useExisting: SmsOtpStepUp },
    StaffMobileChanges,
    FirstApproverMobile,
    StaffMobileChangeService,
    SessionService,
    OtpLoginService,
    PersonBackfill,
    StaffAuthService,
    TotpResetService,
    // Owner 1405/07/23 (plan 4): two-person offboarding of a staff or center account.
    StaffOffboardingService,
    { provide: ACCOUNT_DIRECTORY, useClass: IdentityAccountDirectory },
    // One-time codes for confirmations other than login (task 3-5: credit-check consent).
    OtpChallengeService,
    AccountMobileService,
    // ف۱۲ (owner 1405/07/26): a patient's own mobile change.
    PatientMobileService,
    PatientMobileStaffService,
    // Task 9-3 (R2): login factor changes recorded for an SMS after the commit.
    FactorNotices,
    { provide: OTP_CHALLENGE, useExisting: OtpChallengeService },
    AccountSetupService,
    {
      provide: SETUP_LINK_SENDER,
      useFactory: () =>
        new QueueTextSmsSender(requiredEnv('REDIS_URL'), { attempts: 5, backoffMs: 5_000 }),
    },
    { provide: CENTER_ACCOUNTS, useExisting: AccountSetupService },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [ACCOUNT_DIRECTORY, OTP_CHALLENGE, FINANCIAL_STEP_UP, CENTER_ACCOUNTS],
})
export class IdentityModule {}
