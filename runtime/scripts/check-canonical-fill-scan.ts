#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

import {
  CROSS_J_MAX_FILL_RATIO,
  getCrossJurisdictionCommittedFillAmounts,
  getCrossJurisdictionCommittedProofRatio,
  projectCrossJurisdictionQuantizedClaim,
  validateCrossJurisdictionFillProgress,
  withCrossJurisdictionClaimProgress,
} from '../cross-jurisdiction';
import { buildCrossJurisdictionPendingFillFromAck } from '../extensions/cross-j/fill-ack';
import { HASHLADDER_MAX_FILL_RATIO } from '../protocol/htlc/hash-ladder';
import { MAX_SWAP_FILL_RATIO, exactFillRatioToUint16 } from '../orderbook/swap-execution';
import { UINT16_MAX } from '../constants';
import type { AccountTx, CrossJurisdictionSwapRoute } from '../types';

const readText = (path: string): string => readFileSync(path, 'utf8');

const requireCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const assertIncludes = (text: string, needle: string, path: string): void => {
  if (!text.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
};

const assertNotMatches = (text: string, pattern: RegExp, path: string): void => {
  const match = text.match(pattern);
  if (match) throw new Error(`${path} contains forbidden raw ratio literal: ${match[0]}`);
};

const assertThrows = (fn: () => unknown, expected: string): void => {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    requireCondition(message.includes(expected), `expected ${expected}, got ${message}`);
    return;
  }
  throw new Error(`expected throw containing ${expected}`);
};

const makeRoute = (overrides: Partial<CrossJurisdictionSwapRoute> = {}): CrossJurisdictionSwapRoute => ({
  orderId: 'canonical-fill-scan',
  source: {
    jurisdiction: 'stack:1:0x1111111111111111111111111111111111111111',
    entityId: 'source-user',
    counterpartyEntityId: 'source-hub',
    tokenId: 2,
    amount: 40_000_000_000_000_000n,
  },
  target: {
    jurisdiction: 'stack:2:0x2222222222222222222222222222222222222222',
    entityId: 'target-hub',
    counterpartyEntityId: 'target-user',
    tokenId: 1,
    amount: 100_000_000_000_000_000_000n,
  },
  status: 'resting',
  createdAt: 1_000,
  updatedAt: 1_000,
  expiresAt: 61_000,
  ...overrides,
} as CrossJurisdictionSwapRoute);

requireCondition(UINT16_MAX === 0xffff, 'UINT16_MAX must be uint16 max');
requireCondition(MAX_SWAP_FILL_RATIO === UINT16_MAX, 'swap fill ratio must be uint16 max');
requireCondition(HASHLADDER_MAX_FILL_RATIO === UINT16_MAX, 'hash-ladder fill ratio must be uint16 max');
requireCondition(CROSS_J_MAX_FILL_RATIO === UINT16_MAX, 'cross-j fill ratio must be uint16 max');

const quarterProofRatio = exactFillRatioToUint16({ numerator: 1n, denominator: 4n });
requireCondition(quarterProofRatio === 16_384, `unexpected quarter proof ratio ${quarterProofRatio}`);

const exactOnlyRoute = makeRoute({
  cumulativeFillRatio: 0,
  claimedRatio: 0,
  fillNumerator: 1n,
  fillDenominator: 4n,
});
const committed = getCrossJurisdictionCommittedFillAmounts(exactOnlyRoute);
requireCondition(committed.fillRatio === quarterProofRatio, 'exact-only route must project proof ratio');
requireCondition(committed.filledSourceAmount === 10_000_000_000_000_000n, 'source economics must stay exact');
requireCondition(committed.filledTargetAmount === 25_000_000_000_000_000_000n, 'target economics must stay exact');
requireCondition(
  (committed.sourceTotal * BigInt(committed.fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO) !== committed.filledSourceAmount,
  'scan fixture must prove exact economics are not rehydrated from uint16',
);

const progress = validateCrossJurisdictionFillProgress(makeRoute(), {
  fillSeq: 1,
  cumulativeFillRatio: 0,
  fillNumerator: 1n,
  fillDenominator: 4n,
  cumulativeSourceAmount: 10_000_000_000_000_000n,
  cumulativeTargetAmount: 25_000_000_000_000_000_000n,
});
if (!progress.ok) {
  throw new Error(`exact fill progress rejected: ${progress.error}`);
}
requireCondition(progress.value.nextRatio === quarterProofRatio, 'fill progress must derive exact proof ratio');
requireCondition(progress.value.incrementalSourceAmount === 10_000_000_000_000_000n, 'fill progress source increment drifted');
requireCondition(progress.value.incrementalTargetAmount === 25_000_000_000_000_000_000n, 'fill progress target increment drifted');

const claimed = withCrossJurisdictionClaimProgress(exactOnlyRoute, quarterProofRatio, 2_000);
requireCondition(claimed.sourceClaimed === committed.filledSourceAmount, 'claim progress must reuse exact source amount');
requireCondition(claimed.targetClaimed === committed.filledTargetAmount, 'claim progress must reuse exact target amount');

const pendingAck = buildCrossJurisdictionPendingFillFromAck({
  type: 'cross_swap_fill_ack',
  data: {
    offerId: exactOnlyRoute.orderId,
    fillSeq: 1,
    cumulativeFillRatio: 0,
    fillNumerator: 1n,
    fillDenominator: 4n,
    incrementalSourceAmount: 10_000_000_000_000_000n,
    incrementalTargetAmount: 25_000_000_000_000_000_000n,
    cumulativeSourceAmount: 10_000_000_000_000_000n,
    cumulativeTargetAmount: 25_000_000_000_000_000_000n,
    executionSourceAmount: 10_000_000_000_000_000n,
    executionTargetAmount: 25_000_000_000_000_000_000n,
    cancelRemainder: false,
  },
} as Extract<AccountTx, { type: 'cross_swap_fill_ack' }>, 2_000);
if (!pendingAck) {
  throw new Error('pending fill ACK was not built');
}
requireCondition(pendingAck?.cumulativeFillRatio === quarterProofRatio, 'pending fill ACK must derive exact proof ratio');
requireCondition(getCrossJurisdictionCommittedProofRatio(pendingAck) === quarterProofRatio, 'pending fill must be proof-ratio readable');

assertThrows(
  () => projectCrossJurisdictionQuantizedClaim(100n, {
    cumulativeFillRatio: 0,
    fillNumerator: 1n,
    orderId: 'canonical-fill-scan',
  }),
  'CROSS_J_EXACT_FILL_RATIO_INCOMPLETE:canonical-fill-scan',
);
const invalidProgress = validateCrossJurisdictionFillProgress(makeRoute(), {
  fillSeq: 1,
  cumulativeFillRatio: 0,
  fillNumerator: 5n,
  fillDenominator: 4n,
});
if (invalidProgress.ok) {
  throw new Error('invalid exact fill progress must not be accepted');
}
requireCondition(
  invalidProgress.error === 'CROSS_J_EXACT_FILL_RATIO_INVALID:canonical-fill-scan:5/4',
  `unexpected invalid exact fill progress error: ${invalidProgress.error}`,
);

for (const [path, markers] of [
  ['runtime/entity-consensus.ts', [
    'export const MAX_PENDING_CROSS_J_FILL_ACKS = 1024;',
    'const prunePendingCrossJurisdictionFillAcks =',
    'pending.size < MAX_PENDING_CROSS_J_FILL_ACKS',
    'targetSize = Math.max(0, MAX_PENDING_CROSS_J_FILL_ACKS - 1)',
    "entityLog.warn('crossj.fill_ack_stash_pruned'",
    "entityLog.warn('crossj.fill_ack_ttl_expired_preserved'",
    'preserveEvidence: true',
    'Do not delete this pending ack silently',
  ]],
  ['runtime/cross-jurisdiction.ts', [
    'getCrossJurisdictionCommittedProofRatio',
    'getCrossJurisdictionCommittedFillAmounts',
    'readCrossJurisdictionExactFillRatio',
    'Runtime order progress is exact.',
    'uint16 projection used by hash-ladder/dispute plumbing',
  ]],
  ['runtime/extensions/cross-j/fill-ack.ts', [
    'getCrossJurisdictionCommittedProofRatio',
    'const getCrossJurisdictionFillAckProofRatio',
  ]],
  ['runtime/extensions/cross-j/orderbook.ts', [
    'getCrossJurisdictionCommittedFillAmounts',
    'exactFillRatioToUint16',
    'Keep settlement amounts exact.',
  ]],
  ['runtime/entity/tx/handlers/account-cross-j-followups.ts', [
    'getCrossJurisdictionCommittedProofRatio',
    'applyCrossJurisdictionFillProgress',
    'CROSS_J_MAX_FILL_RATIO',
  ]],
  ['runtime/entity/tx/handlers/cross-j-book-order.ts', [
    'applyCrossJurisdictionFillProgress',
    'getCrossJurisdictionCommittedProofRatio',
  ]],
  ['runtime/entity/tx/handlers/cross-j-salvage.ts', [
    'getCrossJurisdictionCommittedProofRatio',
    'CROSS_J_MAX_FILL_RATIO',
  ]],
  ['runtime/__tests__/audit-failfast-regressions.test.ts', [
    'MAX_PENDING_CROSS_J_FILL_ACKS',
    'pendingCrossJurisdictionFillAcks = new Map();',
    'expect(cappedPending?.size).toBe(MAX_PENDING_CROSS_J_FILL_ACKS);',
    "entry.tx.data.offerId === orderId && entry.tx.data.fillSeq === 1",
  ]],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

for (const path of [
  'runtime/runtime-ascii.ts',
  'runtime/proof-builder.ts',
  'runtime/networking/gossip-helper.ts',
  'runtime/networking/gossip.ts',
] as const) {
  assertNotMatches(readText(path), /\b65_535\b|\b65535\b/, path);
}

const auditDocPath = 'docs/security/canonical-fill-scan.md';
const auditDoc = readText(auditDocPath);
for (const marker of [
  '# Canonical Fill Scan',
  'Last refreshed: 2026-07-09',
  'bun run security:canonical-fill',
  'Exact bigint amounts are the source of truth',
  'proof projections for hash-ladder and dispute plumbing',
]) {
  assertIncludes(auditDoc, marker, auditDocPath);
}

console.log('canonical fill scan check passed');
