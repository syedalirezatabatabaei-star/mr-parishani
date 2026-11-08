import { describe, expect, it, vi } from 'vitest';
import { KavenegarSmsProvider } from './kavenegar.js';

// Obviously fake: the tests only check that this value never appears in errors.
const API_KEY = 'fake-kavenegar-key';

function fakeFetch(response: Response | Error) {
  return vi.fn<typeof fetch>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
}

const ok = () => new Response(JSON.stringify({ return: { status: 200, message: 'ok' } }));
const signal = () => new AbortController().signal;

describe('KavenegarSmsProvider', () => {
  it('calls the verify-lookup API with the template, national-format receptor and code', async () => {
    const fetchImpl = fakeFetch(ok());
    const sig = signal();
    await new KavenegarSmsProvider(API_KEY, 'sepehr-otp', fetchImpl).sendOtp(
      '9121234567',
      '482913',
      sig,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.kavenegar.com/v1/${API_KEY}/verify/lookup.json`);
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBe(sig);
    const body = init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      receptor: '09121234567',
      token: '482913',
      template: 'sepehr-otp',
    });
  });

  it('sends a financial approval code by its own template: code, amount, operation (ADR-052)', async () => {
    const fetchImpl = fakeFetch(ok());
    await new KavenegarSmsProvider(
      API_KEY,
      'sepehr-otp',
      fetchImpl,
      null,
      null,
      'sepehr-step-up',
    ).sendStepUp(
      '9121234567',
      { code: '482913', amountToman: '12000000', operation: 'شارژ کیف اعتبار' },
      signal(),
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.kavenegar.com/v1/${API_KEY}/verify/lookup.json`);
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      receptor: '09121234567',
      template: 'sepehr-step-up',
      token: '482913',
      token2: '12000000',
      token10: 'شارژ کیف اعتبار',
    });
    // No amount: a dash. Without the template: refused, never sent by the login template.
    const noAmount = fakeFetch(ok());
    await new KavenegarSmsProvider(API_KEY, 'otp', noAmount, null, null, 'step').sendStepUp(
      '9121234567',
      { code: '111111', amountToman: null, operation: 'تغییر شماره بیمار' },
      signal(),
    );
    expect(Object.fromEntries(noAmount.mock.calls[0]?.[1]?.body as URLSearchParams)).toMatchObject({
      token2: '-',
    });
    const none = fakeFetch(ok());
    const refused = await new KavenegarSmsProvider(API_KEY, 'sepehr-otp', none)
      .sendStepUp('9121234567', { code: '1', amountToman: null, operation: 'x' }, signal())
      .catch((e: unknown) => e);
    expect((refused as Error).message).toBe('no Kavenegar step-up template configured');
    expect(none).not.toHaveBeenCalled();
  });

  it('sends an appointment text through the send API from the sender line (task 2-6)', async () => {
    const fetchImpl = fakeFetch(ok());
    await new KavenegarSmsProvider(API_KEY, 'sepehr-otp', fetchImpl, null, '10004346').sendText(
      '9121234567',
      'نوبت شما تأیید شد',
      signal(),
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.kavenegar.com/v1/${API_KEY}/sms/send.json`);
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      receptor: '09121234567',
      sender: '10004346',
      message: 'نوبت شما تأیید شد',
    });
    // Without a sender line the text is refused, never sent from a default line.
    const refused = await new KavenegarSmsProvider(API_KEY, 'sepehr-otp', fakeFetch(ok()))
      .sendText('9121234567', 'x', signal())
      .catch((e: unknown) => e);
    expect((refused as Error).message).toBe('no Kavenegar sender line configured');
  });

  it('returns the message id of a text, and reads delivery by message id (task 6-4)', async () => {
    const sent = await new KavenegarSmsProvider(
      API_KEY,
      'sepehr-otp',
      fakeFetch(
        new Response(
          JSON.stringify({ return: { status: 200 }, entries: [{ messageid: 8792343, status: 1 }] }),
        ),
      ),
      null,
      '10004346',
    ).sendText('9121234567', 'یادآوری قسط', signal());
    expect(sent).toEqual({ messageId: '8792343' });

    const fetchImpl = fakeFetch(
      new Response(
        JSON.stringify({
          return: { status: 200 },
          entries: [
            { messageid: 1, status: 10 },
            { messageid: 2, status: 11 },
            { messageid: 3, status: 4 },
            { messageid: 4, status: 100 },
          ],
        }),
      ),
    );
    const states = await new KavenegarSmsProvider(API_KEY, 'sepehr-otp', fetchImpl).status(
      ['1', '2', '3', '4'],
      signal(),
    );
    expect(Object.fromEntries(states)).toEqual({
      '1': 'delivered',
      '2': 'failed',
      '3': 'pending',
      '4': 'failed',
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.kavenegar.com/v1/${API_KEY}/sms/status.json`);
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({ messageid: '1,2,3,4' });
  });

  it.each([
    ['a Kavenegar error status', new Response(JSON.stringify({ return: { status: 418 } }))],
    ['an HTTP error', new Response('bad gateway', { status: 502 })],
    ['a body that is not JSON', new Response('<html>')],
  ])('fails on %s, without leaking the key, mobile or code', async (_case, response) => {
    const provider = new KavenegarSmsProvider(API_KEY, 'sepehr-otp', fakeFetch(response));
    const error = await provider.sendOtp('9121234567', '482913', signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^kavenegar rejected the send/);
    for (const secret of [API_KEY, '9121234567', '482913']) expect(message).not.toContain(secret);
  });

  it.each([
    ['a network error', new TypeError(`fetch failed for https://api.kavenegar.com/v1/${API_KEY}`)],
    ['a timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' })],
  ])('reports %s without the underlying message, which may contain the URL', async (_case, err) => {
    const provider = new KavenegarSmsProvider(API_KEY, 'sepehr-otp', fakeFetch(err));
    const error = (await provider
      .sendOtp('9121234567', '482913', signal())
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^kavenegar request failed: (network error|timeout)$/);
    expect(error.message).not.toContain(API_KEY);
  });

  it('needs an API key and a template', () => {
    expect(() => new KavenegarSmsProvider('', 'sepehr-otp')).toThrow();
    expect(() => new KavenegarSmsProvider(API_KEY, '')).toThrow();
  });

  it('sends alerts through the alert template, with the alert code as the token', async () => {
    const fetchImpl = fakeFetch(ok());
    await new KavenegarSmsProvider(API_KEY, 'sepehr-otp', fetchImpl, 'sepehr-alert').sendAlert(
      '9121234567',
      'outbox_stale',
      signal(),
    );
    const body = fetchImpl.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      receptor: '09121234567',
      token: 'outbox_stale',
      template: 'sepehr-alert',
    });
  });

  it('refuses to send an alert without an alert template', async () => {
    const fetchImpl = fakeFetch(ok());
    await expect(
      new KavenegarSmsProvider(API_KEY, 'sepehr-otp', fetchImpl).sendAlert(
        '9121234567',
        'outbox_stale',
        signal(),
      ),
    ).rejects.toThrow('no Kavenegar alert template');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ADR-052: reads the account credit in rials; no number is an error, never 0', async () => {
    const fetchImpl = fakeFetch(
      new Response(
        JSON.stringify({
          return: { status: 200 },
          entries: { remaincredit: 1234567, type: 'master' },
        }),
      ),
    );
    const credit = await new KavenegarSmsProvider(API_KEY, 'otp', fetchImpl).remainingCreditRial(
      signal(),
    );
    expect(credit).toBe(1_234_567n);
    expect(fetchImpl.mock.calls[0]?.[0] as string).toContain('/account/info.json');
    const empty = fakeFetch(new Response(JSON.stringify({ return: { status: 200 }, entries: {} })));
    await expect(
      new KavenegarSmsProvider(API_KEY, 'otp', empty).remainingCreditRial(signal()),
    ).rejects.toThrow('no credit');
  });
});
