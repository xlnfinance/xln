import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  createStructuredLogger,
  registerStructuredLogSink,
  type StructuredLogEvent,
} from '../infra/logger';
import { createRelayStore, pushDebugEvent } from '../relay/store';
import { safeStringify } from '../protocol/serialization';

const sentinels = {
  seed: 'seed-sentinel-never-log',
  privateKey: 'private-key-sentinel-never-log',
  hanko: 'hanko-sentinel-never-log',
  ciphertext: 'ciphertext-sentinel-never-log',
  secret: 'secret-sentinel-never-log',
  capability: 'xlnra1.admin.12345.payload.signature.extra',
};

const expectRedacted = (value: unknown): void => {
  const encoded = safeStringify(value);
  for (const sentinel of Object.values(sentinels)) expect(encoded).not.toContain(sentinel);
  expect(encoded).toContain('[REDACTED]');
};

test('structured logger redacts secret-bearing fields before every sink', () => {
  const previousLevel = process.env['XLN_LOG_LEVEL'];
  process.env['XLN_LOG_LEVEL'] = 'error';
  const events: StructuredLogEvent[] = [];
  const unregister = registerStructuredLogSink(event => events.push(event));
  try {
    createStructuredLogger('secret-boundary').error(`TEST_FAILURE secret=${sentinels.secret}`, {
      code: 'TEST_FAILURE',
      seed: sentinels.seed,
      nested: {
        privateKey: sentinels.privateKey,
        hankoData: sentinels.hanko,
        ciphertext: sentinels.ciphertext,
        secret: sentinels.secret,
      },
      message: `Authorization: Bearer ${sentinels.capability}`,
      input: { entityTxs: [{ data: sentinels.secret }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe('TEST_FAILURE');
    expect(events[0]?.message).toBe('TEST_FAILURE secret=[REDACTED]');
    expectRedacted(events[0]);
  } finally {
    unregister();
    if (previousLevel === undefined) delete process.env['XLN_LOG_LEVEL'];
    else process.env['XLN_LOG_LEVEL'] = previousLevel;
  }
});

test('relay debug store applies the same mandatory redactor to browser ingestion', () => {
  const store = createRelayStore('debug-redaction');
  pushDebugEvent(store, {
    event: 'browser_error',
    status: 'error',
    reason: `private_key=${sentinels.privateKey}`,
    details: {
      source: 'browser',
      severity: 'error',
      message: `secret=${sentinels.secret} ${sentinels.capability}`,
      hanko: sentinels.hanko,
      ciphertext: sentinels.ciphertext,
    },
  });

  expect(store.debugEvents).toHaveLength(1);
  expect(store.debugIncidents.size).toBe(1);
  expectRedacted(store.debugEvents[0]);
  expectRedacted(Array.from(store.debugIncidents.values()));
});

test('consensus logging has no raw payload escape hatch', () => {
  const repoRoot = join(import.meta.dir, '..', '..');
  const sources = [
    'runtime/runtime.ts',
    'runtime/account/consensus/index.ts',
    'runtime/entity/consensus/index.ts',
    'runtime/entity/tx/handlers/account/orderbook-matching-same.ts',
    'runtime/entity/tx/handlers/dispute.ts',
    'runtime/infra/logger.ts',
    'runtime/qa/api.ts',
    'package.json',
  ].map(path => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

  expect(sources).not.toContain('shouldLogFullPayloads');
  expect(sources).not.toContain('XLN_LOG_FULL_PAYLOADS');
  expect(sources).not.toContain("'frame.commit.payload'");
  expect(sources).not.toContain("'frame.tx_payload'");
  expect(sources).not.toContain("'tx.payload'");
  expect(sources).not.toContain("'vote.payload'");
  expect(sources).not.toContain("'start.preflight_payload'");
});

test('J adapters route failures through structured telemetry and never synthesize zero reads', () => {
  const repoRoot = join(import.meta.dir, '..', '..');
  const browserVm = readFileSync(join(repoRoot, 'runtime/jadapter/browservm-provider.ts'), 'utf8');
  const rpc = readFileSync(join(repoRoot, 'runtime/jadapter/rpc.ts'), 'utf8');

  expect(browserVm).not.toContain('console.error');
  expect(rpc).not.toContain('console.error');
  expect(browserVm).not.toContain('if (result.execResult.exceptionError) return 0n;');
  expect(browserVm).not.toContain(
    'if (accountKeyResult.execResult.exceptionError) return { collateral: 0n, ondelta: 0n };',
  );
  expect(browserVm).not.toContain(
    'if (result.execResult.exceptionError) return { collateral: 0n, ondelta: 0n };',
  );
  expect(browserVm).toContain("createStructuredLogger('jadapter.browservm')");
  expect(rpc).toContain("createStructuredLogger('jadapter.rpc')");
});
