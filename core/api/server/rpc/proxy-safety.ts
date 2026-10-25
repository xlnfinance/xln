import { HDNodeWallet, Mnemonic, Transaction } from 'ethers';

// The browser bridge holds no signing authority. An allowlist fails closed for
// new client methods, including signing variants such as eth_signTypedData_v4,
// instead of relying on an incomplete denylist. The one write it relays is a
// transaction the wallet already signed with its own key.
const ALLOWED_RPC_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockReceipts',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getProof',
  // Raw bytes are the transactionsRoot leaves the watcher proves debt creation against.
  'eth_getRawTransactionByBlockHashAndIndex',
  'eth_getStorageAt',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'net_version',
  'web3_clientVersion',
]);

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

const RAW_TRANSACTION_METHOD = 'eth_sendRawTransaction';
// Blob (3) and set-code (4) transactions carry sidecars or delegate account code.
const RELAYED_TRANSACTION_TYPES = new Set([0, 1, 2]);
// Anvil and Hardhat ship this mnemonic, so its keys are public: a signature by
// one proves nothing about intent and would let anyone move such an account.
const PUBLIC_DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const PUBLIC_DEV_ACCOUNT_COUNT = 20;
let publicDevAccounts: ReadonlySet<string> | null = null;

const isPublicDevAccount = (address: string): boolean => {
  if (!publicDevAccounts) {
    const root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(PUBLIC_DEV_MNEMONIC), "m/44'/60'/0'/0");
    publicDevAccounts = new Set(
      Array.from({ length: PUBLIC_DEV_ACCOUNT_COUNT }, (_, index) => root.deriveChild(index).address.toLowerCase()),
    );
  }
  return publicDevAccounts.has(address.toLowerCase());
};

/** Signature, nonce, fee and chain match stay the node's checks; this admits only their input shape. */
const rawTransactionRejection = (params: unknown): string | null => {
  if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== 'string') return 'RAW_TX_PARAMS_INVALID';
  let transaction: Transaction;
  try {
    transaction = Transaction.from(params[0]);
  } catch {
    return 'RAW_TX_INVALID';
  }
  if (!RELAYED_TRANSACTION_TYPES.has(transaction.type ?? -1)) return 'RAW_TX_TYPE_UNSUPPORTED';
  if (!transaction.signature || !transaction.from) return 'RAW_TX_UNSIGNED';
  if (transaction.chainId === 0n) return 'RAW_TX_CHAIN_ID_REQUIRED';
  if (isPublicDevAccount(transaction.from)) return 'RAW_TX_PUBLIC_DEV_KEY';
  return null;
};

function findForbiddenRpcProxyMethod(bodyText: string): string | null {
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
    if (method === RAW_TRANSACTION_METHOD) {
      const rejection = rawTransactionRejection(isRecord(call) ? call['params'] : undefined);
      if (rejection) return `${method}:${rejection}`;
      continue;
    }
    if (!ALLOWED_RPC_METHODS.has(method)) {
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

export const readBoundedProxyRequest = (request: Request): Promise<string> =>
  readBoundedText(request, MAX_RPC_PROXY_REQUEST_BYTES, 413, 'RPC_PROXY_REQUEST');

export const readRpcProxyRequest = async (
  request: Request,
): Promise<{ bodyText: string; forbiddenMethod: string | null }> => {
  const bodyText = await readBoundedProxyRequest(request);
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
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await readBoundedText(
          response,
          MAX_RPC_PROXY_RESPONSE_BYTES,
          502,
          'RPC_PROXY_RESPONSE',
        );
        return { response, text };
      })(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error(`${timeoutCode}:${timeoutMs}`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new Error(`${timeoutCode}:${timeoutMs}`);
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
};
