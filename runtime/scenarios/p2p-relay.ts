/**
 * P2P relay orchestration test.
 * Spins up hub + alice + bob nodes and verifies a payment crosses the relay.
 */

import { spawn } from 'child_process';
import net from 'net';
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

const spawnNode = (
  role: string,
  seed: string,
  relayUrl: string,
  seedRuntimeId?: string,
  extraArgs: string[] = []
): ProcInfo => {
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
      XLN_DB_PATH: `db-${role}-${Date.now()}`,
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

const run = async () => {
  const envPort = process.env.P2P_RELAY_PORT;
  const basePort = Number(envPort || 8890);
  let relayPort = basePort;
  let hub: ProcInfo | null = null;

  if (!envPort) {
    try {
      relayPort = await getFreePort();
      console.log(`[P2P] Using free relay port ${relayPort}`);
    } catch (error) {
      const err = error as Error;
      console.warn(`[P2P] Failed to allocate port automatically: ${err.message}`);
      relayPort = basePort;
    }
  }

  const initialPort = relayPort;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    relayPort = envPort ? basePort : initialPort + attempt;
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
        /P2P_NODE_READY role=hub/,
        [/Runtime relay "hub" failed/i, /Failed to start server/i]
      );
      break;
    } catch (error) {
      killAll([hub]);
      procs.splice(procs.indexOf(hub), 1);
      hub = null;
      if (attempt === 4) throw error;
    }
  }

  if (!hub) {
    throw new Error('HUB_START_FAILED');
  }

  const relayUrl = `ws://127.0.0.1:${relayPort}`;

  const alice = spawnNode('alice', aliceSeed, relayUrl, hubRuntimeId);
  const bob = spawnNode('bob', bobSeed, relayUrl, hubRuntimeId);
  procs.push(alice, bob);

  await waitForLine(bob, /P2P_PAYMENT_RECEIVED/);
  console.log('✅ P2P relay test passed');

  killAll(procs);
};

run().catch(error => {
  console.error('P2P_RELAY_FATAL', error);
  killAll(procs);
  process.exit(1);
});
