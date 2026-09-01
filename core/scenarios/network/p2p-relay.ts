/**
 * P2P relay orchestration test.
 * Spins up hub + alice + bob nodes and verifies a payment crosses the relay.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ethers } from 'ethers';
import { deriveSignerAddressSync } from '../../account/crypto';
import { createJAdapter } from '../../jurisdiction/adapter';
import type { JAdapter, JTokenInfo } from '../../jurisdiction/adapter/types';
import { loadJurisdictions } from '../../jurisdiction/adapter/kernel/jurisdiction-loader';
import { deployMissingDefaultTokens } from '../../jurisdiction/adapter/operations/dev-token-deployment';
import type { JReplica } from '../../types/jurisdiction-runtime';
import { hasCliFlag, readCliOption } from '../../config/cli';
import { acquireLocalTestPortLease } from '../../scripts/e2e/harness/local-test-port-lease';
import { stopProcessGroup } from '../../scripts/e2e/runners/process-group';
import { assertScenarioRpcOutsideDev, buildScenarioIsolatedEnv } from '../harness/scenario-isolation';

const args = globalThis.process.argv.slice(2);
const hasFlag = (name: string): boolean => hasCliFlag(args, name);

const useRpc = hasFlag('--rpc') || process.env['P2P_RPC'] === '1';
const rpcUrlOverride = readCliOption(args, '--rpc-url') || process.env['P2P_RPC_URL'];
const jurisdictionName = readCliOption(args, '--jurisdiction', 'arrakis');
const nodeRpcArgs = useRpc
  ? ['--rpc', '--jurisdiction', jurisdictionName, '--skip-wallet-funding', ...(rpcUrlOverride ? ['--rpc-url', rpcUrlOverride] : [])]
  : [];
if (useRpc && !rpcUrlOverride) throw new Error('P2P_RPC_URL_REQUIRED');
if (rpcUrlOverride) assertScenarioRpcOutsideDev(rpcUrlOverride);

const hubSeed = 'hub-seed';
const aliceSeed = 'alice-seed';
const bobSeed = 'bob-seed';

const hubRuntimeId = deriveSignerAddressSync(hubSeed, '1');

type ProcInfo = {
  role: string;
  proc: ReturnType<typeof spawn>;
  stdoutBuffer: string[];  // Buffer all stdout for retrospective matching
};

const ensureTokenCatalog = async (jadapter: JAdapter): Promise<JTokenInfo[]> => {
  await deployMissingDefaultTokens(jadapter, jurisdictionName);
  return await jadapter.getTokenRegistry();
};

const prefundRpcWallets = async (): Promise<void> => {
  const data = loadJurisdictions();
  const entry = data.jurisdictions?.[jurisdictionName];
  if (!entry) {
    throw new Error(`JURISDICTION_NOT_FOUND: ${jurisdictionName}`);
  }
  const rpcUrl = rpcUrlOverride ?? entry.rpc;
  if (!rpcUrl) {
    throw new Error(`JURISDICTION_RPC_MISSING: ${jurisdictionName}`);
  }
  if (!entry.contracts?.depository || !entry.contracts?.entityProvider) {
    throw new Error(`JURISDICTION_CONTRACTS_MISSING: ${jurisdictionName}`);
  }

  const fromReplica: JReplica = {
    name: jurisdictionName,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
    contracts: entry.contracts,
    chainId: entry.chainId,
  };

  const jadapter = await createJAdapter({
    mode: 'rpc',
    chainId: entry.chainId,
    rpcUrl,
    fromReplica,
  });

  const tokenCatalog = await ensureTokenCatalog(jadapter);
  const wallets = [
    { role: 'hub', seed: hubSeed, signerId: 'hub-validator' },
    { role: 'alice', seed: aliceSeed, signerId: 'alice-validator' },
    { role: 'bob', seed: bobSeed, signerId: 'bob-validator' },
  ];

  const targetEth = ethers.parseEther('2');
  for (const wallet of wallets) {
    const address = deriveSignerAddressSync(wallet.seed, wallet.signerId);
    try {
      const providerWithSend = jadapter.provider as { send?: (method: string, params: unknown[]) => Promise<unknown> };
      if (typeof providerWithSend.send !== 'function') {
        throw new Error('provider.send unavailable');
      }
      await providerWithSend.send('anvil_setBalance', [address, ethers.toBeHex(targetEth)]);
    } catch {
      const current = await jadapter.provider.getBalance(address);
      if (current < targetEth) {
        const tx = await jadapter.signer.sendTransaction({ to: address, value: targetEth - current });
        await tx.wait();
      }
    }
  }

  for (const token of tokenCatalog) {
    const decimals = BigInt(token.decimals);
    const target = 5_000n * 10n ** decimals;
    const erc20 = new ethers.Contract(
      token.address,
      ['function balanceOf(address owner) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'],
      jadapter.signer
    );
    for (const wallet of wallets) {
      const address = deriveSignerAddressSync(wallet.seed, wallet.signerId);
      const balanceOf = erc20.getFunction('balanceOf');
      const transfer = erc20.getFunction('transfer');
      const bal = (await balanceOf(address)) as bigint;
      if (bal < target) {
        const tx = await transfer(address, target - bal);
        await tx.wait();
      }
    }
  }

  await jadapter.close();
  console.log('[P2P] Prefund complete');
};

const waitForLineOrError = (
  procInfo: ProcInfo,
  matcher: RegExp,
  errorMatchers: RegExp[],
  timeoutMs = 15000
) => {
  return new Promise<void>((resolve, reject) => {
    // FIRST: Check already-buffered output (solves race condition)
    for (const line of procInfo.stdoutBuffer) {
      if (matcher.test(line)) {
        resolve();
        return;
      }
      for (const err of errorMatchers) {
        if (err.test(line)) {
          reject(new Error(`${procInfo.role} reported error: ${line.trim()}`));
          return;
        }
      }
    }

    const maxTicks = Math.max(1, Math.ceil(timeoutMs / 200));
    let ticks = 0;
    let resolved = false;
    const handler = (chunk: Buffer) => {
      if (resolved) return;
      const text = chunk.toString();
      // Note: Buffer is already populated by spawnNode's handlers
      if (matcher.test(text)) {
        resolved = true;
        cleanup();
        resolve();
        return;
      }
      for (const err of errorMatchers) {
        if (err.test(text)) {
          cleanup();
          reject(new Error(`${procInfo.role} reported error: ${text.trim()}`));
          return;
        }
      }
    };
    const cleanup = () => {
      procInfo.proc.stdout?.off('data', handler);
      procInfo.proc.stderr?.off('data', handler);
      procInfo.proc.off('exit', onExit);
      clearInterval(timer);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (resolved) return;
      cleanup();
      // Exit code 0 is success - process may have buffered output
      // Give a small delay for any buffered stdout to arrive
      if (code === 0 && signal === null) {
        setTimeout(() => {
          if (!resolved) {
            reject(new Error(`${procInfo.role} exited successfully but expected line '${matcher}' not found`));
          }
        }, 200);
      } else {
        reject(new Error(`${procInfo.role} exited early (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
      }
    };
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks > maxTicks) {
        cleanup();
        reject(new Error(`Timeout waiting for ${matcher} from ${procInfo.role}`));
      }
    }, 200);
    procInfo.proc.stdout?.on('data', handler);
    procInfo.proc.stderr?.on('data', handler);
    procInfo.proc.once('exit', onExit);
  });
};

const smokeConnect = async (relayUrl: string, timeoutMs = 3000) => {
  const { WebSocket } = await import('ws');
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WS_SMOKE_TIMEOUT: ${relayUrl}`));
    }, timeoutMs);
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

const spawnNode = (
  role: string,
  seed: string,
  relayUrl: string,
  scenarioDbRoot: string,
  seedRuntimeId?: string,
  extraArgs: string[] = []
): ProcInfo => {
  const dbPath = path.join(scenarioDbRoot, role);
  fs.mkdirSync(dbPath, { recursive: true });
  const args = [
    'run',
    'core/scenarios/network/p2p-node.ts',
    '--role',
    role,
    '--seed',
    seed,
    '--relay-url',
    relayUrl,
    ...extraArgs,
  ];

  if (seedRuntimeId) {
    args.push('--seed-runtime-id', seedRuntimeId);
  }

  const proc = spawn('bun', args, {
    detached: true,
    env: buildScenarioIsolatedEnv(process.env, dbPath, rpcUrlOverride ?? null),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutBuffer: string[] = [];

  proc.stdout?.on('data', chunk => {
    const text = chunk.toString();
    stdoutBuffer.push(text);  // Buffer all output
    process.stdout.write(`[${role}] ${text}`);
  });
  proc.stderr?.on('data', chunk => {
    const text = chunk.toString();
    stdoutBuffer.push(text);  // Also buffer stderr
    process.stderr.write(`[${role}] ${text}`);
  });

  return { role, proc, stdoutBuffer };
};

const killAll = async (procs: ProcInfo[]): Promise<void> => {
  await Promise.all(procs.map(async ({ proc, role }) => {
    if (!proc.pid) return;
    await stopProcessGroup({
      pid: proc.pid,
      termTimeoutMs: 2_000,
      killTimeoutMs: 1_000,
      timeoutError: `P2P_PROCESS_GROUP_STOP_TIMEOUT:${role}:${proc.pid}`,
    });
  }));
};

const procs: ProcInfo[] = [];

const run = async () => {
  const lease = await acquireLocalTestPortLease({ requiredOffsets: [0], timeoutMs: 25_000 });
  const relayPort = lease.basePort;
  const scenarioDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xln-p2p-relay-'));
  let hub: ProcInfo | null = null;
  let alice: ProcInfo | null = null;
  let bob: ProcInfo | null = null;
  const relayUrl = `ws://127.0.0.1:${relayPort}`;

  console.log(`[P2P] Using relay port ${relayPort}`);
  try {
  if (useRpc) {
    console.log(`[P2P] RPC mode enabled (jurisdiction=${jurisdictionName}${rpcUrlOverride ? ` rpc=${rpcUrlOverride}` : ''})`);
    await prefundRpcWallets();
  }

  hub = spawnNode('hub', hubSeed, relayUrl, scenarioDbRoot, undefined, [
    ...nodeRpcArgs,
    '--hub',
    '--relay-port',
    String(relayPort),
    '--relay-host',
    '127.0.0.1',
  ]);
  procs.push(hub);

  // Wait for hub relay to be ready (guarantees WS server listening)
  await waitForLineOrError(
    hub,
    /P2P_RELAY_READY/,
    [/Runtime relay.*failed/i, /Failed to start server/i, /RELAY_PORT_MISSING/i]
  );

  // SMOKE CHECK: Verify relay actually accepts connections
  console.log('[P2P] Running smoke check - connecting to relay...');
  try {
    await smokeConnect(relayUrl, 3000);
    console.log('[P2P] ✅ Smoke check passed - relay accepting connections');
  } catch (error) {
    throw new Error(`Relay smoke check failed: ${(error as Error).message}`);
  }

  console.log('[P2P] Hub relay ready - spawning alice/bob NOW');

  // Spawn alice/bob IMMEDIATELY (before hub starts waiting for them)
  bob = spawnNode('bob', bobSeed, relayUrl, scenarioDbRoot, hubRuntimeId, [
    ...nodeRpcArgs,
    '--stay-alive-after-payment',
  ]);
  procs.push(bob);
  alice = spawnNode('alice', aliceSeed, relayUrl, scenarioDbRoot, hubRuntimeId, [
    ...nodeRpcArgs,
    '--wait-for-bob-ready',
    '--stay-alive-after-payment',
  ]);
  procs.push(alice);

  console.log('[P2P] Waiting for all nodes ready...');

  // Wait for all nodes to reach P2P_NODE_READY state
  await Promise.all([
    waitForLineOrError(hub, /P2P_NODE_READY role=hub/, [/PROFILE_TIMEOUT/i, /P2P_NODE_FATAL/i]),
    waitForLineOrError(alice, /P2P_NODE_READY role=alice/, [/PROFILE_TIMEOUT/i, /P2P_NODE_FATAL/i]),
    waitForLineOrError(bob, /P2P_NODE_READY role=bob/, [/PROFILE_TIMEOUT/i, /P2P_NODE_FATAL/i]),
  ]);

  console.log('[P2P] All nodes ready');

  if (!hub) {
    throw new Error('HUB_START_FAILED');
  }

  // All nodes already ready from Promise.all above
  console.log(`[P2P] All nodes connected to relay ${relayUrl}`)

;

  const errorMatchers = [
    /PROFILE_TIMEOUT/i,
    /PROFILE_MISSING/i,
    /SIGNER_KEY_MISSING/i,
    /Invalid.*signature/i,
    /WS_CLIENT_ERROR/i,
    /FATAL/i,
  ];

  await waitForLineOrError(hub, /P2P_GOSSIP_READY/, errorMatchers);
  await waitForLineOrError(bob, /P2P_HUB_PROFILE_READY/, errorMatchers);
  await waitForLineOrError(alice, /P2P_HUB_PROFILE_READY/, errorMatchers);
  console.log('[P2P] Gossip ready');

  if (useRpc) {
    await waitForLineOrError(hub, /P2P_FAUCET_READY role=hub/, errorMatchers);
    await waitForLineOrError(alice, /P2P_FAUCET_READY role=alice/, errorMatchers);
    await waitForLineOrError(bob, /P2P_FAUCET_READY role=bob/, errorMatchers);
    console.log('[P2P] Faucets ready');
  }

  await waitForLineOrError(bob, /P2P_BOB_READY/, errorMatchers);
  console.log('[P2P] Bob credit ready');
  if (!alice.proc.stdin?.writable) {
    throw new Error('P2P_ALICE_STDIN_UNAVAILABLE');
  }
  alice.proc.stdin.write('P2P_BOB_READY\n');
  if (useRpc) {
    await waitForLineOrError(alice, /P2P_R2R_SENT/, errorMatchers);
    await waitForLineOrError(bob, /P2P_R2R_RECEIVED/, errorMatchers);
    console.log('[P2P] R2R confirmed');
  }
  await waitForLineOrError(alice, /P2P_HTLC_SENT|P2P_PAYMENT_SENT/, errorMatchers);
  console.log('[P2P] Alice HTLC sent');
  await waitForLineOrError(bob, /P2P_HTLC_RECEIVED|P2P_PAYMENT_RECEIVED/, errorMatchers);
  await waitForLineOrError(hub, /P2P_END_TO_END_SETTLED/, errorMatchers);
  console.log('✅ P2P relay test passed');

  } finally {
    await killAll(procs);
    fs.rmSync(scenarioDbRoot, { recursive: true, force: true });
    lease.release();
  }
};

run().catch(error => {
  console.error('P2P_RELAY_FATAL', error);
  process.exitCode = 1;
});
