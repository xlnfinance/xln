import { expect, test } from 'bun:test';

import { decodeRelaySocketFrame } from '../../../api/server/network/relay-frame';
import { serializeWsMessage } from '../../../network/p2p/ws-protocol';
import { encodeMarketWireMessage } from '../../../network/relay/market/wire';

test('a relay socket never decodes a binary non-peer frame as text', () => {
  const market = encodeMarketWireMessage({ type: 'market_snapshot_request', id: 'market-req-1' });
  expect(decodeRelaySocketFrame(market, false)).toMatchObject({ kind: 'market' });
  // The same request sent as bytes used to be decoded to text, twice per frame:
  // an unauthenticated 256 MiB frame cost about 1.5 GB of transient memory.
  expect(() => decodeRelaySocketFrame(new TextEncoder().encode(market), false)).toThrow();
  expect(decodeRelaySocketFrame(serializeWsMessage({ type: 'ping' }), false))
    .toEqual({ kind: 'peer', message: { type: 'ping' } });
});
