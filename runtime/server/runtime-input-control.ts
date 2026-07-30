import type { RuntimeState, RuntimeInput } from '../runtime/types';
import { serializeTaggedJson } from '../protocol/serialization';
import { getControlBodyErrorStatus } from './auth';
import type { createRuntimeIngressReceiptStore } from './ingress-receipts';
import type { parseTaggedControlBody } from './auth';
import type { enqueueRuntimeInput } from '../runtime';
import { decodeRuntimeInput } from '../runtime/input-schema';

type RuntimeInputControlDeps = {
  enqueueRuntimeInput: typeof enqueueRuntimeInput;
  validateRuntimeInputAdmission(env: RuntimeState, runtimeInput: RuntimeInput): void;
  parseTaggedControlBody: typeof parseTaggedControlBody;
  receipts: ReturnType<typeof createRuntimeIngressReceiptStore>;
  getCurrentRuntimeHeight(env: RuntimeState | null): number;
  buildStatusUrl(id: string): string;
};

export const handleRuntimeInputControl = async (
  req: Request,
  headers: HeadersInit,
  env: RuntimeState | null,
  deps: RuntimeInputControlDeps,
): Promise<Response> => {
  if (!env) {
    return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
  }
  try {
    const body = await deps.parseTaggedControlBody<unknown>(req);
    const runtimeInput = decodeRuntimeInput(body, 'CONTROL_RUNTIME_INPUT');
    const { runtimeTxs, entityInputs, jInputs = [] } = runtimeInput;
    if (runtimeTxs.length === 0 && entityInputs.length === 0 && jInputs.length === 0) {
      return new Response(
        serializeTaggedJson({ ok: false, error: 'runtimeTxs, entityInputs, or jInputs are required' }),
        { status: 400, headers },
      );
    }
    deps.validateRuntimeInputAdmission(env, runtimeInput);
    deps.enqueueRuntimeInput(env, runtimeInput);
    const receipt = deps.receipts.register({
      kind: 'control-runtime-input',
      counts: {
        runtimeTxs: runtimeTxs.length,
        entityInputs: entityInputs.length,
        jInputs: jInputs.length,
      },
      enqueuedHeight: deps.getCurrentRuntimeHeight(env),
      runtimeInput,
    });
    return new Response(
      serializeTaggedJson({
        ok: true,
        accepted: {
          runtimeTxs: runtimeTxs.length,
          entityInputs: entityInputs.length,
          jInputs: jInputs.length,
        },
        receipt,
        statusUrl: deps.buildStatusUrl(receipt.id),
      }),
      { headers },
    );
  } catch (error) {
    return new Response(
      serializeTaggedJson({ ok: false, error: (error as Error).message || 'Failed to queue runtime input' }),
      { status: getControlBodyErrorStatus(error, 400), headers },
    );
  }
};

export const handleRuntimeInputStatus = (
  receiptId: string,
  headers: HeadersInit,
  env: RuntimeState | null,
  deps: Pick<RuntimeInputControlDeps, 'receipts' | 'getCurrentRuntimeHeight'>,
): Response => {
  const receipt = deps.receipts.get(receiptId);
  if (!receipt) {
    return new Response(
      serializeTaggedJson({ ok: false, error: 'Runtime input receipt not found' }),
      { status: 404, headers },
    );
  }
  return new Response(
    serializeTaggedJson({
      ok: true,
      receipt,
      currentHeight: deps.getCurrentRuntimeHeight(env),
      runtime: env?.runtimeState
        ? {
            halted: env.runtimeState.halted === true,
            fatalDebugPayload: env.runtimeState.fatalDebugPayload ?? null,
          }
        : null,
    }),
    { headers },
  );
};
