#!/usr/bin/env bun
/**
 * CLI smoke against the canonical local orchestration stack.
 *
 * Reuses the same boot path as `core/scripts/operations/production/local-prod-smoke.ts`:
 *   acquireLocalTestPortLease → start-anvil.sh → start-anvil2.sh → start-server.sh
 *
 * Then drives two CLI wallets: onboard → hubs → open → pay → status → daemon.
 */
import { startNativeJSubmitCrashProof } from './native-j-submit-crash-proof';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import {
  acquireLocalTestPortLease,
  buildInheritedLocalTestLeaseEnv,
  stripLocalTestLeaseEnv,
} from '../../core/scripts/e2e/harness/local-test-port-lease.ts';
import { collectHltRunProvenance } from '../../core/scripts/operations/hlt/boundary/environment-manifest';
import { stopProcessGroup } from '../../core/scripts/e2e/runners/process-group.ts';

const repoRoot = process.cwd();
const inheritedProcessEnv = stripLocalTestLeaseEnv(process.env);

type ManagedProcess = { name: string; proc: ChildProcess };

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
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
  entryPath = 'cli/xln.ts',
): Promise<RunResult> => {
  const proc = spawn('bun', [entryPath, ...args], {
    cwd: repoRoot,
    env: {
      ...inheritedProcessEnv,
      XLN_HOME: home,
      ...(entryPath !== 'cli/xln.ts' ? { XLN_DB_PATH: join(home, 'db') } : {}),
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
  const crashProof = process.env['XLN_NATIVE_J_CRASH_PROOF'] === '1';
  assert(!crashProof || process.env['XLN_HLT_ENGINE'] === 'rust', 'crash proof requires native H1');
  const localTestLease = await acquireLocalTestPortLease({
    requiredOffsets: [0, 1, ...(crashProof ? [2] : []), 4, 7, 8, 10, 11, 12, 13],
  });
  const portBase = localTestLease.basePort;
  const rpcPort = portBase;
  const rpc2Port = portBase + 1;
  const apiPort = portBase + 4;
  const custodyPort = portBase + 7;
  const custodyDaemonPort = portBase + 8;
  const nodePortBase = portBase + 10;
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const evidenceDirectory = process.env['XLN_CLI_SMOKE_DIR'];
  const workDir = evidenceDirectory || join(tmpdir(), `xln-cli-orch-${portBase}`);
  const children: ManagedProcess[] = [];
  let faultGate: ReturnType<typeof startNativeJSubmitCrashProof> | null = null;
  const logPath = (name: string): string => join(workDir, `${name}.log`);

  const startManaged = (name: string, command: string, args: string[], env: Record<string, string>): ChildProcess => {
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
    return proc;
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
      ...(crashProof ? [portBase + 2] : []),
      apiPort,
      custodyPort,
      custodyDaemonPort,
      nodePortBase,
      nodePortBase + 1,
      nodePortBase + 2,
      nodePortBase + 3,
    ]);
    assert(!evidenceDirectory || !existsSync(workDir), `evidence directory already exists: ${workDir}`);
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const resetMarker = join(workDir, 'core', '.mesh-reset-once');
    mkdirSync(join(workDir, 'core'), { recursive: true });
    writeFileSync(resetMarker, 'cli-orch-smoke fresh bootstrap\n');

    log(`boot portBase=${portBase} workDir=${workDir}`);

    if (crashProof) {
      writeFileSync(join(workDir, 'native-j-crash-provenance.json'), JSON.stringify(collectHltRunProvenance('rust')));
      faultGate = startNativeJSubmitCrashProof(rpcPort, portBase + 2, workDir);
    }
    startManaged('anvil', 'scripts/operations/start-anvil.sh', ['--reset'], {
      XLN_PORT_BASE: String(portBase),
      ...(crashProof ? { ANVIL_PORT: String(portBase + 2) } : {}),
      ANVIL_STATE: join(workDir, 'anvil-state.json'),
      ANVIL_LOG: join(workDir, 'anvil.log'),
      ANVIL_TMPDIR: join(workDir, 'anvil-tmp'),
    });
    await waitForRpc(rpcPort, '0x7a69', 'Testnet');

    startManaged('anvil2', 'scripts/operations/start-anvil2.sh', ['--reset'], {
      XLN_PORT_BASE: String(portBase),
      ANVIL2_STATE: join(workDir, 'anvil2-state.json'),
      ANVIL2_LOG: join(workDir, 'anvil2.log'),
      ANVIL_TMPDIR: join(workDir, 'anvil2-tmp'),
    });
    await waitForRpc(rpc2Port, '0x7a6a', 'Tron');

    startManaged('server', 'scripts/operations/start-server.sh', [], {
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
      hubs: Array<{ entityId: string; runtimeId: string; name?: string }>;
    };
    assert(hubsPayload.hubs.length > 0, 'expected hubs from /api/hubs');
    const selectedHub = hubsPayload.hubs.find(hub => hub.name === 'H1');
    assert(selectedHub, 'H1 required for wallet recovery');
    const hubEntityId = selectedHub.entityId.toLowerCase();
    log(`hub ${hubEntityId} (${selectedHub.name || 'unnamed'})`);

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
    if (faultGate) await faultGate.prove(nodePortBase, entityA, apiBase);

    assert(existsSync(join(walletA, 'db')) && existsSync(join(walletB, 'db')), 'CLI did not use each wallet home DB');

    log('fresh-device wallet recovery with two settled payments');
    const evidenceDir = join(workDir, 'wallet-recovery');
    const restoredWallet = join(workDir, 'wallet-restored');
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    const engine = process.env['XLN_HLT_ENGINE'];
    assert(engine === 'ts' || engine === 'rust', 'explicit engine required');
    const provenance = collectHltRunProvenance(engine);
    const hubInfo = await fetchJson(`http://127.0.0.1:${nodePortBase}/api/info`) as {
      runtimeId: string; entityId: string; workers?: number;
    };
    assert(hubInfo.runtimeId === selectedHub.runtimeId && hubInfo.entityId === hubEntityId,
      'selected H1 differs from direct runtime identity');
    if (process.env['XLN_HLT_ENGINE'] === 'rust') {
      assert(provenance.rustBinarySha256, 'native binary digest missing');
      const ready = readFileSync(logPath('server'), 'utf8').split('\n')
        .filter(line => line.startsWith('[H1] {'))
        .map(line => JSON.parse(line.slice(5)) as { status: string; runtimeId: string; workers: number })
        .find(row => row.status === 'ready');
      assert(ready?.runtimeId === hubInfo.runtimeId && ready.workers === hubInfo.workers,
        'native ready identity differs from selected H1');
    }
    writeFileSync(join(evidenceDir, 'native-identity.json'), JSON.stringify({ engine, provenance, hubInfo }));
    const helper = 'cli/scripts/wallet-recovery-proof.ts';
    const proofArgs = [hubEntityId, entityB, evidenceDir, restoredWallet];
    const recipientProcess = startManaged('wallet-recipient', 'bun', [helper, 'recipient', ...proofArgs], {
      XLN_HOME: walletB, XLN_DB_PATH: join(walletB, 'db'), XLN_API_BASE: apiBase, XLN_PASSPHRASE: 'smoke-pass',
    });
    const recipientExit = new Promise<number>((resolve, reject) => {
      recipientProcess.once('error', reject);
      recipientProcess.once('exit', code => resolve(code ?? 1));
    });
    requireOk(await runCli(apiBase, walletA, ['export', ...proofArgs], 'smoke-pass', helper), 'wallet export');
    const beforeImport = await runCli(apiBase, restoredWallet, ['status', '--local']);
    assert(beforeImport.code !== 0 && beforeImport.stderr.includes('CLI_WALLET_RECOVERY_REQUIRED'),
      'copied wallet must reject missing local history before import');
    requireOk(await runCli(apiBase, restoredWallet, ['restore', ...proofArgs], 'smoke-pass', helper), 'wallet restore/payment');
    assert(await recipientExit === 0, 'recipient proof process failed');
    assert(existsSync(join(evidenceDir, 'complete.json')), 'wallet recovery proof missing');

    log('daemon status');
    const daemon = spawn('bun', ['cli/xln.ts', 'daemon'], {
      cwd: repoRoot,
      env: {
        ...inheritedProcessEnv,
        XLN_HOME: restoredWallet,
        XLN_API_BASE: apiBase,
        XLN_PASSPHRASE: 'smoke-pass',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let daemonOk = false;
    const daemonDeadline = Date.now() + 60_000;
    while (Date.now() < daemonDeadline) {
      await sleep(500);
      const probe = await runCli(apiBase, restoredWallet, ['status']);
      if (probe.code === 0 && probe.stdout.includes('Accounts')) {
        daemonOk = true;
        break;
      }
    }
    daemon.kill('SIGTERM');
    assert(daemonOk, 'daemon status failed');

    requireOk(await runCli(apiBase, restoredWallet, ['settings', '--bars', 'twin']), 'settings');
    const twin = await runCli(apiBase, restoredWallet, ['status', '--local']);
    requireOk(twin, 'twin status');
    assert(twin.stdout.includes('out[') && twin.stdout.includes('in['), twin.stdout);

    log(
      `PASS in ${Date.now() - startedAt}ms api=${apiBase} hub=${hubEntityId.slice(0, 12)}… a=${entityA.slice(0, 12)}… b=${entityB.slice(0, 12)}…`,
    );
  } finally {
    await stopManaged().catch(error => {
      console.error('[cli-orch] stop failed', error);
    });
    faultGate?.stop();
    localTestLease.release();
    if (!evidenceDirectory && process.env['XLN_CLI_SMOKE_KEEP'] !== '1' && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
};

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
