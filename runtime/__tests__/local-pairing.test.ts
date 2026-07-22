import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { verifyRuntimeAdapterAuthCredential } from '../radapter/auth';
import { createLocalPairingController, isTrustedLocalPairingOrigin } from '../server/local-pairing';
import type { Env } from '../types';

const CONTROL_TOKEN = 'control-token-that-is-longer-than-thirty-two-bytes';
const AUTH_SEED = 'runtime-auth-seed-that-is-longer-than-thirty-two-bytes';
const RUNTIME_ID = `0x${'ab'.repeat(32)}`;
const previousAuthSeed = process.env['XLN_RADAPTER_AUTH_SEED'];

beforeAll(() => {
  process.env['XLN_RADAPTER_AUTH_SEED'] = AUTH_SEED;
});

afterAll(() => {
  if (previousAuthSeed === undefined) delete process.env['XLN_RADAPTER_AUTH_SEED'];
  else process.env['XLN_RADAPTER_AUTH_SEED'] = previousAuthSeed;
});

const env = { runtimeId: RUNTIME_ID } as Env;

const issueRequest = (token = CONTROL_TOKEN): Request => new Request(
  'http://localhost:8080/api/local-pairing/issue',
  { method: 'POST', headers: { authorization: `Bearer ${token}` } },
);

const consumeRequest = (pairingToken: string, origin = 'http://localhost:8080'): Request => new Request(
  'http://localhost:8080/api/local-pairing/consume',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ pairingToken }),
  },
);

describe('local runtime pairing', () => {
  test('accepts only a same-origin browser exchange', () => {
    expect(isTrustedLocalPairingOrigin(consumeRequest('token'))).toBe(true);
    expect(isTrustedLocalPairingOrigin(consumeRequest('token', 'https://evil.example'))).toBe(false);
  });

  test('exchanges one CLI-issued token for one real runtime capability', async () => {
    const controller = createLocalPairingController({
      controlToken: CONTROL_TOKEN,
      instanceId: 'test-instance',
      version: '0.1.16',
    });

    const unauthorized = await controller.handle(
      issueRequest('wrong-control-token-that-is-long-enough'),
      '/api/local-pairing/issue',
      env,
    );
    expect(unauthorized?.status).toBe(401);

    const issued = await controller.handle(issueRequest(), '/api/local-pairing/issue', env);
    expect(issued?.status).toBe(200);
    const issuedBody = await issued!.json() as { pairingToken: string };

    const consumed = await controller.handle(
      consumeRequest(issuedBody.pairingToken),
      '/api/local-pairing/consume',
      env,
    );
    expect(consumed?.status).toBe(200);
    const body = await consumed!.json() as {
      manifest: { entries: Array<{ wsUrl: string; access: string; token: string }> };
    };
    const entry = body.manifest.entries[0]!;
    expect(entry.wsUrl).toBe('ws://localhost:8080/rpc');
    expect(entry.access).toBe('admin');
    expect(verifyRuntimeAdapterAuthCredential(AUTH_SEED, entry.token, { audience: RUNTIME_ID })?.level).toBe('admin');

    const replayed = await controller.handle(
      consumeRequest(issuedBody.pairingToken),
      '/api/local-pairing/consume',
      env,
    );
    expect(replayed?.status).toBe(401);
  });
});
