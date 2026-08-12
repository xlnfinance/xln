#!/usr/bin/env bun
/**
 * RPC settlement parity harness.
 *
 * Proves that J-events decoded from a submitted batch receipt hash identically
 * to the same events refetched from the chain, and that reserves moved exactly
 * as the batch declared.
 *
 * Modes:
 *   deploy  Bring up a stack and write a deployment descriptor. Nothing else.
 *   attach  Read a descriptor and run parity against that already deployed
 *           stack. Never deploys, so it is safe against a public chain whose
 *           sources are already verified.
 *   all     Deploy and run parity in one process (default; local anvil flow).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PRIVATE_KEY, DEV_CHAIN_IDS, createJAdapter } from '../../../jurisdiction/adapter';
import type { JAdapter } from '../../../jurisdiction/adapter/types';
import { startAnvil, stopAnvil, waitForRpcReady, type ManagedAnvil } from './rpc-settlement-anvil';
import { runParity } from './rpc-settlement-run';
import {
  readJurisdictionDeployment,
  readParityDeployment,
  toParityDeployment,
  toReplicaConnection,
  writeParityDeployment,
  type ParityDeployment,
} from './rpc-settlement-deployment';

type Mode = 'deploy' | 'attach' | 'all';

type Args = {
  mode: Mode;
  rpcUrl: string;
  chainId: number;
  spawnAnvil: boolean;
  anvilPort: number;
  keepAnvil: boolean;
  deploymentPath?: string;
  deploymentOut: string;
  tokenAddress?: string;
};

type Jurisdiction = {
  chainId: number;
  rpc: string;
  tokens?: { USDT?: { address?: string } };
};

let activeAnvil: ManagedAnvil | null = null;
let keepActiveAnvil = false;

const readFlags = (): Map<string, string | true> => {
  const flags = new Map<string, string | true>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const current = process.argv[index];
    if (!current || !current.startsWith('--')) continue;
    const [inlineKeyRaw, inlineValue] = current.split('=', 2);
    const inlineKey = inlineKeyRaw || current;
    if (inlineValue !== undefined) {
      flags.set(inlineKey, inlineValue);
      continue;
    }
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(current, true);
      continue;
    }
    flags.set(current, next);
    index += 1;
  }
  return flags;
};

const parseMode = (raw: string | true | undefined): Mode => {
  const value = raw === undefined ? 'all' : String(raw);
  if (value === 'deploy' || value === 'attach' || value === 'all') return value;
  throw new Error(`PARITY_MODE_INVALID:${value}`);
};

const loadJurisdiction = (id: string): Jurisdiction => {
  const path = fileURLToPath(new URL('../../../../jurisdictions/jurisdictions.json', import.meta.url));
  const catalog = JSON.parse(readFileSync(path, 'utf8')) as {
    jurisdictions: Record<string, Jurisdiction>;
  };
  const entry = catalog.jurisdictions[id];
  if (!entry) throw new Error(`PARITY_JURISDICTION_UNKNOWN:${id}`);
  return entry;
};

const parseArgs = (): Args => {
  const flags = readFlags();
  const mode = parseMode(flags.get('--mode'));
  const jurisdictionId = flags.get('--jurisdiction');

  let chainId = Number(flags.get('--chain-id') || 31337);
  let rpcUrl = flags.get('--rpc-url') ? String(flags.get('--rpc-url')) : '';
  let tokenAddress = flags.get('--token') ? String(flags.get('--token')) : undefined;
  let deploymentPath = flags.get('--deployment') ? String(flags.get('--deployment')) : undefined;

  if (typeof jurisdictionId === 'string') {
    const jurisdiction = loadJurisdiction(jurisdictionId);
    chainId = Number(jurisdiction.chainId);
    rpcUrl = rpcUrl || jurisdiction.rpc;
    tokenAddress = tokenAddress ?? jurisdiction.tokens?.USDT?.address;
    deploymentPath = deploymentPath ?? `jurisdictions/deployments/${jurisdictionId}.json`;
  }

  const anvilPort = Number(flags.get('--anvil-port') || 18545);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error(`PARITY_CHAIN_ID_INVALID:${chainId}`);
  if (!Number.isFinite(anvilPort) || anvilPort <= 0) throw new Error(`PARITY_ANVIL_PORT_INVALID:${anvilPort}`);

  const resolvedRpc = rpcUrl || process.env['ANVIL_RPC'] || `http://127.0.0.1:${anvilPort}`;
  const args: Args = {
    mode,
    rpcUrl: resolvedRpc,
    chainId: Math.floor(chainId),
    // Only the single-process flow may spawn its own chain. A spawned anvil dies
    // with this process, so deploy mode must target a chain that outlives it,
    // and attach mode by definition already has one. A non-dev chain is never
    // local, so spawning would race a real endpoint.
    spawnAnvil: mode === 'all' && !flags.has('--no-spawn-anvil') && DEV_CHAIN_IDS.has(Math.floor(chainId)),
    anvilPort: Math.floor(anvilPort),
    keepAnvil: flags.has('--keep-anvil'),
    deploymentOut: String(flags.get('--deployment-out') || '.logs/rpc-settlement/deployment.json'),
  };
  if (deploymentPath !== undefined) args.deploymentPath = deploymentPath;
  if (tokenAddress !== undefined) args.tokenAddress = tokenAddress;
  return args;
};

/**
 * A non-dev chain must never fall back to the well-known anvil key. The key is
 * read from the environment and never logged.
 */
const resolvePrivateKey = (chainId: number): string => {
  if (DEV_CHAIN_IDS.has(chainId)) return DEFAULT_PRIVATE_KEY;
  const key = String(process.env['PUBLIC_CHAIN_PRIVATE_KEY'] || '').trim();
  if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error(`PARITY_PUBLIC_CHAIN_PRIVATE_KEY_REQUIRED:${chainId}`);
  return key;
};

const loadDeployment = (args: Args): ParityDeployment => {
  if (!args.deploymentPath) throw new Error('PARITY_DEPLOYMENT_PATH_REQUIRED');
  const deployment = args.deploymentPath.includes('jurisdictions/deployments/')
    ? readJurisdictionDeployment(args.deploymentPath)
    : readParityDeployment(args.deploymentPath);
  if (deployment.chainId !== args.chainId) {
    throw new Error(`PARITY_DEPLOYMENT_CHAIN_MISMATCH:${deployment.chainId}:${args.chainId}`);
  }
  return deployment;
};

const openAdapter = async (args: Args, privateKey: string): Promise<JAdapter> => {
  const base = { mode: 'rpc' as const, chainId: args.chainId, rpcUrl: args.rpcUrl, privateKey };
  if (args.mode !== 'attach') return await createJAdapter(base);
  return await createJAdapter({ ...base, fromReplica: toReplicaConnection(loadDeployment(args)) });
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  if (args.spawnAnvil) activeAnvil = await startAnvil({ chainId: args.chainId, port: args.anvilPort });
  keepActiveAnvil = args.keepAnvil;
  const cleanup = async (): Promise<void> => {
    const managed = activeAnvil;
    activeAnvil = null;
    await stopAnvil(managed, keepActiveAnvil);
  };
  process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
  process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });

  await waitForRpcReady(args.rpcUrl);
  const privateKey = resolvePrivateKey(args.chainId);
  const adapter = await openAdapter(args, privateKey);
  if (args.mode !== 'attach') await adapter.deployStack();

  if (args.mode === 'deploy') {
    const deployment = toParityDeployment(
      args.chainId,
      adapter.addresses,
      adapter.entityProviderDeploymentBlock,
    );
    const written = writeParityDeployment(args.deploymentOut, deployment);
    await adapter.close();
    await cleanup();
    console.log('✅ rpc-settlement-parity deployed');
    console.log(JSON.stringify({ kind: 'RPC_SETTLEMENT_DEPLOYMENT', path: written, ...deployment }, null, 2));
    return;
  }

  await runParity(adapter, args, privateKey);
  await adapter.close();
  await cleanup();
};

main().catch(async (error) => {
  await stopAnvil(activeAnvil, keepActiveAnvil);
  activeAnvil = null;
  console.error('❌ rpc-settlement-parity failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
