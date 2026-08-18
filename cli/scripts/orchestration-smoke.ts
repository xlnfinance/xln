#!/usr/bin/env bun
/**
 * CLI smoke against the canonical local orchestration stack.
 *
 * Reuses the same boot path as `core/scripts/operations/production/local-prod-smoke.ts`:
 *   acquireLocalTestPortLease → start-anvil.sh → start-anvil2.sh → start-server.sh
 *
 * Then drives two CLI wallets: onboard → hubs → open → pay → status → daemon.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import {
  acquireLocalTestPortLease,
  buildInheritedLocalTestLeaseEnv,
  stripLocalTestLeaseEnv,
} from '../../core/scripts/e2e/harness/local-test-port-lease.ts';
import { stopProcessGroup } from '../../core/scripts/e2e/runners/process-group.ts';

const repoRoot = process.cwd();
const inheritedProcessEnv = stripLocalTestLeaseEnv(process.env);

type ManagedProcess = { name: string; proc: ChildProcess };

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(`CLI_ORCH_SMOKE: ${message}`);
};

const log = (message: string): void => {
  console.log(`[cli-orch] ${message}`);
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const isPortOpen = async (port: number): Promise<boolean> =>
  new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

const assertPortsFree = async (ports: number[]): Promise<void> => {
  const busy: number[] = [];
  for (const port of ports) {
    if (await isPortOpen(port)) busy.push(port);
  }
  if (busy.length > 0) throw new Error(`CLI_ORCH_SMOKE_PORTS_BUSY: ${busy.join(',')}`);
};

const rpcChainId = async (port: number): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  });
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`);
  const payload = (await response.json()) as { result?: unknown };
  return String(payload.result || '');
};

const waitForRpc = async (port: number, expectedChainId: string, label: string): Promise<void> => {
  const deadline = Date.now() + 45_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await rpcChainId(port);
      if (last === expectedChainId) {
        log(`${label} ready chainId=${expectedChainId}`);
        return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${label} RPC not ready on :${port}; last=${last}`);
};

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000),
    headers: { 'cache-control': 'no-store' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
};

const waitForMesh = async (apiBase: string): Promise<void> => {
  const deadline = Date.now() + 420_000;
  let last = 'not-started';
  while (Date.now() < deadline) {
    try {
      const health = (await fetchJson(`${apiBase}/api/health`)) as Record<string, unknown>;
      const hubs = (await fetchJson(`${apiBase}/api/hubs`)) as { hubs?: unknown[] };
      const jurisdictions = (await fetchJson(`${apiBase}/api/jurisdictions`)) as {
        jurisdictions?: Record<string, unknown>;
      };
      const hubCount = Array.isArray(hubs.hubs) ? hubs.hubs.length : 0;
      const jCount = Object.keys(jurisdictions.jurisdictions || {}).length;
      const hubMesh = health['hubMesh'] as { ok?: boolean } | undefined;
      const system = health['system'] as { runtime?: boolean; relay?: boolean } | undefined;
      const ready =
        hubCount > 0 &&
        jCount > 0 &&
        (hubMesh?.ok === true || system?.runtime === true || health['ok'] === true);
      last = `hubs=${hubCount} j=${jCount} hubMesh=${String(hubMesh?.ok)} runtime=${String(system?.runtime)}`;
      log(`health ${last}`);
      if (ready) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      log(`waiting: ${last}`);
    }
    await sleep(1_000);
  }
  throw new Error(`Mesh not ready within timeout (${last})`);
};

type RunResult = { code: number; stdout: string; stderr: string };

const runCli = async (
  apiBase: string,
  home: string,
  args: string[],
  passphrase = 'smoke-pass',
): Promise<RunResult> => {
  const proc = spawn('bun', ['cli/xln.ts', ...args], {
    cwd: repoRoot,
    env: {
      ...inheritedProcessEnv,
      XLN_HOME: home,
      XLN_API_BASE: apiBase,
      XLN_PASSPHRASE: passphrase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  const code: number = await new Promise(resolve => {
    proc.on('exit', value => resolve(value ?? 1));
  });
  return { code, stdout, stderr };
};

const requireOk = (result: RunResult, label: string): void => {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed code=${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
};

const extractEntityId = (text: string): string => {
  const match = text.match(/entity:\s*(0x[a-fA-F0-9]{64})/);
  assert(match?.[1], `entity id missing in receive output:\n${text}`);
  return match[1]!.toLowerCase();
};

const main = async (): Promise<void> => {
  const startedAt = Date.now();
  const localTestLease = await acquireLocalTestPortLease({
    requiredOffsets: [0, 1, 4, 7, 8, 10, 11, 12, 13],
  });
  const portBase = localTestLease.basePort;
  const rpcPort = portBase;
  const rpc2Port = portBase + 1;
  const apiPort = portBase + 4;
  const custodyPort = portBase + 7;
  const custodyDaemonPort = portBase + 8;
  const nodePortBase = portBase + 10;
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const workDir = join(tmpdir(), `xln-cli-orch-${portBase}`);
  const children: ManagedProcess[] = [];
  const logPath = (name: string): string => join(workDir, `${name}.log`);

  const startManaged = (name: string, command: string, args: string[], env: Record<string, string>): void => {
    mkdirSync(workDir, { recursive: true });
    const out = openSync(logPath(name), 'a');
    const proc = spawn(command, args, {
      cwd: repoRoot,
      detached: true,
      env: { ...inheritedProcessEnv, ...env },
      stdio: ['ignore', out, out],
    });
    closeSync(out);
    children.push({ name, proc });
  };

  const stopManaged = async (): Promise<void> => {
    await Promise.all(
      [...children].reverse().map(({ name, proc }) =>
        proc.pid
          ? stopProcessGroup({
              pid: proc.pid,
              termTimeoutMs: 2_000,
              killTimeoutMs: 2_000,
              timeoutError: `CLI_ORCH_SMOKE_GROUP_EXIT_TIMEOUT:name=${name}:pid=${proc.pid}`,
            })
          : Promise.resolve(),
      ),
    );
  };

  process.on('SIGINT', () => {
    void stopManaged().finally(() => {
      localTestLease.release();
      process.exit(130);
    });
  });
  process.on('SIGTERM', () => {
    void stopManaged().finally(() => {
      localTestLease.release();
      process.exit(143);
    });
  });

  try {
    await assertPortsFree([
      rpcPort,
      rpc2Port,
      apiPort,
      custodyPort,
      custodyDaemonPort,
      nodePortBase,
      nodePortBase + 1,
      nodePortBase + 2,
      nodePortBase + 3,
    ]);
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const resetMarker = join(workDir, 'runtime', '.mesh-reset-once');
    mkdirSync(join(workDir, 'runtime'), { recursive: true });
    writeFileSync(resetMarker, 'cli-orch-smoke fresh bootstrap\n');

    log(`boot portBase=${portBase} workDir=${workDir}`);

    startManaged('anvil', 'scripts/start-anvil.sh', ['--reset'], {
      XLN_PORT_BASE: String(portBase),
      ANVIL_STATE: join(workDir, 'anvil-state.json'),
      ANVIL_LOG: join(workDir, 'anvil.log'),
      ANVIL_TMPDIR: join(workDir, 'anvil-tmp'),
    });
    await waitForRpc(rpcPort, '0x7a69', 'Testnet');

    startManaged('anvil2', 'scripts/start-anvil2.sh', ['--reset'], {
      XLN_PORT_BASE: String(portBase),
      ANVIL2_STATE: join(workDir, 'anvil2-state.json'),
      ANVIL2_LOG: join(workDir, 'anvil2.log'),
      ANVIL_TMPDIR: join(workDir, 'anvil2-tmp'),
    });
    await waitForRpc(rpc2Port, '0x7a6a', 'Tron');

    startManaged('server', 'scripts/start-server.sh', [], {
      ...buildInheritedLocalTestLeaseEnv(localTestLease, repoRoot),
      XLN_SERVER_PORT: String(apiPort),
      XLN_RDB_ROOT: workDir,
      XLN_DB_PATH: join(workDir, 'prod-main'),
      XLN_JURISDICTIONS_PATH: join(workDir, 'prod-main', 'jurisdictions.json'),
      XLN_MESH_DB_ROOT: join(workDir, 'prod-mesh'),
      XLN_MESH_API_PORT_BASE: String(nodePortBase),
      XLN_MESH_PUBLIC_PORT_BASE: String(nodePortBase),
      XLN_MESH_CUSTODY_PORT: String(custodyPort),
      XLN_MESH_CUSTODY_DAEMON_PORT: String(custodyDaemonPort),
      PUBLIC_WS_BASE_URL: `ws://127.0.0.1:${apiPort}`,
      PUBLIC_RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
      INTERNAL_RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
      RELAY_URL: `ws://127.0.0.1:${apiPort}/relay`,
      PUBLIC_RPC: `http://127.0.0.1:${apiPort}/rpc`,
      XLN_MIN_DISK_FREE_BYTES: '1',
    });

    await waitForMesh(apiBase);
    log(`mesh ready api=${apiBase}`);

    const hubsPayload = (await fetchJson(`${apiBase}/api/hubs`)) as {
      hubs: Array<{ entityId: string; name?: string }>;
    };
    assert(hubsPayload.hubs.length > 0, 'expected hubs from /api/hubs');
    const hubEntityId = String(hubsPayload.hubs[0]!.entityId).toLowerCase();
    log(`hub ${hubEntityId} (${hubsPayload.hubs[0]!.name || 'unnamed'})`);

    const walletA = join(workDir, 'wallet-a');
    const walletB = join(workDir, 'wallet-b');

    log('onboard A');
    requireOk(
      await runCli(apiBase, walletA, ['onboard', '--mode', 'demo', '--name', 'alice']),
      'onboard A',
    );

    log('hubs A');
    const hubsA = await runCli(apiBase, walletA, ['hubs', '--local']);
    requireOk(hubsA, 'hubs A');
    assert(hubsA.stdout.includes('available') || hubsA.stdout.includes('connected'), hubsA.stdout);

    log('open A');
    requireOk(
      await runCli(apiBase, walletA, ['open', hubEntityId, '--credit', '100', '--token', '1', '--local']),
      'open A',
    );

    const statusA = await runCli(apiBase, walletA, ['status', '--local']);
    requireOk(statusA, 'status A');
    assert(
      statusA.stdout.includes('Accounts') && (statusA.stdout.includes('[') || statusA.stdout.includes('out[')),
      `missing bars:\n${statusA.stdout}`,
    );

    const receiveA = await runCli(apiBase, walletA, ['receive', '--local']);
    requireOk(receiveA, 'receive A');
    const entityA = extractEntityId(receiveA.stdout);

    log('onboard B + open');
    requireOk(
      await runCli(apiBase, walletB, ['onboard', '--mode', 'demo', '--name', 'bob']),
      'onboard B',
    );
    requireOk(
      await runCli(apiBase, walletB, ['open', hubEntityId, '--credit', '100', '--token', '1', '--local']),
      'open B',
    );
    const receiveB = await runCli(apiBase, walletB, ['receive', '--local']);
    requireOk(receiveB, 'receive B');
    const entityB = extractEntityId(receiveB.stdout);
    assert(entityA !== entityB, 'distinct entities required');

    log('pay A→B via hub');
    const pay = await runCli(apiBase, walletA, [
      'pay',
      entityB,
      '1',
      '--token',
      '1',
      '--mode',
      'instant',
      '--hub',
      hubEntityId,
      '--local',
    ]);
    requireOk(pay, 'pay');

    log('daemon status');
    const daemon = spawn('bun', ['cli/xln.ts', 'daemon'], {
      cwd: repoRoot,
      env: {
        ...inheritedProcessEnv,
        XLN_HOME: walletA,
        XLN_API_BASE: apiBase,
        XLN_PASSPHRASE: 'smoke-pass',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let daemonOk = false;
    const daemonDeadline = Date.now() + 60_000;
    while (Date.now() < daemonDeadline) {
      await sleep(500);
      const probe = await runCli(apiBase, walletA, ['status']);
      if (probe.code === 0 && probe.stdout.includes('Accounts')) {
        daemonOk = true;
        break;
      }
    }
    daemon.kill('SIGTERM');
    assert(daemonOk, 'daemon status failed');

    requireOk(await runCli(apiBase, walletA, ['settings', '--bars', 'twin']), 'settings');
    const twin = await runCli(apiBase, walletA, ['status', '--local']);
    requireOk(twin, 'twin status');
    assert(twin.stdout.includes('out[') && twin.stdout.includes('in['), twin.stdout);

    log(
      `PASS in ${Date.now() - startedAt}ms api=${apiBase} hub=${hubEntityId.slice(0, 12)}… a=${entityA.slice(0, 12)}… b=${entityB.slice(0, 12)}…`,
    );
  } finally {
    await stopManaged().catch(error => {
      console.error('[cli-orch] stop failed', error);
    });
    localTestLease.release();
    if (process.env['XLN_CLI_SMOKE_KEEP'] !== '1' && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
};

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
