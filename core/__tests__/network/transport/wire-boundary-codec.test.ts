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
      hello: '0x67d058920f988427e97f542a0054e8ae827687ef3f547df973d0e5f8d305acb6',
      hello_challenge: '0x62b8fdfd5f31a09e987ae22f2c88beca6dcd52194dfd400779aceae1f22cde72',
      hello_ack: '0x22213cebb281dd0ec4f73cfd5472407165eea5670e61f7b798be3d728b4b0a7c',
      entity_inputs: '0x49df4b993bbf08ed80de3cd4644e57d71168cd58d5daaaf457464bd0497dd0fe',
      debug_event: '0x3da2b0a0683b15b73e8dc7d281a38575ec17bb14914adb390bdd7e81a90cea7d',
      gossip_request: '0xa83f38f3ff5b2bbd53398c703be1024996617454a4dd278d59e9bbd53cd14ddc',
      gossip_response: '0x4ca3d895f8665ad057b10cb53de8af87132e81f10c27de4bc076021f08d0bc61',
      gossip_announce: '0xd164f639b9e542b71e7f6bf09566a6c914fc43ba41fc180333d235a6cdec2e96',
      gossip_update: '0x93b16b1e875a71a2ec1dc1f707afb0ec6148f741cd63dd6e7fd6861a91ca3ff7',
      recovery_bundle_request: '0x2294aa1138c5754bde0eb02ec30abd2ca8ad8eacfd59d1b1558d914f384e88c0',
      recovery_bundle_response: '0x6e629c6fad93dab7f464719bc4d2fc1fb859e05e654354b32f9438335815afec',
      error: '0x5ae6818aa95c44ffa90f4e91c65a9b56a8666e2819d7e0f7125335afe8437623',
      ping: '0xe646fbf1a2276f9ae7baad5fac2de7183563fcd5d12808325ef4f0d064a514ed',
      pong: '0x830408a848d44936f39d56f8ec6f4c887da1e072a86c2a932fe6fa1ab0732e97',
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
      auth: '0xd39ae58ff43fa6f0289e6295ad771d1c3806d868ba3b9fadec9ff7620dc20979',
      read: '0xcd2dd43e3d67fd18fe3787525bf7216dec22d3c5bd0b62b82e9c83da0363fcc2',
      send: '0x952b54e205f756f931246a2e428adf26e0c114304d138fcda257ec51d42b36c6',
      ok: '0x3cd4ebc63318e341632394598f7b4e4da591bf3bb1b148d5966a3b0153c3ed6b',
      error: '0xda58018ed9c462325c818bac21545d6cf561a46408c96411beff403864550511',
      tick: '0x7201ac738a520fc81d70ee83c813c1e50b65f449f1cb6554555fc47588ea72ec',
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
