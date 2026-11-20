import type { ChildProcess } from 'node:child_process';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'bun:test';
import { readAuthority } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/authority';
import { requireTargetBacking } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/flow/preflight';
import { readVaultSeed } from '../../../../../jurisdictions/scripts/usdc-cross-j-preflight/identities';
import { Depository__factory, ERC20Mock__factory } from '../../../../../jurisdictions/typechain-types';
import { waitForRpcReady } from '../../../../scripts/operations/settlement/rpc-settlement-anvil';
import { RemoteRuntimeAdapter } from '../../../../api/runtime-adapter/remote';
import { deriveRuntimeAdapterCapabilityToken } from '../../../../api/runtime-adapter/security/auth';
import type { UsdcFixture } from './approval';
import { freePort, stopFixtureChildren, until } from './fixture';
import { JsonRpcProvider, Transaction } from 'ethers';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';
import { computeAccountKey } from '../../../../jurisdiction/adapter/events/contract-codec';
import type { RuntimeAdapterAccountViewPage } from '../../../../api/runtime-adapter/read/compact-view';

type RpcCall = { id: number; method: string; params: unknown[] };

const advanceTargetTariff = async (fixture: UsdcFixture, hub: string, signerId: string, user: string) => {
  const adapter = new RemoteRuntimeAdapter();
  const seed = readVaultSeed(join(fixture.root, 'hub'));
  try {
    await adapter.connect({
      mode: 'remote',
      wsUrl: `ws://127.0.0.1:${fixture.hubPort}/rpc`,
      authKey: deriveRuntimeAdapterCapabilityToken(seed, 'full', Date.now() + 60_000, { audience: 'poc-usdc' }),
    });
    const commandSequence = adapter.nextCommandSequence;
    if (commandSequence === null) throw new Error('TEST_TARIFF_COMMAND_FRONTIER_MISSING');
    await adapter.send(
      {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId: hub,
            signerId,
            entityTxs: [{ type: 'setHubConfig', data: { policyVersion: 2, swapTakerFeeBps: 1 } }],
          },
        ],
      },
      { commandId: 'test-advance-target-tariff', commandSequence },
    );
    await until('new-tariff-committed', async () => {
      const account = await adapter.read<RuntimeAdapterAccountViewPage['items'][number]>(
        `entity/${hub}/account/${user}`,
      );
      const terms = account.state.rebalanceFeePolicies?.get(1);
      return !account.pendingFrame && (terms?.left?.policyVersion === 2 || terms?.right?.policyVersion === 2);
    });
  } finally {
    adapter.disconnect();
  }
};

export const tariffChangeDuringCover = (fixture: UsdcFixture) => {
  const hub = fixture.identities.find(identity => identity.role === 'hub')!.chains[1]!;
  const user = fixture.identities.find(identity => identity.role === 'user')!.chains[1]!;
  const abi = Depository__factory.createInterface();
  const collateralRead = abi.encodeFunctionData('_collaterals', [computeAccountKey(hub.entityId, user.entityId), 1]);
  const reserveRead = abi.encodeFunctionData('_reserves', [hub.entityId, 1]);
  let armed = false;
  let snapshotRead = false;
  return {
    arm: () => {
      armed = true;
    },
    async beforeRead(call: RpcCall) {
      if (!armed || call.method !== 'eth_call') return;
      const data = requireBoundaryRecord(call.params[0], 'TEST_COVER_RPC_CALL')['data'];
      if (data === collateralRead) snapshotRead = true;
      if (!snapshotRead || data !== reserveRead) return;
      armed = false;
      await advanceTargetTariff(fixture, hub.entityId, hub.signerId, user.entityId);
    },
  };
};

export const verifyPendingCoverHash = async (fixture: UsdcFixture, provider: JsonRpcProvider, wire: Transaction) => {
  const seed = readVaultSeed(join(fixture.root, 'hub'));
  const url = new URL(`http://127.0.0.1:${fixture.hubPort}/api/control/evm-attempts`);
  url.search = new URLSearchParams({
    chainId: String(wire.chainId),
    payer: wire.from!.toLowerCase(),
    nonce: String(wire.nonce),
  }).toString();
  const authKey = deriveRuntimeAdapterCapabilityToken(seed, 'inspect', Date.now() + 60_000, { audience: 'poc-usdc' });
  expect(await provider.getTransaction(wire.hash!)).toBeNull();
  expect((await fetch(url, { signal: AbortSignal.timeout(4_000) })).status).toBe(401);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${authKey}` },
    signal: AbortSignal.timeout(4_000),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ hashes: [wire.hash], complete: true });
  return wire.hash!;
};

export const withoutPreflightReports = async <T>(store: string, run: () => Promise<T>): Promise<T> => {
  const reports = join(store, 'execution-reports');
  const saved = join(store, 'preflight-evidence-for-test');
  renameSync(reports, saved);
  try {
    return await run();
  } finally {
    renameSync(saved, reports);
  }
};

export const coverBalanceReadFault = (provider: JsonRpcProvider, recipient: string) => {
  const balanceOf = ERC20Mock__factory.createInterface().encodeFunctionData('balanceOf', [recipient]);
  let armed = false;
  let coverHash: string | undefined;
  return {
    arm: () => {
      armed = true;
    },
    recordCover: (hash: string) => {
      coverHash = hash;
    },
    coverHash: () => coverHash,
    async rejectRead(call: RpcCall) {
      if (!armed || !coverHash || call.method !== 'eth_call') return false;
      if (requireBoundaryRecord(call.params[0], 'TEST_TARGET_RPC_CALL')['data'] !== balanceOf) return false;
      if ((await provider.getTransactionReceipt(coverHash))?.status !== 1) return false;
      armed = false;
      return true;
    },
  };
};

export const startReportRpc = (
  rpc: string,
  provider: JsonRpcProvider,
  withdrawalPayer: string,
  beforeSend?: (wire: Transaction) => Promise<void>,
  failRead?: (call: RpcCall) => boolean | Promise<boolean>,
) => {
  let insertedGap = false;
  const forward = async (call: RpcCall) => {
    if (failRead && (await failRead(call)))
      return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'TEST_REPORT_RPC_INTERRUPTED' } };
    if (beforeSend && call.method === 'eth_sendRawTransaction')
      await beforeSend(Transaction.from(String(call.params[0])));
    if (call.method === 'eth_getLogs') {
      const filter = requireBoundaryRecord(call.params[0], 'TEST_LOG_FILTER');
      const { fromBlock, toBlock } = filter;
      if (
        typeof fromBlock === 'string' &&
        /^0x[0-9a-f]+$/i.test(fromBlock) &&
        typeof toBlock === 'string' &&
        /^0x[0-9a-f]+$/i.test(toBlock) &&
        BigInt(toBlock) - BigInt(fromBlock) >= 10n
      )
        return { jsonrpc: '2.0', id: call.id, error: { code: -32600, message: 'TEST_LOG_RANGE_EXCEEDS_10_BLOCKS' } };
    }
    if (
      !insertedGap &&
      call.method === 'eth_sendRawTransaction' &&
      Transaction.from(String(call.params[0])).from?.toLowerCase() === withdrawalPayer.toLowerCase()
    ) {
      insertedGap = true;
      await provider.send('anvil_mine', ['0xc']);
    }
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: safeStringify(call),
    });
    if (!response.ok) throw new Error(`TEST_REPORT_RPC_HTTP:${response.status}`);
    return response.json();
  };
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as RpcCall | RpcCall[];
      return Response.json(Array.isArray(payload) ? await Promise.all(payload.map(forward)) : await forward(payload));
    },
  });
};

export const reportReceipts = (report: Record<string, unknown>, field: 'ingress' | 'target') => {
  const { receipts } = requireBoundaryRecord(report[field], 'TEST_REPORT_RECEIPT_GROUP');
  if (!Array.isArray(receipts)) throw new Error('TEST_REPORT_RECEIPTS_MISSING');
  return receipts.map(value => {
    const { hash, blockNumber } = requireBoundaryRecord(value, 'TEST_REPORT_RECEIPT_INVALID');
    if (typeof hash !== 'string' || typeof blockNumber !== 'number') throw new Error('TEST_REPORT_RECEIPT_FIELDS');
    return { hash, blockNumber };
  });
};

export const verifyArchiveForkRejected = async (
  fixture: UsdcFixture,
  archiveUrl: string,
  historical: JsonRpcProvider,
  authority: string,
) => {
  const parent = (await historical.getBlock('latest'))!;
  const port = await freePort();
  const forkUrl = `http://127.0.0.1:${port}`;
  const fork = fixture.launch(
    'archive-fork',
    '',
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      '421614',
      '--fork-url',
      archiveUrl,
      '--fork-block-number',
      String(parent.number),
      '--silent',
    ],
    process.env,
    'anvil',
  );
  const current = new JsonRpcProvider(forkUrl, 421614, { cacheTimeout: -1 });
  try {
    await waitForRpcReady(forkUrl);
    expect((await current.getBlock(parent.number))?.hash).toBe(parent.hash);
    await current.send('evm_setNextBlockTimestamp', [parent.timestamp + 3_600]);
    await current.send('evm_mine', []);
    const head = (await current.getBlock('latest'))!;
    await until('distinct-archive-branch', async () => Boolean(await historical.getBlock(head.number)));
    expect((await historical.getBlock(head.number))?.hash).not.toBe(head.hash);
    const chain = readAuthority(authority).chains[1]!;
    await expect(requireTargetBacking(chain, { current, historical }, 1n)).rejects.toThrow(
      'STACK_MANAGER_CANONICAL_SNAPSHOT_CONFLICT',
    );
  } finally {
    current.destroy();
    await stopFixtureChildren([fork]);
  }
};

export const financialChildPid = (parent: ChildProcess, output: string): number => {
  const processes = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,command=']);
  if (processes.exitCode !== 0) throw new Error('TEST_SUPERVISED_PROCESS_LIST_FAILED');
  const matches = processes.stdout
    .toString()
    .split('\n')
    .flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match && Number(match[2]) === parent.pid && match[3]?.endsWith(`--output ${output}`)
        ? [Number(match[1])]
        : [];
    });
  if (matches.length !== 1) throw new Error('TEST_SUPERVISED_RUNNER_REQUIRED');
  return matches[0]!;
};
