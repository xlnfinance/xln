import { describe, expect, test } from 'bun:test';

import {
  deserializeWsMessage,
  hashHelloMessage,
  serializeWsMessage,
} from '../network/p2p/ws-protocol';
import {
  decodeRuntimeAdapterBrowserMessage,
  encodeRuntimeAdapterMessageForBrowser,
} from '../api/runtime-adapter/codec';
import { decodeBinaryPayload, encodeBinaryPayload } from '../storage/binary-codec';

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
      {
        audience: 'xln-runtime:0x3333333333333333333333333333333333333333',
        initiatorRole: 'runtime-client',
        responderRole: 'direct-runtime-server',
        responderRuntimeId: '0x3333333333333333333333333333333333333333',
        responderEncryptionPubKey: `0x${'44'.repeat(32)}`,
        challenge: `0x${'55'.repeat(32)}`,
        challengeTimestamp: 1_699_999_999_000,
        initiatorRuntimeId: '0x1111111111111111111111111111111111111111',
        initiatorEncryptionPubKey: `0x${'22'.repeat(32)}`,
        timestamp: 1_700_000_000_000,
      },
    )).toBe('0x7c610749ddfc934b54eb8af81a702420cba85321683ee8f539f6cc276aad98d9');
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
