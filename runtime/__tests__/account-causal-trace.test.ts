import { describe, expect, test } from 'bun:test';
import { summarizeRuntimeAccountCausality } from '../infra/account-causal-trace';
import type { AccountInput, EntityInput } from '../types';

const frameAck = {
  kind: 'frame_ack',
  fromEntityId: '0xhub',
  toEntityId: '0xuser',
  domain: { chainId: 31337, depositoryAddress: '0xdep' },
  ack: { height: 10, frameHash: '0xack' },
  proposal: {
    frame: {
      height: 11,
      timestamp: 123,
      jHeight: 4,
      accountTxs: [{
        type: 'swap_resolve',
        data: { offerId: 'order-1', fillRatio: 65535, cancelRemainder: false },
      }],
      prevFrameHash: '0xprev',
      accountStateRoot: '0xroot',
      stateHash: '0xstate',
      deltas: [],
    },
  },
} as AccountInput;

describe('account causal trace', () => {
  test('shows a coalesced offer ACK and resolve proposal in one envelope', () => {
    const trace = summarizeRuntimeAccountCausality([{
      entityId: '0xuser',
      signerId: '0xsigner',
      entityTxs: [{ type: 'accountInput', data: frameAck }],
    }]);

    expect(trace).toHaveLength(1);
    expect(trace[0]?.accountEnvelopes).toEqual([{
      kind: 'frame_ack',
      from: '0xhub',
      to: '0xuser',
      ackHeight: 10,
      proposalHeight: 11,
      proposalTxs: [{ type: 'swap_resolve', offerId: 'order-1', fillRatio: 65535 }],
      hasSwapTx: true,
    }]);
  });

  test('shows the initiating Entity command and its offer id', () => {
    const input = {
      entityId: '0xuser',
      signerId: '0xsigner',
      entityTxs: [{
        type: 'placeSwapOffer',
        data: {
          counterpartyEntityId: '0xhub',
          offerId: 'order-2',
          giveTokenId: 1,
          giveAmount: 1n,
          wantTokenId: 2,
          wantAmount: 1n,
        },
      }],
    } as EntityInput;

    expect(summarizeRuntimeAccountCausality([input])[0]).toMatchObject({
      entityTxTypes: ['placeSwapOffer'],
      entityOfferIds: ['order-2'],
      accountEnvelopes: [],
    });
  });

  test('does not add noise for unrelated Entity inputs', () => {
    const input = {
      entityId: '0xuser',
      signerId: '0xsigner',
      entityTxs: [{ type: 'scheduledWake', data: { reason: 'account' } }],
    } as EntityInput;
    expect(summarizeRuntimeAccountCausality([input])).toEqual([]);
  });
});
