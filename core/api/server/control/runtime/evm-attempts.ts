import { getRuntimeWalDb, tryOpenRuntimeWalDb } from '../../../../runtime';
import type { RuntimeReplica } from '../../../../runtime/types';
import { evmAttemptSlot, readEvmAttemptHistory } from '../../../../storage/queries/evm-attempts';
import { withStorageConsistentRead } from '../../../../storage/runtime-dbs';
import { requireDaemonControlAuth } from '../auth';

export const handleEvmAttemptInspection = async (
  request: Request,
  url: URL,
  env: RuntimeReplica,
): Promise<Response> => {
  const auth = requireDaemonControlAuth(request, env, 'inspect');
  if (auth) return auth;
  const chain = url.searchParams.get('chainId');
  const payer = url.searchParams.get('payer');
  const slot = url.searchParams.get('nonce');
  const chainId = Number(chain);
  const nonce = Number(slot);
  if (
    !Number.isSafeInteger(chainId) ||
    chainId < 1 ||
    String(chainId) !== chain ||
    !payer ||
    !/^0x[0-9a-f]{40}$/.test(payer) ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0 ||
    String(nonce) !== slot
  )
    return Response.json({ error: 'EVM_ATTEMPT_SLOT_INVALID' }, { status: 400 });
  // A slow broadcast can hold the Runtime writer after WAL commit. Read the
  // pinned WAL head directly, without touching mutable state or that writer.
  if (!(await tryOpenRuntimeWalDb(env))) return Response.json({ error: 'EVM_ATTEMPT_WAL_EMPTY' }, { status: 503 });
  const key = evmAttemptSlot(chainId, payer, nonce);
  const hashes = new Map<string, string[]>();
  const complete = await withStorageConsistentRead(env, () =>
    readEvmAttemptHistory(getRuntimeWalDb(env), new Set([key]), hashes),
  );
  return Response.json({ hashes: hashes.get(key) ?? [], complete });
};
