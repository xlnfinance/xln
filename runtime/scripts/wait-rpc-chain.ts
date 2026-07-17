import { setTimeout as sleep } from 'node:timers/promises';

type RpcResponse = {
  result?: unknown;
};

const readArg = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`DEV_RPC_ARG_REQUIRED:${name}`);
  return value;
};

const parsePositiveInteger = (raw: string, label: string, max: number): number => {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${label}_INVALID:${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`${label}_INVALID:${raw}`);
  return value;
};

const rpcUrl = new URL(readArg('--url'));
if (rpcUrl.protocol !== 'http:' && rpcUrl.protocol !== 'https:') {
  throw new Error(`DEV_RPC_URL_PROTOCOL_INVALID:${rpcUrl.protocol}`);
}
const expectedChainId = parsePositiveInteger(readArg('--chain-id'), 'DEV_RPC_CHAIN_ID', Number.MAX_SAFE_INTEGER);
const timeoutMs = parsePositiveInteger(readArg('--timeout-ms'), 'DEV_RPC_TIMEOUT_MS', 120_000);

const readChainId = async (requestTimeoutMs: number): Promise<number> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const payload = await response.json() as RpcResponse;
  if (typeof payload.result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(payload.result)) {
    throw new Error('RPC_CHAIN_ID_RESPONSE_INVALID');
  }
  const parsed = Number(BigInt(payload.result));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('RPC_CHAIN_ID_RESPONSE_INVALID');
  return parsed;
};

const waitForExpectedChain = async (): Promise<void> => {
  const startedAt = performance.now();
  let lastError = 'RPC_NOT_REACHABLE';
  while (performance.now() - startedAt < timeoutMs) {
    const remainingMs = Math.max(1, Math.ceil(timeoutMs - (performance.now() - startedAt)));
    try {
      const actualChainId = await readChainId(Math.min(1_000, remainingMs));
      if (actualChainId !== expectedChainId) {
        throw new Error(
          `DEV_RPC_CHAIN_ID_MISMATCH:url=${rpcUrl.href} expected=${expectedChainId} actual=${actualChainId}`,
        );
      }
      console.log(`DEV_RPC_READY url=${rpcUrl.href} chainId=${actualChainId}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('DEV_RPC_CHAIN_ID_MISMATCH:')) throw error;
      lastError = message;
    }
    const remainingAfterAttempt = timeoutMs - (performance.now() - startedAt);
    if (remainingAfterAttempt > 0) await sleep(Math.min(100, remainingAfterAttempt));
  }
  throw new Error(
    `DEV_RPC_READY_TIMEOUT:url=${rpcUrl.href} expectedChainId=${expectedChainId} timeoutMs=${timeoutMs} lastError=${lastError}`,
  );
};

try {
  await waitForExpectedChain();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
