import { afterEach, describe, expect, test } from 'bun:test';

import { closeRuntimeDb, createEmptyEnv } from '../../../runtime';
import { TsAccountWorkerAuthority } from '../../../runtime/workers/account';
import { installTsAccountWorkerAuthority } from '../../../runtime/workers/account/provider';
import { tsAccountWorkerPoolStats } from '../../../runtime/workers/account/coordinator/pool';
import { safeStringify } from '../../../protocol/serialization';
import { createJReplica } from '../../../scenarios/harness/boot';
import { entity, makeAccount, makeJurisdiction, makeState, openWritableEntityAccounts } from '../../helpers/cross-j';

const priorWorkerCount = process.env['XLN_TS_ACCOUNT_WORKERS'];
const priorHubName = process.env['XLN_HUB_NAME'];

afterEach(() => {
  if (priorWorkerCount === undefined) delete process.env['XLN_TS_ACCOUNT_WORKERS'];
  else process.env['XLN_TS_ACCOUNT_WORKERS'] = priorWorkerCount;
  if (priorHubName === undefined) delete process.env['XLN_HUB_NAME'];
  else process.env['XLN_HUB_NAME'] = priorHubName;
});

describe('TS Account worker installation', () => {
  test('explicit zero keeps a sovereign Runtime on the canonical inline transition', () => {
    process.env['XLN_TS_ACCOUNT_WORKERS'] = '0';
    const env = createEmptyEnv('ts-inline-sovereign-runtime');

    installTsAccountWorkerAuthority(env);

    expect(env.accountAuthorityExecutionMode).toBeUndefined();
    expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
  });

  test('worker installation boots the whole pool before the first Account dispatch', () => {
    process.env['XLN_TS_ACCOUNT_WORKERS'] = '2';
    const env = createEmptyEnv('ts-worker-eager-pool');
    const before = tsAccountWorkerPoolStats();

    installTsAccountWorkerAuthority(env);

    expect(env.accountAuthorityExecutionMode).toBe('cutover');
    // The pool size is fixed by the first user in this process.
    const after = tsAccountWorkerPoolStats();
    expect(after.threads).toBe(after.size);
    expect(after.residents).toBe(before.residents);
  });

  test('H1 rejects the inline path because Stage 2 requires its resident worker pool', () => {
    process.env['XLN_TS_ACCOUNT_WORKERS'] = '0';
    process.env['XLN_HUB_NAME'] = 'H1';
    const env = createEmptyEnv('ts-h1-worker-required');

    expect(() => installTsAccountWorkerAuthority(env))
      .toThrow('TS_H1_BOOK_WORKER_PROVIDER_REQUIRED');
  });
});

test('Runtime close releases its Account workers but borrowed replay close preserves the live executor', async () => {
  const owner = entity('11');
  const counterparty = entity('22');
  const signer = `0x${'44'.repeat(20)}`;
  const jurisdiction = makeJurisdiction('worker-runtime-close', 31_337, '55', '66');
  const state = makeState(owner, signer, jurisdiction);
  openWritableEntityAccounts(state).set(counterparty, makeAccount(owner, counterparty, jurisdiction));
  const env = createEmptyEnv('worker-runtime-close');
  const jReplica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
  jReplica.chainId = jurisdiction.chainId;
  const authority = new TsAccountWorkerAuthority(env, 1);
  env.accountAuthorityEntityStageProvider = authority.provider;
  env.accountAuthorityExecutionMode = 'cutover';
  const common = {
    ownerEntityId: owner,
    ownerSignerId: signer,
    unsupportedEntityTxTypes: [],
    occurrence: { kind: 'runtime-input' as const, inputIndex: 0 },
    deferProposal: false,
  };
  const execute = () => authority.provider.executeAccountInboundBatch({
    ...common,
    expectedAccountsRoot: state.accounts.rootHash(),
    entityState: state,
    entityContext: undefined,
    requests: [],
  });
  try {
    await execute();
    expect((await authority.telemetry()).initializedAccounts).toBe(1);
    const borrowed = createEmptyEnv('worker-runtime-close-borrowed');
    borrowed.infrastructure = { ...borrowed.infrastructure, runtimeWalDbBorrowed: true };
    borrowed.accountAuthorityEntityStageProvider = authority.provider;
    borrowed.accountAuthorityExecutionMode = 'cutover';
    await closeRuntimeDb(borrowed);
    expect(borrowed.accountAuthorityEntityStageProvider).toBe(authority.provider);
    expect((await authority.telemetry()).initializedAccounts).toBe(1);
    await authority.provider.discardEntityFrameAttempt(common);
    await execute();
    await authority.provider.discardEntityFrameAttempt(common);
    await closeRuntimeDb(env);
    expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
    expect(env.accountAuthorityExecutionMode).toBeUndefined();
    expect((await authority.telemetry()).initializedAccounts).toBe(0);
    await closeRuntimeDb(env);
  } finally {
    await authority.close();
  }
});

const poolUrl = new URL('../../../runtime/workers/account/coordinator/pool.ts', import.meta.url).href;

// The pool is process-wide, so each case runs in a fresh process whose Worker
// is a mailbox stub: the isolate's reply is whatever the case delivers.
const deliver = (message: string) => Bun.spawnSync({
  cmd: [process.execPath, '--eval', `
    const workers = [];
    globalThis.Worker = class {
      constructor() { workers.push(this); }
      postMessage() {}
      addEventListener() {}
      terminate() { this.terminated = true; }
      unref() {}
      ref() {}
    };
    const { acquireTsAccountWorkerResidency } = await import(${safeStringify(poolUrl)});
    const a = acquireTsAccountWorkerResidency(0);
    const b = acquireTsAccountWorkerResidency(0);
    if (a.thread !== b.thread) throw new Error('RESIDENTS_NOT_CO_LOCATED');
    const settle = promise => promise.then(() => 'RESOLVED', error => error.message);
    const pending = [a, b].map(r => settle(r.thread.send(r.residentId, 'phase', new ArrayBuffer(1))));
    workers[0].onmessage({ data: ${message} });
    const [first, second] = await Promise.all(pending);
    const later = await settle(a.thread.send(a.residentId, 'phase', new ArrayBuffer(1)));
    console.log(JSON.stringify({ first, second, later, terminated: workers[0].terminated === true }));
  `],
  cwd: process.cwd(),
  env: { ...process.env, XLN_TS_ACCOUNT_WORKERS: '1' },
  stdout: 'pipe',
  stderr: 'pipe',
  timeout: 10_000,
});

for (const message of [
  'null',
  '{ requestId: 1, kind: "result" }',
  '{ requestId: 0, kind: "result", payload: new ArrayBuffer(0), encodeUs: 0 }',
  '{ requestId: 1, kind: "other" }',
]) {
  test(`malformed response ${message} retires the shared thread for every resident`, () => {
    const child = deliver(message);
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const outcome = JSON.parse(child.stdout.toString().trim()) as Record<string, unknown>;
    expect(String(outcome['first'])).toStartWith('TS_ACCOUNT_WORKER_MALFORMED_RESPONSE:0:');
    expect(outcome['second']).toBe(outcome['first']);
    expect(outcome['later']).toBe(outcome['first']);
    expect(outcome['terminated']).toBe(true);
  });
}
