/**
 * P2P relay orchestration test.
 * Spins up hub + alice + bob nodes and verifies a payment crosses the relay.
 */

import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { deriveSignerAddressSync } from '../account-crypto';

const hubSeed = 'hub-seed';
const aliceSeed = 'alice-seed';
const bobSeed = 'bob-seed';

const hubRuntimeId = deriveSignerAddressSync(hubSeed, '1');

type ProcInfo = {
  role: string;
  proc: ReturnType<typeof spawn>;
};

const waitForLine = (procInfo: ProcInfo, matcher: RegExp, timeoutMs = 15000) => {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
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
      if (Date.now() - start > timeoutMs) {
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
    const start = Date.now();
    const handler = (chunk: Buffer) => {
      const text = chunk.toString();
      if (matcher.test(text)) {
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
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`${procInfo.role} exited early (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
    };
    const timer = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        cleanup();
        clearInterval(timer);
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
  fs.mkdirSync(dbRoot, { recursive: true });
  const dbPath = path.join(dbRoot, `${role}-${Date.now()}`);
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

  proc.stdout?.on('data', chunk => {
    process.stdout.write(`[${role}] ${chunk.toString()}`);
  });
  proc.stderr?.on('data', chunk => {
    process.stderr.write(`[${role}] ${chunk.toString()}`);
  });

  return { role, proc };
};

const killAll = (procs: ProcInfo[]) => {
  for (const { proc } of procs) {
    if (!proc.killed) {
      proc.kill('SIGTERM');
    }
  }
};

const procs: ProcInfo[] = [];

const getFreePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate relay port'));
        return;
      }
      const { port } = address;
      server.close(err => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
};

const pickRandomPort = (): number => 10000 + Math.floor(Math.random() * 20000);

const run = async () => {
  const envPort = process.env.P2P_RELAY_PORT;
  const basePort = envPort ? Number(envPort) : null;
  let relayPort = basePort ?? 8890;
  let hub: ProcInfo | null = null;

  if (!envPort) {
    try {
      relayPort = await getFreePort();
      console.log(`[P2P] Using free relay port ${relayPort}`);
    } catch (error) {
      const err = error as Error;
      console.warn(`[P2P] Failed to allocate port automatically: ${err.message}`);
      relayPort = pickRandomPort();
    }
  }

  const maxAttempts = envPort ? 1 : 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!envPort && attempt > 0) {
      relayPort = pickRandomPort();
    }
    const relayUrl = `ws://127.0.0.1:${relayPort}`;
    console.log(`[P2P] Trying relay port ${relayPort}`);

    hub = spawnNode('hub', hubSeed, relayUrl, undefined, [
      '--hub',
      '--relay-port',
      String(relayPort),
      '--relay-host',
      '127.0.0.1',
    ]);
    procs.push(hub);

    try {
      await waitForLineOrError(
        hub,
        /P2P_RELAY_READY/,
        [/Runtime relay "hub" failed/i, /Failed to start server/i, /RELAY_PORT_MISSING/i]
      );
      await waitForLineOrError(
        hub,
        /Runtime relay "hub" listening/i,
        [/Runtime relay "hub" failed/i, /Failed to start server/i]
      );
      await smokeConnect(relayUrl);
      console.log('[P2P] WS smoke test passed');
      await waitForLineOrError(
        hub,
        /P2P_NODE_READY role=hub/,
        [/PROFILE_TIMEOUT/i, /PROFILE_MISSING_RUNTIME_ID/i, /PROFILE_MISSING_PUBLIC_KEY/i]
      );
      break;
    } catch (error) {
      killAll([hub]);
      procs.splice(procs.indexOf(hub), 1);
      hub = null;
      if (envPort) throw error;
      if (attempt === maxAttempts - 1) throw error;
    }
  }

  if (!hub) {
    throw new Error('HUB_START_FAILED');
  }

  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  console.log(`[P2P] Relay URL ${relayUrl}`);

  const bob = spawnNode('bob', bobSeed, relayUrl, hubRuntimeId);
  procs.push(bob);
  const alice = spawnNode('alice', aliceSeed, relayUrl, hubRuntimeId);
  procs.push(alice);

  const errorMatchers = [
    /PROFILE_TIMEOUT/i,
    /PROFILE_MISSING_RUNTIME_ID/i,
    /PROFILE_MISSING_PUBLIC_KEY/i,
    /ACCOUNT_PENDING_FRAME/i,
    /ACCOUNT_NOT_ACKED/i,
    /SIGNER_KEY_MISSING/i,
    /Invalid frame signature/i,
    /WS_CLIENT_ERROR/i,
    /RELAY_PORT_MISSING/i,
  ];

  await waitForLineOrError(bob, /P2P_NODE_READY role=bob/, errorMatchers);
  await waitForLineOrError(alice, /P2P_NODE_READY role=alice/, errorMatchers);
  console.log('[P2P] Nodes ready');

  await waitForLineOrError(bob, /P2P_PROFILE_SENT/, errorMatchers);
  await waitForLineOrError(alice, /P2P_PROFILE_SENT/, errorMatchers);

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
