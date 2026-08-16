/**
 * Exact completion authority for production swap-load runs. A matched order is
 * not settled until both Account replicas and every participating Runtime are
 * drained; this boundary prevents matcher throughput from masquerading as TPS.
 */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';

export type ProductionSwapSettlementEvidence = Readonly<{
  expectedSwaps: number;
  tradeCountBefore: number;
  tradeCountAfter: number;
  matchedElapsedMs: number;
  fullySettledElapsedMs: number;
  createdOfferIds: readonly string[];
  accounts: readonly AccountSettlementEvidence[];
  runtimes: readonly RuntimeSettlementEvidence[];
  bestBidPriceTicks: bigint | null;
  bestAskPriceTicks: bigint | null;
}>;

type AccountSettlementEvidence = Readonly<{
  accountKey: string;
  createdOfferIds: readonly string[];
  committedOfferIds: readonly string[];
  committedResolveIds: readonly string[];
  liveOfferIds: readonly string[];
  pendingFrame: boolean;
  pendingProposal: boolean;
  mempoolTxs: number;
}>;

type RuntimeSettlementEvidence = Readonly<{
  role: 'hub' | 'load' | 'market-maker';
  processing: number;
  pendingOutputs: number;
  pendingNetworkOutputs: number;
  networkInbox: number;
  runtimeEntityInputs: number;
  runtimeTxs: number;
  runtimeJInputs: number;
  retryEntries: number;
  pendingReceipts: number;
}>;

export type ProductionSwapSettlementRates = Readonly<{
  matchedTps: number;
  fullySettledTps: number;
}>;

const requireBoolean = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

const requireString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(code);
  return value;
};

const requireUniqueStrings = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value)) throw new Error(code);
  const decoded = value.map((entry, index) => requireString(entry, `${code}:${index}`));
  if (new Set(decoded).size !== decoded.length) throw new Error(`${code}_DUPLICATE`);
  return decoded;
};

const decodeAccountEvidence = (value: unknown, index: number): AccountSettlementEvidence => {
  const account = requireBoundaryRecord(value, `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_INVALID:${index}`);
  requireExactBoundaryKeys(account, [
    'accountKey', 'createdOfferIds', 'committedOfferIds', 'committedResolveIds',
    'liveOfferIds', 'pendingFrame', 'pendingProposal', 'mempoolTxs',
  ], [], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_FIELDS_INVALID:${index}`);
  return {
    accountKey: requireString(account['accountKey'], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_KEY_INVALID:${index}`),
    createdOfferIds: requireUniqueStrings(account['createdOfferIds'], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_CREATED_INVALID:${index}`),
    committedOfferIds: requireUniqueStrings(account['committedOfferIds'], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_OFFERS_INVALID:${index}`),
    committedResolveIds: requireUniqueStrings(account['committedResolveIds'], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_RESOLVES_INVALID:${index}`),
    liveOfferIds: requireUniqueStrings(account['liveOfferIds'], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_LIVE_INVALID:${index}`),
    pendingFrame: requireBoolean(account['pendingFrame'], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_FRAME_INVALID:${index}`),
    pendingProposal: requireBoolean(account['pendingProposal'], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_PROPOSAL_INVALID:${index}`),
    mempoolTxs: requireBoundaryInteger(account['mempoolTxs'], `PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_MEMPOOL_INVALID:${index}`),
  };
};

const decodeRuntimeEvidence = (value: unknown, index: number): RuntimeSettlementEvidence => {
  const runtime = requireBoundaryRecord(value, `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_INVALID:${index}`);
  requireExactBoundaryKeys(runtime, [
    'role', 'processing', 'pendingOutputs', 'pendingNetworkOutputs', 'networkInbox',
    'runtimeEntityInputs', 'runtimeTxs', 'runtimeJInputs', 'retryEntries', 'pendingReceipts',
  ], [], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_FIELDS_INVALID:${index}`);
  const role = runtime['role'];
  if (role !== 'hub' && role !== 'load' && role !== 'market-maker') {
    throw new Error(`PRODUCTION_SWAP_SETTLEMENT_RUNTIME_ROLE_INVALID:${index}`);
  }
  return {
    role,
    processing: requireBoundaryInteger(runtime['processing'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_PROCESSING_INVALID:${index}`),
    pendingOutputs: requireBoundaryInteger(runtime['pendingOutputs'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_OUTPUTS_INVALID:${index}`),
    pendingNetworkOutputs: requireBoundaryInteger(runtime['pendingNetworkOutputs'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_NETWORK_INVALID:${index}`),
    networkInbox: requireBoundaryInteger(runtime['networkInbox'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_INBOX_INVALID:${index}`),
    runtimeEntityInputs: requireBoundaryInteger(runtime['runtimeEntityInputs'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_ENTITY_INPUTS_INVALID:${index}`),
    runtimeTxs: requireBoundaryInteger(runtime['runtimeTxs'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_TXS_INVALID:${index}`),
    runtimeJInputs: requireBoundaryInteger(runtime['runtimeJInputs'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_J_INPUTS_INVALID:${index}`),
    retryEntries: requireBoundaryInteger(runtime['retryEntries'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_RETRIES_INVALID:${index}`),
    pendingReceipts: requireBoundaryInteger(runtime['pendingReceipts'], `PRODUCTION_SWAP_SETTLEMENT_RUNTIME_RECEIPTS_INVALID:${index}`),
  };
};

const requireOptionalBigInt = (value: unknown, code: string): bigint | null => {
  if (value === null || typeof value === 'bigint') return value;
  throw new Error(code);
};

export const decodeProductionSwapSettlementEvidence = (
  value: unknown,
): ProductionSwapSettlementEvidence => {
  const evidence = requireBoundaryRecord(value, 'PRODUCTION_SWAP_SETTLEMENT_INVALID');
  requireExactBoundaryKeys(evidence, [
    'expectedSwaps', 'tradeCountBefore', 'tradeCountAfter', 'matchedElapsedMs',
    'fullySettledElapsedMs', 'createdOfferIds', 'accounts', 'runtimes',
    'bestBidPriceTicks', 'bestAskPriceTicks',
  ], [], 'PRODUCTION_SWAP_SETTLEMENT_FIELDS_INVALID');
  if (!Array.isArray(evidence['accounts']) || !Array.isArray(evidence['runtimes'])) {
    throw new Error('PRODUCTION_SWAP_SETTLEMENT_COLLECTIONS_INVALID');
  }
  return {
    expectedSwaps: requireBoundaryInteger(evidence['expectedSwaps'], 'PRODUCTION_SWAP_SETTLEMENT_EXPECTED_INVALID', 1),
    tradeCountBefore: requireBoundaryInteger(evidence['tradeCountBefore'], 'PRODUCTION_SWAP_SETTLEMENT_TRADE_BEFORE_INVALID'),
    tradeCountAfter: requireBoundaryInteger(evidence['tradeCountAfter'], 'PRODUCTION_SWAP_SETTLEMENT_TRADE_AFTER_INVALID'),
    matchedElapsedMs: requireBoundaryInteger(evidence['matchedElapsedMs'], 'PRODUCTION_SWAP_SETTLEMENT_MATCHED_TIME_INVALID', 1),
    fullySettledElapsedMs: requireBoundaryInteger(evidence['fullySettledElapsedMs'], 'PRODUCTION_SWAP_SETTLEMENT_FULL_TIME_INVALID', 1),
    createdOfferIds: requireUniqueStrings(evidence['createdOfferIds'], 'PRODUCTION_SWAP_SETTLEMENT_CREATED_INVALID'),
    accounts: evidence['accounts'].map(decodeAccountEvidence),
    runtimes: evidence['runtimes'].map(decodeRuntimeEvidence),
    bestBidPriceTicks: requireOptionalBigInt(evidence['bestBidPriceTicks'], 'PRODUCTION_SWAP_SETTLEMENT_BID_INVALID'),
    bestAskPriceTicks: requireOptionalBigInt(evidence['bestAskPriceTicks'], 'PRODUCTION_SWAP_SETTLEMENT_ASK_INVALID'),
  };
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every(id => right.includes(id));

export const assertProductionSwapFullySettled = (
  evidence: ProductionSwapSettlementEvidence,
): ProductionSwapSettlementRates => {
  if (evidence.tradeCountAfter - evidence.tradeCountBefore !== evidence.expectedSwaps) {
    throw new Error('PRODUCTION_SWAP_SETTLEMENT_TRADE_DELTA_MISMATCH');
  }
  if (evidence.createdOfferIds.length < evidence.expectedSwaps) {
    throw new Error('PRODUCTION_SWAP_SETTLEMENT_CREATED_COUNT_INVALID');
  }
  const accountIds = evidence.accounts.flatMap(account => account.createdOfferIds);
  if (!sameIds(evidence.createdOfferIds, accountIds) || new Set(accountIds).size !== accountIds.length) {
    throw new Error('PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_COVERAGE_MISMATCH');
  }
  for (const account of evidence.accounts) {
    if (!sameIds(account.createdOfferIds, account.committedOfferIds) ||
      !sameIds(account.createdOfferIds, account.committedResolveIds)) {
      throw new Error(`PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_COMMIT_INCOMPLETE:${account.accountKey}`);
    }
    if (account.liveOfferIds.length || account.pendingFrame || account.pendingProposal || account.mempoolTxs) {
      throw new Error(`PRODUCTION_SWAP_SETTLEMENT_ACCOUNT_NOT_DRAINED:${account.accountKey}`);
    }
  }
  const roles = evidence.runtimes.map(runtime => runtime.role);
  if (!sameIds(roles, ['hub', 'load', 'market-maker'])) {
    throw new Error('PRODUCTION_SWAP_SETTLEMENT_RUNTIME_COVERAGE_MISMATCH');
  }
  for (const runtime of evidence.runtimes) {
    const pending = runtime.processing + runtime.pendingOutputs + runtime.pendingNetworkOutputs +
      runtime.networkInbox + runtime.runtimeEntityInputs + runtime.runtimeTxs +
      runtime.runtimeJInputs + runtime.retryEntries + runtime.pendingReceipts;
    if (pending !== 0) throw new Error(`PRODUCTION_SWAP_SETTLEMENT_RUNTIME_NOT_DRAINED:${runtime.role}`);
  }
  if (evidence.bestBidPriceTicks !== null && evidence.bestAskPriceTicks !== null &&
    evidence.bestBidPriceTicks >= evidence.bestAskPriceTicks) {
    throw new Error('PRODUCTION_SWAP_SETTLEMENT_BOOK_CROSSED');
  }
  if (evidence.matchedElapsedMs > evidence.fullySettledElapsedMs) {
    throw new Error('PRODUCTION_SWAP_SETTLEMENT_TIMING_ORDER_INVALID');
  }
  return {
    matchedTps: evidence.expectedSwaps * 1_000 / evidence.matchedElapsedMs,
    fullySettledTps: evidence.expectedSwaps * 1_000 / evidence.fullySettledElapsedMs,
  };
};
