import { describe, expect, test } from 'bun:test';

import {
  deserializeWsMessage,
  hashHelloMessage,
  resolveRuntimeWsRelayAudience,
  serializeWsMessage,
} from '../network/p2p/ws-protocol';
import {
  decodeRuntimeAdapterBrowserMessage,
  encodeRuntimeAdapterMessageForBrowser,
} from '../api/runtime-adapter/codec';
import { decodeBinaryPayload, encodeBinaryPayload } from '../storage/codec/binary-codec';

describe('global network protocol version', () => {
  test('adds version 1 to every serialized peer envelope', () => {
    const encoded = serializeWsMessage({ type: 'ping' });

    expect(decodeBinaryPayload(encoded)).toEqual({ type: 'ping', v: 1 });
    expect(deserializeWsMessage(encoded)).toEqual({ type: 'ping' });
  });

  test('rejects missing and incompatible peer versions before routing', () => {
    expect(() => deserializeWsMessage(encodeBinaryPayload({ type: 'ping' })))
      .toThrow('WS_MESSAGE_VERSION_INVALID');
    expect(() => deserializeWsMessage(encodeBinaryPayload({ type: 'ping', v: 2 })))
      .toThrow('WS_MESSAGE_VERSION_INVALID');
  });

  test('pins hello authentication to protocol version 1', () => {
    expect(hashHelloMessage(
      '0x1111111111111111111111111111111111111111',
      `0x${'22'.repeat(32)}`,
      1_700_000_000_000,
      'nonce-1',
      'wss://xln.finance/relay',
    )).toBe('0x4434ed36645e6be2c9cae9321c1bd2f3032399ab3e40abb613dcddba46a98640');
  });

  test('binds reverse-proxy relay challenges to the configured public audience', () => {
    expect(resolveRuntimeWsRelayAudience(
      'ws://runtime-internal:8080/relay',
      'ws://127.0.0.1:8080/relay',
      'wss://xln.finance/relay',
    )).toBe('wss://xln.finance/relay');
    expect(resolveRuntimeWsRelayAudience(
      'ws://untrusted-host:8080/relay',
      'ws://127.0.0.1:8080/relay',
    )).toBeNull();
  });
});

describe('browser-readable rAdapter output', () => {
  test('uses validated tagged JSON for server output without accepting JSON commands', () => {
    const response = { v: 1 as const, inReplyTo: 'read-1', ok: true as const, payload: { amount: 7n } };
    const readable = encodeRuntimeAdapterMessageForBrowser(response);

    expect(typeof readable).toBe('string');
    expect(readable).toContain('"inReplyTo":"read-1"');
    expect(decodeRuntimeAdapterBrowserMessage(readable)).toEqual(response);
  });
});
