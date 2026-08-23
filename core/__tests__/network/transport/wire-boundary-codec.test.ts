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
      hello: '0xa2266ac52550c7a6572f2683a59cec61e35401706454dfd6e283017ab87ca126',
      hello_challenge: '0xb7ad3b3c5416530d7afd5cf502a756ea0f6314e25466e192a67679ae002a2c2c',
      hello_ack: '0xdb53ed3863ce99f39f991074cf39302aed0a85a7ee73e9a723015a7a26046f3e',
      entity_inputs: '0x5b6669d6114c03ed23d8eefdae3eba77f6e3c37d9465fdb620bbf2e89299a5d1',
      debug_event: '0xb7e04662f033f749a826f5610e6348eeac94d16cc9ee5cbde5b686d146ad5014',
      gossip_request: '0xe45579eefa154d217f4ecbac4828bd18dfe279bc2cba09060c22f78fe269cef2',
      gossip_response: '0xebac1b909b787e80f7ef97ba52f82b858e9bb00a72c15c2275ef747f0ef485eb',
      gossip_announce: '0xefcc260b1131872ae709039176921f74649af90351b442835dccb47d24d2d398',
      gossip_update: '0xac0e00c6926e1802e5b45214e8a89c2da535a5bcc0fdfa9f02e6aeac4f254cf5',
      recovery_bundle_request: '0x1718ab0de51643a4b606c34388a39227552fb7d675eddf772bf40341dd8ebb87',
      recovery_bundle_response: '0x47143e51336159e65cbc0235843a5cf3ceda2d4048ee62677e6d00aec98c5772',
      error: '0x7c5fe99f0d2b7bebe414579183923c7dc9a4d32a3896c67a859be2fdd051651e',
      ping: '0x2aa10d25163a8b043acacbb6836997c886adaf9f97ae32c3a078d62a347ef210',
      pong: '0x542d7c0b98506d78307da43a2db88c2f6196525f80f4b0d69c94a9776f3daf07',
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

  test('rejects a debug JSON binary envelope before peer payload decoding', () => {
    const debugEnvelope = encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, type: 'ping' }, 'json');

    expect(debugEnvelope[0]).toBe(0x02);
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
    expect(() => deserializeWsMessage(encodeBinaryPayload(value, 'msgpack')))
      .toThrow(/WS_MESSAGE_/);
  });

  test('rejects oversized payload before MessagePack decoding', () => {
    process.env['XLN_WS_MAX_MESSAGE_BYTES'] = '4';
    expect(() => deserializeWsMessage(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff])))
      .toThrow('WS_MESSAGE_TOO_LARGE:bytes=5:max=4');
  });

  test('uses one exact 32 MiB authenticated cap for direct and relay frame envelopes', () => {
    delete process.env['XLN_WS_MAX_MESSAGE_BYTES'];
    expect(resolveRuntimeWsMaxMessageBytes()).toBe(32 * 1024 * 1024);
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
      auth: '0x867117905ba13a6f04316fd2ec383c5aa7930d6471922845bec02b17db12a11b',
      read: '0x26cef89a17b9effd99fc9549d5bd262a434991a49300ec38002c5ce9545a9d88',
      send: '0x90bf7cc4bcc5b5ebe8ebb23ff5d9d828b76707da75ad42b1559e1dd2617f0476',
      ok: '0x16382c2a91f2683231b1fe278dd04a18f300450e4d364d583aceb3c23ab04e1b',
      error: '0x8361152a205ab89bde0114f3a69f683718cd2d2c4d57efc66065079b3b431be1',
      tick: '0xef45dd9834b3fbd4fd19e1ff475bc8eb1807e8041fdd4401031c212cba983fa0',
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

  test('rejects a debug JSON binary envelope before rAdapter payload decoding', () => {
    const debugEnvelope = encodeBinaryPayload({
      v: XLN_PROTOCOL_VERSION,
      id: 'read-1',
      op: 'read',
      path: 'head',
    }, 'json');

    expect(debugEnvelope[0]).toBe(0x02);
    expect(() => decodeRuntimeAdapterMessage(debugEnvelope))
      .toThrow('RADAPTER_WIRE_MESSAGEPACK_REQUIRED:magic=2');
  });

  test.each([
    ['JSON text', '{"v":1,"id":"x","op":"read","path":"head"}'],
    ['null', encodeBinaryPayload(null, 'msgpack')],
    ['array', encodeBinaryPayload([], 'msgpack')],
    ['unknown op', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, id: 'x', op: 'wat' }, 'msgpack')],
    ['missing request id', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, op: 'read', path: 'head' }, 'msgpack')],
    ['missing read path', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, id: 'x', op: 'read' }, 'msgpack')],
    ['type-confused tick height', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, op: 'tick', height: '9' }, 'msgpack')],
    ['missing tick readiness', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, op: 'tick', height: 9 }, 'msgpack')],
    ['type-confused response status', encodeBinaryPayload({ v: XLN_PROTOCOL_VERSION, inReplyTo: 'x', ok: 'true', payload: null }, 'msgpack')],
    ['missing send input arrays', encodeBinaryPayload({
      v: XLN_PROTOCOL_VERSION,
      id: 'x',
      op: 'send',
      commandId: 'command-00000001',
      commandSequence: 1,
      input: {},
    }, 'msgpack')],
    ['unknown request field', encodeBinaryPayload({
      v: XLN_PROTOCOL_VERSION,
      id: 'x',
      op: 'read',
      path: 'head',
      surprise: true,
    }, 'msgpack')],
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
