import { describe, expect, test } from 'bun:test';

import {
  buildEntityConsensusSettingsView,
} from '../../../../../frontend/src/lib/components/Entity/workspace/entity-consensus-settings';
import type { EntityReplica, Proposal } from '../../../../entity/types';
import type { EntityTx } from '../../../../types/entity-tx';

const signer = `0x${'11'.repeat(20)}`;
const recipient = `0x${'22'.repeat(32)}`;
const hashlock = `0x${'33'.repeat(32)}`;

const preparedPayment = (): Extract<EntityTx, { type: 'htlcPayment' }> => ({
  type: 'htlcPayment',
  data: {
    targetEntityId: recipient,
    tokenId: 7,
    amount: 1_000n,
    maxSenderDebit: 1_025n,
    route: [`0x${'aa'.repeat(32)}`, recipient],
    deliveryMode: 'instant',
    hashlock,
  },
});

const proposal = (payment: EntityTx): Proposal => ({
  id: 'prop-payment',
  proposer: signer,
  boardHash: `0x${'66'.repeat(32)}`,
  boardEpoch: 0,
  action: {
    type: 'entity_transaction',
    data: { version: 1, actionHash: `0x${'77'.repeat(32)}`, txs: [payment] },
  },
  actionHash: `0x${'88'.repeat(32)}`,
  votes: new Map([[signer, 'yes']]),
  status: 'pending',
  created: 123,
});

const replica = (payment: EntityTx): EntityReplica => ({
  entityId: `0x${'aa'.repeat(32)}`,
  signerId: signer,
  entityEncPubKey: '',
  isProposer: true,
  mempool: [],
  state: {
    entityId: `0x${'aa'.repeat(32)}`,
    height: 9,
    timestamp: 123,
    prevFrameHash: `0x${'99'.repeat(32)}`,
    lastFinalizedJHeight: 42,
    nonces: new Map(),
    proposals: new Map([['prop-payment', proposal(payment)]]),
    config: {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signer],
      shares: { [signer]: 1n },
    },
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    jBlockChain: [],
    profile: { name: 'Payment board', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    swapTradingPairs: [],
  },
}) as EntityReplica;

describe('Entity Consensus payment projection', () => {
  test('shows only the caller-authorized payment ceiling before frame preparation', () => {
    const view = buildEntityConsensusSettingsView(replica(preparedPayment()), 19, true, {
      resolveTokenMetadata: (tokenId) => tokenId === 7
        ? { symbol: 'USDC', name: 'USD Coin' }
        : null,
    });
    const payment = view.proposals[0]?.payments[0];

    expect(payment).toEqual({
      recipientEntityId: recipient,
      tokenId: 7,
      tokenSymbol: 'USDC',
      tokenName: 'USD Coin',
      recipientAmount: 1_000n,
      hashlock,
      maxSenderDebit: 1_025n,
      maxFee: 25n,
      deliveryMode: 'instant',
    });
    expect(Object.keys(payment ?? {})).not.toContain('envelope');
    expect(Object.keys(payment ?? {})).not.toContain('totalFee');
  });

  test('shows that the proposer will derive an omitted hashlock', () => {
    const malformed = preparedPayment();
    delete malformed.data.hashlock;

    expect(buildEntityConsensusSettingsView(replica(malformed), 19, true)
      .proposals[0]?.payments[0]?.hashlock).toBeNull();
  });

  test('fails loudly when the sender ceiling is below the recipient amount', () => {
    const malformed = preparedPayment();
    malformed.data.maxSenderDebit = 999n;

    expect(() => buildEntityConsensusSettingsView(replica(malformed), 19, true))
      .toThrow('CONSENSUS_SETTINGS_HTLC_MAX_SENDER_DEBIT_BELOW_AMOUNT:proposal=prop-payment:tx=0');
  });
});
