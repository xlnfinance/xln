import type { RuntimeReplica, RuntimeInput } from '../../../runtime/types';
import { serializeTaggedJson } from '../../../protocol/serialization';
import { getControlBodyErrorStatus } from './auth';
import type { parseTaggedControlBody } from './auth';
import type { enqueueRuntimeInput } from '../../../runtime';
import { decodeRuntimeInput } from '../../../runtime/decode';

type RuntimeInputControlDeps = {
  enqueueRuntimeInput: typeof enqueueRuntimeInput;
  validateRuntimeInputAdmission(env: RuntimeReplica, runtimeInput: RuntimeInput): void;
  parseTaggedControlBody: typeof parseTaggedControlBody;
};

export const handleRuntimeInputControl = async (
  req: Request,
  headers: HeadersInit,
  env: RuntimeReplica | null,
  deps: RuntimeInputControlDeps,
): Promise<Response> => {
  if (!env) {
    return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
  }
  try {
    const body = await deps.parseTaggedControlBody(req);
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
    // Queue admission is intentionally best-effort. Financial completion is
    // proven only by the resulting Entity/Account state and bilateral ACK;
    // never reintroduce transport receipts or a parallel delivery protocol.
    return new Response(
      serializeTaggedJson({
        ok: true,
        accepted: {
          runtimeTxs: runtimeTxs.length,
          entityInputs: entityInputs.length,
          jInputs: jInputs.length,
        },
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
