import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isError, parseEther } from 'ethers';
import {
  PreflightProvider,
  preflightRpcError,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/provider';
import { prepareIdentities } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/identities';
import { proposeNativeBudget } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/budget';
import { safeStringify } from '../../../../protocol/serialization';
import { isTransientRpcUnavailableError } from '../../../../jurisdiction/adapter/rpc-public';
import {
  readSessionConfig,
  sessionArgs,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/session/config';
import {
  createHeaderReadQueue,
  HeaderReadCancelled,
  requireLiveHeaderClient,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/header-read-queue';
import { createReadPacer } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/read-pacing';
import {
  createArbitrumHeaderRouter,
  parseSecondaryHeaderRpc,
} from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/operators/arbitrum-header-rpc';

test('secondary RPC shares numbered Arbitrum header batches and leaves other requests on the primary lane', () => {
  const useSecondary = createArbitrumHeaderRouter(0x34);
  const block = (height: string, includeTransactions = false) => ({
    method: 'eth_getBlockByNumber',
    params: [height, includeTransactions],
  });
  const batch = [block('0x32'), block('0x33')];
  expect(useSecondary(421614, batch)).toBeTrue();
  expect(useSecondary(11155111, batch)).toBeFalse();
  expect(useSecondary(421614, [])).toBeFalse();
  expect(useSecondary(421614, [block('latest')])).toBeFalse();
  expect(useSecondary(421614, [block('0x32', true)])).toBeFalse();
  expect(useSecondary(421614, [block('0x032')])).toBeFalse();
  expect(useSecondary(421614, [block('0x32'), { method: 'eth_chainId', params: [] }])).toBeFalse();
  expect(useSecondary(421614, [{ method: 'eth_sendRawTransaction', params: ['0x'] }])).toBeFalse();
  expect(useSecondary(421614, batch)).toBeFalse();
  expect(useSecondary(421614, batch)).toBeTrue();
});

test('Arbitrum header routing pins batches at or above the verified common tip to the primary', () => {
  const useSecondary = createArbitrumHeaderRouter(0x34);
  const block = (height: string) => ({ method: 'eth_getBlockByNumber', params: [height, false] });
  const historical = [block('0x32'), block('0x33')];

  expect(useSecondary(421614, [...historical, block('0x34')])).toBeFalse();
  expect(useSecondary(421614, [block('0x35')])).toBeFalse();
  expect(useSecondary(421614, historical)).toBeTrue();
  expect(useSecondary(421614, [block('0x36')])).toBeFalse();
  expect(useSecondary(421614, historical)).toBeFalse();
  expect(useSecondary(421614, historical)).toBeTrue();
});

test('secondary RPC configuration rejects duplicate endpoints and requires HTTPS on external hosts', () => {
  const primary = 'https://primary.example';
  expect(parseSecondaryHeaderRpc(primary, 'https://secondary.example/rpc')).toBe('https://secondary.example/rpc');
  expect(() => parseSecondaryHeaderRpc(primary, 'https://primary.example/'))
    .toThrow('USDC_PREFLIGHT_ARBITRUM_HEADER_RPC_DUPLICATE');
  expect(() => parseSecondaryHeaderRpc(primary, 'http://secondary.example/rpc'))
    .toThrow('USDC_PREFLIGHT_ARBITRUM_HEADER_RPC_INVALID');
  expect(() => parseSecondaryHeaderRpc(primary, ''))
    .toThrow('USDC_PREFLIGHT_ARBITRUM_HEADER_RPC_INVALID');
});

test('read pacing spaces starts on one endpoint and releases a cancelled waiter', async () => {
  const pace = createReadPacer();
  const signal = new AbortController().signal;
  const startedAt = performance.now();
  await pace('headers', 25, signal);
  const cancelled = new AbortController();
  const waiting = pace('headers', 25, cancelled.signal).catch((error: unknown) => error);
  const next = pace('headers', 25, signal);
  cancelled.abort();
  expect(await waiting).toBeInstanceOf(HeaderReadCancelled);
  await next;
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
});

test('header queue drops the cancelled waiter before either slot is released and preserves FIFO', async () => {
  const queue = createHeaderReadQueue();
  const live = new AbortController().signal;
  const cancelled = new AbortController();
  const first = await queue.acquire(live);
  const second = await queue.acquire(live);
  const dropped = queue.acquire(cancelled.signal).catch((error: unknown) => error);
  const order: string[] = [];
  const next = (name: string) => queue.acquire(live).then(release => {
    order.push(name);
    return release;
  });
  const fourth = next('D');
  const fifth = next('E');
  cancelled.abort();
  expect(queue.size()).toEqual({ active: 2, waiting: 2 });
  const rejection = await dropped;
  expect(rejection).toBeInstanceOf(HeaderReadCancelled);
  expect(preflightRpcError(rejection)).toEqual({ code: 503, message: 'RPC_BATCH_HTTP_503' });
  first();
  const releaseFourth = await fourth;
  expect(order).toEqual(['D']);
  expect(queue.size()).toEqual({ active: 2, waiting: 1 });
  releaseFourth();
  const releaseFifth = await fifth;
  expect(order).toEqual(['D', 'E']);
  releaseFifth();
  second();
  expect(queue.size()).toEqual({ active: 0, waiting: 0 });
});

test('header read cancelled at handoff leaves its slot available to the next live request', async () => {
  const queue = createHeaderReadQueue();
  const live = new AbortController().signal;
  const cancelled = new AbortController();
  const first = await queue.acquire(live);
  const second = await queue.acquire(live);
  const handedOff = queue.acquire(cancelled.signal);
  const next = queue.acquire(live);
  first();
  cancelled.abort();
  const releaseHandedOff = await handedOff;
  try {
    expect(() => requireLiveHeaderClient(cancelled.signal)).toThrow(HeaderReadCancelled);
  } finally {
    releaseHandedOff();
  }
  const releaseNext = await next;
  releaseNext();
  second();
  await expect(queue.acquire(cancelled.signal)).rejects.toBeInstanceOf(HeaderReadCancelled);
  expect(queue.size()).toEqual({ active: 0, waiting: 0 });
});

test('public restore accepts an explicit bounded startup budget without changing its default', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-poc-startup-budget-'));
  try {
    prepareIdentities(directory);
    const args = [
      '--directory',
      directory,
      ...['hub', 'mm', 'user'].flatMap(role => [`--${role}-store`, join(directory, role)]),
    ];
    expect(readSessionConfig(args).startupTimeoutMs).toBe(60_000);
    const selected = readSessionConfig([...args, '--startup-timeout-ms', '600000']);
    expect(selected.startupTimeoutMs).toBe(600_000);
    expect(readSessionConfig(sessionArgs(selected)).startupTimeoutMs).toBe(600_000);
    expect(readSessionConfig([...args, '--startup-timeout-ms', '21600000']).startupTimeoutMs).toBe(21_600_000);
    const hubOnly = readSessionConfig([...args, '--hub-only']);
    expect(readSessionConfig(sessionArgs(hubOnly)).hubOnly).toBeTrue();
    for (const incompatible of [['--external-gateway'], ['--authority-file', 'unused.json']])
      expect(() => readSessionConfig([...args, '--hub-only', ...incompatible])).toThrow(
        'USDC_SESSION_HUB_ONLY_REQUIRES_MANAGED_READ_ONLY_GATEWAY',
      );
    for (const invalid of ['0', '59999', String(Number.MAX_SAFE_INTEGER + 1), 'NaN'])
      expect(() => readSessionConfig([...args, '--startup-timeout-ms', invalid])).toThrow(
        'USDC_SESSION_STARTUP_BUDGET_INVALID',
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('captured upstream capacity rejection reaches watcher backoff without leaking provider details', () => {
  const captured = {
    code: 'UNKNOWN_ERROR',
    error: { code: 429, message: 'Your app has exceeded its compute units per second capacity.' },
    payload: { method: 'eth_getBlockByNumber', params: ['0xb966f8', false] },
  };
  const reply = preflightRpcError(captured);
  expect(reply).toEqual({ code: 429, message: 'RPC_BATCH_HTTP_429' });
  expect(
    isTransientRpcUnavailableError(new Error(`J_RECEIPT_BATCH_CALL_FAILED:73:eth_getBlockByNumber:${reply.message}`)),
  ).toBe(true);
  expect(safeStringify(reply)).not.toContain(captured.error.message);
});

test('upstream transient statuses stay transport failures while malformed and authority failures stay terminal', () => {
  for (const code of [429, 500, 502, 503, 504]) {
    const reply = preflightRpcError({ code: 'UNKNOWN_ERROR', error: { code, message: 'Upstream unavailable' } });
    expect(reply.code).toBe(code);
    expect(
      isTransientRpcUnavailableError(new Error(`J_RECEIPT_BATCH_CALL_FAILED:1:eth_getProof:${reply.message}`)),
    ).toBe(true);
  }
  for (const failure of [
    new Error('RPC_BATCH_HTTP_429 in an untrusted protocol error'),
    { code: 'CALL_EXCEPTION', error: { code: 429 }, message: 'execution reverted' },
    { code: 'UNSUPPORTED_OPERATION', error: { code: 429 } },
    { code: 'UNKNOWN_ERROR', error: { code: 401, message: 'Unauthorized' } },
    { code: 'UNKNOWN_ERROR', error: { code: -32602, message: 'Invalid proof parameters' } },
  ]) {
    const reply = preflightRpcError(failure);
    expect(reply).toEqual({ code: -32000, message: 'USDC_PREFLIGHT_RPC_REJECTED' });
    expect(isTransientRpcUnavailableError(new Error(reply.message))).toBe(false);
  }
});

test('captured provider request timeout stays retryable after gateway serialization', () => {
  const captured = { code: 'TIMEOUT', operation: 'request.send', reason: 'timeout', message: 'timeout' };
  const reply = preflightRpcError(captured);
  expect(reply).toEqual({ code: -32000, message: 'RPC_BATCH_TIMEOUT:10000' });
  expect(isTransientRpcUnavailableError(new Error(reply.message))).toBe(true);
});

test('ethers call wrappers preserve an upstream throttle while actual contract reverts stay terminal', () => {
  const provider = new PreflightProvider('http://127.0.0.1:1', 11155111);
  const payload = {
    id: 1,
    jsonrpc: '2.0' as const,
    method: 'eth_call',
    params: [{ to: '0x32A4A72992aD142E36fA1C5989b95FeD60987818', data: '0xb0c26ecf' }, 'latest'],
  };
  try {
    const unavailable = provider.getRpcError(payload, {
      id: 1,
      error: { code: 429, message: 'Your app has exceeded its compute units per second capacity.' },
    });
    expect(isError(unavailable, 'CALL_EXCEPTION')).toBeTrue();
    expect(preflightRpcError(unavailable)).toEqual({ code: 429, message: 'RPC_BATCH_HTTP_429' });
    const reverted = provider.getRpcError(payload, {
      id: 1,
      error: { code: -32000, message: 'execution reverted', data: '0x' },
    });
    expect(preflightRpcError(reverted)).toEqual({ code: -32000, message: 'USDC_PREFLIGHT_RPC_REJECTED' });
  } finally {
    provider.destroy();
  }
});

test('preparation rejects all signing, broadcast and state mutation RPC before transport', () => {
  const provider = new PreflightProvider('http://127.0.0.1:1', 11155111);
  try {
    for (const method of [
      'eth_sendRawTransaction',
      'eth_sendTransaction',
      'eth_sign',
      'personal_sign',
      'wallet_sendCalls',
      'anvil_setBalance',
      'evm_mine',
    ])
      expect(() => provider.send(method, [])).toThrow(`USDC_PREFLIGHT_RPC_FORBIDDEN:${method}`);
  } finally {
    provider.destroy();
  }
});

test('repeated preparation preserves distinct private vaults and reserves recovery inside the proposed cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xln-poc-preparation-'));
  try {
    const first = prepareIdentities(directory);
    expect(prepareIdentities(directory)).toEqual(first);
    expect(new Set(first.flatMap(role => role.chains.map(chain => chain.entityId))).size).toBe(6);
    for (const role of first) {
      const path = join(directory, role.role, 'vault.seed');
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(safeStringify(first)).not.toContain(readFileSync(path, 'utf8'));
    }
    const budget = proposeNativeBudget(first, '0x42Da3Ba8c586F6fe9eF6ed1d09423eB73E4fe25b');
    expect(budget.approved).toBe(false);
    expect(budget.cumulativeEnforcementImplemented).toBe(false);
    for (const chainId of [11155111, 421614]) {
      const payers = budget.payers.filter(payer => payer.chainId === chainId);
      expect(payers).toHaveLength(4);
      const total = payers.reduce(
        (sum, payer) => sum + parseEther(payer.normalEth) + parseEther(payer.recoveryEth),
        0n,
      );
      const limit = chainId === 11155111 ? '0.200' : '0.100';
      expect(total).toBe(parseEther(limit));
      expect(payers.filter(payer => parseEther(payer.recoveryEth) > 0n)).toHaveLength(3);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
