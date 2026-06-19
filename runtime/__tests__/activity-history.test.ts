import { describe, expect, test } from 'bun:test';
import { buildRuntimeActivityEvents, dedupeRuntimeActivityEvents } from '../activity-history';

const alice = `0x${'aa'.repeat(32)}`;
const bob = `0x${'bb'.repeat(32)}`;
const hub = `0x${'cc'.repeat(32)}`;

describe('runtime activity history', () => {
  test('describes direct payment from the viewed entity perspective', () => {
    const events = buildRuntimeActivityEvents({
      height: 7,
      timestamp: 1_700_000_000_000,
      runtimeInput: {
        runtimeTxs: [],
        entityInputs: [{
          entityId: alice,
          signerId: alice,
          entityTxs: [{
            type: 'directPayment',
            data: {
              targetEntityId: bob,
              tokenId: 1,
              amount: 123n,
              route: [alice, hub, bob],
            },
          }],
        }],
      },
      logs: [],
    }, { entityId: alice });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      height: 7,
      kind: 'offchain',
      type: 'payment',
      direction: 'out',
      title: 'Payment sent',
      amount: '123',
      tokenId: 1,
      counterpartyId: hub,
    });
  });

  test('includes cross-j swap lifecycle events when route mentions the entity', () => {
    const route = {
      orderId: 'cross-order-1',
      status: 'resting',
      source: { entityId: alice, counterpartyEntityId: hub, tokenId: 1, amount: 1000n },
      target: { entityId: bob, counterpartyEntityId: hub, tokenId: 3, amount: 900n },
    };

    const events = buildRuntimeActivityEvents({
      height: 11,
      timestamp: 1_700_000_010_000,
      runtimeInput: {
        runtimeTxs: [],
        entityInputs: [{
          entityId: hub,
          signerId: hub,
          entityTxs: [{
            type: 'commitCrossJurisdictionSwap',
            data: { route },
          }],
        }],
      },
      logs: [],
    } as any, { entityId: bob, types: ['cross_swap'] });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'offchain',
      type: 'cross_swap',
      direction: 'in',
      title: 'Cross-j swap resting',
      orderId: 'cross-order-1',
      amount: '1000',
      quoteAmount: '900',
    });
  });

  test('filters on-chain logs by entity and kind', () => {
    const events = buildRuntimeActivityEvents({
      height: 15,
      timestamp: 1_700_000_020_000,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [{
        id: 1,
        timestamp: 1_700_000_020_000,
        level: 'info',
        category: 'jurisdiction',
        message: 'JEventReceived',
        entityId: alice,
        data: { entityId: alice, type: 'AccountSettled', amount: 33n, tokenId: 1 },
      }],
    }, { entityId: alice, kind: 'onchain' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'onchain',
      type: 'j_event',
      title: 'On-chain event received',
      amount: '33',
    });
  });

  test('exposes htlc receipts as payments while preserving htlc filter alias', () => {
    const journal = {
      height: 21,
      timestamp: 1_700_000_030_000,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [{
        id: 2,
        timestamp: 1_700_000_030_000,
        level: 'info',
        category: 'entity',
        message: 'HtlcReceived',
        entityId: bob,
        data: { entityId: bob, fromEntity: hub, toEntity: bob, amount: 7n * 10n ** 18n, tokenId: 1 },
      }],
    };

    const paymentEvents = buildRuntimeActivityEvents(journal, { entityId: bob, types: ['payment'] });
    const htlcAliasEvents = buildRuntimeActivityEvents(journal, { entityId: bob, types: ['htlc'] });

    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0]).toMatchObject({
      kind: 'offchain',
      type: 'payment',
      title: 'Payment received',
      status: 'received',
      amount: '7000000000000000000',
    });
    expect(htlcAliasEvents).toHaveLength(1);
  });

  test('expands accountInput frame transactions into payment history', () => {
    const events = buildRuntimeActivityEvents({
      height: 25,
      timestamp: 1_700_000_035_000,
      runtimeInput: {
        runtimeTxs: [],
        entityInputs: [{
          entityId: alice,
          signerId: alice,
          entityTxs: [{
            type: 'accountInput',
            data: {
              kind: 'frame',
              fromEntityId: alice,
              toEntityId: hub,
              newAccountFrame: {
                height: 4,
                timestamp: 1_700_000_035_000,
                jHeight: 9,
                prevFrameHash: '0xprev',
                stateHash: '0xstate',
                accountTxs: [{
                  type: 'htlc_lock',
                  data: {
                    lockId: 'lock-1',
                    hashlock: '0xhash',
                    timelock: 1_700_000_045_000n,
                    revealBeforeHeight: 44,
                    amount: 7n * 10n ** 18n,
                    tokenId: 1,
                  },
                }],
                deltas: [],
              },
              newHanko: '0xhanko',
            },
          }],
        }],
      },
      logs: [],
    } as any, { entityId: alice, types: ['payment'] });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'offchain',
      type: 'payment',
      direction: 'out',
      title: 'Payment sent',
      status: 'locked',
      amount: '7000000000000000000',
      tokenId: 1,
      counterpartyId: hub,
      rawType: 'htlc_lock',
    });
  });

  test('deduplicates repeated htlc lifecycle logs by hashlock', () => {
    const first = buildRuntimeActivityEvents({
      height: 31,
      timestamp: 1_700_000_040_000,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [{
        id: 7,
        timestamp: 1_700_000_040_000,
        level: 'info',
        category: 'entity',
        message: 'HtlcFinalized',
        data: { entityId: alice, fromEntity: alice, toEntity: hub, hashlock: '0xhash', amount: 7n * 10n ** 18n, tokenId: 1 },
      }],
    }, { entityId: alice, types: ['payment'] });
    const repeated = buildRuntimeActivityEvents({
      height: 32,
      timestamp: 1_700_000_041_000,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      logs: [{
        id: 8,
        timestamp: 1_700_000_041_000,
        level: 'info',
        category: 'entity',
        message: 'HtlcFinalized',
        data: { entityId: alice, fromEntity: alice, toEntity: hub, hashlock: '0xhash', amount: 7n * 10n ** 18n, tokenId: 1 },
      }],
    }, { entityId: alice, types: ['payment'] });

    const events = dedupeRuntimeActivityEvents([...repeated, ...first]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      height: 31,
      title: 'Payment finalized',
      hash: '0xhash',
    });
  });
});
