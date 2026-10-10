import { expect, test } from 'bun:test';
import type { EntityReplica, RuntimeAdapterViewFrame } from '../../../core/api/public/runtime-module';
import { createDefaultDelta } from '../../../core/account/state/delta';
import { deriveDelta } from '../../../core/account/utils';
import { createEmptyAccountJClaimAccumulator } from '../../../core/account/j-claims/j-claim-accumulator';
import {
  buildEntityPanelView,
  findReplicaForEntityTab,
} from '../../../frontend/src/lib/components/Entity/core/entity-panel-model';
import { buildPaymentPanelViewFromRuntimeView } from '../../../frontend/src/lib/components/Entity/payments/payment-panel-view';
import { buildAccountBalancesByToken } from '../../../frontend/src/lib/components/Entity/assets/entity-asset-values';
import type { ExternalToken } from '../../../frontend/src/lib/components/Entity/assets/entity-asset-catalog';
import {
  buildExternalWalletStateSyncSignature,
  buildOnchainReserves,
  readExternalWalletState,
} from '../../../frontend/src/lib/components/Entity/external-wallet-reader';

type ActiveEntity = NonNullable<RuntimeAdapterViewFrame['activeEntity']>;
type AccountDoc = ActiveEntity['accounts']['items'][number];
type Dispute = NonNullable<AccountDoc['activeDispute']>;

// Live callers retain the full replica type without manufacturing a live fixture.
findReplicaForEntityTab satisfies (
  replicas: Map<string, EntityReplica> | null | undefined,
  entityId: string,
  signerId: string,
) => EntityReplica | null;

const OWNER = `0x${'11'.repeat(32)}`;
const HUB = `0x${'22'.repeat(32)}`;
const SIGNER = `0x${'33'.repeat(20)}`;
const HASH = `0x${'44'.repeat(32)}`;

const accountDoc = (): AccountDoc => ({
  state: {
    leftEntity: OWNER,
    rightEntity: HUB,
    domain: { chainId: 31337, depositoryAddress: `0x${'55'.repeat(20)}` },
    watchSeed: '',
    deltas: new Map([[1, createDefaultDelta(1)]]),
    locks: new Map(),
    swapOffers: new Map(),
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 3,
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    jNonce: 4,
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
  },
  status: 'active',
  currentHeight: 5,
  currentFrame: {
    height: 5, timestamp: 1000, jHeight: 3, accountTxs: [],
    prevFrameHash: HASH, accountStateRoot: HASH, stateHash: HASH,
  },
  mempool: [],
  mempoolCount: 0,
  rollbackCount: 0,
  proofHeader: { fromEntity: OWNER, toEntity: HUB, nextProofNonce: 6 },
  pendingWithdrawals: new Map(),
  shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
});

const frameFor = (account: AccountDoc): RuntimeAdapterViewFrame => {
  const summary: ActiveEntity['summary'] = { entityId: OWNER, signerId: SIGNER, height: 7, label: 'Owner' };
  return {
    height: 7,
    head: {
      schemaVersion: 1, latestHeight: 7, latestMaterializedHeight: 7, latestSnapshotHeight: 0,
      snapshotPeriodFrames: 100, retainSnapshots: 1, epochMaxBytes: 1_048_576,
      accountMerkleRadix: 16, epochReplayBytes: 0, retainedWalBytes: 0,
    },
    entities: [summary, { entityId: HUB, height: 7, label: 'Hub' }],
    activeEntityId: OWNER,
    activeEntity: {
      summary,
      core: {
        entityId: OWNER, signerId: SIGNER, isProposer: true, height: 7, timestamp: 1000,
        nonces: new Map(), proposals: new Map(), entityEncryptionPublicKey: '',
        config: { mode: 'proposer-based', threshold: 1n, validators: [SIGNER], shares: { [SIGNER]: 1n } },
        reserves: new Map(), lastFinalizedJHeight: 3,
        profile: { name: 'Owner', isHub: false, avatar: '', bio: '', website: '' },
        paybook: { entries: new Map(), feesEarned: 0n },
      },
      accounts: { items: [account], nextCursor: null, totalItems: 1 },
      books: { items: [], nextCursor: null, totalItems: 0 },
    },
  };
};

const placeholder: Dispute = {
  startedByLeft: true, initialProofbodyHash: HASH, initialNonce: 5, initialProposerIsLeft: true,
  disputeTimeout: 0, jNonce: 4, starterCounterProofCommitment: HASH,
  observedOnChain: false, observedBlockNumber: 0, batchNonce: 2, finalizeQueued: false,
};

const observed: Dispute = {
  ...placeholder, disputeStartTimestamp: 800, disputeTimeout: 820,
  observedOnChain: true, observedBlockNumber: 77, selectedCounterNonce: 6,
  selectedCounterProofbodyHash: HASH, selectedCounterProposerIsLeft: false, finalizeQueued: true,
};

const cases: Array<{ name: string; lifecycle: Pick<AccountDoc, 'status' | 'activeDispute'> }> = [
  { name: 'unobserved placeholder', lifecycle: { status: 'active', activeDispute: placeholder } },
  { name: 'observed dispute', lifecycle: { status: 'disputed', activeDispute: observed } },
  { name: 'finalized closed account', lifecycle: { status: 'disputed' } },
];

for (const { name, lifecycle } of cases) {
  test(`compact ${name} preserves lifecycle and blocks payment without proof arguments`, () => {
    const doc: AccountDoc = { ...accountDoc(), ...lifecycle };
    const frame = frameFor(doc);
    const panel = buildEntityPanelView(null, OWNER, SIGNER, '', frame);
    const account = panel.replica?.state.accounts.get(HUB);
    if (!account) throw new Error('COMPACT_ACCOUNT_PROJECTION_MISSING');
    expect(panel.replica).not.toHaveProperty('mempool');
    expect(panel.replica?.state.accounts).not.toHaveProperty('rootHash');
    expect(account).toBe(doc);
    expect(account).not.toHaveProperty('history');
    expect(account.state.deltas).toBe(doc.state.deltas);
    expect(account.state.locks).toBe(doc.state.locks);
    expect(account.state.swapOffers).toBe(doc.state.swapOffers);
    for (const collection of [account.state.deltas, account.state.locks, account.state.swapOffers]) {
      expect(collection).not.toHaveProperty('rootHash');
    }
    expect(account.status).toBe(doc.status);
    expect(account.activeDispute).toEqual(doc.activeDispute);
    expect(account.state.jNonce).toBe(4);
    expect(account.currentHeight).toBe(5);
    expect(account.state.deltas.get(1)).toEqual(doc.state.deltas.get(1));
    expect(Object.keys(account.activeDispute ?? {})).not.toContain('starterInitialArguments');
    expect(Object.keys(account.activeDispute ?? {})).not.toContain('starterCounterArguments');
    const payment = buildPaymentPanelViewFromRuntimeView({ entityId: OWNER, frame });
    expect(payment.blockedCounterpartyIds).toEqual(new Set([HUB]));
    expect(payment.replicaMap.get(`${OWNER}:${SIGNER}`)?.state.accounts.has(HUB)).toBe(true);
  });
}

test('compact active account permits payment and preparing metadata survives Entity projection', () => {
  const active = accountDoc();
  const payment = buildPaymentPanelViewFromRuntimeView({ entityId: OWNER, frame: frameFor(active) });
  expect(payment.blockedCounterpartyIds.size).toBe(0);
  const preparing: AccountDoc = {
    ...active, status: 'dispute_preparing',
    disputePrepare: { startedAt: 1000, readyAfter: 2000, reason: 'owner request' },
  };
  const panel = buildEntityPanelView(null, OWNER, SIGNER, '', frameFor(preparing));
  const account = panel.replica?.state.accounts.get(HUB);
  if (!account) throw new Error('COMPACT_PREPARING_PROJECTION_MISSING');
  expect(account.status).toBe('dispute_preparing');
  expect(account.disputePrepare).toEqual(preparing.disputePrepare);
  expect(account.disputePrepare).not.toHaveProperty('startIntent');
  expect(account.disputePrepare).not.toHaveProperty('crossJurisdictionRecovery');
});

test('remote projection without a live environment preserves nonzero assets for display readers', () => {
  const doc = accountDoc();
  doc.state.deltas.set(1, {
    ...createDefaultDelta(1, { left: 20_000_000n }),
    collateral: 100_000_000n, ondelta: 60_000_000n, offdelta: -10_000_000n, leftHold: 5_000_000n,
  });
  const frame = frameFor(doc);
  if (!frame.activeEntity) throw new Error('REMOTE_ASSETS_ENTITY_MISSING');
  const tokenAddress = `0x${'66'.repeat(20)}`;
  const nativeAddress = `0x${'00'.repeat(20)}`;
  const tokens: ExternalToken[] = [{
    symbol: 'USDC', address: tokenAddress, balance: 0n, decimals: 6, tokenId: 1,
  }];
  frame.activeEntity.core.reserves.set(1, 70_000_000n);
  frame.activeEntity.core.externalWallet = {
    balances: new Map([[SIGNER, new Map([
      [nativeAddress, { tokenAddress: nativeAddress, balance: 500_000_000_000_000_000n, jHeight: 77 }],
      [tokenAddress, { tokenAddress, balance: 30_000_000n, jHeight: 77 }],
    ])]]),
    allowances: new Map(),
  };
  const panel = buildEntityPanelView(null, OWNER, SIGNER, '', frame);
  if (!panel.replica) throw new Error('REMOTE_ASSETS_PROJECTION_MISSING');
  const visible = panel.replica.state;
  expect(panel.runtimeId).toBeNull();
  expect(visible.reserves).toBe(frame.activeEntity.core.reserves);
  expect(buildOnchainReserves(visible.reserves, tokens)).toEqual(new Map([[1, 70_000_000n]]));
  expect(buildAccountBalancesByToken({
    accounts: visible.accounts, localEntityId: visible.entityId, deriveDelta,
  })).toEqual(new Map([[1, 50_000_000n]]));
  expect(visible.externalWallet).toBe(frame.activeEntity.core.externalWallet);
  expect(readExternalWalletState(visible.externalWallet, tokens, SIGNER, [])).toEqual({
    nativeBalance: 500_000_000_000_000_000n, balances: [30_000_000n], allowanceValues: [], sourceHeight: 77,
  });
  expect(buildExternalWalletStateSyncSignature(visible.externalWallet, SIGNER)).not.toBe('');
});
