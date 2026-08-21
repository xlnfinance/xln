import { expect, test } from 'bun:test';
import {
  DEFAULT_CONTROL_BODY_MAX_BYTES,
  getControlBodyErrorStatus,
  parseTaggedControlBody,
} from '../../../api/server/control/auth';
import { handleRuntimeInputControl } from '../../../api/server/control/runtime-input';
import { decodeP2PControlBody } from '../../../api/server/control/p2p';
import { decodeSignerRegistration } from '../../../api/server/control/signer';
import { deserializeTaggedJson, serializeTaggedJson } from '../../../protocol/serialization';
import type { RuntimeReplica, RuntimeInput } from '../../../runtime/types';

test('control body parser rejects oversized request bodies before deserializing', async () => {
  const request = new Request('http://localhost/api/control/runtime-input', {
    method: 'POST',
    body: 'x'.repeat(DEFAULT_CONTROL_BODY_MAX_BYTES + 1),
  });

  await expect(parseTaggedControlBody(request)).rejects.toThrow('CONTROL_BODY_TOO_LARGE');
});

test('runtime input control rejects oversized payloads without enqueueing runtime work', async () => {
  let enqueueCalled = false;
  let validateCalled = false;
  const response = await handleRuntimeInputControl(
    new Request('http://localhost/api/control/runtime-input', {
      method: 'POST',
      body: 'x'.repeat(DEFAULT_CONTROL_BODY_MAX_BYTES + 1),
    }),
    { 'Content-Type': 'application/json' },
    {} as RuntimeReplica,
    {
      enqueueRuntimeInput: () => {
        enqueueCalled = true;
      },
      validateRuntimeInputAdmission: () => {
        validateCalled = true;
      },
      parseTaggedControlBody,
    },
  );

  expect(response.status).toBe(413);
  expect(enqueueCalled).toBe(false);
  expect(validateCalled).toBe(false);
  const body = deserializeTaggedJson<{ ok?: boolean; error?: string }>(await response.text());
  expect(body.ok).toBe(false);
  expect(body.error).toContain('CONTROL_BODY_TOO_LARGE');
});

test('runtime input control still accepts normal tagged payloads', async () => {
  const accepted: RuntimeInput[] = [];
  const response = await handleRuntimeInputControl(
    new Request('http://localhost/api/control/runtime-input', {
      method: 'POST',
      body: serializeTaggedJson({ runtimeTxs: [], entityInputs: [], jInputs: [{ jurisdictionName: 'test', jTxs: [] }] }),
    }),
    { 'Content-Type': 'application/json' },
    {} as RuntimeReplica,
    {
      enqueueRuntimeInput: (_env, runtimeInput) => {
        accepted.push(runtimeInput);
      },
      validateRuntimeInputAdmission: () => undefined,
      parseTaggedControlBody,
    },
  );

  expect(response.status).toBe(200);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.jInputs).toHaveLength(1);
});

test('runtime input control rejects malformed Runtime transactions before enqueue', async () => {
  let enqueueCalled = false;
  const response = await handleRuntimeInputControl(
    new Request('http://localhost/api/control/runtime-input', {
      method: 'POST',
      body: serializeTaggedJson({
        runtimeTxs: [{ type: 'advanceJWatcherCursor', data: { blockNumber: -1 } }],
        entityInputs: [],
      }),
    }),
    { 'Content-Type': 'application/json' },
    {} as RuntimeReplica,
    {
      enqueueRuntimeInput: () => {
        enqueueCalled = true;
      },
      validateRuntimeInputAdmission: () => {
        throw new Error('admission must not receive malformed RuntimeTx');
      },
      parseTaggedControlBody,
    },
  );

  expect(response.status).toBe(400);
  expect(enqueueCalled).toBe(false);
  expect(await response.text()).toContain(
    'CONTROL_RUNTIME_INPUT_RUNTIME_TX_0_DATA_FIELDS',
  );
});

test('control body error status maps oversized bodies to 413 only', () => {
  expect(getControlBodyErrorStatus(new Error(`CONTROL_BODY_TOO_LARGE: bytes=2 max=1`), 400)).toBe(413);
  expect(getControlBodyErrorStatus(new Error('bad json'), 400)).toBe(400);
});

test('control request decoders reject unknown fields and implicit coercion', () => {
  expect(() => decodeSignerRegistration({
    signerId: '0x0000000000000000000000000000000000000001',
    privateKeyHex: `0x${'11'.repeat(32)}`,
    ignored: true,
  })).toThrow('SIGNER_REGISTRATION_FIELDS_INVALID');
  expect(() => decodeP2PControlBody({ gossipPollMs: '250' }))
    .toThrow('P2P_CONTROL_GOSSIP_POLL_MS_INVALID');
  expect(() => decodeP2PControlBody({ relayUrls: ['wss://relay', 7] }))
    .toThrow('P2P_CONTROL_RELAY_URLS_INVALID:index=1');
});

test('control request decoders return one canonical representation', () => {
  expect(decodeSignerRegistration({
    signerId: ' 0x00000000000000000000000000000000000000AA ',
    privateKeyHex: ` 0x${'AB'.repeat(32)} `,
  })).toEqual({
    signerId: '0x00000000000000000000000000000000000000aa',
    privateKeyHex: `0x${'ab'.repeat(32)}`,
  });
  expect(decodeP2PControlBody({
    relayUrls: [' wss://relay.example '],
    advertiseEntityIds: [' 0xABCD '],
    gossipPollMs: 250,
  })).toEqual({
    relayUrls: ['wss://relay.example'],
    advertiseEntityIds: ['0xabcd'],
    gossipPollMs: 250,
  });
});
