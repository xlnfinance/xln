import { describe, expect, test } from 'bun:test';

import {
  buildEntityConsensusSettingsView,
} from '../../frontend/src/lib/components/Entity/entity-consensus-settings';
import type { EntityReplica, EntityTx, Proposal } from '../types';

const signer = `0x${'11'.repeat(20)}`;
const recipient = `0x${'22'.repeat(32)}`;
const hashlock = `0x${'33'.repeat(32)}`;

const preparedPayment = (): Extract<EntityTx, { type: 'htlcPayment' }> => ({
  type: 'htlcPayment',
  data: {
    targetEntityId: recipient,
    tokenId: 7,
    amount: 1_000n,
    route: [`0x${'aa'.repeat(32)}`, recipient],
    deliveryMode: 'instant',
    secret: `0x${'44'.repeat(32)}`,
    hashlock,
    preparedEnvelope: { nextHop: recipient, innerEnvelope: { ciphertext: 'never-project-me' } },
    preparedSenderLockAmount: '1025',
    preparedTotalFee: '25',
    preparedLockId: `0x${'55'.repeat(32)}`,
    preparedTimelock: '500',
    preparedRevealBeforeHeight: 499,
    preparedRouteProfiles: [],
    preparedHopForwardAmounts: [],
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
  isProposer: true,
  mempool: [],
  state: {
    entityId: `0x${'aa'.repeat(32)}`,
    height: 9,
    timestamp: 123,
    prevFrameHash: `0x${'99'.repeat(32)}`,
    lastFinalizedJHeight: 42,
    nonces: new Map(),
    messages: [],
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
    entityEncPubKey: '',
    entityEncPrivKey: '',
    profile: { name: 'Payment board', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
  },
}) as EntityReplica;

describe('Entity Consensus payment projection', () => {
  test('shows exact public prepared payment intent without secret or ciphertext', () => {
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
      totalDebit: 1_025n,
      totalFee: 25n,
      deliveryMode: 'instant',
    });
    expect(Object.keys(payment ?? {})).not.toContain('secret');
    expect(Object.keys(payment ?? {})).not.toContain('preparedEnvelope');
  });

  test('fails loudly when a prepared payment omits an exact public amount', () => {
    const malformed = preparedPayment();
    delete malformed.data.preparedTotalFee;

    expect(() => buildEntityConsensusSettingsView(replica(malformed), 19, true))
      .toThrow('CONSENSUS_SETTINGS_HTLC_PREPARED_FEE_INVALID:proposal=prop-payment:tx=0');
  });

  test('fails loudly when exact debit does not equal recipient amount plus fee', () => {
    const malformed = preparedPayment();
    malformed.data.preparedSenderLockAmount = '1026';

    expect(() => buildEntityConsensusSettingsView(replica(malformed), 19, true))
      .toThrow('CONSENSUS_SETTINGS_HTLC_TOTAL_MISMATCH:proposal=prop-payment:tx=0');
  });
});
