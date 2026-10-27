import { expect, test } from 'bun:test';

import { isTransientRpcUnavailableError } from '../../../jurisdiction/adapter/rpc-public';
import { isRpcWatcherTransientError } from '../../../jurisdiction/adapter/rpc/rpc-adapter';
import { ReceiptAvailabilityError } from '../../../jurisdiction/adapter/receipt-root';
import { RpcTransportUnavailableError } from '../../../jurisdiction/adapter/kernel/failure';
import { createRpcChainIo } from '../../../jurisdiction/adapter/rpc/rpc-chain-io';
import type { JAdapterConfig } from '../../../jurisdiction/adapter/types';
import { ethers } from 'ethers';

/**
 * A shared public RPC rate-limits by IP. Classifying that throttle as fatal
 * permanently halted the jurisdiction watcher for the whole adapter instance,
 * and every restart afterwards short-circuited on the recorded fatal error.
 */
test('HTTP 429 throttling is transient, like the 5xx family already in the list', () => {
  expect(isTransientRpcUnavailableError(new Error('RPC_BATCH_HTTP_429'))).toBe(true);
  expect(isTransientRpcUnavailableError(new Error('429 Too Many Requests'))).toBe(true);
  expect(isTransientRpcUnavailableError(new Error('server response 429'))).toBe(true);
  expect(isTransientRpcUnavailableError(new Error('responseStatus: 429'))).toBe(true);
});

test('existing transient classifications still hold', () => {
  for (const message of [
    'RPC_BATCH_HTTP_503',
    'RPC_BATCH_HTTP_502',
    '504 Gateway Timeout',
    'ECONNREFUSED',
    'Failed to fetch',
    'RPC_BATCH_TIMEOUT:30000',
  ]) {
    expect(isTransientRpcUnavailableError(new Error(message))).toBe(true);
  }
});

test('typed receipt availability failures stay retryable at the watcher controller boundary', () => {
  expect(isRpcWatcherTransientError(
    new ReceiptAvailabilityError('J_RECEIPT_BLOCK_MISSING', '123'),
  )).toBe(true);
  expect(isRpcWatcherTransientError(
    new ReceiptAvailabilityError('J_RECEIPT_TRANSACTION_RECEIPT_MISSING', '0x1234'),
  )).toBe(true);
  expect(isRpcWatcherTransientError(new Error('J_RECEIPT_ROOT_MISMATCH'))).toBe(false);
});

test('genuine faults stay fatal so a broken stack still fails loudly', () => {
  for (const message of [
    'RPC_BATCH_HTTP_400',
    'RPC_BATCH_HTTP_401',
    'RPC_BATCH_HTTP_404',
    'DEPOSITORY_ENTITY_PROVIDER_BINDING_MISMATCH',
    'J_RECEIPT_ROOT_MISMATCH',
  ]) {
    expect(isTransientRpcUnavailableError(new Error(message))).toBe(false);
  }
});

test('the adapter\'s own TRON transport outages are retryable, never a watcher exit', async () => {
  // TRON_SOLIDIFIED_HEAD_HTTP:503 and TRON_RPC_TIMEOUT matched no transient
  // pattern, so one flaky TRON response exited the whole process.
  let status = 503;
  const server = Bun.serve({ port: 0, fetch: () => new Response('busy', { status }) });
  try {
    const host = `http://127.0.0.1:${server.port}`;
    const chainIo = createRpcChainIo(
      { mode: 'tron', rpcUrl: `${host}/jsonrpc`, tronFullHost: host } as JAdapterConfig,
      new ethers.JsonRpcProvider(`${host}/jsonrpc`),
      ethers.Wallet.createRandom(),
    );
    const outage = await chainIo.readSafeBlockNumber().catch((error: unknown) => error);
    expect(outage).toBeInstanceOf(RpcTransportUnavailableError);
    expect(String((outage as Error).message)).toBe('TRON_SOLIDIFIED_HEAD_HTTP:503');
    expect(isRpcWatcherTransientError(outage)).toBe(true);
    expect(isRpcWatcherTransientError(new Error('J_WATCHER_POLL_FAILED', { cause: outage }))).toBe(true);

    status = 400;
    const rejected = await chainIo.readSafeBlockNumber().catch((error: unknown) => error);
    expect(String((rejected as Error).message)).toBe('TRON_SOLIDIFIED_HEAD_HTTP:400');
    expect(isRpcWatcherTransientError(rejected)).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test('a header audit wider than one proxy batch is split, never a fatal 413', async () => {
  const hashAt = (height: number) => ethers.zeroPadValue(ethers.toBeHex(height + 1), 32);
  const batchSizes: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      const batch = await request.json() as Array<{ id: number; params: [string, boolean] }>;
      batchSizes.push(batch.length);
      if (batch.length > 128) return new Response('too many calls', { status: 413 });
      return Response.json(batch.map(({ id, params }) => {
        const height = Number(params[0]);
        return { jsonrpc: '2.0', id, result: { number: params[0], hash: hashAt(height), parentHash: hashAt(height - 1) } };
      }));
    },
  });
  try {
    const rpcUrl = `http://127.0.0.1:${server.port}`;
    const chainIo = createRpcChainIo(
      { mode: 'rpc', rpcUrl } as JAdapterConfig,
      new ethers.JsonRpcProvider(rpcUrl),
      ethers.Wallet.createRandom(),
    );
    const heights = Array.from({ length: 300 }, (_, index) => index + 1);
    const headers = await chainIo.readBlockHeaders([...heights].reverse());
    expect(headers.map(header => header.jHeight)).toEqual(heights);
    expect(headers.at(-1)?.jBlockHash).toBe(hashAt(300));
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(128);
  } finally {
    await server.stop(true);
  }
});
