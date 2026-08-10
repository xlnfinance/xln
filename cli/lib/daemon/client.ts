import { connect } from 'node:net';
import { access, readFile, stat } from 'node:fs/promises';
import type { CliSettings } from '../settings';
import { createFrameDecoder, encodeMessage, type DaemonOperation, type DaemonRequest, type DaemonResponse } from './protocol';

export const daemonTokenPath = (settings: CliSettings): string => `${settings.socketPath}.token`;

const assertOwnerOnly = async (path: string, label: string): Promise<void> => {
  const info = await stat(path);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && info.uid !== currentUid) throw new Error(`${label}_OWNER_INVALID`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label}_MODE_INVALID:${(info.mode & 0o777).toString(8)}`);
};

export const daemonSocketExists = async (settings: CliSettings): Promise<boolean> => {
  try {
    await access(settings.socketPath);
    return true;
  } catch {
    return false;
  }
};

export const callDaemon = async (
  settings: CliSettings,
  request: DaemonOperation & { id?: string },
  timeoutMs = 60_000,
): Promise<DaemonResponse> => {
  const id = request.id || `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await assertOwnerOnly(settings.socketPath, 'DAEMON_SOCKET');
  const tokenPath = daemonTokenPath(settings);
  await assertOwnerOnly(tokenPath, 'DAEMON_TOKEN');
  const authToken = (await readFile(tokenPath, 'utf8')).trim();
  if (!authToken) throw new Error('DAEMON_TOKEN_EMPTY');
  const payload = {
    ...request,
    id,
    authToken,
    expectedApiBase: settings.apiBase.replace(/\/$/, ''),
  } as DaemonRequest;
  return new Promise((resolve, reject) => {
    const socket = connect(settings.socketPath);
    const decoder = createFrameDecoder();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Daemon timeout for ${payload.op}`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(encodeMessage(payload));
    });
    socket.on('data', chunk => {
      for (const message of decoder.push(chunk)) {
        const response = message as DaemonResponse;
        if (response.id !== id) continue;
        clearTimeout(timer);
        socket.end();
        resolve(response);
      }
    });
    socket.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
};
