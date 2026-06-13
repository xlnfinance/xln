import { expect, test } from 'bun:test';
import {
  DEFAULT_CONTROL_BODY_MAX_BYTES,
  getControlBodyErrorStatus,
  parseTaggedControlBody,
} from '../server/auth';
import { handleRuntimeInputControl } from '../server/runtime-input-control';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import type { Env, RuntimeInput } from '../types';

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
    {} as Env,
    {
      enqueueRuntimeInput: () => {
        enqueueCalled = true;
      },
      validateRuntimeInputAdmission: () => {
        validateCalled = true;
      },
      parseTaggedControlBody,
      receipts: {
        register: () => {
          throw new Error('receipt must not be registered');
        },
        get: () => undefined,
      } as never,
      getCurrentRuntimeHeight: () => 0,
      buildStatusUrl: (id: string) => `/api/control/runtime-input/${id}/status`,
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
    {} as Env,
    {
      enqueueRuntimeInput: (_env, runtimeInput) => {
        accepted.push(runtimeInput);
      },
      validateRuntimeInputAdmission: () => undefined,
      parseTaggedControlBody,
      receipts: {
        register: () => ({ id: 'receipt-1' }),
        get: () => undefined,
      } as never,
      getCurrentRuntimeHeight: () => 7,
      buildStatusUrl: (id: string) => `/api/control/runtime-input/${id}/status`,
    },
  );

  expect(response.status).toBe(200);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.jInputs).toHaveLength(1);
});

test('control body error status maps oversized bodies to 413 only', () => {
  expect(getControlBodyErrorStatus(new Error(`CONTROL_BODY_TOO_LARGE: bytes=2 max=1`), 400)).toBe(413);
  expect(getControlBodyErrorStatus(new Error('bad json'), 400)).toBe(400);
});
