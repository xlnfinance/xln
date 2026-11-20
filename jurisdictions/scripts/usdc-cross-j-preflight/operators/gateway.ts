import { safeStringify } from '../../../../core/protocol/serialization';
import { requireBoundaryRecord } from '../../../../core/protocol/boundary-validation';
import { startStandaloneRelayServer } from '../../../../core/network/relay/standalone-server';
import { preflightProvider, preflightRpcError, runtimeRpc } from '../provider';
import { networks } from '../identities';
import { sanitizeDeploymentMessage } from '../../deployment/evidence.cjs';
import { readCliOption } from '../../../../core/config/cli';
import { isLoopbackUrl } from '../../../../core/network/p2p/loopback-url';
import { startParentLivenessWatch } from '../../../../core/support/process/parent-watch';
import { openExecutionWriters } from './execution-writer';
import { sendRpcBatch, type RpcBatchRequest } from '../../../../core/jurisdiction/adapter/rpc-utils';
import { createHeaderReadQueue, HeaderReadCancelled, requireLiveHeaderClient } from './header-read-queue';
import { createReadPacer } from './read-pacing';
import { readBooleanEnv, readPositiveIntegerEnv } from '../../../../core/config/environment';
import { RPC_BLOCK_RANGE_METHOD, RPC_RECEIPT_BATCH_METHOD } from '../../../../core/jurisdiction/adapter/rpc/watcher/rpc-watcher-block-range';
import { createHyperSyncHeaderReader } from './hypersync-headers';
import { createHyperRpcReceiptReader } from './hyperrpc-receipts';

const requestedApi = readCliOption(process.argv.slice(2), '--api-base', 'http://localhost:8080');
const endpoint = new URL(requestedApi);
if (
  !isLoopbackUrl(requestedApi) ||
  endpoint.protocol !== 'http:' ||
  endpoint.pathname !== '/' ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error('USDC_PREFLIGHT_LOCAL_GATEWAY_REQUIRED');
const apiBase = endpoint.origin;
const catalogPath = process.env['XLN_JURISDICTIONS_PATH'] ?? '';
const providers = new Map<string, ReturnType<typeof preflightProvider>>();
for (const chain of networks) {
  const archive = process.env[chain.env];
  if (!archive) throw new Error(`USDC_EXECUTION_HISTORY_RPC_REQUIRED:${chain.env}`);
  providers.set(chain.path, preflightProvider(runtimeRpc(chain), chain.chainId));
  providers.set('/current' + chain.path, providers.get(chain.path)!);
  providers.set('/history' + chain.path, preflightProvider(archive, chain.chainId));
}
const executionWriters = await openExecutionWriters(process.argv.slice(2), apiBase, catalogPath, providers);

const reported = new Set<string>();
const currentHeaderMethods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash']);
const readArbitrumRange = readBooleanEnv('POC_HYPERSYNC_ARBITRUM_HEADERS', false)
  ? createHyperSyncHeaderReader(process.env['POC_HYPERSYNC_TOKEN'] ?? '')
  : undefined;
const readEthereumReceipts = createHyperRpcReceiptReader();
type GatewayCall = { id: unknown; method: string; params: unknown[] };
const headerReadQueue = createHeaderReadQueue();
let headerCooldownUntilMs = 0;
const traceHeaderTiming = process.env['POC_HEADER_BATCH_TIMING'] === '1';
const paceRead = process.env['POC_RPC_READ_PACING'] === '1' ? createReadPacer() : null;
const headerIntervalMs = readPositiveIntegerEnv('POC_RPC_HEADER_INTERVAL_MS', 500);
const receiptIntervalMs = readPositiveIntegerEnv('POC_RPC_RECEIPT_INTERVAL_MS', 1_000);
let headerBatchSequence = 0;

const beginHeaderTiming = (calls: GatewayCall[], chainId: number, signal: AbortSignal) => {
  if (!traceHeaderTiming || !calls.length || !calls.every(call => call.method === 'eth_getBlockByNumber')) return;
  const id = ++headerBatchSequence;
  const startedAt = performance.now();
  const { active, waiting } = headerReadQueue.size();
  const meta = {
    id,
    chainId,
    items: calls.length,
    positionIds: calls.every((call, index) => call.id === index + 1),
    activeAtArrival: active,
    waitingAtArrival: waiting,
  };
  const mark = (phase: string, failure?: string) => {
    const now = performance.now();
    const event = { ...meta, phase, atMs: Math.round(now), elapsedMs: Math.round(now - startedAt), failure };
    process.stderr.write(`USDC_PREFLIGHT_HEADER_TIMING:${safeStringify(event)}\n`);
  };
  const abort = () => mark('client-abort');
  mark('queued');
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const finish = () => {
    signal.removeEventListener('abort', abort);
    mark('finished');
  };
  return { mark, finish };
};

const readHeaderBatch = async (calls: GatewayCall[], rpc: string, chainId: number, signal: AbortSignal) => {
  const timing = beginHeaderTiming(calls, chainId, signal);
  let release: (() => void) | undefined;
  try {
    release = await headerReadQueue.acquire(signal);
    timing?.mark('admitted');
    requireLiveHeaderClient(signal);
    const cooldown = headerCooldownUntilMs - performance.now();
    if (cooldown > 0) {
      await Bun.sleep(cooldown);
      timing?.mark('cooldown-ended');
    }
    const batch: RpcBatchRequest[] = calls.map(call => {
      if (typeof call.id !== 'number' || !Number.isSafeInteger(call.id) || call.id < 0)
        throw new Error('USDC_PREFLIGHT_HEADER_REQUEST_ID_INVALID');
      return { id: call.id, jsonrpc: '2.0', method: call.method, params: call.params };
    });
    if (paceRead) {
      await paceRead(rpc, headerIntervalMs, signal);
      timing?.mark('pacing-ended');
    }
    requireLiveHeaderClient(signal);
    timing?.mark('sent');
    const responses = await sendRpcBatch(rpc, batch, 10_000);
    timing?.mark('upstream-replied');
    return batch.map(call => {
      const reply = responses.get(call.id);
      if (!reply || (!reply.error && !Object.hasOwn(reply, 'result')))
        throw new Error('USDC_PREFLIGHT_HEADER_RESPONSE_MISSING');
      return {
        jsonrpc: '2.0',
        id: call.id,
        ...(reply.error ? { error: preflightRpcError(reply.error) } : { result: reply.result }),
      };
    });
  } catch (error) {
    const failure = preflightRpcError(error);
    if (error instanceof HeaderReadCancelled) {
      timing?.mark('cancelled');
      return calls.map(call => ({ jsonrpc: '2.0', id: call.id, error: failure }));
    }
    const rawFailure = error instanceof Error ? error.message : '';
    const rateLimited = rawFailure === 'RPC_BATCH_HTTP_429';
    if (rateLimited) headerCooldownUntilMs = performance.now() + 1_000;
    const rpcTimeout = rawFailure === 'RPC_BATCH_TIMEOUT:10000';
    timing?.mark('failed', rateLimited || rpcTimeout ? rawFailure : failure.message);
    process.stderr.write(`USDC_PREFLIGHT_HEADER_BATCH_REJECTED:${failure.message}\n`);
    const detail =
      error instanceof Error
        ? `${error.message}; cause=${error.cause instanceof Error ? error.cause.message : ''}`
        : 'unknown';
    process.stderr.write(
      `USDC_PREFLIGHT_HEADER_BATCH_EVIDENCE:${new URL(rpc).host}:${sanitizeDeploymentMessage(detail, '', rpc)}\n`,
    );
    return calls.map(call => ({ jsonrpc: '2.0', id: call.id, error: failure }));
  } finally {
    release?.();
    timing?.finish();
  }
};

const readPacedReceipt = async (
  call: GatewayCall,
  rpc: string,
  chainId: number,
  signal: AbortSignal,
  pace: ReturnType<typeof createReadPacer>,
) => {
  await pace(rpc, receiptIntervalMs, signal);
  requireLiveHeaderClient(signal);
  const sentAt = Math.round(performance.now());
  const report = (result: number | string) => process.stderr.write(
    `USDC_PREFLIGHT_PACED_RECEIPT:${safeStringify({ chainId, sentAt, ms: Math.round(performance.now()) - sentAt, result })}\n`,
  );
  // Explicit one-call transport here prevents provider-internal HTTP retries
  // from starting a second upstream read outside the configured pacing.
  try {
    const responses = await sendRpcBatch(rpc, [{ id: 1, jsonrpc: '2.0', method: call.method, params: call.params }], 10_000);
    const reply = responses.get(1);
    if (!reply || (!reply.error && !Object.hasOwn(reply, 'result')))
      throw new Error('USDC_PREFLIGHT_RECEIPT_RESPONSE_MISSING');
    report(reply.error ? reply.error.code ?? 'rpc-error' : 'reply');
    return { jsonrpc: '2.0', id: call.id, ...(reply.error ? { error: preflightRpcError(reply.error) } : { result: reply.result }) };
  } catch (error) {
    report(error instanceof Error && error.message === 'RPC_BATCH_HTTP_429' ? 429 : 'transport-error');
    throw error;
  }
};

const relay = startStandaloneRelayServer({
  host: '127.0.0.1',
  port: Number(endpoint.port || 80),
  serverId: 'usdc-poc',
  audience: apiBase.replace('http', 'ws') + '/relay',
  httpHandler: async request => {
    const path = new URL(request.url).pathname;
    const observation = path.startsWith('/current/');
    const provider = providers.get(path);
    if (!provider || request.method !== 'POST') return new Response('USDC PoC read-only gateway', { status: 404 });
    const payload = await request.json();
    const calls = (Array.isArray(payload) ? payload : [payload]).map(raw => {
      const call = requireBoundaryRecord(raw, 'USDC_PREFLIGHT_RPC_REQUEST_INVALID');
      if (typeof call['method'] !== 'string' || !Array.isArray(call['params']))
        throw new Error('USDC_PREFLIGHT_RPC_REQUEST_INVALID');
      return { id: call['id'], method: call['method'], params: call['params'] };
    });
    const chain = networks.find(value => value.path === path);
    const writer = chain && executionWriters.get(chain.chainId);
    const replies =
      chain && calls.every(call => currentHeaderMethods.has(call.method))
        ? await readHeaderBatch(calls, runtimeRpc(chain), chain.chainId, request.signal)
        : await Promise.all(
            calls.map(async call => {
              try {
                if (call.method === RPC_BLOCK_RANGE_METHOD || call.method === RPC_RECEIPT_BATCH_METHOD) {
                  const read = call.method === RPC_BLOCK_RANGE_METHOD
                    ? chain?.chainId === 421614 && readArbitrumRange
                    : chain?.chainId === 11155111 && readEthereumReceipts;
                  if (calls.length !== 1 || !read) throw new Error('USDC_PREFLIGHT_WATCHER_READ_NOT_CONFIGURED');
                  const result = await read(call.params, request.signal);
                  return { jsonrpc: '2.0', id: call.id, result };
                }
                if (writer && call.method === 'xln_executionAuthority')
                  return { jsonrpc: '2.0', id: call.id, result: writer.digest() };
                if (writer && call.method === 'eth_sendRawTransaction') {
                  if (call.params.length !== 1 || typeof call.params[0] !== 'string')
                    throw new Error('USDC_EXECUTION_SIGNED_WIRE_REQUIRED');
                  return { jsonrpc: '2.0', id: call.id, result: await writer.submit(call.params[0]) };
                }
                // Deployment receipts and fixed-block state need archive capability;
                // bulk headers use the explicitly selected current RPC. Header roots
                // still authenticate every receipt and proof returned by the archive.
                const liveNonce =
                  chain &&
                  call.method === 'eth_getTransactionCount' &&
                  (call.params[1] === 'latest' || call.params[1] === 'pending');
                const reader =
                  !observation && !liveNonce && !currentHeaderMethods.has(call['method'])
                    ? providers.get(path.startsWith('/history') ? path : '/history' + path)!
                    : provider;
                if (paceRead && call.method === 'eth_getBlockReceipts') {
                  const receiptChain = chain ?? networks.find(value => '/history' + value.path === path)!;
                  return await readPacedReceipt(call, process.env[receiptChain.env]!, receiptChain.chainId, request.signal, paceRead);
                }
                return { jsonrpc: '2.0', id: call['id'], result: await reader.send(call['method'], call['params']) };
              } catch (error) {
                if (error instanceof HeaderReadCancelled)
                  return { jsonrpc: '2.0', id: call['id'], error: preflightRpcError(error) };
                const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'RPC_ERROR';
                process.stderr.write(`USDC_PREFLIGHT_RPC_REJECTED:${call['method']}:${code}\n`);
                if (!reported.has(`${call['method']}:${code}`)) {
                  reported.add(`${call['method']}:${code}`);
                  let message = error instanceof Error ? error.message : 'RPC_ERROR';
                  message = sanitizeDeploymentMessage(message, '', process.env['POC_HYPERRPC_11155111_RPC']);
                  for (const chain of networks) {
                    message = sanitizeDeploymentMessage(message, '', process.env[chain.env]);
                    message = sanitizeDeploymentMessage(message, '', process.env[`POC_RUNTIME_${chain.chainId}_RPC`]);
                  }
                  process.stderr.write(`USDC_PREFLIGHT_RPC_EVIDENCE:${message}\n`);
                }
                return { jsonrpc: '2.0', id: call['id'], error: preflightRpcError(error) };
              }
            }),
          );
    return new Response(safeStringify(Array.isArray(payload) ? replies : replies[0]), {
      headers: { 'content-type': 'application/json' },
    });
  },
});

const close = () => {
  stopParentWatch();
  relay.close();
  for (const provider of new Set(providers.values())) provider.destroy();
  for (const writer of executionWriters.values()) writer.close();
  process.exit(0);
};
const stopParentWatch = process.env['XLN_ORCHESTRATOR_PID']
  ? startParentLivenessWatch('PoC gateway', process.env['XLN_ORCHESTRATOR_PID'], close)
  : () => {};
process.on('SIGTERM', close);
process.on('SIGINT', close);
