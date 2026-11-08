import {
  SmsSendError,
  type AlertSender,
  type Delivery,
  type SentText,
  type SmsProvider,
} from './sms-provider.js';

const API_BASE = 'https://api.kavenegar.com/v1';

interface KavenegarResponse {
  return?: { status?: number };
  entries?: { messageid?: number | string; status?: number }[];
}

/**
 * Kavenegar's delivery states (its "status" API): 10 delivered; 6 failed, 11 undelivered,
 * 13 cancelled, 14 blocked, 100 unknown id are final failures; the rest still on the way.
 */
const FAILED = new Set([6, 11, 13, 14, 100]);

/**
 * Kavenegar (rule 19) through its "verify lookup" API: the message text is a template
 * registered in the Kavenegar panel, and our value fills its `%token%`. One template for
 * login codes, another for operational alerts (task 0-7), whose token is the alert code.
 * Appointment SMS (task 2-6) are texts edited in our own panel, so they go through the
 * plain send API from the sender line KAVENEGAR_SENDER.
 *
 * The API key is part of the URL, so neither the URL nor the underlying error message
 * ever leaves this class.
 */
export class KavenegarSmsProvider implements SmsProvider, AlertSender {
  constructor(
    private readonly apiKey: string,
    private readonly template: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly alertTemplate: string | null = null,
    private readonly sender: string | null = null,
    private readonly stepUpTemplate: string | null = null,
  ) {
    if (!apiKey || !template) throw new Error('Kavenegar needs an API key and an OTP template');
  }

  sendOtp(mobile: string, code: string, signal: AbortSignal): Promise<void> {
    return this.lookup(this.template, mobile, code, signal);
  }

  /**
   * ADR-052: the second template: %token% the code, %token2% the amount in tomans (digits, no
   * spaces; «-» when there is none), %token10% what is approved (a few words).
   */
  async sendStepUp(
    mobile: string,
    message: { code: string; amountToman: string | null; operation: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.stepUpTemplate) throw new SmsSendError('no Kavenegar step-up template configured');
    await this.post(
      'verify/lookup.json',
      new URLSearchParams({
        receptor: `0${mobile}`,
        template: this.stepUpTemplate,
        token: message.code,
        token2: message.amountToman ?? '-',
        token10: message.operation,
      }),
      signal,
    );
  }

  sendAlert(mobile: string, code: string, signal: AbortSignal): Promise<void> {
    if (!this.alertTemplate) {
      return Promise.reject(new SmsSendError('no Kavenegar alert template configured'));
    }
    return this.lookup(this.alertTemplate, mobile, code, signal);
  }

  async sendText(mobile: string, text: string, signal: AbortSignal): Promise<SentText> {
    if (!this.sender) throw new SmsSendError('no Kavenegar sender line configured');
    const answer = await this.post(
      'sms/send.json',
      new URLSearchParams({ receptor: `0${mobile}`, sender: this.sender, message: text }),
      signal,
    );
    const id = answer.entries?.[0]?.messageid;
    return { messageId: id === undefined ? null : String(id) };
  }

  /** Task 6-4: delivery of up to 500 messages a call. */
  async status(messageIds: readonly string[], signal: AbortSignal): Promise<Map<string, Delivery>> {
    const out = new Map<string, Delivery>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const answer = await this.post(
        'sms/status.json',
        new URLSearchParams({ messageid: messageIds.slice(i, i + 500).join(',') }),
        signal,
      );
      for (const e of answer.entries ?? []) {
        if (e.messageid === undefined) continue;
        const state =
          e.status === 10 ? 'delivered' : FAILED.has(e.status ?? -1) ? 'failed' : 'pending';
        out.set(String(e.messageid), state);
      }
    }
    return out;
  }

  private lookup(
    template: string,
    mobile: string,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Kavenegar expects the national format, 09XXXXXXXXX.
    return this.post(
      'verify/lookup.json',
      new URLSearchParams({ receptor: `0${mobile}`, token, template }),
      signal,
    ).then(() => undefined);
  }

  /** ADR-052: what is left on the account (Kavenegar's account/info, in rials). */
  async remainingCreditRial(signal: AbortSignal): Promise<bigint> {
    const answer = await this.post('account/info.json', new URLSearchParams(), signal);
    // account/info answers one object, not a list.
    const credit = (answer.entries as unknown as { remaincredit?: unknown } | undefined)
      ?.remaincredit;
    if (typeof credit !== 'number' || !Number.isFinite(credit) || credit < 0) {
      throw new SmsSendError('kavenegar answered no credit');
    }
    return BigInt(Math.floor(credit));
  }

  private async post(
    path: string,
    body: URLSearchParams,
    signal: AbortSignal,
  ): Promise<KavenegarResponse> {
    const url = `${API_BASE}/${encodeURIComponent(this.apiKey)}/${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error';
      throw new SmsSendError(`kavenegar request failed: ${reason}`);
    }

    let answer: KavenegarResponse;
    try {
      answer = (await response.json()) as KavenegarResponse;
    } catch {
      answer = {};
    }
    const status = answer.return?.status;
    if (!response.ok || status !== 200) {
      throw new SmsSendError(
        `kavenegar rejected the send: http ${String(response.status)}, status ${String(status)}`,
      );
    }
    return answer;
  }
}
