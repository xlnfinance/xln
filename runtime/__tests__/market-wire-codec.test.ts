import { describe, expect, test } from 'bun:test';
import { keccak256, toUtf8Bytes } from 'ethers';

import {
  decodeMarketWireMessage,
  encodeMarketWireMessage,
} from '../relay/market-wire';

describe('frontend market JSON protocol', () => {
  const snapshotEnvelope = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    v: 1,
    type: 'market_snapshot',
    id: 'market-snapshot-1',
    timestamp: 1,
    payload: {
      format: 'exact-price-levels',
      hubEntityId: `0x${'11'.repeat(32)}`,
      pairId: '1/2',
      depth: 20,
      displayDecimals: 4,
      priceScale: '10000',
      bucketWidthTicks: '1',
      bids: [{ price: '10000', size: '5', total: '5' }],
      asks: [{ price: '10001', size: '7', total: '7' }],
      spread: '1',
      spreadPercent: '0.010',
      source: 'orderbookExt',
      entityHeight: 3,
      entityStateHash: `0x${'22'.repeat(32)}`,
      hubUpdatedAt: 4,
      updatedAt: 5,
      ...overrides,
    },
  });

  test('adds global protocol version and pins readable bytes', () => {
    const encoded = encodeMarketWireMessage({
      type: 'market_snapshot_request',
      id: 'market-1',
    });

    expect(encoded).toBe('{"id":"market-1","type":"market_snapshot_request","v":1}');
    expect(keccak256(toUtf8Bytes(encoded)))
      .toBe('0x5018cb9c8363bbf92434185ad69b8b3e5988b93d12af2e98f50c46af331aa8ed');
    expect(decodeMarketWireMessage(encoded)).toEqual({
      type: 'market_snapshot_request',
      id: 'market-1',
    });
  });

  test('rejects missing/wrong version, unknown fields, and malformed variants', () => {
    expect(() => decodeMarketWireMessage('{"type":"market_snapshot_request","id":"x"}'))
      .toThrow('MARKET_WIRE_VERSION_INVALID');
    expect(() => decodeMarketWireMessage('{"v":2,"type":"market_snapshot_request","id":"x"}'))
      .toThrow('MARKET_WIRE_VERSION_INVALID');
    expect(() => decodeMarketWireMessage('{"v":1,"type":"market_snapshot_request","id":"x","extra":true}'))
      .toThrow('MARKET_WIRE_FIELDS_INVALID');
    expect(() => decodeMarketWireMessage('{"v":1,"type":"market_subscribe","id":"x","depth":"20"}'))
      .toThrow('MARKET_WIRE_DEPTH_INVALID');
  });

  test('rejects semantically invalid exact market snapshots at the wire boundary', () => {
    expect(decodeMarketWireMessage(snapshotEnvelope()).type).toBe('market_snapshot');
    expect(() => decodeMarketWireMessage(snapshotEnvelope({
      bids: [{ price: 'not-an-integer', size: '5', total: '5' }],
    }))).toThrow('MARKET_WIRE_LEVEL_PRICE_INVALID');
    expect(() => decodeMarketWireMessage(snapshotEnvelope({ hubEntityId: 'hub-alias' })))
      .toThrow('MARKET_WIRE_SNAPSHOT_hubEntityId_INVALID');
    expect(() => decodeMarketWireMessage(snapshotEnvelope({ pairId: '2/1' })))
      .toThrow('MARKET_WIRE_SNAPSHOT_pairId_INVALID');
  });
});
