import { dbRootPath } from '../../../runtime/replica/platform';
import { safeStringify } from '../../../protocol/serialization';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fundedLoan, bank, saver, replica, command, jurisdiction } from '../../fixtures/storage/lending-runtime';
import { closeRuntimeDb, closeInfraDb, processRuntime } from '../../../runtime';
import { transitionRuntimeLifecycle } from '../../../runtime/replica/lifecycle';
import { converge } from '../../../scenarios/harness/helpers';
import { RemoteRuntimeAdapter } from '../../../api/runtime-adapter/remote';
import { deriveRuntimeAdapterCapabilityToken } from '../../../api/runtime-adapter/security/auth';
import { CreditOfficer } from '../../../orchestrator/credit-officer/officer';
import { CreditLedger } from '../../../orchestrator/credit-officer/ledger';
import { creditDay, validCreditProof, type CreditRequest } from '../../../orchestrator/credit-officer/proof';
import { creditDifficulty, creditUsd } from '../../../orchestrator/credit-officer/policy';
import { creditOfficerHttp } from '../../../orchestrator/credit-officer/http';
import { startOfficerRpc } from './rpc-fixture';

function mine(amount: string): CreditRequest {
  const request: CreditRequest = {
    hubEntityId: bank.entityId,
    borrowerEntityId: saver.entityId,
    tokenId: 1,
    amount,
    termId: '1h',
    day: creditDay(Date.now()),
    nonce: '0',
  };
  for (let n = 0; n < 10_000_000; n++) {
    request.nonce = n.toString(16);
    if (validCreditProof(request, bank.entityId, Date.now(), creditDifficulty(creditUsd(1, BigInt(amount)))))
      return request;
  }
  throw new Error('TEST_PROOF_EXHAUSTED');
}

test('HTTP officer submits authenticated approval, real runtime funds it, and denies over-limit and replay after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-credit-integration-'));
  const previousAuth = process.env['XLN_RADAPTER_AUTH_SEED'];
  process.env['XLN_RADAPTER_AUTH_SEED'] = 'credit-officer-integration-auth-strong-seed';
  const namespace = `credit-officer-${crypto.randomUUID()}`;
  const env = await fundedLoan('1h', namespace);
  const adapter = new RemoteRuntimeAdapter();
  let rpc: ReturnType<typeof startOfficerRpc> | undefined;
  let ledger = new CreditLedger(join(dir, 'officer.sqlite'));
  let officer = new CreditOfficer(ledger, new Map([[bank.entityId, adapter]]));
  let http: ReturnType<typeof Bun.serve> | undefined;
  const startHttp = () =>
    Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 4096,
      fetch: request => creditOfficerHttp(officer, new Set([bank.entityId]))(request),
    });
  const proof = mine('1000');
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${http?.port}/api/credit-officer/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: safeStringify(body),
    });
    return response.json();
  };
  try {
    rpc = startOfficerRpc(env);
    http = startHttp();
    env.state.timestamp = Date.now();
    await command(env, bank, {
      type: 'lendingSetTerms',
      data: {
        chainId: jurisdiction.chainId,
        depositoryAddress: jurisdiction.depositoryAddress,
        tokenId: 1,
        termId: '1h',
        savingsInterestBps: 100,
        loanInterestBps: 200,
        loanLateMs: 3_600_000,
        expiresAt: Date.now() + 3_600_000,
      },
    });
    if (!env.infrastructure) throw new Error('TEST_INFRASTRUCTURE_MISSING');
    transitionRuntimeLifecycle(env.infrastructure, 'running');
    if (!env.runtimeId) throw new Error('TEST_RUNTIME_ID_MISSING');
    const authKey = deriveRuntimeAdapterCapabilityToken(
      process.env['XLN_RADAPTER_AUTH_SEED'],
      'full',
      Date.now() + 60_000,
      { audience: env.runtimeId, keyId: 'credit', tokenId: 'integration' },
    );
    await adapter.connect({
      mode: 'remote',
      wsUrl: `ws://127.0.0.1:${rpc.port}/rpc`,
      runtimeId: env.runtimeId,
      authKey,
    });
    expect(adapter.commandReady).toBe(true);
    expect(await post(proof)).toMatchObject({ success: true, approved: true, reason: 'APPROVAL_SUBMITTED' });
    await processRuntime(env);
    await converge(env, 40);
    const facilities = [...(replica(env, bank).state.lending?.facilities?.values() ?? [])];
    expect(facilities.some(row => row.borrowerEntityId === saver.entityId && row.maxPrincipal === 1000n)).toBe(true);
    await command(env, saver, {
      type: 'lendingBorrow',
      data: {
        requestId: 'borrow-4444444444444444',
        hubEntityId: bank.entityId,
        tokenId: 1,
        amount: 1000n,
        termId: '1h',
        maxInterestBps: 200,
        maxLateMs: 3_600_000,
        expiresAt: Date.now() + 60_000,
      },
    });
    expect(
      [...(replica(env, bank).state.lending?.loans.values() ?? [])].some(
        row => row.borrowerEntityId === saver.entityId && row.status === 'active',
      ),
    ).toBe(true);
    ledger.close();
    ledger = new CreditLedger(join(dir, 'officer.sqlite'));
    officer = new CreditOfficer(ledger, new Map([[bank.entityId, adapter]]));
    expect(await post(proof)).toMatchObject({ success: false, error: 'PROOF_REUSED' });
    expect(await post(mine('50000001'))).toMatchObject({ success: true, approved: false, reason: 'BORROWER_LIMIT' });
  } finally {
    await adapter.disconnect();
    await http?.stop(true);
    await rpc?.stop(true);
    ledger.close();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    if (previousAuth === undefined) delete process.env['XLN_RADAPTER_AUTH_SEED'];
    else process.env['XLN_RADAPTER_AUTH_SEED'] = previousAuth;
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-infra']) {
      rmSync(join(dbRootPath, namespace + suffix), { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
