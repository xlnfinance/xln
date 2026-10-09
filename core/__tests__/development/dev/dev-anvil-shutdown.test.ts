import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';

const repo = resolve(import.meta.dir, '../../../..');
const address = `0x${'22'.repeat(20)}`;
const code = `0x${'60'.repeat(1_000_000)}`;

async function rpc(port: number, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: safeStringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(1_000),
  });
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || 'error' in body || !('result' in body)) {
    throw new Error(`SHUTDOWN_RPC_FAILED:${method}:${safeStringify(body)}`);
  }
  return body.result;
}

async function waitReady(check: () => Promise<boolean>, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) {
      if (error instanceof Error && error.message.startsWith('LAUNCHER_EXITED:')) throw error;
      lastError = error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`SHUTDOWN_READINESS_TIMEOUT:${label}`, { cause: lastError });
}

const launcherSource = `
import { acquireDevSingleton, runDevCommands } from './scripts/dev/run-dev.ts';
const lease = acquireDevSingleton();
try {
  process.exitCode = await runDevCommands([
    ['bash', 'scripts/dev/prepare-start.sh'], ['bash', 'scripts/dev/run-dev.sh'],
  ], { ...process.env, XLN_DEV_LAUNCHER_PORT: String(lease.port), XLN_DEV_LAUNCHER_TOKEN: lease.capability },
  { termTimeoutMs: 15000, killTimeoutMs: 2000 });
} finally { lease.release(); }
`;

// Run under stand:run: this deliberately exercises the production launcher,
// supervisor and both real Anvil chains, including group-signal forwarding.
test('launcher shutdown preserves Anvil code and the exact mined block across reload', async () => {
  const data = mkdtempSync(join(tmpdir(), 'xln-anvil-shutdown-regression-'));
  const launcher = Bun.spawn(['bun', '-e', launcherSource], {
    cwd: repo, stdout: Bun.file(join(data, 'launcher.log')), stderr: Bun.file(join(data, 'launcher-error.log')),
    env: { ...process.env, XLN_DEV_DATA_ROOT: data, XLN_DEV_LOG_DIR: join(data, 'logs'),
      XLN_HLT_ENGINE: 'ts', XLN_VITE_FORCE_HTTP: '1', XLN_DEV_SHUTDOWN_TIMEOUT_MS: '10000',
      XLN_DEV_CHILD_TERM_TIMEOUT_MS: '5000' },
  });
  let restored: ReturnType<typeof Bun.spawn> | null = null;
  let passed = false;
  try {
    await waitReady(async () => {
      if (launcher.exitCode !== null) throw new Error(`LAUNCHER_EXITED:${launcher.exitCode}:${data}`);
      // A pre-existing dev server can be healthy while our launcher fails its
      // singleton lease. Never mutate that unrelated chain as test evidence.
      if (!(await Bun.file(join(data, 'launcher.log')).text()).includes('DEV_BOOTING ')) return false;
      const response = await fetch('http://127.0.0.1:8082/api/health?full=1', { signal: AbortSignal.timeout(1000) });
      const health: unknown = await response.json();
      return Boolean(health && typeof health === 'object' && 'systemOk' in health && health.systemOk === true);
    }, 'three-hub-stand', 30_000);
    await rpc(8545, 'anvil_setCode', [address, code]);
    await rpc(8545, 'anvil_mine', ['0x1']);
    const before = await rpc(8545, 'eth_getBlockByNumber', ['latest', false]);
    if (!before || typeof before !== 'object' || !('number' in before) || !('hash' in before)) {
      throw new Error('MINED_BLOCK_EVIDENCE_MISSING');
    }
    launcher.kill('SIGTERM');
    expect(await launcher.exited).toBe(143);
    const state = join(data, 'jdb/anvil-31337-state.json');
    expect(await Bun.file(state).json()).toBeObject();
    expect(Bun.file(state).size).toBeGreaterThan(code.length);
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const port = reservation.port;
    reservation.stop(true);
    restored = Bun.spawn(['anvil', '--silent', '--host', '127.0.0.1', '--port', String(port),
      '--chain-id', '31337', '--no-mining', '--state', state], {
      stdout: Bun.file(join(data, 'restored.log')), stderr: Bun.file(join(data, 'restored-error.log')),
    });
    await waitReady(async () => await rpc(port, 'eth_chainId') === '0x7a69', 'restored-chain', 5_000);
    expect(await rpc(port, 'eth_getCode', [address, 'latest'])).toBe(code);
    const after = await rpc(port, 'eth_getBlockByNumber', [before.number, false]);
    expect(after).toMatchObject({ number: before.number, hash: before.hash });
    passed = true;
  } finally {
    if (launcher.exitCode === null) launcher.kill('SIGTERM');
    await launcher.exited;
    if (restored) { if (restored.exitCode === null) restored.kill('SIGTERM'); await restored.exited; }
    if (passed) rmSync(data, { recursive: true, force: true });
    else console.error(`ANVIL_SHUTDOWN_FAILURE_EVIDENCE:${data}`);
  }
}, 55_000);
