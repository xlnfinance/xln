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
      hello: '0x45218b0572920fd44e65f2e69e6d648e230f00a4a4b836fa1f1920cd24d661d9',
      hello_challenge: '0x6d1fdf678f897e7e99b101a7535112026e686bd2bdd35c4fd2e532a842b18fb2',
      hello_ack: '0xe706a531cecdffe5272cd73732ac38f4160898935e265befd9da95b72cdef81b',
      entity_inputs: '0x27d24811c53f68697c47e4c55f6ccf4848ba52f8395969aba5038a2f9a5cff04',
      debug_event: '0xe0af6238b04d11eb2c5722f791096bf1379718b9a0d96de9069f76e476364dd9',
      gossip_request: '0xfa2d937758c36668a0f728722494f59e19a183eaec2ed082e340283aae2af679',
      gossip_response: '0xb7c17ab8f547e8f41ee39cec7b1c8a7d0bb3a974d4513ce2471f104e5f959069',
      gossip_announce: '0x3e738bb000b77b4af6749052e1b408fbc0458b8a0197d3d7c698a2e84b03453a',
      gossip_update: '0x6dc0078b944a9e92fa5104e846da5f2697fc6a15719bb8b9eac338d3c8ce2ada',
      recovery_bundle_request: '0x0989b1dd84030997b89a0d7d1f2f35ae1e8f12518ba7b6789608dd9185ba2b5e',
      recovery_bundle_response: '0x9e0bbb626bb4e6e7b464242a676d00c5f6fd1f456ef7d3912889b1b978a9f407',
      error: '0xe3bad0c0db2f6047e71a6214f0fe9f890de66b87507de8d08a27a26fa937fb9a',
      ping: '0x9404c21fe688b87cd4371b28f4152440ffcb95b00c577e64b954f71b3bc57394',
      pong: '0x42684cebef0591f8c704eae43ffafc1577e6833e251111cdbcccc5f26de08e8c',
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
      auth: '0xf31dbd2448bc0430a3bf0e82f1e431143f2276207c4bb6490a1295af20992a5b',
      read: '0xc0e19dfc04346f4a9f8783b798d462572c1cb178947b8addf8cae6298b097854',
      send: '0xbd1a3eabf0d5ec7bf8f4c46096f11d044de406b47d6a12d34dab769272b8385e',
      ok: '0x59110d26493d012f3810c1e32854d7a17b6e4ee14c188aded493505e27a3b61b',
      error: '0xedf10168afa765b872ca86fc53775d150ef8af30a61457841d43b6ca4efcefdb',
      tick: '0x4ce3f9a45cc138030713992c84ac62318daedccbe078d66f790ef949b6cb4a85',
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
