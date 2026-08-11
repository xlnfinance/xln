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

const MAX_RPC_PROXY_REQUEST_BYTES = 256 * 1024;
const MAX_RPC_PROXY_BATCH_CALLS = 128;
const MAX_RPC_PROXY_RESPONSE_BYTES = 8 * 1024 * 1024;

export class RpcProxyError extends Error {
  constructor(
    readonly status: 400 | 413 | 502,
    readonly code: string,
    details: string,
  ) {
    super(`${code}:${details}`);
    this.name = 'RpcProxyError';
  }
}

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

const readBoundedText = async (
  message: Pick<Request | Response, 'body' | 'headers'>,
  maximumBytes: number,
  tooLargeStatus: 413 | 502,
  codePrefix: string,
): Promise<string> => {
  const declared = Number(message.headers.get('content-length') || '');
  if (Number.isSafeInteger(declared) && declared > maximumBytes) {
    throw new RpcProxyError(tooLargeStatus, `${codePrefix}_TOO_LARGE`, `bytes=${declared}:max=${maximumBytes}`);
  }
  if (!message.body) return '';
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        throw new RpcProxyError(tooLargeStatus, `${codePrefix}_TOO_LARGE`, `bytes>${maximumBytes}`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RpcProxyError) throw error;
    throw new RpcProxyError(tooLargeStatus === 413 ? 400 : 502, `${codePrefix}_INVALID`, 'invalid-utf8');
  }
};

export const readRpcProxyRequest = async (
  request: Request,
): Promise<{ bodyText: string; forbiddenMethod: string | null }> => {
  const bodyText = await readBoundedText(
    request,
    MAX_RPC_PROXY_REQUEST_BYTES,
    413,
    'RPC_PROXY_REQUEST',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new RpcProxyError(400, 'RPC_PROXY_JSON_INVALID', 'expected JSON-RPC object or batch');
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0) throw new RpcProxyError(400, 'RPC_PROXY_BATCH_EMPTY', 'empty batch');
  if (calls.length > MAX_RPC_PROXY_BATCH_CALLS) {
    throw new RpcProxyError(413, 'RPC_PROXY_BATCH_TOO_LARGE', `calls=${calls.length}:max=${MAX_RPC_PROXY_BATCH_CALLS}`);
  }
  const forbiddenMethod = findForbiddenRpcProxyMethod(bodyText);
  if (forbiddenMethod === 'invalid-json' || forbiddenMethod === 'invalid-json-rpc' || forbiddenMethod === 'empty-batch') {
    throw new RpcProxyError(400, 'RPC_PROXY_JSON_INVALID', forbiddenMethod);
  }
  return { bodyText, forbiddenMethod };
};

export const fetchRpcProxyText = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutCode = 'RPC_PROXY_TIMEOUT',
): Promise<{ response: Response; text: string }> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await readBoundedText(
      response,
      MAX_RPC_PROXY_RESPONSE_BYTES,
      502,
      'RPC_PROXY_RESPONSE',
    );
    return { response, text };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new Error(`${timeoutCode}:${timeoutMs}`);
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};
