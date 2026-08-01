import { createFrameHashSync } from '../../account/consensus/frame';
import { createSettlementWorkspaceHash } from '../../account/tx/handlers/settle-transition';
import { computeAccountStateRoot } from '../../account/state-root';
import { projectAccountDoc } from '../../storage/projections';
import type { StorageAccountDoc } from '../../storage/types';
import { makeAccount } from './cross-j';

const digest = (byte: string): string => `0x${byte.repeat(32)}`;

export type StorageAccountFixture = {
  doc: StorageAccountDoc;
  owner: string;
  counterparty: string;
};

export const makeStorageAccountFixture = (): StorageAccountFixture => {
  const owner = digest('11');
  const counterparty = digest('22');
  const account = makeAccount(owner, counterparty);
  const delta = account.state.deltas.get(1)!;
  account.state.locks.set('lock-1', {
    lockId: 'lock-1',
    hashlock: digest('31'),
    timelock: 2_000n,
    revealBeforeHeight: 20,
    amount: 7n,
    tokenId: 1,
    senderIsLeft: true,
    createdHeight: 1,
    createdTimestamp: 1_000,
  });
  account.state.pulls = new Map([['pull-1', {
    pullId: 'pull-1',
    tokenId: 1,
    amount: 5n,
    revealedUntilTimestamp: 3_000,
    fullHash: digest('32'),
    partialRoot: digest('33'),
    createdHeight: 1,
    createdTimestamp: 1_000,
  }]]);
  account.state.swapOffers.set('offer-1', {
    offerId: 'offer-1',
    giveTokenId: 1,
    giveAmount: 5n,
    wantTokenId: 2,
    wantAmount: 10n,
    makerIsLeft: true,
    createdHeight: 1,
  });
  account.state.subcontracts = new Map([['transformer-1', {
    transformerAddress: `0x${'44'.repeat(20)}`,
    encodedBatch: '0x1234',
    allowances: [{ deltaIndex: 0, rightAllowance: 1n, leftAllowance: 2n }],
  }]]);
  const workspaceBase = {
    workspaceHash: digest('00'),
    ops: [{ type: 'r2c' as const, tokenId: 1, amount: 1n }],
    lastModifiedByLeft: true,
    status: 'draft' as const,
    revision: 1,
    createdAt: 1_000,
    lastUpdatedAt: 1_000,
    executorIsLeft: true,
  };
  account.state.settlementWorkspace = {
    ...workspaceBase,
    workspaceHash: createSettlementWorkspaceHash(account.state, workspaceBase),
  };
  account.pendingWithdrawals.set('withdraw-1', {
    requestId: 'withdraw-1',
    tokenId: 1,
    amount: 3n,
    requestedAt: 1_000,
    direction: 'outgoing',
    status: 'pending',
  });
  account.proofBody = {
    tokenIds: [1],
    deltas: [delta.offdelta],
    htlcLocks: [{
      deltaIndex: 0,
      amount: 7n,
      revealedUntilTimestamp: 2_000,
      hash: digest('31'),
    }],
  };
  account.proofHeader.nextProofNonce = 1;
  account.currentHeight = 1;
  account.currentFrame = {
    height: 1,
    timestamp: 1_000,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: computeAccountStateRoot(account.state),
    stateHash: '',
    byLeft: account.state.leftEntity === owner,
    deltas: [{ ...delta }],
  };
  account.currentFrame.stateHash = createFrameHashSync(account.currentFrame);
  return { doc: projectAccountDoc(account), owner, counterparty };
};
