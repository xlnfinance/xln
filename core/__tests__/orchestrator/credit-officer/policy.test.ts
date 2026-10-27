import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREDIT_POLICY,
  creditDifficulty,
  creditUsd,
  scoreCredit,
  type CreditFacts,
} from '../../../orchestrator/credit-officer/policy';
import { CreditLedger } from '../../../orchestrator/credit-officer/ledger';
import {
  creditDay,
  decodeCreditRequest,
  validCreditProof,
  type CreditRequest,
} from '../../../orchestrator/credit-officer/proof';

const now = Date.UTC(2026, 9, 27);
const request: CreditRequest = {
  hubEntityId: `0x${'11'.repeat(32)}`,
  borrowerEntityId: `0x${'22'.repeat(32)}`,
  day: creditDay(now),
  tokenId: 1,
  amount: '50000000',
  termId: '1d',
  nonce: '0',
};
const facts: CreditFacts = {
  chainId: 31337,
  ageDays: 0,
  volumeUsd: 0n,
  repaid: 0,
  adverse: false,
  epochChanged: false,
  exposureUsd: 0n,
};

function mine(r: CreditRequest, bits = creditDifficulty(creditUsd(r.tokenId, BigInt(r.amount)))): CreditRequest {
  for (let nonce = 0; nonce < 10_000_000; nonce++) {
    const proof = { ...r, nonce: nonce.toString(16) };
    if (validCreditProof(proof, r.hubEntityId, Date.parse(`${r.day}T00:00:00Z`), bits)) return proof;
  }
  throw new Error('TEST_PROOF_EXHAUSTED');
}

test('new borrower gets $50; reputation tiers require all committed predicates', () => {
  expect(scoreCredit(request, facts, 0n).approved).toBe(true);
  expect(scoreCredit({ ...request, amount: '50000001' }, facts, 0n).reason).toBe('BORROWER_LIMIT');
  const established = { ...facts, ageDays: 30, volumeUsd: 1_000_000_000n, repaid: 3 };
  expect(scoreCredit({ ...request, amount: '500000000' }, established, 0n).approved).toBe(true);
  expect(scoreCredit({ ...request, amount: '100000000' }, { ...established, repaid: 0 }, 0n).approved).toBe(false);
  expect(
    scoreCredit({ ...request, amount: '100000000' }, { ...facts, ageDays: 7, volumeUsd: 100_000_000n, repaid: 1 }, 0n)
      .approved,
  ).toBe(true);
});

test('mainnet, adverse history, outstanding exposure and daily cap deny explicitly', () => {
  expect(scoreCredit(request, { ...facts, chainId: 1 }, 0n).reason).toBe('TESTNET_ONLY');
  expect(scoreCredit(request, { ...facts, epochChanged: true }, 0n).reason).toBe('ACCOUNT_EPOCH_REVIEW_REQUIRED');
  expect(scoreCredit(request, { ...facts, adverse: true }, 0n).reason).toBe('DEFAULT_OR_DISPUTE');
  expect(scoreCredit(request, { ...facts, exposureUsd: 1n }, 0n).reason).toBe('BORROWER_LIMIT');
  expect(scoreCredit(request, facts, CREDIT_POLICY.dailyCapUsd).reason).toBe('DAILY_LIMIT');
});

test('USD uses catalog rates, rounds dust up and scales hashcash difficulty', () => {
  expect(creditUsd(2, 10n ** 18n)).toBe(2_500_000_000n);
  expect(creditUsd(4, 10n ** 6n)).toBe(120_000n);
  expect(creditUsd(2, 1n)).toBe(1n);
  expect(() => creditUsd(999, 1n)).toThrow('USD_RATE_UNAVAILABLE');
  expect(creditDifficulty(50_000_000n)).toBe(16);
  expect(creditDifficulty(50_000_001n)).toBe(17);
  expect(creditDifficulty(500_000_000n)).toBe(20);
});

test('proof binds hub, borrower, UTC day, token, amount and term', () => {
  const proof = mine(request);
  expect(validCreditProof(proof, request.hubEntityId, now, 16)).toBe(true);
  expect(validCreditProof(proof, request.borrowerEntityId, now, 16)).toBe(false);
  expect(validCreditProof(proof, request.hubEntityId, now + 86_400_000, 16)).toBe(false);
  for (const changed of [
    { amount: '50000001' },
    { termId: '1h' as const },
    { tokenId: 4 },
    { borrowerEntityId: request.hubEntityId },
  ]) {
    expect(validCreditProof({ ...proof, ...changed }, request.hubEntityId, now, 16)).toBe(false);
  }
  expect(() => decodeCreditRequest({ ...proof, amount: '-1' })).toThrow('INVALID_AMOUNT');
  expect(() => decodeCreditRequest({ ...proof, nonce: 'a'.repeat(65) })).toThrow('INVALID_NONCE');
});

test('proof replay and allowance reservations survive database reopen and competing connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xln-credit-ledger-'));
  let ledger = new CreditLedger(join(dir, 'ledger.sqlite'));
  try {
    ledger.record(request, 50_000_000n, true, { request });
    ledger.close();
    ledger = new CreditLedger(join(dir, 'ledger.sqlite'));
    expect(ledger.spent(request)).toBe(50_000_000n);
    expect(() => ledger.record(request, 1n, true, {})).toThrow('PROOF_REUSED');
    const competitor = new CreditLedger(join(dir, 'ledger.sqlite'));
    try {
      expect(() => competitor.record({ ...request, nonce: '1' }, 1n, true, {}, 50_000_000n)).toThrow('DAILY_LIMIT');
    } finally {
      competitor.close();
    }
    expect(ledger.spent({ ...request, day: '2026-10-28' })).toBe(0n);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
