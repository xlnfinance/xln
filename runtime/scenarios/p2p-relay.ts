/**
 * P2P relay orchestration test.
 * Spins up hub + alice + bob nodes and verifies a payment crosses the relay.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { deriveSignerAddressSync } from '../account-crypto';
import { createJAdapter } from '../jadapter';
import { loadJurisdictions } from '../jurisdiction-loader';
import { DEFAULT_TOKENS, DEFAULT_TOKEN_SUPPLY, TOKEN_REGISTRATION_AMOUNT } from '../jadapter/default-tokens';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { ethers } from 'ethers';

const args = globalThis.process.argv.slice(2);
const hasFlag = (name: string) => args.includes(name);
const getArg = (name: string, fallback?: string): string | undefined => {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
};

const useRpc = hasFlag('--rpc') || process.env.P2P_RPC === '1';
const rpcUrlOverride = getArg('--rpc-url') || process.env.P2P_RPC_URL;
const jurisdictionName = getArg('--jurisdiction', 'arrakis')!;
const nodeRpcArgs = useRpc
  ? ['--rpc', '--jurisdiction', jurisdictionName, '--skip-wallet-funding', ...(rpcUrlOverride ? ['--rpc-url', rpcUrlOverride] : [])]
  : [];

const hubSeed = 'hub-seed';
const aliceSeed = 'alice-seed';
const bobSeed = 'bob-seed';

const hubRuntimeId = deriveSignerAddressSync(hubSeed, '1');

type ProcInfo = {
  role: string;
  proc: ReturnType<typeof spawn>;
  stdoutBuffer: string[];  // Buffer all stdout for retrospective matching
};

const ensureTokenCatalog = async (jadapter: any) => {
  const current = await jadapter.getTokenRegistry().catch(() => []);
  if (current.length > 0) {
    return current;
  }

  const depositoryAddress = jadapter.addresses?.depository;
  if (!depositoryAddress) {
    throw new Error('TOKEN_DEPLOY: Depository address missing');
  }

  console.log('[P2P] Deploying default tokens (prefund step)...');
  const erc20Factory = new ERC20Mock__factory(jadapter.signer as any);
  for (const token of DEFAULT_TOKENS) {
    const tokenContract = await erc20Factory.deploy(token.name, token.symbol, DEFAULT_TOKEN_SUPPLY);
    await tokenContract.waitForDeployment();
    const tokenAddress = await tokenContract.getAddress();
    console.log(`[P2P] ${token.symbol} deployed at ${tokenAddress}`);

    const approveTx = await tokenContract.approve(depositoryAddress, TOKEN_REGISTRATION_AMOUNT);
    await approveTx.wait();

    const registerTx = await jadapter.depository.connect(jadapter.signer as any).externalTokenToReserve({
      entity: ethers.ZeroHash,
      contractAddress: tokenAddress,
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: TOKEN_REGISTRATION_AMOUNT,
    });
    await registerTx.wait();
    console.log(`[P2P] Token registered: ${token.symbol}`);
  }

  return await jadapter.getTokenRegistry().catch(() => []);
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

  const jadapter = await createJAdapter({
    mode: 'rpc',
    chainId: entry.chainId,
    rpcUrl,
    fromReplica: {
      depositoryAddress: entry.contracts.depository,
      entityProviderAddress: entry.contracts.entityProvider,
      contracts: entry.contracts,
      chainId: entry.chainId,
    } as any,
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
      await jadapter.provider.send('anvil_setBalance', [address, ethers.toBeHex(targetEth)]);
    } catch {
      const current = await jadapter.provider.getBalance(address);
      if (current < targetEth) {
        const tx = await jadapter.signer.sendTransaction({ to: address, value: targetEth - current });
        await tx.wait();
      }
    }
  }

  for (const token of tokenCatalog) {
    const decimals = BigInt(token.decimals ?? 18);
    const target = 5_000n * 10n ** decimals;
    const erc20 = new ethers.Contract(
      token.address,
      ['function balanceOf(address owner) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'],
      jadapter.signer as any
    );
    for (const wallet of wallets) {
      const address = deriveSignerAddressSync(wallet.seed, wallet.signerId);
      const bal = (await erc20.balanceOf(address)) as bigint;
      if (bal < target) {
        const tx = await erc20.transfer(address, target - bal);
        await tx.wait();
      }
    }
  }

  await jadapter.close();
  console.log('[P2P] Prefund complete');
};

const waitForLine = (procInfo: ProcInfo, matcher: RegExp, timeoutMs = 15000) => {
  return new Promise<void>((resolve, reject) => {
    const maxTicks = Math.max(1, Math.ceil(timeoutMs / 200));
    let ticks = 0;
    const handler = (chunk: Buffer) => {
      const text = chunk.toString();
      if (matcher.test(text)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      procInfo.proc.stdout?.off('data', handler);
      procInfo.proc.off('exit', onExit);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`${procInfo.role} exited early (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
    };
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks > maxTicks) {
        cleanup();
        clearInterval(timer);
        reject(new Error(`Timeout waiting for ${matcher} from ${procInfo.role}`));
      }
    }, 200);
    procInfo.proc.stdout?.on('data', handler);
    procInfo.proc.once('exit', onExit);
  });
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
  seedRuntimeId?: string,
  extraArgs: string[] = []
): ProcInfo => {
  const dbRoot = path.join(process.cwd(), 'db-tmp');
  const relayPort = (() => {
    try {
      const url = new URL(relayUrl);
      return url.port || 'unknown';
    } catch {
      return 'unknown';
    }
  })();
  const dbPath = path.join(dbRoot, `p2p-${role}-${relayPort}`);
  fs.rmSync(dbPath, { recursive: true, force: true });
  fs.mkdirSync(dbPath, { recursive: true });
  const args = [
    'run',
    'runtime/scenarios/p2p-node.ts',
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
    env: {
      ...process.env,
      XLN_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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

const killAll = (procs: ProcInfo[]) => {
  for (const { proc } of procs) {
    if (!proc.killed) {
      proc.kill('SIGTERM');
    }
  }
};

const getFreePort = async () => {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('FREE_PORT_UNAVAILABLE'));
        }
      });
    });
  });
};

const procs: ProcInfo[] = [];

const run = async () => {
  const envPort = process.env.P2P_RELAY_PORT;
  const relayPort = envPort ? Number(envPort) : await getFreePort();
  let hub: ProcInfo | null = null;
  let alice: ProcInfo | null = null;
  let bob: ProcInfo | null = null;
  const relayUrl = `ws://127.0.0.1:${relayPort}`;

  console.log(`[P2P] Using relay port ${relayPort}`);
  if (useRpc) {
    console.log(`[P2P] RPC mode enabled (jurisdiction=${jurisdictionName}${rpcUrlOverride ? ` rpc=${rpcUrlOverride}` : ''})`);
    await prefundRpcWallets();
  }

  hub = spawnNode('hub', hubSeed, relayUrl, undefined, [
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
  bob = spawnNode('bob', bobSeed, relayUrl, hubRuntimeId, [...nodeRpcArgs]);
  procs.push(bob);
  alice = spawnNode('alice', aliceSeed, relayUrl, hubRuntimeId, [...nodeRpcArgs]);
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

  await waitForLineOrError(bob, /P2P_PROFILE_ANNOUNCE/, errorMatchers);
  await waitForLineOrError(alice, /P2P_PROFILE_ANNOUNCE/, errorMatchers);

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
  if (useRpc) {
    await waitForLineOrError(alice, /P2P_R2R_SENT/, errorMatchers);
    await waitForLineOrError(bob, /P2P_R2R_RECEIVED/, errorMatchers);
    console.log('[P2P] R2R confirmed');
  }
  await waitForLineOrError(alice, /P2P_HTLC_SENT|P2P_PAYMENT_SENT/, errorMatchers);
  console.log('[P2P] Alice HTLC sent');
  await waitForLineOrError(bob, /P2P_HTLC_RECEIVED|P2P_PAYMENT_RECEIVED/, errorMatchers);
  console.log('✅ P2P relay test passed');

  killAll(procs);
};

run().catch(error => {
  console.error('P2P_RELAY_FATAL', error);
  killAll(procs);
  process.exit(1);
});
