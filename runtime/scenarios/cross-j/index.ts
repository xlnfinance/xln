/**
 * Cross-Jurisdiction Swap Scenario (P2P dual-Runtime topology probe)
 *
 * Topology contract (`resolveCrossJurisdictionRuntimeTopology`):
 *   - both users share one Runtime
 *   - both hubs share another Runtime
 *   - those two Runtimes must differ
 *
 * Shape copied from `p2p-relay.ts` / `p2p-node.ts` — no in-process bridge.
 *
 * For full MM same-j + cross-j books + adversary recovery, use
 * `bun runtime/scenarios/run.ts mm-mesh` (real orchestrator --mm path).
 * This scenario only covers thin dual-Runtime P2P topology.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeReplica } from '../../runtime/types';

type ProcInfo = {
  role: string;
  proc: ReturnType<typeof spawn>;
  stdoutBuffer: string[];
};

const getFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('CROSS_J_FREE_PORT_UNAVAILABLE'));
      });
    });
  });

const waitForLineOrError = (
  procInfo: ProcInfo,
  success: RegExp,
  errors: RegExp[] = [],
  timeoutMs = 180_000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const text = procInfo.stdoutBuffer.join('');
      for (const err of errors) {
        if (err.test(text)) {
          clearInterval(timer);
          reject(new Error(`CROSS_J_${procInfo.role.toUpperCase()}_ERROR: ${text.slice(-2_000)}`));
          return;
        }
      }
      const match = text.match(success);
      if (match) {
        clearInterval(timer);
        resolve(match[0]!);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(
          `CROSS_J_${procInfo.role.toUpperCase()}_TIMEOUT waiting ${success}: ${text.slice(-2_000)}`,
        ));
      }
    };
    const timer = setInterval(check, 100);
    procInfo.proc.once('exit', code => {
      clearInterval(timer);
      if (code !== 0 && code !== null) {
        reject(new Error(
          `CROSS_J_${procInfo.role.toUpperCase()}_EXIT:${code}: ${procInfo.stdoutBuffer.join('').slice(-2_000)}`,
        ));
      }
    });
    check();
  });

const spawnNode = (role: 'hubs' | 'users', extraArgs: string[]): ProcInfo => {
  const dbRoot = path.join(process.cwd(), 'db-tmp');
  const dbPath = path.join(dbRoot, `cross-j-${role}-${Date.now()}`);
  fs.rmSync(dbPath, { recursive: true, force: true });
  fs.mkdirSync(dbPath, { recursive: true });
  const args = [
    'run',
    'runtime/scenarios/cross-j/node.ts',
    '--role',
    role,
    '--seed',
    `cross-j-${role}-seed`,
    ...extraArgs,
  ];
  const proc = spawn('bun', args, {
    env: {
      ...process.env,
      XLN_DB_PATH: dbPath,
      XLN_RUNTIME_SEED: process.env['XLN_RUNTIME_SEED'] || 'dev-scenario-seed',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutBuffer: string[] = [];
  proc.stdout?.on('data', chunk => {
    const text = chunk.toString();
    stdoutBuffer.push(text);
    process.stdout.write(`[${role}] ${text}`);
  });
  proc.stderr?.on('data', chunk => {
    const text = chunk.toString();
    stdoutBuffer.push(text);
    process.stderr.write(`[${role}] ${text}`);
  });
  return { role, proc, stdoutBuffer };
};

const stopAll = async (procs: ProcInfo[]): Promise<void> => {
  await Promise.all(procs.map(({ proc }) => new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
  })));
};

const extractJsonAfter = (buffer: string[], marker: string): unknown => {
  const text = buffer.join('');
  const idx = text.lastIndexOf(marker);
  if (idx < 0) throw new Error(`CROSS_J_MARKER_MISSING:${marker}`);
  const after = text.slice(idx + marker.length).trimStart();
  const line = after.split('\n')[0] ?? '';
  return JSON.parse(line);
};

/**
 * Orchestrator entry used by `bun runtime/scenarios/run.ts cross-j`.
 * The unused env argument is the CLI shell Runtime; real work happens in children.
 */
export async function crossJ(_existingEnv?: RuntimeReplica): Promise<RuntimeReplica> {
  if (!_existingEnv) throw new Error('CROSS_J_RUNTIME_REQUIRED');
  console.log('\n🌉 Cross-jurisdiction swap scenario (dual-Runtime P2P)\n');
  const procs: ProcInfo[] = [];
  const relayPort = await getFreePort();
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  // Parent-owned phase barriers: children must not race credit/orders ahead of
  // bilateral readiness on BOTH runtimes.
  // Keep process-coordination files outside db-tmp: scenario DB cleanup owns
  // that tree and may run while the second determinism pass is starting.
  const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xln-cross-j-barrier-'));
  console.log(`[cross-j] relay ${relayUrl}`);
  console.log(`[cross-j] barrierDir ${barrierDir}`);

  try {
    const hubs = spawnNode('hubs', [
      '--relay-url', relayUrl,
      '--relay-port', String(relayPort),
      '--relay-host', '127.0.0.1',
      '--barrier-dir', barrierDir,
    ]);
    procs.push(hubs);

    await waitForLineOrError(hubs, /CROSS_J_STACKS_READY/, [/CROSS_J_NODE_FATAL/i]);
    await waitForLineOrError(hubs, /P2P_RELAY_READY/, [/CROSS_J_NODE_FATAL/i, /RELAY_PORT/i]);
    const hubsReadyLine = await waitForLineOrError(
      hubs,
      /CROSS_J_HUBS_READY/,
      [/CROSS_J_NODE_FATAL/i],
    );
    void hubsReadyLine;
    const stacks = extractJsonAfter(hubs.stdoutBuffer, 'CROSS_J_STACKS_READY') as {
      source: unknown;
      target: unknown;
    };
    const hubsMeta = extractJsonAfter(hubs.stdoutBuffer, 'CROSS_J_HUBS_READY') as {
      runtimeId: string;
      hubSrc: unknown;
      hubTgt: unknown;
    };

    const usersPayload = JSON.stringify({
      source: stacks.source,
      target: stacks.target,
      hubSrc: hubsMeta.hubSrc,
      hubTgt: hubsMeta.hubTgt,
    });
    const users = spawnNode('users', [
      '--relay-url', relayUrl,
      '--seed-runtime-id', hubsMeta.runtimeId,
      '--stacks', usersPayload,
      '--barrier-dir', barrierDir,
    ]);
    procs.push(users);

    await waitForLineOrError(users, /P2P_NODE_READY role=users/, [/CROSS_J_NODE_FATAL/i]);
    // Setup contract:
    //   1) both sides accounts open+idle
    //   2) both sides hub↔user credit committed+idle  (= setup finalized)
    //   3) only then same/cross swap creation / settle / invariants
    await waitForLineOrError(hubs, /CROSS_J_PHASE_ACCOUNTS_OPEN/, [/CROSS_J_NODE_FATAL/i, /TIMEOUT/i], 180_000);
    await waitForLineOrError(users, /CROSS_J_PHASE_ACCOUNTS_OPEN/, [/CROSS_J_NODE_FATAL/i, /TIMEOUT/i], 180_000);
    fs.writeFileSync(path.join(barrierDir, 'accounts-open.ready'), '1');
    console.log('[cross-j] BARRIER accounts-open.ready (both runtimes) → credit may start');

    await waitForLineOrError(hubs, /CROSS_J_PHASE_CREDIT_READY/, [/CROSS_J_NODE_FATAL/i, /TIMEOUT/i], 180_000);
    await waitForLineOrError(users, /CROSS_J_PHASE_CREDIT_READY/, [/CROSS_J_NODE_FATAL/i, /TIMEOUT/i], 180_000);
    fs.writeFileSync(path.join(barrierDir, 'setup-ready'), '1');
    console.log('[cross-j] BARRIER setup-ready (mutual credits idle) → swaps may start');

    await waitForLineOrError(users, /CROSS_J_PHASE_ORDERS/, [/CROSS_J_NODE_FATAL/i, /TIMEOUT/i, /ASSERTION FAILED/i]);
    await waitForLineOrError(users, /CROSS_J_INTENT_SUBMITTED/, [/CROSS_J_NODE_FATAL/i, /ASSERTION FAILED/i]);
    await waitForLineOrError(hubs, /CROSS_J_MATERIALIZED/, [/CROSS_J_NODE_FATAL/i, /TIMEOUT/i, /ASSERTION FAILED/i], 180_000);
    await waitForLineOrError(hubs, /CROSS_J_PHASE_ORDERBOOK/, [/CROSS_J_NODE_FATAL/i, /TIMEOUT/i, /ASSERTION FAILED/i], 180_000);
    await waitForLineOrError(
      hubs,
      /CROSS_J_PHASE_SETTLED|CROSS_J_SETTLED/,
      [/CROSS_J_NODE_FATAL/i, /TIMEOUT/i, /ASSERTION FAILED/i],
      180_000,
    );
    console.log('\n✅ cross-j dual-Runtime scenario complete (settled)\n');
    return _existingEnv;
  } finally {
    // Do not delete phase markers until every child has acknowledged SIGTERM;
    // otherwise a still-running Runtime can observe a torn coordination tree.
    await stopAll(procs);
    fs.rmSync(barrierDir, { recursive: true, force: true });
  }
}
