const FORBIDDEN_RPC_METHODS = new Set([
  'eth_accounts',
  'eth_coinbase',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_submitHashrate',
  'eth_submitWork',
]);

const FORBIDDEN_RPC_PREFIXES = [
  'admin_',
  'anvil_',
  'debug_',
  'evm_',
  'hardhat_',
  'miner_',
  'personal_',
  'txpool_',
  'wallet_',
];

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_CLIENTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeClientAddress = (value: string | undefined): string =>
  String(value || '').trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();

export function isLocalProxyRequest(requestUrl: string, clientAddress?: string): boolean {
  const hostname = new URL(requestUrl).hostname;
  if (process.env['NODE_ENV'] === 'production') return false;
  if (!LOCAL_HOSTNAMES.has(hostname)) return false;
  if (process.env['XLN_ALLOW_LOCAL_RPC_PROXY'] === '1') return true;
  return LOOPBACK_CLIENTS.has(normalizeClientAddress(clientAddress));
}

export function findForbiddenRpcProxyMethod(bodyText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return 'invalid-json';
  }

  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0) return 'empty-batch';

  for (const call of calls) {
    const method = isRecord(call) ? call['method'] : null;
    if (typeof method !== 'string' || !method) {
      return 'invalid-json-rpc';
    }
    if (FORBIDDEN_RPC_METHODS.has(method) || FORBIDDEN_RPC_PREFIXES.some(prefix => method.startsWith(prefix))) {
      return method;
    }
  }

  return null;
}
