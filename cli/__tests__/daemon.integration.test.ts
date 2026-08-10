import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

import { createEmptyEnv } from '../../runtime/runtime';
import { callDaemon, daemonTokenPath } from '../lib/daemon/client';
import { startDaemonServer } from '../lib/daemon/server';
import { createFrameDecoder, encodeMessage, type DaemonRequest, type DaemonResponse } from '../lib/daemon/protocol';
import type { CliSession } from '../lib/session';

const callRawDaemon = (
  socketPath: string,
  request: DaemonRequest,
): Promise<DaemonResponse> => new Promise((resolve, reject) => {
  const socket = connect(socketPath);
  const decoder = createFrameDecoder();
  socket.on('connect', () => socket.write(encodeMessage(request)));
  socket.on('data', chunk => {
    for (const message of decoder.push(chunk)) {
      socket.end();
      resolve(message as DaemonResponse);
    }
  });
  socket.on('error', reject);
});

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
    const rejectedShutdown = await callDaemon(
      { ...settings, apiBase: 'https://wrong.example' },
      { op: 'shutdown' },
    );
    expect(rejectedShutdown.ok).toBe(false);
    expect(rejectedShutdown.error).toContain('DAEMON_CONTEXT_API_MISMATCH');
    const unauthenticatedShutdown = await callRawDaemon(settings.socketPath, {
      id: 'unauthenticated-shutdown',
      op: 'shutdown',
      authToken: 'invalid',
      expectedApiBase: settings.apiBase,
    });
    expect(unauthenticatedShutdown.ok).toBe(false);
    expect(unauthenticatedShutdown.error).toContain('DAEMON_AUTH_INVALID');
    expect(await callDaemon(settings, { op: 'ping' })).toMatchObject({
      ok: true,
      result: { pong: true },
    });
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
