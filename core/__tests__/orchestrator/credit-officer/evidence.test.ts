import { dbRootPath } from '../../../runtime/replica/platform';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fundedLoan, bank, saver, borrower, command, jurisdiction } from '../../fixtures/storage/lending-runtime';
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
import { CreditLedger } from '../../../orchestrator/credit-officer/ledger';

test('scoring reads real committed account evidence, excludes bank funding, and counts one trusted source leg', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-credit-evidence-'));
  const namespace = `credit-officer-${crypto.randomUUID()}`;
  const ledgerPath = join(dir, 'officer.sqlite');
  let ledger = new CreditLedger(ledgerPath);
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
    const now = env.state.timestamp + 8 * 86_400_000;
    await expect(readCreditEvidence(adapter, { ...request, tokenId: 999 }, now - 86_400_000, ledger)).rejects.toThrow(
      'ACCOUNT_UNAVAILABLE',
    );
    // A verified Account starts observation even if lending terms are unavailable.
    await expect(readCreditEvidence(adapter, request, now, ledger)).rejects.toThrow('BANK_TERMS_UNAVAILABLE');
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
        expiresAt: now + 31 * 86_400_000,
      },
    });
    // These real committed frames predate officer observation by eight days.
    // A borrower cannot use their timestamps to obtain the seven-day tier.
    const initial = await readCreditEvidence(adapter, request, now, ledger);
    expect(initial.firstSeenAt).toBe(now);
    expect(initial.facts.ageDays).toBe(0);
    const regressedClock = await readCreditEvidence(adapter, request, now - 1, ledger);
    expect(regressedClock.firstSeenAt).toBe(now);
    expect(regressedClock.facts.ageDays).toBe(0);
    const tierRequest = { ...request, amount: '100000000' };
    const tierFacts = { ...initial.facts, volumeUsd: 100_000_000n, repaid: 1 };
    expect(scoreCredit(tierRequest, tierFacts, 0n).reason).toBe('BORROWER_LIMIT');
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
    ledger.close();
    ledger = new CreditLedger(ledgerPath);
    const settled = await readCreditEvidence(adapter, request, now + 6 * 86_400_000, ledger);
    expect(settled.facts.ageDays).toBe(6);
    const aged = await readCreditEvidence(adapter, request, now + 7 * 86_400_000, ledger);
    expect(aged.facts.ageDays).toBe(7);
    expect(scoreCredit(tierRequest, { ...tierFacts, ageDays: aged.facts.ageDays }, 0n).approved).toBe(true);
    expect(settled.atHeight).toBeGreaterThan(initial.atHeight);
    expect(settled.facts.volumeUsd).toBe(1000n);
    expect(settled.accountRoot).not.toBe(initial.accountRoot);
    // Client-supplied history is not among the reader's inputs.
    expect(initial.facts.volumeUsd).toBe(0n);
  } finally {
    ledger.close();
    await closeRuntimeDb(env);
    await closeInfraDb(env);
    for (const suffix of ['', '-storage-current', '-storage-previous', '-wal', '-history-views', '-infra']) {
      rmSync(join(dbRootPath, namespace + suffix), { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
