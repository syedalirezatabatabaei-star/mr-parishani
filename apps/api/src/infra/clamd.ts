import { ServiceUnavailableException } from '@nestjs/common';
import { Socket } from 'node:net';
import type { MalwareScanner, ScanResult } from '../common/security/malware-scanner.port';

/** clamd's default StreamMaxLength is 25 MB; larger files are refused before sending. */
const CHUNK = 64 * 1024;

export const scannerUnavailable = () =>
  new ServiceUnavailableException({ error: 'scanner_unavailable' });

/**
 * Reads clamd's answer to INSTREAM: `stream: OK`, `stream: <name> FOUND`, or an error such
 * as `INSTREAM size limit exceeded. ERROR` (refused as unavailable: nothing unscanned passes).
 */
export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, '').trim();
  if (text === 'stream: OK') return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found?.[1]) return { clean: false, signature: found[1] };
  throw new Error(`clamd: ${text.slice(0, 120)}`);
}

/**
 * ClamAV's clamd over TCP (task 2-8, rule 28), with the INSTREAM command: the file is sent
 * in length-prefixed chunks and never written to disk here. Without CLAMAV_HOST it is not
 * configured and every scan is refused; a failed connection or an error reply is refused
 * too, so no file is ever taken as clean because the scanner was away.
 */
export class ClamdScanner implements MalwareScanner {
  constructor(
    private readonly host: string | null,
    private readonly port: number,
    private readonly timeoutMs = 60_000,
  ) {}

  get configured() {
    return this.host !== null;
  }

  async scan(file: Buffer): Promise<ScanResult> {
    if (this.host === null) throw scannerUnavailable();
    try {
      return parseClamdReply(await this.instream(this.host, file));
    } catch (error) {
      // The reason may name the host; the caller sees only that scanning is unavailable.
      throw Object.assign(scannerUnavailable(), { cause: error });
    }
  }

  private instream(host: string, file: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(Buffer.concat(chunks).toString('utf8'));
      };
      socket.setTimeout(this.timeoutMs, () => {
        finish(new Error('clamd timed out'));
      });
      // The reply ends with NUL (the `z` form of the command). The socket is not half-closed
      // before it comes: clamd drops a stream whose client has ended its side.
      socket.on('data', (data: Buffer) => {
        chunks.push(data);
        if (data.includes(0)) finish(null);
      });
      socket.on('error', finish);
      socket.on('close', () => {
        finish(null);
      });
      socket.connect(this.port, host, () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < file.length; offset += CHUNK) {
          const part = file.subarray(offset, offset + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

/** From CLAMAV_HOST and CLAMAV_PORT (default 3310); not configured without a host. */
export function clamdScannerFromEnv(env: NodeJS.ProcessEnv = process.env): ClamdScanner {
  const host = env['CLAMAV_HOST']?.trim() || null;
  const port = Number(env['CLAMAV_PORT'] ?? '3310');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CLAMAV_PORT must be a port number');
  }
  return new ClamdScanner(host, port);
}
