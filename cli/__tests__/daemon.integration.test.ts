import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEmptyEnv } from '../../runtime/runtime';
import { callDaemon, daemonTokenPath } from '../lib/daemon/client';
import { startDaemonServer } from '../lib/daemon/server';
import type { CliSession } from '../lib/session';

test('daemon binds owner-only files and rejects the wrong API context', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'xln-daemon-'));
  const settings = {
    barStyle: 'closed' as const,
    apiBase: 'https://xln.finance',
    dbPath: join(homeDir, 'db'),
    homeDir,
    socketPath: join(homeDir, 'daemon.sock'),
    profileName: 'wallet',
  };
  const env = createEmptyEnv('daemon-integration');
  const session: CliSession = {
    settings,
    env,
    entityId: `0x${'11'.repeat(32)}`,
    signerId: '1',
    jurisdictionName: 'daemon-test',
    identity: {
      mnemonic: 'test only',
      runtimeId: `0x${'22'.repeat(20)}`,
      signerAddress: `0x${'22'.repeat(20)}`,
      privateKeyHex: `0x${'33'.repeat(32)}`,
      privateKeyBytes: new Uint8Array(32),
      label: 'daemon-test',
      entityId: null,
    },
  };
  const server = await startDaemonServer(session);
  try {
    expect((await stat(homeDir)).mode & 0o777).toBe(0o700);
    expect((await stat(settings.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(daemonTokenPath(settings))).mode & 0o777).toBe(0o600);
    expect(await callDaemon(settings, { op: 'ping' })).toMatchObject({
      ok: true,
      result: { pong: true },
    });

    const wrongContext = await callDaemon(
      { ...settings, apiBase: 'https://wrong.example' },
      { op: 'ping' },
    );
    expect(wrongContext.ok).toBe(false);
    expect(wrongContext.error).toContain('DAEMON_CONTEXT_API_MISMATCH');
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
