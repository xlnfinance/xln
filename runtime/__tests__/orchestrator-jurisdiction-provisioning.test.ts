import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JAdapter } from '../jadapter/types';
import { normalizeJurisdictionImportRequest } from '../machine/jurisdiction-import';
import { findMissingRpcContractCode } from '../orchestrator/contract-readiness';
import {
  assertDeterministicRpcStackAddresses,
  deployRpc2JurisdictionStack,
  provisionPrimaryRpcJurisdictionStack,
  type OrchestratorJurisdictionsConfig,
} from '../orchestrator/jurisdictions';
import { createEmptyEnv, enqueueRuntimeInput, process as processRuntime } from '../runtime';
import { setScenarioStorageEnabled } from '../scenarios/helpers';
import { stopProcess, type ManagedChildProcess } from '../scripts/e2e-managed-process';

const CHAIN_ID = 31_337;
const CHAIN_ID_2 = 31_338;
test('cross-chain stack address mismatch fails before runtime import', () => {
  const primary = {
    account: `0x${'11'.repeat(20)}`,
    depository: `0x${'22'.repeat(20)}`,
    entityProvider: `0x${'33'.repeat(20)}`,
    deltaTransformer: `0x${'44'.repeat(20)}`,
  };
  expect(() => assertDeterministicRpcStackAddresses(primary, primary)).not.toThrow();
  expect(() => assertDeterministicRpcStackAddresses(primary, {
    ...primary,
    deltaTransformer: `0x${'55'.repeat(20)}`,
  })).toThrow('CROSS_CHAIN_CONTRACT_ADDRESS_MISMATCH:deltaTransformer');
});
const reservePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      reject(new Error('PRIMARY_RPC_TEST_PORT_RESERVATION_FAILED'));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const rpcCall = async (rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`PRIMARY_RPC_TEST_HTTP_${response.status}`);
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (payload.error) throw new Error(`PRIMARY_RPC_TEST_ERROR:${payload.error.message || 'unknown'}`);
  return payload.result;
};

const waitForRpc = async (rpcUrl: string, chainId = CHAIN_ID): Promise<void> => {
  let lastError = 'not-ready';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if (await rpcCall(rpcUrl, 'eth_chainId') === `0x${chainId.toString(16)}`) return;
      lastError = 'wrong-chain';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(50);
  }
  throw new Error(`PRIMARY_RPC_TEST_NOT_READY:${lastError}`);
};

const startAnvil = (port: number, chainId: number, root: string, stateFile: string): ManagedChildProcess => spawn(
  'anvil',
  [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId),
    '--block-gas-limit', '60000000', '--prune-history', '256', '--silent',
    '--state', join(root, stateFile),
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: root } },
) as ManagedChildProcess;

test('orchestrator provisions exact primary contracts before RPC import', async () => {
  const port = await reservePort();
  const root = await mkdtemp(join(tmpdir(), 'xln-primary-rpc-provision-'));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = startAnvil(port, CHAIN_ID, root, 'state.json');
  const jurisdictionsPath = join(root, 'jurisdictions.json');
  const config: OrchestratorJurisdictionsConfig = {
    shardJurisdictionsPath: jurisdictionsPath,
    rpc2Url: '',
    rpcUrls: { 1: rpcUrl },
  };
  let importedAdapter: JAdapter | null = null;

  try {
    await waitForRpc(rpcUrl);
    await writeFile(jurisdictionsPath, `${JSON.stringify({
      version: '3',
      jurisdictions: {
        primary: {
          name: 'Primary',
          primary: true,
          chainId: CHAIN_ID,
          rpc: '/rpc',
          contracts: {
            account: `0x${'11'.repeat(20)}`,
            depository: `0x${'22'.repeat(20)}`,
            entityProvider: `0x${'33'.repeat(20)}`,
            deltaTransformer: `0x${'44'.repeat(20)}`,
          },
        },
      },
    }, null, 2)}\n`, 'utf8');

    const first = await provisionPrimaryRpcJurisdictionStack(config);
    expect(first.deployed).toBe(true);
    expect(await findMissingRpcContractCode(rpcUrl, first.contracts)).toEqual([]);
    expect(() => normalizeJurisdictionImportRequest({
      name: 'Primary',
      ticker: 'XLN',
      chainId: CHAIN_ID,
      rpcs: [rpcUrl],
      contracts: first.contracts,
      entityProviderDeploymentBlock: first.entityProviderDeploymentBlock,
    })).not.toThrow();

    const blockAfterDeploy = await rpcCall(rpcUrl, 'eth_blockNumber');
    const second = await provisionPrimaryRpcJurisdictionStack(config);
    expect(second).toEqual({ ...first, deployed: false });
    expect(await rpcCall(rpcUrl, 'eth_blockNumber')).toBe(blockAfterDeploy);
    const persisted = JSON.parse(await readFile(jurisdictionsPath, 'utf8')) as
      { jurisdictions: { primary: {
        contracts: Record<string, string>;
        entityProviderDeploymentBlock: number;
      } } };
    expect(persisted.jurisdictions.primary.contracts).toEqual(first.contracts);
    expect(persisted.jurisdictions.primary.entityProviderDeploymentBlock)
      .toBe(first.entityProviderDeploymentBlock);

    const env = createEmptyEnv(`orchestrator-primary-rpc-import-${String(process.pid)}-${String(port)}`);
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    setScenarioStorageEnabled(env, false);
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importJ',
        data: {
          name: 'Primary',
          ticker: 'XLN',
          chainId: CHAIN_ID,
          rpcs: [rpcUrl],
          contracts: first.contracts,
          entityProviderDeploymentBlock: first.entityProviderDeploymentBlock,
        },
      }],
      entityInputs: [],
    });
    await processRuntime(env);
    await processRuntime(env);
    const replica = env.jReplicas.get('Primary');
    importedAdapter = replica?.jadapter ?? null;
    expect(replica?.contracts).toEqual(Object.fromEntries(
      Object.entries(first.contracts).map(([key, value]) => [key, value.toLowerCase()]),
    ));
    expect(importedAdapter).not.toBeNull();

    const importedProvider = importedAdapter!.provider as typeof importedAdapter.provider & {
      destroy(): void;
    };
    const destroyProvider = importedProvider.destroy.bind(importedProvider);
    let destroyCalls = 0;
    importedProvider.destroy = () => {
      destroyCalls += 1;
      destroyProvider();
    };
    const adapterToClose = importedAdapter!;
    await adapterToClose.close();
    await adapterToClose.close();
    importedAdapter = null;

    const deltaTransformer = first.contracts.deltaTransformer;
    const canonicalDeltaCode = await rpcCall(rpcUrl, 'eth_getCode', [deltaTransformer, 'latest']);
    await rpcCall(rpcUrl, 'anvil_setCode', [deltaTransformer, '0x60006000f3']);
    await expect(provisionPrimaryRpcJurisdictionStack(config)).rejects.toThrow(
      'PRIMARY_RPC_CODE_MISMATCH:deltaTransformer',
    );

    await rpcCall(rpcUrl, 'anvil_setCode', [deltaTransformer, canonicalDeltaCode]);
    const canonicalPayloadText = await readFile(jurisdictionsPath, 'utf8');
    const misboundPayload = JSON.parse(canonicalPayloadText) as
      { jurisdictions: { primary: { contracts: Record<string, string> } } };
    const alternateEntityProvider = `0x${'99'.repeat(20)}`;
    const entityProviderCode = await rpcCall(rpcUrl, 'eth_getCode', [first.contracts.entityProvider, 'latest']);
    await rpcCall(rpcUrl, 'anvil_setCode', [alternateEntityProvider, entityProviderCode]);
    misboundPayload.jurisdictions.primary.contracts.entityProvider = alternateEntityProvider;
    await writeFile(jurisdictionsPath, `${JSON.stringify(misboundPayload, null, 2)}\n`, 'utf8');
    await expect(provisionPrimaryRpcJurisdictionStack(config)).rejects.toThrow(
      'PRIMARY_RPC_ENTITY_PROVIDER_BINDING_MISMATCH',
    );

    await writeFile(jurisdictionsPath, canonicalPayloadText, 'utf8');
    await rpcCall(rpcUrl, 'anvil_setCode', [deltaTransformer, '0x']);
    const beforePartialStack = await readFile(jurisdictionsPath, 'utf8');
    const blockBeforePartialStack = await rpcCall(rpcUrl, 'eth_blockNumber');
    await expect(provisionPrimaryRpcJurisdictionStack(config)).rejects.toThrow(
      'PRIMARY_RPC_PARTIAL_STACK_CORRUPTION:deltaTransformer',
    );
    expect(await readFile(jurisdictionsPath, 'utf8')).toBe(beforePartialStack);
    expect(await rpcCall(rpcUrl, 'eth_blockNumber')).toBe(blockBeforePartialStack);
    expect(destroyCalls).toBe(1);
  } finally {
    await importedAdapter?.close();
    await stopProcess(child, 3_000);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 120_000);

test('fresh RPC import uses provisioned deployment metadata after Anvil history is pruned', async () => {
  const port = await reservePort();
  const root = await mkdtemp(join(tmpdir(), 'xln-pruned-rpc-import-'));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = startAnvil(port, CHAIN_ID, root, 'state.json');
  const jurisdictionsPath = join(root, 'jurisdictions.json');
  const config: OrchestratorJurisdictionsConfig = {
    shardJurisdictionsPath: jurisdictionsPath,
    rpc2Url: '',
    rpcUrls: { 1: rpcUrl },
  };
  let importedAdapter: JAdapter | null = null;

  try {
    await waitForRpc(rpcUrl);
    await writeFile(jurisdictionsPath, `${JSON.stringify({
      version: '3',
      jurisdictions: {
        primary: {
          name: 'Primary', primary: true, chainId: CHAIN_ID, rpc: '/rpc',
          contracts: {
            account: `0x${'11'.repeat(20)}`,
            depository: `0x${'22'.repeat(20)}`,
            entityProvider: `0x${'33'.repeat(20)}`,
            deltaTransformer: `0x${'44'.repeat(20)}`,
          },
        },
      },
    }, null, 2)}\n`, 'utf8');

    const provisioned = await provisionPrimaryRpcJurisdictionStack(config);
    const deploymentBlock = provisioned.entityProviderDeploymentBlock;
    expect(await rpcCall(rpcUrl, 'eth_getCode', [
      provisioned.contracts.entityProvider,
      `0x${deploymentBlock.toString(16)}`,
    ])).not.toBe('0x');
    expect(await rpcCall(rpcUrl, 'eth_getCode', [
      provisioned.contracts.entityProvider,
      `0x${(deploymentBlock - 1).toString(16)}`,
    ])).toBe('0x');
    await rpcCall(rpcUrl, 'anvil_mine', ['0x200']);

    const env = createEmptyEnv(`orchestrator-pruned-rpc-import-${String(process.pid)}-${String(port)}`);
    env.quietRuntimeLogs = true;
    env.scenarioMode = true;
    env.timestamp = 1_000;
    setScenarioStorageEnabled(env, false);
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importJ',
        data: {
          name: 'Primary',
          ticker: 'XLN',
          chainId: CHAIN_ID,
          rpcs: [rpcUrl],
          contracts: provisioned.contracts,
          entityProviderDeploymentBlock: deploymentBlock,
        },
      }],
      entityInputs: [],
    });
    await processRuntime(env);
    await processRuntime(env);
    const imported = env.jReplicas.get('Primary');
    importedAdapter = imported?.jadapter ?? null;
    expect(imported?.blockNumber).toBe(BigInt(deploymentBlock - 1));
    expect(importedAdapter?.entityProviderDeploymentBlock).toBe(deploymentBlock);
  } finally {
    await importedAdapter?.close();
    await stopProcess(child, 3_000);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 120_000);

test('secondary RPC stack reuses deterministic addresses across reset retries', async () => {
  const [primaryPort, secondaryPort] = await Promise.all([reservePort(), reservePort()]);
  const root = await mkdtemp(join(tmpdir(), 'xln-two-rpc-provision-'));
  const primaryRpc = `http://127.0.0.1:${primaryPort}`;
  const secondaryRpc = `http://127.0.0.1:${secondaryPort}`;
  const children = [
    startAnvil(primaryPort, CHAIN_ID, root, 'primary-state.json'),
    startAnvil(secondaryPort, CHAIN_ID_2, root, 'secondary-state.json'),
  ];
  const jurisdictionsPath = join(root, 'jurisdictions.json');
  const staleContracts = {
    account: `0x${'11'.repeat(20)}`,
    depository: `0x${'22'.repeat(20)}`,
    entityProvider: `0x${'33'.repeat(20)}`,
    deltaTransformer: `0x${'44'.repeat(20)}`,
  };
  const config: OrchestratorJurisdictionsConfig = {
    shardJurisdictionsPath: jurisdictionsPath,
    rpc2Url: secondaryRpc,
    rpcUrls: { 1: primaryRpc, 2: secondaryRpc },
  };

  try {
    await Promise.all([waitForRpc(primaryRpc), waitForRpc(secondaryRpc, CHAIN_ID_2)]);
    await writeFile(jurisdictionsPath, `${JSON.stringify({
      version: '3',
      jurisdictions: {
        primary: {
          name: 'Primary', primary: true, chainId: CHAIN_ID, rpc: '/rpc',
          contracts: staleContracts,
        },
        tron: {
          name: 'Tron', chainId: CHAIN_ID_2, rpc: '/rpc2', contracts: staleContracts,
        },
      },
    }, null, 2)}\n`, 'utf8');

    const primary = await provisionPrimaryRpcJurisdictionStack(config);
    await deployRpc2JurisdictionStack(config);
    const first = JSON.parse(await readFile(jurisdictionsPath, 'utf8')) as { version: string; jurisdictions: {
        primary: {
          chainId: number;
          entityProviderDeploymentBlock: number;
          contracts: Record<string, string>;
          [key: string]: unknown;
        };
        tron: {
          chainId: number;
          entityProviderDeploymentBlock: number;
          contracts: Record<string, string>;
          [key: string]: unknown;
        };
      } };
    expect(first.jurisdictions.tron.contracts).toEqual(primary.contracts);
    expect(first.jurisdictions.primary.entityProviderDeploymentBlock)
      .toBe(primary.entityProviderDeploymentBlock);
    expect(first.jurisdictions.tron.entityProviderDeploymentBlock).toBeGreaterThan(0);
    const primaryBlock = await rpcCall(primaryRpc, 'eth_blockNumber');
    const secondaryBlock = await rpcCall(secondaryRpc, 'eth_blockNumber');

    // A real reset rewinds the shard metadata from its canonical seed while the
    // Anvil processes retain the already-deployed deterministic stacks.
    await writeFile(jurisdictionsPath, `${JSON.stringify({
      version: first.version,
      jurisdictions: {
        primary: first.jurisdictions.primary,
        tron: first.jurisdictions.tron,
      },
    }, null, 2)}\n`, 'utf8');
    expect((await provisionPrimaryRpcJurisdictionStack(config)).deployed).toBe(false);
    await deployRpc2JurisdictionStack(config);
    const second = JSON.parse(await readFile(jurisdictionsPath, 'utf8')) as { jurisdictions: {
        primary: { chainId: number; entityProviderDeploymentBlock: number; contracts: Record<string, string> };
        tron: { chainId: number; entityProviderDeploymentBlock: number; contracts: Record<string, string> };
      } };
    expect(second.jurisdictions.tron.contracts).toEqual(primary.contracts);
    expect(second.jurisdictions.primary.entityProviderDeploymentBlock)
      .toBe(first.jurisdictions.primary.entityProviderDeploymentBlock);
    expect(second.jurisdictions.tron.entityProviderDeploymentBlock)
      .toBe(first.jurisdictions.tron.entityProviderDeploymentBlock);
    expect(await rpcCall(primaryRpc, 'eth_blockNumber')).toBe(primaryBlock);
    expect(await rpcCall(secondaryRpc, 'eth_blockNumber')).toBe(secondaryBlock);

    const colliding = {
      ...second,
      jurisdictions: {
        ...second.jurisdictions,
        primary: { ...second.jurisdictions.primary, chainId: CHAIN_ID_2 },
      },
    };
    await writeFile(jurisdictionsPath, `${JSON.stringify(colliding, null, 2)}\n`, 'utf8');
    const beforeCollision = await readFile(jurisdictionsPath, 'utf8');
    const blockBeforeCollision = await rpcCall(secondaryRpc, 'eth_blockNumber');
    await expect(deployRpc2JurisdictionStack(config)).rejects.toThrow('RPC2_STACK_DOMAIN_COLLISION');
    expect(await readFile(jurisdictionsPath, 'utf8')).toBe(beforeCollision);
    expect(await rpcCall(primaryRpc, 'eth_blockNumber')).toBe(primaryBlock);
    expect(await rpcCall(secondaryRpc, 'eth_blockNumber')).toBe(blockBeforeCollision);
  } finally {
    await Promise.all(children.map(child => stopProcess(child, 3_000)));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 180_000);
