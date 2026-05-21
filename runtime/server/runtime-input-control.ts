import type { Env, RuntimeInput } from '../types';
import { serializeTaggedJson } from '../serialization-utils';
import type { createRuntimeIngressReceiptStore } from './ingress-receipts';
import type { parseTaggedControlBody as parseTaggedControlBodyType } from './auth';
import type { enqueueRuntimeInput as enqueueRuntimeInputType } from '../runtime';

type RuntimeInputControlDeps = {
  enqueueRuntimeInput: typeof enqueueRuntimeInputType;
  parseTaggedControlBody: typeof parseTaggedControlBodyType;
  receipts: ReturnType<typeof createRuntimeIngressReceiptStore>;
  getCurrentRuntimeHeight(env: Env | null): number;
  buildStatusUrl(id: string): string;
};

export const handleRuntimeInputControl = async (
  req: Request,
  headers: HeadersInit,
  env: Env | null,
  deps: RuntimeInputControlDeps,
): Promise<Response> => {
  if (!env) {
    return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
  }
  try {
    const body = await deps.parseTaggedControlBody<Partial<RuntimeInput>>(req);
    const runtimeTxs = Array.isArray(body?.runtimeTxs) ? body.runtimeTxs : [];
    const entityInputs = Array.isArray(body?.entityInputs) ? body.entityInputs : [];
    const jInputs = Array.isArray(body?.jInputs) ? body.jInputs : [];
    if (runtimeTxs.length === 0 && entityInputs.length === 0 && jInputs.length === 0) {
      return new Response(
        serializeTaggedJson({ ok: false, error: 'runtimeTxs, entityInputs, or jInputs are required' }),
        { status: 400, headers },
      );
    }
    deps.enqueueRuntimeInput(env, {
      runtimeTxs,
      entityInputs,
      ...(jInputs.length > 0 ? { jInputs } : {}),
    });
    const receipt = deps.receipts.register({
      kind: 'control-runtime-input',
      counts: {
        runtimeTxs: runtimeTxs.length,
        entityInputs: entityInputs.length,
        jInputs: jInputs.length,
      },
      enqueuedHeight: deps.getCurrentRuntimeHeight(env),
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
      { status: 500, headers },
    );
  }
};

export const handleRuntimeInputStatus = (
  receiptId: string,
  headers: HeadersInit,
  env: Env | null,
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
    }),
    { headers },
  );
};
