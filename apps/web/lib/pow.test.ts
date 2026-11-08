import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { leadingZeroBits, sha256Ascii, solveProofOfWork } from './pow';

const node = (text: string) => new Uint8Array(createHash('sha256').update(text).digest());

describe('the partnership form’s proof of work', () => {
  it('hashes as node does, for short, block-edge and long inputs', () => {
    for (const text of [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'x'.repeat(200),
    ]) {
      expect(sha256Ascii(text)).toEqual(node(text));
    }
  });

  it('counts the leading zero bits', () => {
    expect(leadingZeroBits(new Uint8Array([0, 0, 0x10, 0xff]))).toBe(19);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
  });

  it('finds a counter the server would accept', async () => {
    const challenge = '1790000000000.abcdef.signature';
    const counter = await solveProofOfWork(challenge, 12);
    expect(leadingZeroBits(node(`${challenge}:${String(counter)}`))).toBeGreaterThanOrEqual(12);
  });
});
