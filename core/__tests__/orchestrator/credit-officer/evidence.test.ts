import { dbRootPath } from '../../../runtime/replica/platform';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fundedLoan, bank, saver, borrower, command } from '../../fixtures/storage/lending-runtime';
import { EmbeddedRuntimeAdapter } from '../../../api/runtime-adapter/embedded';
import {
  enqueueRuntimeInput,
  validateRuntimeInputAdmission,
  submitCrossJurisdictionIntent,
  registerRuntimePublishedCallback,
  readPersistedAccountFrameHistory,
  closeRuntimeDb,
  closeInfraDb,
} from '../../../runtime';
import { readCreditEvidence } from '../../../orchestrator/credit-officer/runtime';
import { scoreCredit } from '../../../orchestrator/credit-officer/policy';
import { creditDay, type CreditRequest } from '../../../orchestrator/credit-officer/proof';

test('scoring reads real committed account evidence, excludes bank funding, and counts one trusted source leg', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-credit-evidence-'));
  const namespace = `credit-officer-${crypto.randomUUID()}`;
  const env = await fundedLoan('1h', namespace);
  const adapter = new EmbeddedRuntimeAdapter({
    getEnv: () => env,
    enqueueRuntimeInput,
    validateRuntimeInputAdmission,
    submitCrossJurisdictionIntent: async (target, route) => {
      await submitCrossJurisdictionIntent(target, route);
      return { delivered: true as const };
    },
    registerRuntimePublishedCallback,
    buildReadContext: target => ({
      readAccountFrameHistory: (entityId, counterpartyId, limit) =>
        readPersistedAccountFrameHistory(target, entityId, counterpartyId, limit),
    }),
  });
  const request: CreditRequest = {
    hubEntityId: bank.entityId,
    borrowerEntityId: saver.entityId,
    tokenId: 1,
    amount: '1000',
    termId: '1h',
    day: creditDay(env.state.timestamp),
    nonce: '0',
  };
  try {
    const initial = await readCreditEvidence(adapter, request, env.state.timestamp);
    expect(initial.facts.volumeUsd).toBe(0n);
    expect(initial.facts.repaid).toBe(0);
    expect(initial.facts.exposureUsd).toBe(0n);
    expect(initial.facts.adverse).toBe(false);
    expect(scoreCredit(request, initial.facts, 0n).approved).toBe(true);
    await command(env, saver, {
      type: 'directPayment',
      data: {
        targetEntityId: borrower.entityId,
        tokenId: 1,
        amount: 1000n,
        route: [saver.entityId, bank.entityId, borrower.entityId],
        deliveryMode: 'trusted',
        trustedGatewayEntityId: bank.entityId,
      },
    });
    const settled = await readCreditEvidence(adapter, request, env.state.timestamp);
    expect(settled.atHeight).toBeGreaterThan(initial.atHeight);
    expect(settled.facts.volumeUsd).toBe(1000n);
    expect(settled.accountRoot).not.toBe(initial.accountRoot);
    // Client-supplied history is not among the reader's inputs.
    expect(initial.facts.volumeUsd).toBe(0n);
  } finally {
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-infra']) {
      rmSync(join(dbRootPath, namespace + suffix), { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
