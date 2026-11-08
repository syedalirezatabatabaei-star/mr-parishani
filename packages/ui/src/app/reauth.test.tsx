import { describe, expect, it, vi } from 'vitest';
import { reauthFetch } from './reauth.js';

/** Task 9-3 (R1): an action refused for want of a fresh TOTP code asks once, then retries once. */

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const post = () =>
  new Request('https://admin.sepehr.test/api/v1/access/assignments', {
    method: 'POST',
    body: JSON.stringify({ roleCode: 'support' }),
  });

describe('reauthFetch', () => {
  it('asks for a code on reauth_required and sends the same request again, once', async () => {
    const seen: string[] = [];
    const base = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      seen.push(await request.text());
      return seen.length === 1
        ? answer(403, { error: 'reauth_required' })
        : answer(201, { id: 'x' });
    });
    const prompt = vi.fn(() => Promise.resolve(true));
    const res = await reauthFetch(prompt, base)(post());
    expect(res.status).toBe(201);
    expect(prompt).toHaveBeenCalledTimes(1);
    // The retry carries the same body.
    expect(seen).toEqual(['{"roleCode":"support"}', '{"roleCode":"support"}']);
  });

  it('gives the refusal back when the user cancels, or when the retry is refused again', async () => {
    const refused = () => Promise.resolve(answer(403, { error: 'reauth_required' }));
    const cancel = vi.fn(() => Promise.resolve(false));
    const base = vi.fn(refused);
    expect((await reauthFetch(cancel, base)(post())).status).toBe(403);
    expect(base).toHaveBeenCalledTimes(1);

    const again = vi.fn(refused);
    const res = await reauthFetch(() => Promise.resolve(true), again)(post());
    expect(res.status).toBe(403);
    // Never a loop: one retry only.
    expect(again).toHaveBeenCalledTimes(2);
  });

  it('leaves every other answer alone, and asks nothing without a prompt', async () => {
    const prompt = vi.fn(() => Promise.resolve(true));
    const other = vi.fn(() => Promise.resolve(answer(403, { error: 'permission_required' })));
    expect((await reauthFetch(prompt, other)(post())).status).toBe(403);
    expect(prompt).not.toHaveBeenCalled();
    const needs = vi.fn(() => Promise.resolve(answer(403, { error: 'reauth_required' })));
    expect((await reauthFetch(null, needs)(post())).status).toBe(403);
    expect(needs).toHaveBeenCalledTimes(1);
  });
});
