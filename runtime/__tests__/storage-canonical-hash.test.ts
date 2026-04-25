import { expect, test } from 'bun:test';

import { computeStorageCanonicalStateHashFromEnv } from '../storage';
import type { AccountMachine, EntityReplica, Env } from '../types';

const entityId = `0x${'11'.repeat(32)}`;
const counterpartyId = `0x${'22'.repeat(32)}`;

const makeAccount = (frameStateHash: string): AccountMachine =>
  ({
    leftEntity: entityId,
    rightEntity: counterpartyId,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '0x0',
      stateHash: '0x1',
      deltas: [],
    },
    deltas: new Map([[1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 10n,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
      leftAllowance: 0n,
      rightAllowance: 0n,
    }]]),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 1,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: entityId, toEntity: counterpartyId, nonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [{
      height: 1,
      timestamp: 100,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '0x0',
      stateHash: frameStateHash,
      deltas: [],
    }],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    rebalancePolicy: new Map(),
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    onChainSettlementNonce: 0,
  }) as AccountMachine;

const makeEnv = (account: AccountMachine, reserves: Array<[number, bigint]>): Env =>
  ({
    height: 7,
    timestamp: 1234,
    eReplicas: new Map<string, EntityReplica>([
      [`${entityId}:1`, {
        entityId,
        signerId: '1',
        mempool: [],
        isProposer: true,
        state: {
          entityId,
          height: 7,
          timestamp: 1234,
          messages: [],
          nonces: new Map([['1', 1]]),
          proposals: new Map(),
          config: { mode: 'proposer-based', threshold: 1n, validators: ['1'], shares: { '1': 1n } },
          reserves: new Map(reserves),
          accounts: new Map([[counterpartyId, account]]),
          deferredAccountProposals: new Map(),
          lastFinalizedJHeight: 0,
          jBlockObservations: [],
          jBlockChain: [],
          entityEncPubKey: 'pub',
          entityEncPrivKey: 'priv',
          profile: { name: 'canonical-test', isHub: false, avatar: '', bio: '', website: '' },
          htlcRoutes: new Map(),
          htlcFeesEarned: 0n,
          htlcNotes: new Map(),
          lockBook: new Map(),
          swapTradingPairs: [],
          pendingSwapFillRatios: new Map(),
        },
      } as EntityReplica],
    ]),
  }) as Env;

test('canonical storage hash is deterministic across Map insertion order', () => {
  const left = computeStorageCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[2, 20n], [1, 10n]]));
  const right = computeStorageCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 10n], [2, 20n]]));
  expect(left).toBe(right);
});

test('canonical storage hash ignores UI frameHistory and reacts to consensus state', () => {
  const base = computeStorageCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 10n]]));
  const changedHistory = computeStorageCanonicalStateHashFromEnv(makeEnv(makeAccount('history-b'), [[1, 10n]]));
  const changedReserve = computeStorageCanonicalStateHashFromEnv(makeEnv(makeAccount('history-a'), [[1, 11n]]));

  expect(changedHistory).toBe(base);
  expect(changedReserve).not.toBe(base);
});
