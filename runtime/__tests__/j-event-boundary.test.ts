import { describe, expect, test } from 'bun:test';

import { receiptFromEvents } from '../jadapter/browservm-submit';
import { rawEventToJEvents } from '../jadapter/helpers';
import type { JEvent } from '../jadapter/types';

const entityId = `0x${'11'.repeat(32)}`;

describe('J event canonical boundary', () => {
  test('normalizes valid watcher payloads before enqueue', () => {
    expect(
      rawEventToJEvents(
        {
          name: 'ReserveUpdated',
          args: { entity: entityId.toUpperCase(), tokenId: 7n, newBalance: 42n },
          blockNumber: 12,
        },
        entityId,
      ),
    ).toEqual([
      {
        type: 'ReserveUpdated',
        blockNumber: 12,
        data: { entity: entityId, tokenId: 7, newBalance: '42' },
      },
    ]);
  });

  test('rejects malformed canonical watcher payloads instead of dropping them later', () => {
    expect(() =>
      rawEventToJEvents(
        {
          name: 'ReserveUpdated',
          args: { entity: '', tokenId: 7n, newBalance: 42n },
          blockNumber: 12,
          transactionHash: `0x${'22'.repeat(32)}`,
        },
        entityId,
      ),
    ).toThrow('J_EVENT_CANONICAL_PAYLOAD_INVALID:ReserveUpdated');
  });

  test('never manufactures receipt coordinates for missing events', () => {
    expect(() => receiptFromEvents([])).toThrow('J_ADAPTER_RECEIPT_EVENTS_EMPTY');
  });

  test('rejects placeholder receipt coordinates at the witnessed boundary', () => {
    const event: JEvent = {
      name: 'ReserveUpdated',
      args: {},
      blockNumber: 0,
      blockHash: '0x',
      transactionHash: '0x',
      logIndex: 0,
    };
    expect(() => receiptFromEvents([event])).toThrow('J_ADAPTER_RECEIPT_COORDINATES_INVALID:0x:0');
  });
});
