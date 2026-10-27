import { decodeRuntimeAdapterRequest } from '../../../api/runtime-adapter/codec';
import { handleRuntimeAdapterMessage, forgetRuntimeAdapterClient } from '../../../api/runtime-adapter/server';
import {
  enqueueRuntimeInput,
  validateRuntimeInputAdmission,
  loadEntityStateFromStorageDb,
  loadEntityAccountDocFromStorageDb,
  readPersistedAccountFrameHistory,
} from '../../../runtime';
import type { RuntimeReplica } from '../../../runtime/types';

/** Real authenticated RPC handler and real WAL readers; no modelled responses. */
export function startOfficerRpc(env: RuntimeReplica) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === '/rpc' && server.upgrade(request)) return undefined;
      return new Response(null, { status: 404 });
    },
    websocket: {
      async message(ws, raw) {
        await handleRuntimeAdapterMessage(ws, decodeRuntimeAdapterRequest(raw), env, {
          enqueueRuntimeInput,
          validateRuntimeInputAdmission,
          loadEntityState: loadEntityStateFromStorageDb,
          loadEntityAccountDoc: loadEntityAccountDocFromStorageDb,
          readAccountFrameHistory: readPersistedAccountFrameHistory,
        });
      },
      close: ws => forgetRuntimeAdapterClient(ws),
    },
  });
}
