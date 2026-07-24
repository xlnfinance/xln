import { afterEach, describe, expect, test } from 'bun:test';
import { keccak256 } from 'ethers';

import {
  deserializeWsMessage,
  serializeWsMessage,
  serializeWsMessageForDebug,
  type RuntimeWsMessage,
} from '../networking/ws-protocol';
import {
  decodeRuntimeAdapterMessage,
  encodeRuntimeAdapterMessage,
} from '../radapter/codec';
import {
  assertRuntimeAdapterCommandTxAuthorized,
  markLocalRuntimeAdapterCommandTx,
} from '../radapter/command-frontier-auth';
import { projectRuntimeIngressReceiptForWire } from '../server/ingress-receipts';
import { encodeBinaryPayload } from '../storage/binary-codec';
import type { RuntimeTx } from '../types';
import type { RuntimeAdapterWireMessage } from '../radapter/wire-schema';

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
      hello_challenge: { type: 'hello_challenge', challenge: 'c' },
      hello_ack: { type: 'hello_ack', to: 'a' },
      entity_inputs: { type: 'entity_inputs', from: 'a', to: 'b', payload: 'cipher', encrypted: true },
      entity_input_receipt: { type: 'entity_input_receipt', from: 'a', to: 'b', payload: { body: {}, signature: 's' } },
      debug_event: { type: 'debug_event', payload: { level: 'info' } },
      gossip_request: { type: 'gossip_request', from: 'a', payload: {} },
      gossip_response: { type: 'gossip_response', from: 'a', payload: {} },
      gossip_announce: { type: 'gossip_announce', from: 'a', payload: {} },
      gossip_subscribed: { type: 'gossip_subscribed', from: 'a', payload: {} },
      gossip_subscribe: { type: 'gossip_subscribe', from: 'a', payload: {} },
      gossip_update: { type: 'gossip_update', from: 'a', payload: {} },
      recovery_bundle_request: { type: 'recovery_bundle_request', from: 'a', to: 'b', payload: { lookupKey: 'k' } },
      recovery_bundle_response: { type: 'recovery_bundle_response', from: 'b', to: 'a', payload: {} },
      error: { type: 'error', error: 'e' },
      ping: { type: 'ping' },
      pong: { type: 'pong' },
    } satisfies Record<string, RuntimeWsMessage>;
    const expected = {
      hello: '0x423cfb7fbf1b9cf067bd5d3f89afbeb3c6f19c03e8f9410bae38b3d43e2529cb',
      hello_challenge: '0x3f7788d14487e6b59f9441b65d8bc9dba8266eb9f910cbb0fff3b243138db87a',
      hello_ack: '0x01c85fe2130cce80700f27ad3a4b9c5ce3f03c044b0502b7903d0d21558ee2ad',
      entity_inputs: '0x449d22e5c7ccfcdc8c4d93b1437c45b608fa6e88deba3d45f22d0d39fafb3702',
      entity_input_receipt: '0x32e7f1648fdd73e30679ce2aa7e2932dae420c073268b7cfbf27b75307cf1c12',
      debug_event: '0x7cd307e43d877b5741a93f7ca02fdcddd13a91489798f133b65be0cbb0dfc897',
      gossip_request: '0xf1126cf381505dc8dd42ecda121c95d4675e4a8a5176928e8fac42c473b7b3bf',
      gossip_response: '0xa8de6f8857c4490cce9289bd2829403604caebf22d841dc6cc864b8fe1d6cad0',
      gossip_announce: '0xf91813f0d50b84d94e47f04f4bddb6ed08c01b84c61be3a62cda24415d2d7d01',
      gossip_subscribed: '0xc5be3962407020747fcd20934f649e479eaab83a1a3fc4782bfbd21ab981ce30',
      gossip_subscribe: '0x756f289fac20b3ecaa79855b9f9659673aff7318a389cfab2432ff997975594a',
      gossip_update: '0x4eb5ebe01f3aa759444cebf17a81f18eb7202cfd28737a3e97710bc013f09ea2',
      recovery_bundle_request: '0x56c5ce3b060f62ed509f751a5b938385d8c2541fa3efe1790f03cdc937fb7ded',
      recovery_bundle_response: '0xf1324220d5bdac3a61d556fd7ff3ace257ae8e7e8697494da8de2099b987b66a',
      error: '0xeec28762c01f7fd689b790dbbe6ef362abda04903e6239709f537c6d48244786',
      ping: '0xa4a1dd1fc521b9aa2a877c49824449939935958667d2cc1dbdc1259f39912939',
      pong: '0x297d17ac72508a386d27ca0dd57dbe46ab5a8617354a3af1339b45ae1c0df0d5',
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
    const debugEnvelope = encodeBinaryPayload({ v: 1, type: 'ping' }, 'json');

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
});

describe('rAdapter trusted decode boundary', () => {
  test('pins every canonical envelope variant to an independent golden hash', () => {
    const variants = {
      auth: { v: 1, id: 'a', op: 'auth', challenge: `0x${'11'.repeat(32)}` },
      read: { v: 1, id: 'r', op: 'read', path: 'head', query: { atHeight: 1 } },
      send: {
        v: 1,
        id: 's',
        op: 'send',
        commandId: 'command-00000001',
        commandSequence: 1,
        input: { runtimeTxs: [], entityInputs: [] },
      },
      ok: { v: 1, inReplyTo: 'r', ok: true, payload: { height: 1 } },
      error: {
        v: 1,
        inReplyTo: 'r',
        ok: false,
        error: { code: 'E_BAD_QUERY', message: 'bad', retryable: false },
      },
      tick: { v: 1, op: 'tick', height: 1, commandReady: true, commandReadyReason: null },
    } satisfies Record<string, RuntimeAdapterWireMessage>;
    const expected = {
      auth: '0x815bbc35b560e10d2e786331870725f223a394f86715911f3de984bdd1daa8f8',
      read: '0xec4ebd09994412a9b889327d4a9fd251ec476a1d3c2d586a24289260e2f20403',
      send: '0x710ca84bb36e77be6e6362c8039ace7b53fe26c1a7f4e6e5b3e58051b4633078',
      ok: '0x2130fe297611af9f54e231850d447eae7c1d39e9357a970e291f0f900363b42d',
      error: '0x6aaee897bbac946f5a952c2321086eab0b7f7d7ae841c9973a8e0d9a82b556af',
      tick: '0x266ba5fbb38e955c1cdeb40209dadc2bcd64a3673363737e5e9753011d37608d',
    } as const;

    expect(Object.fromEntries(Object.entries(variants).map(([name, value]) => [
      name,
      keccak256(encodeRuntimeAdapterMessage(value)),
    ]))).toEqual(expected);
  });

  test('accepts exact request, response, and push variants', () => {
    const messages = [
      { v: 1 as const, id: 'auth-1', op: 'auth' as const, challenge: `0x${'11'.repeat(32)}` },
      { v: 1 as const, inReplyTo: 'auth-1', ok: true as const, payload: { authLevel: 'inspect' } },
      {
        v: 1 as const,
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
      v: 1,
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
    ['unknown op', encodeBinaryPayload({ v: 1, id: 'x', op: 'wat' }, 'msgpack')],
    ['missing request id', encodeBinaryPayload({ v: 1, op: 'read', path: 'head' }, 'msgpack')],
    ['missing read path', encodeBinaryPayload({ v: 1, id: 'x', op: 'read' }, 'msgpack')],
    ['type-confused tick height', encodeBinaryPayload({ v: 1, op: 'tick', height: '9' }, 'msgpack')],
    ['missing tick readiness', encodeBinaryPayload({ v: 1, op: 'tick', height: 9 }, 'msgpack')],
    ['type-confused response status', encodeBinaryPayload({ v: 1, inReplyTo: 'x', ok: 'true', payload: null }, 'msgpack')],
    ['missing send input arrays', encodeBinaryPayload({
      v: 1,
      id: 'x',
      op: 'send',
      commandId: 'command-00000001',
      commandSequence: 1,
      input: {},
    }, 'msgpack')],
    ['unknown request field', encodeBinaryPayload({
      v: 1,
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

  test('wire receipts strip local command authority and decoding cannot recreate it', () => {
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
    const projected = projectRuntimeIngressReceiptForWire({
      id: 'receipt-1',
      kind: 'radapter-runtime-input',
      status: 'pending',
      counts: { runtimeTxs: 1, entityInputs: 0, jInputs: 0 },
      enqueuedAt: 1,
      enqueuedHeight: 1,
      expiresAt: 2,
      runtimeInput: { runtimeTxs: [authorized], entityInputs: [] },
    } as Parameters<typeof projectRuntimeIngressReceiptForWire>[0]);
    const plainMarker = { ...authorized } as RuntimeTx;
    const decoded = decodeRuntimeAdapterMessage<{
      payload: { receipt: Record<string, unknown>; attemptedMarker: RuntimeTx };
    }>(encodeRuntimeAdapterMessage({
      v: 1,
      inReplyTo: 'send-1',
      ok: true,
      payload: { receipt: projected, attemptedMarker: plainMarker },
    }));

    expect(decoded.payload.receipt['runtimeInput']).toBeUndefined();
    expect(Object.getOwnPropertySymbols(decoded.payload.attemptedMarker)).toHaveLength(0);
    expect(() => assertRuntimeAdapterCommandTxAuthorized(decoded.payload.attemptedMarker, false))
      .toThrow('RADAPTER_COMMAND_RUNTIME_TX_UNAUTHORIZED');
  });
});
