import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

import { createEmptyEnv } from '../../core/runtime';
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

const callRawDaemonSequence = (
  socketPath: string,
  requests: readonly DaemonRequest[],
): Promise<DaemonResponse[]> => new Promise((resolve, reject) => {
  const socket = connect(socketPath);
  const decoder = createFrameDecoder();
  const responses: DaemonResponse[] = [];
  socket.on('connect', () => {
    socket.write(Buffer.concat(requests.map(request => encodeMessage(request))));
  });
  socket.on('data', chunk => {
    for (const message of decoder.push(chunk)) responses.push(message as DaemonResponse);
    if (responses.length !== requests.length) return;
    socket.end();
    resolve(responses);
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

test('daemon serializes shutdown and rejects later decoded commands', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'xln-daemon-order-'));
  const settings = {
    barStyle: 'closed' as const,
    apiBase: 'https://xln.finance',
    dbPath: join(homeDir, 'db'),
    homeDir,
    socketPath: join(homeDir, 'daemon.sock'),
    profileName: 'wallet',
  };
  const session = {
    settings,
    env: createEmptyEnv('daemon-order'),
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
  } satisfies CliSession;
  const server = await startDaemonServer(session);
  try {
    const authToken = (await Bun.file(daemonTokenPath(settings)).text()).trim();
    const request = (id: string, op: 'ping' | 'shutdown'): DaemonRequest => ({
      id,
      op,
      authToken,
      expectedApiBase: settings.apiBase,
    });
    const responses = await callRawDaemonSequence(settings.socketPath, [
      request('before', 'ping'),
      request('stop', 'shutdown'),
      request('after', 'ping'),
    ]);
    expect(responses).toEqual([
      { id: 'before', ok: true, result: { pong: true } },
      { id: 'stop', ok: true, result: { shutdown: true } },
      { id: 'after', ok: false, error: 'DAEMON_SHUTTING_DOWN' },
    ]);
    await server.closed;
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
