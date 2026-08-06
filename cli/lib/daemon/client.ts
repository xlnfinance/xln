import { connect } from 'node:net';
import { access } from 'node:fs/promises';
import type { CliSettings } from '../settings';
import { createFrameDecoder, encodeMessage, type DaemonRequest, type DaemonResponse } from './protocol';

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
  request: Omit<DaemonRequest, 'id'> & { id?: string },
  timeoutMs = 60_000,
): Promise<DaemonResponse> => {
  const id = request.id || `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const payload = { ...request, id } as DaemonRequest;
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
