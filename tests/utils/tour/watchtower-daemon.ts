import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** A standalone watchtower daemon on the shard's leased E2E_WATCHTOWER_PORT. */
export type WatchtowerChild = {
  process: ChildProcess;
  baseUrl: string;
  dbRoot: string;
};

async function waitForTowerHealth(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        const payload = (await response.json()) as { ok?: boolean; service?: string };
        if (payload.ok && payload.service === 'xln-watchtower') return;
      }
    } catch {
      // keep polling until timeout
    }
    await delay(250);
  }
  throw new Error(`Watchtower did not become healthy at ${baseUrl}`);
}

export async function startWatchtower(): Promise<WatchtowerChild> {
  const port = Number(process.env.E2E_WATCHTOWER_PORT);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error('RECOVERY_LEASED_TOWER_PORT_REQUIRED');
  const dbRoot = await mkdtemp(join(tmpdir(), 'xln-watchtower-e2e-'));
  const proc = spawn(
    'bun',
    [
      'core/watchtower/standalone-server.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--db',
      join(dbRoot, 'watchtower.level'),
      '--quota-bytes',
      String(4 * 1024 * 1024),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  proc.stdout?.on('data', chunk => process.stdout.write(`[watchtower] ${chunk.toString()}`));
  proc.stderr?.on('data', chunk => process.stderr.write(`[watchtower] ${chunk.toString()}`));
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForTowerHealth(baseUrl);
  } catch (error) {
    proc.kill('SIGKILL');
    throw error;
  }
  return { process: proc, baseUrl, dbRoot };
}

export async function stopWatchtower(child: WatchtowerChild | null): Promise<void> {
  if (!child) return;
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill('SIGTERM');
    const deadline = Date.now() + 5_000;
    while (child.process.exitCode === null && child.process.signalCode === null && Date.now() < deadline) {
      await delay(100);
    }
    if (child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill('SIGKILL');
      const killDeadline = Date.now() + 1_000;
      while (child.process.exitCode === null && child.process.signalCode === null && Date.now() < killDeadline)
        await delay(25);
    }
  }
  const exited = child.process.exitCode !== null || child.process.signalCode !== null;
  if (!exited) throw new Error('RECOVERY_TOWER_PROCESS_STILL_RUNNING');
  await rm(child.dbRoot, { recursive: true, force: true });
}
