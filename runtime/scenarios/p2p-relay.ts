/**
 * P2P relay orchestration test.
 * Spins up hub + alice + bob nodes and verifies a payment crosses the relay.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { deriveSignerAddressSync } from '../account-crypto';

const hubSeed = 'hub-seed';
const aliceSeed = 'alice-seed';
const bobSeed = 'bob-seed';

const hubRuntimeId = deriveSignerAddressSync(hubSeed, '1');

type ProcInfo = {
  role: string;
  proc: ReturnType<typeof spawn>;
  stdoutBuffer: string[];  // Buffer all stdout for retrospective matching
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

  hub = spawnNode('hub', hubSeed, relayUrl, undefined, [
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
  bob = spawnNode('bob', bobSeed, relayUrl, hubRuntimeId);
  procs.push(bob);
  alice = spawnNode('alice', aliceSeed, relayUrl, hubRuntimeId);
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

  await waitForLineOrError(bob, /P2P_BOB_READY/, errorMatchers);
  console.log('[P2P] Bob credit ready');
  await waitForLineOrError(alice, /P2P_PAYMENT_SENT/, errorMatchers);
  console.log('[P2P] Alice payment sent');
  await waitForLineOrError(bob, /P2P_PAYMENT_RECEIVED/, errorMatchers);
  console.log('✅ P2P relay test passed');

  killAll(procs);
};

run().catch(error => {
  console.error('P2P_RELAY_FATAL', error);
  killAll(procs);
  process.exit(1);
});
