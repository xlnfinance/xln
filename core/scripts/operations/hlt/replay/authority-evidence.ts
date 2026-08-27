import { createHash } from 'node:crypto';

import { safeStringify } from '../../../../protocol/serialization';
import type { EntityTx } from '../../../../types/entity-tx';
import type { AccountTx } from '../../../../types/account';
import type { PersistedFrameJournal } from '../../../../storage/types';
import type {
  HltAuthorityFrameOracle,
  HltCertifiedAccountFrame,
  HltCertifiedEntityFrame,
} from './authority-frame-oracle';
import {
  buildHltEntityEffectEvidence,
  type HltEntityEffectEvidence,
} from './entity-effect-evidence';

type HltOperationKind =
  | 'direct_payment'
  | 'htlc'
  | 'swap'
  | 'rebalance_policy'
  | 'j_event_claim';

type HltOperationStage = Readonly<{
  runtimeHeight: number;
  ownerEntityId: string;
  counterpartyId: string;
  accountHeight: number;
  accountStateHash: string;
  accountStateRoot: string;
  txIndex: number;
  txType: AccountTx['type'];
}>;

export type HltEconomicOperationLedger = Readonly<{
  operations: readonly Readonly<{
    key: string;
    kind: HltOperationKind;
    stages: readonly HltOperationStage[];
  }>[];
  coverage: Readonly<{
    directPayments: number;
    htlcLocks: number;
    htlcResolves: number;
    rebalancePolicies: number;
    swapOffers: number;
    swapResolves: number;
    jEventClaims: number;
    accountSettledEvents: number;
  }>;
}>;

export type HltAuthorityExpectations = Readonly<{
  runtimeFrames: readonly Readonly<{
    height: number;
    timestamp: number;
    postStateHash: string;
    runtimeStateHash: string | null;
  }>[];
  entityFrames: readonly HltCertifiedEntityFrame[];
  accountFrames: readonly Readonly<{
    runtimeHeight: number;
    entityId: string;
    counterpartyId: string;
    accountHeight: number;
    stateHash: string;
    accountStateRoot: string;
    txTypes: readonly AccountTx['type'][];
  }>[];
  effects: readonly Readonly<{
    runtimeHeight: number;
    outputCount: number;
    orderedOutputDigest: string;
  }>[];
  /** Ordered Entity economic effects, distinct from signed events and Runtime outbox. */
  entityEffects: readonly HltEntityEffectEvidence[];
}>;

export type HltAuthorityEvidence = Readonly<{
  expectations: HltAuthorityExpectations;
  economicOperations: HltEconomicOperationLedger;
}>;

const nestedEntityTxs = (tx: EntityTx): readonly EntityTx[] => {
  if (tx.type === 'entityCommand') return tx.data.txs;
  if (tx.type === 'runtimeOutput') {
    return tx.data.entityTxs;
  }
  return [];
};

const assertFeaturePolicy = (
  frames: readonly PersistedFrameJournal[],
  accountFrames: readonly HltCertifiedAccountFrame[],
): void => {
  const inspectEntityTx = (tx: EntityTx): void => {
    if (
      tx.type === 'disputeStart' || tx.type === 'disputeFinalize' ||
      tx.type === 'crossPullClose' || tx.type.startsWith('crossJurisdiction') ||
      tx.type.startsWith('lending') || tx.type === 'runtimeOutput'
    ) throw new Error(`HLT_AUTHORITY_FEATURE_POLICY_ENTITY_TX_FORBIDDEN:${tx.type}`);
    for (const nested of nestedEntityTxs(tx)) inspectEntityTx(nested);
  };
  for (const frame of frames) {
    for (const input of frame.runtimeInput.entityInputs) {
      for (const tx of input.entityTxs ?? []) inspectEntityTx(tx);
      for (const tx of input.proposedFrame?.txs ?? []) inspectEntityTx(tx);
    }
  }
  for (const record of accountFrames) {
    for (const tx of record.frame.accountTxs) {
      if (
        tx.type.startsWith('lending_') || tx.type.startsWith('cross_') ||
        tx.type === 'reserve_to_collateral'
      ) throw new Error(`HLT_AUTHORITY_FEATURE_POLICY_ACCOUNT_TX_FORBIDDEN:${tx.type}`);
      if (tx.type === 'swap_offer' && tx.data.crossJurisdiction !== undefined) {
        throw new Error('HLT_AUTHORITY_FEATURE_POLICY_CROSS_J_SWAP_FORBIDDEN');
      }
    }
  }
};

const directKey = (tx: Extract<AccountTx, { type: 'direct_payment' }>): string =>
  `direct:${createHash('sha256').update(safeStringify(tx.data)).digest('hex')}`;

const operationKey = (tx: AccountTx, record: HltCertifiedAccountFrame): Readonly<{
  key: string;
  kind: HltOperationKind;
}> | null => {
  if (tx.type === 'direct_payment') return { key: directKey(tx), kind: 'direct_payment' };
  if (tx.type === 'htlc_lock' || tx.type === 'htlc_resolve') return { key: `lock:${tx.data.lockId}`, kind: 'htlc' };
  if (tx.type === 'swap_offer' || tx.type === 'swap_resolve' || tx.type === 'swap_cancel_request') {
    return { key: `swap:${tx.data.offerId}`, kind: 'swap' };
  }
  if (tx.type === 'rebalance_policy') {
    return {
      key: `rebalance:${record.entityId}:${record.counterpartyId}:${tx.data.tokenId}:${tx.data.policyVersion}`,
      kind: 'rebalance_policy',
    };
  }
  if (tx.type === 'j_event_claim') {
    return {
      key: `j-event:${record.entityId}:${record.counterpartyId}:${tx.data.jHeight}:${tx.data.jBlockHash}`,
      kind: 'j_event_claim',
    };
  }
  return null;
};

export const buildHltAuthorityEvidence = (
  frames: readonly PersistedFrameJournal[],
  oracle: HltAuthorityFrameOracle,
): HltAuthorityEvidence => {
  assertFeaturePolicy(frames, oracle.accountFrames);
  const grouped = new Map<string, { key: string; kind: HltOperationKind; stages: HltOperationStage[] }>();
  const coverage = {
    directPayments: 0,
    htlcLocks: 0,
    htlcResolves: 0,
    rebalancePolicies: 0,
    swapOffers: 0,
    swapResolves: 0,
    jEventClaims: 0,
    accountSettledEvents: 0,
  };
  for (const record of oracle.accountFrames) {
    record.frame.accountTxs.forEach((tx, txIndex) => {
      const operation = operationKey(tx, record);
      if (!operation) return;
      const row = grouped.get(operation.key) ?? { ...operation, stages: [] };
      if (row.kind !== operation.kind) throw new Error(`HLT_AUTHORITY_OPERATION_KIND_CONFLICT:${operation.key}`);
      row.stages.push({
        runtimeHeight: record.runtimeHeight,
        ownerEntityId: record.entityId,
        counterpartyId: record.counterpartyId,
        accountHeight: record.frame.height,
        accountStateHash: record.frame.stateHash,
        accountStateRoot: record.frame.accountStateRoot,
        txIndex,
        txType: tx.type,
      });
      grouped.set(operation.key, row);
      if (tx.type === 'direct_payment') coverage.directPayments += 1;
      if (tx.type === 'htlc_lock') coverage.htlcLocks += 1;
      if (tx.type === 'htlc_resolve') coverage.htlcResolves += 1;
      if (tx.type === 'rebalance_policy') coverage.rebalancePolicies += 1;
      if (tx.type === 'swap_offer') coverage.swapOffers += 1;
      if (tx.type === 'swap_resolve') coverage.swapResolves += 1;
      if (tx.type === 'j_event_claim') {
        coverage.jEventClaims += 1;
        coverage.accountSettledEvents += tx.data.events.filter(event => event.type === 'AccountSettled').length;
      }
    });
  }
  const entityFrames = [...oracle.entityFrames].sort((left, right) =>
    left.runtimeHeight - right.runtimeHeight || left.entityId.localeCompare(right.entityId) || left.entityHeight - right.entityHeight);
  const accountFrames = oracle.accountFrames.map(record => ({
    runtimeHeight: record.runtimeHeight,
    entityId: record.entityId,
    counterpartyId: record.counterpartyId,
    accountHeight: record.frame.height,
    stateHash: record.frame.stateHash,
    accountStateRoot: record.frame.accountStateRoot,
    txTypes: record.frame.accountTxs.map(tx => tx.type),
  })).sort((left, right) => left.runtimeHeight - right.runtimeHeight ||
    left.entityId.localeCompare(right.entityId) || left.accountHeight - right.accountHeight);
  return {
    expectations: {
      runtimeFrames: frames.map(frame => ({
        height: frame.height,
        timestamp: frame.timestamp,
        postStateHash: frame.postStateHash,
        runtimeStateHash: frame.runtimeStateHash ?? null,
      })),
      entityFrames,
      accountFrames,
      effects: frames.map(frame => ({
        runtimeHeight: frame.height,
        outputCount: frame.runtimeOutputCount,
        orderedOutputDigest: frame.runtimeOutputsDigest,
      })),
      entityEffects: frames.map(frame => buildHltEntityEffectEvidence(frame.height, frame.logs)),
    },
    economicOperations: {
      operations: [...grouped.values()].map(row => ({
        ...row,
        stages: row.stages.sort((left, right) => left.runtimeHeight - right.runtimeHeight ||
          left.accountHeight - right.accountHeight || left.txIndex - right.txIndex),
      })).sort((left, right) => left.key.localeCompare(right.key)),
      coverage,
    },
  };
};

export const assertCompleteHltAuthorityEvidence = (evidence: HltAuthorityEvidence): void => {
  const missing = Object.entries(evidence.economicOperations.coverage)
    .filter(([, count]) => count < 1)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`HLT_AUTHORITY_EVIDENCE_COVERAGE_MISSING:${missing.join(',')}`);
};
