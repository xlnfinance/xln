export const REQUIRED_RPC_CONTRACT_KEYS = [
  'account',
  'depository',
  'entityProvider',
  'deltaTransformer',
] as const;

export type RpcContractAddresses = Partial<Record<(typeof REQUIRED_RPC_CONTRACT_KEYS)[number], string>>;

type RpcCodeResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: unknown };
};

export const findMissingRpcContractCode = async (
  rpcUrl: string,
  contracts: RpcContractAddresses | null | undefined,
  timeoutMs = 2_000,
): Promise<string[]> => {
  const missing = REQUIRED_RPC_CONTRACT_KEYS
    .filter((key) => !/^0x[0-9a-fA-F]{40}$/.test(String(contracts?.[key] || '')))
    .map((key) => `${key}:missing`);
  const requests = REQUIRED_RPC_CONTRACT_KEYS.flatMap((key, index) => {
    const address = String(contracts?.[key] || '');
    return /^0x[0-9a-fA-F]{40}$/.test(address)
      ? [{ jsonrpc: '2.0', id: index + 1, method: 'eth_getCode', params: [address, 'latest'] }]
      : [];
  });
  if (requests.length === 0) return missing;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requests),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC_CONTRACT_CODE_HTTP_${response.status}`);
    const payload = await response.json() as RpcCodeResponse[];
    if (!Array.isArray(payload)) throw new Error('RPC_CONTRACT_CODE_BATCH_INVALID');
    const responseById = new Map(payload.map((entry) => [Number(entry.id), entry]));
    for (const [index, key] of REQUIRED_RPC_CONTRACT_KEYS.entries()) {
      const address = String(contracts?.[key] || '');
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
      const entry = responseById.get(index + 1);
      if (!entry || entry.error) {
        throw new Error(`RPC_CONTRACT_CODE_RESULT_INVALID:${key}:${String(entry?.error?.message || 'missing')}`);
      }
      const code = String(entry.result || '');
      if (!code || code === '0x') missing.push(`${key}:${address}`);
    }
    return missing;
  } finally {
    clearTimeout(timeout);
  }
};
