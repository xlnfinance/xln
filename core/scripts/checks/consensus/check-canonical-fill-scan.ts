#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

import {
  CROSS_J_MAX_FILL_RATIO,
  getCrossJurisdictionCommittedFillAmounts,
  getCrossJurisdictionCommittedProofRatio,
  validateCrossJurisdictionFillProgress,
} from '../../../extensions/cross-j';
import { HASHLADDER_MAX_FILL_RATIO } from '../../../protocol/htlc/hash-ladder';
import { MAX_SWAP_FILL_RATIO, exactFillRatioToUint16 } from '../../../orderbook/swap-execution';
import { UINT16_MAX } from '../../../config/constants';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';

const readText = (path: string): string => {
  if (path !== 'core/__tests__/audit-failfast-regressions.test.ts') return readFileSync(path, 'utf8');
  return [
    'core/__tests__/testing/audit/audit-failfast-regressions-part-1.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-2.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-3.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-4.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-5.test.ts',
    'core/__tests__/testing/audit/audit-failfast-regressions-part-6.test.ts',
  ].map(file => readFileSync(file, 'utf8')).join('\n');
};

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

const exactRoute = makeRoute({
  cumulativeFillRatio: quarterProofRatio,
  claimedRatio: quarterProofRatio,
  fillNumerator: 1n,
  fillDenominator: 4n,
});
const committed = getCrossJurisdictionCommittedFillAmounts(exactRoute);
requireCondition(committed.fillRatio === quarterProofRatio, 'exact route must project one proof ratio');
requireCondition(committed.filledSourceAmount === 10_000_000_000_000_000n, 'source economics must stay exact');
requireCondition(committed.filledTargetAmount === 25_000_000_000_000_000_000n, 'target economics must stay exact');
requireCondition(
  (committed.sourceTotal * BigInt(committed.fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO) !== committed.filledSourceAmount,
  'scan fixture must prove exact economics are not rehydrated from uint16',
);

const progress = validateCrossJurisdictionFillProgress(makeRoute(), {
  fillSeq: 1,
  cumulativeFillRatio: quarterProofRatio,
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

assertThrows(
  () => getCrossJurisdictionCommittedProofRatio({
    orderId: 'coarse-only',
    cumulativeFillRatio: 1,
  }),
  'CROSS_J_EXACT_FILL_RATIO_REQUIRED:coarse-only',
);
assertThrows(
  () => getCrossJurisdictionCommittedProofRatio({
    orderId: 'coarse-exact-divergence',
    cumulativeFillRatio: quarterProofRatio - 1,
    fillNumerator: 1n,
    fillDenominator: 4n,
  }),
  'CROSS_J_COARSE_EXACT_RATIO_MISMATCH:coarse-exact-divergence',
);
const missingExactProgress = validateCrossJurisdictionFillProgress(makeRoute(), {
  fillSeq: 1,
  cumulativeFillRatio: quarterProofRatio,
});
requireCondition(
  !missingExactProgress.ok && missingExactProgress.error === 'CROSS_J_EXACT_FILL_RATIO_REQUIRED:canonical-fill-scan',
  `coarse-only fill must fail loud: ${missingExactProgress.ok ? 'accepted' : missingExactProgress.error}`,
);

for (const [path, markers] of [
  ['core/extensions/cross-j/index.ts', [
    'getCrossJurisdictionCommittedProofRatio',
    'getCrossJurisdictionCommittedFillAmounts',
    'readCrossJurisdictionExactFillRatio',
    'Runtime order progress is exact.',
    'uint16 projection used by hash-ladder/dispute plumbing',
  ]],
  ['core/extensions/cross-j/orderbook.ts', [
    'getCrossJurisdictionCommittedFillAmounts',
    'exactFillRatioToUint16',
    'single\n  // representation shared by the cooperative close, the ladder reveal and the\n  // on-chain dispute',
  ]],
  ['core/entity/tx/handlers/account-cross-j-followups.ts', [
    'getCrossJurisdictionCommittedProofRatio',
    'applyCrossJurisdictionFillProgress',
    'CROSS_J_MAX_FILL_RATIO',
  ]],
  ['core/entity/tx/handlers/cross-j/book-order.ts', [
    'applyCrossJurisdictionFillProgress',
    'getCrossJurisdictionCommittedProofRatio',
  ]],
  ['core/entity/tx/handlers/cross-j/salvage.ts', [
    'verifyHashLadderBinary',
    'verifiedFillRatio !== claimedFillRatio',
    'Off-chain fill progress is informational only',
  ]],
] as const) {
  const text = readText(path);
  for (const marker of markers) assertIncludes(text, marker, path);
}

for (const path of [
  'core/qa/runtime-ascii.ts',
  'core/protocol/dispute/proof-builder.ts',
  'core/network/p2p/gossip/helper.ts',
  'core/entity/profile/index.ts',
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
