import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createCreditOfficerChild } from '../../../orchestrator/credit-officer/child';
import type { HubChild } from '../../../orchestrator/orchestrator-types';

function hub(): HubChild {
  return {
    name: 'H1',
    region: 'test',
    seed: 'test',
    authSeed: 'credit-officer-child-test-auth-seed',
    signerLabel: 'test',
    apiPort: 1,
    publicPort: 2,
    dbPath: '',
    deployTokens: false,
    engine: 'typescript',
    proc: null,
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    restartTimer: null,
    restartCount: 0,
    recoveryInProgress: false,
    failureCounts: {},
    lastHealth: null,
    recentStdout: [],
    recentStderr: [],
    lastInfo: {
      runtimeId: `0x${'11'.repeat(20)}`,
      hubEntities: Array.from({ length: 1100 }, () => ({ entityId: `0x${'22'.repeat(32)}` })),
    },
  };
}

test('secret delivery failure is isolated, cleans up officer, and approvals return 503', async () => {
  const previous = process.env['XLN_CREDIT_OFFICER_TESTNET'];
  process.env['XLN_CREDIT_OFFICER_TESTNET'] = '1';
  const dir = mkdtempSync(join(tmpdir(), 'xln-credit-child-'));
  const officer = createCreditOfficerChild(dir, 1);
  const hubProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise<void>(resolve => hubProcess.once('spawn', resolve));
  const activeHub = { ...hub(), proc: hubProcess };
  try {
    await expect(officer.start([activeHub])).resolves.toBeUndefined();
    const response = await officer.proxy(
      new Request('http://localhost/api/credit-officer/approve', { method: 'POST' }),
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: 'CREDIT_OFFICER_UNAVAILABLE' });
    expect(hubProcess.exitCode).toBeNull();
    expect(hubProcess.signalCode).toBeNull();
    expect(process.kill(hubProcess.pid!, 0)).toBe(true);
    expect(await officer.proxy(new Request('http://localhost/api/health'))).toBeNull();
    const unready = hub();
    unready.lastInfo = null;
    await expect(officer.start([unready])).resolves.toBeUndefined();
    expect((await officer.proxy(new Request('http://localhost/api/credit-officer/approve')))?.status).toBe(503);
    const previousPath = process.env['PATH'];
    try {
      // Real spawn failure has no PID and never emits an exit event.
      process.env['PATH'] = dir;
      const readyHub = hub();
      readyHub.lastInfo = { runtimeId: `0x${'11'.repeat(20)}`, hubEntities: [{ entityId: `0x${'22'.repeat(32)}` }] };
      await expect(officer.start([readyHub])).resolves.toBeUndefined();
      expect((await officer.proxy(new Request('http://localhost/api/credit-officer/approve')))?.status).toBe(503);
      expect(process.kill(hubProcess.pid!, 0)).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
    }
  } finally {
    await officer.stop();
    const exited = new Promise<void>(resolve => hubProcess.once('exit', () => resolve()));
    hubProcess.kill('SIGKILL');
    await exited;
    if (previous === undefined) delete process.env['XLN_CREDIT_OFFICER_TESTNET'];
    else process.env['XLN_CREDIT_OFFICER_TESTNET'] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
