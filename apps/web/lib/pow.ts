/**
 * The partnership form's proof of work (owner 1405/08/10): the counter whose SHA-256 of
 * `challenge:counter` starts with `bits` zero bits, found in the page. No outside service and
 * no library (rule 18): a small SHA-256 of our own, checked against node's in its test.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of an ASCII string (the challenge and a counter are ASCII), as 32 bytes. */
export function sha256Ascii(text: string): Uint8Array {
  const length = text.length;
  const blocks = Math.ceil((length + 9) / 64);
  const words = new Uint32Array(blocks * 16);
  for (let i = 0; i < length; i += 1) {
    words[i >> 2] = (words[i >> 2] ?? 0) | ((text.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8));
  }
  words[length >> 2] = (words[length >> 2] ?? 0) | (0x80 << (24 - (length % 4) * 8));
  words[blocks * 16 - 1] = length * 8;
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let b = 0; b < blocks; b += 1) {
    for (let t = 0; t < 16; t += 1) w[t] = words[b * 16 + t] ?? 0;
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] ?? 0;
      const w2 = w[t - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, hh] = [
      h[0] ?? 0,
      h[1] ?? 0,
      h[2] ?? 0,
      h[3] ?? 0,
      h[4] ?? 0,
      h[5] ?? 0,
      h[6] ?? 0,
      h[7] ?? 0,
    ];
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[t] ?? 0) + (w[t] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + bb) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  h.forEach((v, i) => {
    out[i * 4] = v >>> 24;
    out[i * 4 + 1] = (v >>> 16) & 0xff;
    out[i * 4 + 2] = (v >>> 8) & 0xff;
    out[i * 4 + 3] = v & 0xff;
  });
  return out;
}

/** Leading zero bits of a digest. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/**
 * The first counter solving the challenge; works in slices so the page stays responsive.
 * Gives up after `limit` tries (a challenge expires long before).
 */
export async function solveProofOfWork(
  challenge: string,
  bits: number,
  limit = 1 << 24,
): Promise<number> {
  const slice = 4000;
  for (let start = 0; start < limit; start += slice) {
    for (let counter = start; counter < start + slice; counter += 1) {
      if (leadingZeroBits(sha256Ascii(`${challenge}:${String(counter)}`)) >= bits) return counter;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('proof of work not found');
}
