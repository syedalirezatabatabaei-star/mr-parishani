/**
 * demo up's first check (runtime.ts): after Docker stopped all at once, a healthy container's
 * host port can hang up on every connection unanswered; up then names the exact restart
 * (owner 1405/08/10).
 */
import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { test } from 'node:test';
import { answers, portsMessage } from './runtime.ts';

async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

void test('a port that answers its opening line, and one that hangs up unanswered', async () => {
  const live = createServer((socket) => {
    socket.once('data', () => socket.end('+PONG\r\n'));
  });
  const broken = createServer((socket) => socket.destroy());
  try {
    assert.equal(await answers(await listen(live), 'PING\r\n'), true);
    assert.equal(await answers(await listen(broken), 'PING\r\n'), false);
  } finally {
    live.close();
    broken.close();
  }
});

void test('nothing listening, or silence, is no answer either', async () => {
  const silent = createServer(() => undefined);
  const port = await listen(silent);
  try {
    assert.equal(await answers(port, 'PING\r\n', 300), false);
  } finally {
    silent.close();
  }
  assert.equal(await answers(port, 'PING\r\n', 300), false);
});

void test('the message names each service and the exact docker restart', () => {
  const message = portsMessage([
    { service: 'postgres', port: 5442, name: 'sepehr-demo-postgres-1' },
    { service: 'seaweedfs', port: 8343, name: 'sepehr-demo-seaweedfs-1' },
  ]);
  assert.match(message, /postgres \(درگاه 5442\)، seaweedfs \(درگاه 8343\)/);
  assert.match(message, /\n {2}docker restart sepehr-demo-postgres-1 sepehr-demo-seaweedfs-1$/);
});
