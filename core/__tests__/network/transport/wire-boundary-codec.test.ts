import { XLN_PROTOCOL_VERSION } from '../../../protocol/version';
import { afterEach, describe, expect, test } from 'bun:test';
import { keccak256 } from 'ethers';

import {
  DEFAULT_MAX_WS_MESSAGE_BYTES,
  deserializeWsMessage,
  resolveRuntimeWsMaxMessageBytes,
  serializeWsMessage,
  serializeWsMessageForDebug,
  type RuntimeWsMessage,
} from '../../../network/p2p/ws-protocol';
import {
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
} from '../../../api/runtime-adapter/codec';
import {
  assertRuntimeAdapterCommandTxAuthorized,
  markLocalRuntimeAdapterCommandTx,
} from '../../../runtime/command/frontier-auth';
import { encodeBinaryPayload } from '../../../protocol/serialization/binary-codec';
import type { RuntimeTx } from '../../../runtime/types';
import type { RuntimeAdapterWireMessage } from '../../../api/runtime-adapter/wire-schema';

const previousWsMax = process.env['XLN_WS_MAX_MESSAGE_BYTES'];
const previousRadapterMax = process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];

afterEach(() => {
  if (previousWsMax === undefined) delete process.env['XLN_WS_MAX_MESSAGE_BYTES'];
  else process.env['XLN_WS_MAX_MESSAGE_BYTES'] = previousWsMax;
  if (previousRadapterMax === undefined) delete process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'];
  else process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = previousRadapterMax;
});

describe('WebSocket trusted decode boundary', () => {
  test('pins every canonical envelope variant to an independent golden hash', () => {
    const variants = {
      hello: { type: 'hello', from: 'a', fromEncryptionPubKey: 'k', timestamp: 1 },
      hello_challenge: { type: 'hello_challenge', challenge: 'c', audience: 'xln-runtime:test' },
      hello_ack: { type: 'hello_ack', to: 'a' },
      entity_inputs: { type: 'entity_inputs', id: 'entity-1', from: 'a', to: 'b', payload: new Uint8Array([1, 2, 3]), encrypted: true },
      debug_event: { type: 'debug_event', payload: { level: 'info' } },
      gossip_request: { type: 'gossip_request', from: 'a', payload: {} },
      gossip_response: { type: 'gossip_response', from: 'a', payload: {} },
      gossip_announce: { type: 'gossip_announce', from: 'a', payload: {} },
      gossip_update: { type: 'gossip_update', from: 'a', payload: {} },
      recovery_bundle_request: { type: 'recovery_bundle_request', from: 'a', to: 'b', payload: { lookupKey: 'k' } },
      recovery_bundle_response: { type: 'recovery_bundle_response', from: 'b', to: 'a', payload: {} },
      error: { type: 'error', error: 'e' },
      ping: { type: 'ping' },
      pong: { type: 'pong' },
    } satisfies Record<string, RuntimeWsMessage>;
    const expected = {
      hello: '0x7d1cdf738ad92df1102294c0ba3f3905565ec647fee53fd8c6bd86e34b6ee30a',
      hello_challenge: '0xb0f776a1452bd5053220e1cd415889f3ea2ad691d93bd20c5adbc7437e1237b4',
      hello_ack: '0xd646382e68b53131842a9e6bc94d300b15db9da985358ac1960303fbad226364',
      entity_inputs: '0xaa281d3de87c89a267adf1b71f922f41db6b4634e161eb421a236d7b7ac67163',
      debug_event: '0x1ab877491e9781ac22ff85db90c642a19c45a00bb700e95bbcc455ca8a3b0e6a',
      gossip_request: '0x2c28d91481c0ef4716bf88d9ec05b16efa22d1dcf12ea7d7b8b95cecd03ecd68',
      gossip_response: '0x3a53351d8615b708c228206c90323713a1e5f1a72b6c6ee2c8d518535ca296a1',
      gossip_announce: '0xed0c41139f2d34527396fd9680803102bc35ee744d172d601265e91a6c6036c2',
      gossip_update: '0x7266cb9f2bbd2a02d53e30d1417cad37310332d74bca3babe36b96f6501e5520',
      recovery_bundle_request: '0x0f74f0ebd99eeb631a403a9a6a74fe6c9e62293b50c66b11b8f59fcb9f42f9c4',
      recovery_bundle_response: '0x4a89fd210cadfbc82c3e7f5a3bbf8f09367e30e6b751c32a7e36c9c242d69ca5',
      error: '0x402d41a3aed08327cf662964a20e65d5d9e549f371687abe1340390d2a2fd3d9',
      ping: '0x2dc0089c6e599d87d53ea3b8d2b22453ce87dbda787842434fb3c2511b0ebfcb',
      pong: '0x2fd07c58cdf34bee955037ac41e0be62e255d423b5ebf3848e13b64755ff1368',
    } as const;

    expect(Object.fromEntries(Object.entries(variants).map(([name, value]) => [
      name,
      keccak256(serializeWsMessage(value)),
    ]))).toEqual(expected);
  });

  test('accepts canonical MessagePack and keeps tagged JSON output-only', () => {
    const message = { type: 'debug_event' as const, payload: { amount: 7n } };
    expect(deserializeWsMessage(serializeWsMessage(message))).toEqual(message);
    expect(() => deserializeWsMessage(serializeWsMessageForDebug(message)))
      .toThrow('WS_WIRE_BINARY_REQUIRED');
  });

  test('rejects every non-MessagePack binary envelope before peer payload decoding', () => {
    const debugEnvelope = new Uint8Array([0x02, 0x00]);
    expect(() => deserializeWsMessage(debugEnvelope))
      .toThrow('WS_WIRE_MESSAGEPACK_REQUIRED:magic=2');
  });

  test.each([
    ['null', null],
    ['array', []],
    ['unknown type', { type: 'wat' }],
    ['missing type', {}],
    ['type-confused hello source', { type: 'hello', from: 7, fromEncryptionPubKey: '02aa', timestamp: 1 }],
    ['missing encrypted entity payload', { type: 'entity_inputs', from: 'a', to: 'b', encrypted: true }],
    ['type-confused tick timestamp', { type: 'ping', timestamp: '1' }],
    ['unknown envelope field', { type: 'ping', surprise: true }],
  ])('rejects %s before routing', (_label, value) => {
    expect(() => deserializeWsMessage(encodeBinaryPayload(value)))
      .toThrow(/WS_MESSAGE_/);
  });

  test('rejects oversized payload before MessagePack decoding', () => {
    process.env['XLN_WS_MAX_MESSAGE_BYTES'] = '4';
    expect(() => deserializeWsMessage(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff])))
      .toThrow('WS_MESSAGE_TOO_LARGE:bytes=5:max=4');
  });

  test('uses one exact 256 MiB authenticated cap for direct and relay frame envelopes', () => {
    delete process.env['XLN_WS_MAX_MESSAGE_BYTES'];
    expect(resolveRuntimeWsMaxMessageBytes()).toBe(256 * 1024 * 1024);
    expect(DEFAULT_MAX_WS_MESSAGE_BYTES).toBe(resolveRuntimeWsMaxMessageBytes());

    const atLimit = new Uint8Array(DEFAULT_MAX_WS_MESSAGE_BYTES);
    atLimit[0] = 0x00;
    expect(() => deserializeWsMessage(atLimit)).toThrow('WS_WIRE_MESSAGEPACK_REQUIRED');
    expect(() => deserializeWsMessage(new Uint8Array(DEFAULT_MAX_WS_MESSAGE_BYTES + 1)))
      .toThrow(`WS_MESSAGE_TOO_LARGE:bytes=${DEFAULT_MAX_WS_MESSAGE_BYTES + 1}:max=${DEFAULT_MAX_WS_MESSAGE_BYTES}`);
  });
});

describe('rAdapter trusted decode boundary', () => {
  test('pins every canonical envelope variant to an independent golden hash', () => {
    const variants = {
      auth: { v: XLN_PROTOCOL_VERSION, id: 'a', op: 'auth', challenge: `0x${'11'.repeat(32)}` },
      read: { v: XLN_PROTOCOL_VERSION, id: 'r', op: 'read', path: 'head', query: { atHeight: 1 } },
      send: {
        v: XLN_PROTOCOL_VERSION,
        id: 's',
        op: 'send',
        commandId: 'command-00000001',
        commandSequence: 1,
        input: { runtimeTxs: [], entityInputs: [] },
      },
      ok: { v: XLN_PROTOCOL_VERSION, inReplyTo: 'r', ok: true, payload: { height: 1 } },
      error: {
        v: XLN_PROTOCOL_VERSION,
        inReplyTo: 'r',
        ok: false,
        error: { code: 'E_BAD_QUERY', message: 'bad', retryable: false },
      },
      tick: { v: XLN_PROTOCOL_VERSION, op: 'tick', height: 1, commandReady: true, commandReadyReason: null },
    } satisfies Record<string, RuntimeAdapterWireMessage>;
    const expected = {
      auth: '0x89b559a9513a25b21aed3d0d06e25fb0c1d388c9adaf1e82da61a533fe3a8b5c',
      read: '0x35a60583df70e8aa7778c2791b058b3a10d3fe3a25f218dc3932b8c4171f4692',
      send: '0x50e7a3006cc2646eb8dbbd37c3c87209bea163b7732fcd147a963f32bcc70386',
      ok: '0x281dc0a21601fba2eb93c599257a704a460b6d785d4971bc22461391f8af84fe',
      error: '0x81327bd0cbe0f4cd84b494e1f29c8017da136e171a5c4b3cdebe3e61e848f4f3',
      tick: '0x232677f7fa2520c665e153131505113a9c779f659f62cd8eee5707d740bbdef2',
    } as const;

    expect(Object.fromEntries(Object.entries(variants).map(([name, value]) => [
      name,
      keccak256(encodeRuntimeAdapterMessage(value)),
    ]))).toEqual(expected);
  });

  test('accepts exact request, response, and push variants', () => {
    const messages = [
      { v: XLN_PROTOCOL_VERSION as const, id: 'auth-1', op: 'auth' as const, challenge: `0x${'11'.repeat(32)}` },
      { v: XLN_PROTOCOL_VERSION as const, inReplyTo: 'auth-1', ok: true as const, payload: { authLevel: 'inspect' } },
      {
        v: XLN_PROTOCOL_VERSION as const,
        op: 'tick' as const,
        height: 9,
        commandReady: false,
        commandReadyReason: 'phase=halted',
      },
    ];
    for (const message of messages) {
      expect(decodeRuntimeAdapterMessage(encodeRuntimeAdapterMessage(message))).toEqual(message);
    }
  });

  test('rejects every non-MessagePack binary envelope before rAdapter payload decoding', () => {
    const debugEnvelope = new Uint8Array([0x02, 0x00]);
    expect(() => decodeRuntimeAdapterMessage(debugEnvelope))
      .toThrow('RADAPTER_WIRE_MESSAGEPACK_REQUIRED:magic=2');
  });

  test.each([
    ['JSON text', '{"v":1,"id":"x","op":"read","path":"head"}'],
    ['null', encodeBinaryPayload(null)],
    ['array', encodeBinaryPayload([])],
    ['unknown op', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, id: 'x', op: 'wat' })],
    ['missing request id', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, op: 'read', path: 'head' })],
    ['missing read path', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, id: 'x', op: 'read' })],
    ['type-confused tick height', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, op: 'tick', height: '9' })],
    ['missing tick readiness', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, op: 'tick', height: 9 })],
    ['type-confused response status', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, inReplyTo: 'x', ok: 'true', payload: null })],
    ['missing send input arrays', encodeBinaryPayload({
      v: XLN_PROTOCOL_VERSION,
      id: 'x',
      op: 'send',
      commandId: 'command-00000001',
      commandSequence: 1,
      input: {},
    })],
    ['unknown request field', encodeBinaryPayload({
      v: XLN_PROTOCOL_VERSION,
      id: 'x',
      op: 'read',
      path: 'head',
      surprise: true,
    })],
  ])('rejects %s before handling', (_label, raw) => {
    expect(() => decodeRuntimeAdapterMessage(raw)).toThrow(/RADAPTER_(?:WIRE|REQUEST|RESPONSE|PUSH)/);
  });

  test('rejects oversized payload before MessagePack decoding', () => {
    process.env['XLN_RADAPTER_MAX_MESSAGE_BYTES'] = '4';
    expect(() => decodeRuntimeAdapterMessage(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff])))
      .toThrow('RADAPTER_MESSAGE_TOO_LARGE: bytes=5 max=4');
  });

  test('wire decoding cannot recreate local command authority', () => {
    const authorized = markLocalRuntimeAdapterCommandTx({
      type: 'recordRuntimeAdapterCommand',
      data: {
        laneId: `0x${'11'.repeat(32)}`,
        sequence: 1,
        commandId: 'command-00000001',
        inputHash: `0x${'22'.repeat(32)}`,
        expiresAtMs: null,
      },
    });
    const plainMarker = { ...authorized } as RuntimeTx;
    const decoded = decodeRuntimeAdapterMessage<{
      payload: { attemptedMarker: RuntimeTx };
    }>(encodeRuntimeAdapterMessage({
      v: XLN_PROTOCOL_VERSION,
      inReplyTo: 'send-1',
      ok: true,
      payload: { attemptedMarker: plainMarker },
    }));

    expect(Object.getOwnPropertySymbols(decoded.payload.attemptedMarker)).toHaveLength(0);
    expect(() => assertRuntimeAdapterCommandTxAuthorized(decoded.payload.attemptedMarker, false))
      .toThrow('RADAPTER_COMMAND_RUNTIME_TX_UNAUTHORIZED');
  });
});
