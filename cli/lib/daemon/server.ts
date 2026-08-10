import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CliSession } from '../session';
import { formatAccountsPanel } from '../accounts';
import { listDiscoverableHubs, openHubAccount, formatHubList } from '../actions/open-account';
import { buildReceiveInvoice, sendPayment, type DeliveryMode } from '../actions/pay';
import { placeSwap } from '../actions/swap';
import { executeMove } from '../actions/move';
import { executeLending } from '../actions/lending';
import {
  createFrameDecoder,
  encodeMessage,
  type DaemonRequest,
  type DaemonResponse,
} from './protocol';
import { daemonTokenPath } from './client';

const respond = (socket: Socket, response: DaemonResponse): void => {
  socket.write(encodeMessage(response));
};

const normalizedApiBase = (value: string): string => value.trim().replace(/\/$/, '');

const handleRequest = async (
  session: CliSession,
  req: DaemonRequest,
  authToken: string,
): Promise<DaemonResponse> => {
  try {
    if (req.authToken !== authToken) throw new Error('DAEMON_AUTH_INVALID');
    if (normalizedApiBase(req.expectedApiBase) !== normalizedApiBase(session.settings.apiBase)) {
      throw new Error(
        `DAEMON_CONTEXT_API_MISMATCH:expected=${req.expectedApiBase}:actual=${session.settings.apiBase}`,
      );
    }
    switch (req.op) {
      case 'ping':
        return { id: req.id, ok: true, result: { pong: true } };
      case 'status':
        return {
          id: req.id,
          ok: true,
          result: {
            runtimeId: session.identity.runtimeId,
            entityId: session.entityId,
            jurisdiction: session.jurisdictionName,
            accounts: formatAccountsPanel(session.env, session.entityId, session.settings.barStyle, false),
          },
        };
      case 'hubs': {
        const hubs = await listDiscoverableHubs(session);
        return { id: req.id, ok: true, result: { text: formatHubList(hubs, session), hubs } };
      }
      case 'open':
        return {
          id: req.id,
          ok: true,
          result: {
            accepted: 'runtime-input-committed',
            committedHeight: await openHubAccount(session, req.hubEntityId, BigInt(req.creditAmount), req.tokenId ?? 1),
          },
        };
      case 'pay':
        return { id: req.id, ok: true, result: {
          accepted: 'runtime-input-committed',
          committedHeight: await sendPayment(session, {
          to: req.to,
          amount: BigInt(req.amount),
          tokenId: req.tokenId ?? 1,
          mode: (req.mode as DeliveryMode) || 'direct',
          hub: req.hub,
          description: req.description,
          }),
        } };
      case 'swap':
        return { id: req.id, ok: true, result: {
          accepted: 'runtime-input-committed',
          committedHeight: await placeSwap(session, {
          hubEntityId: req.hubEntityId,
          giveTokenId: req.giveTokenId,
          wantTokenId: req.wantTokenId,
          giveAmount: BigInt(req.giveAmount),
          wantAmount: BigInt(req.wantAmount),
          }),
        } };
      case 'move':
        return { id: req.id, ok: true, result: {
          accepted: 'runtime-input-committed',
          committedHeight: await executeMove(session, {
          kind: req.kind,
          amount: BigInt(req.amount),
          tokenId: req.tokenId ?? 1,
          counterpartyId: req.counterpartyId,
          to: req.to,
          }),
        } };
      case 'lend':
        return { id: req.id, ok: true, result: {
          accepted: 'runtime-input-committed',
          committedHeight: await executeLending(session, {
          op: req.lendOp,
          hubEntityId: req.hubEntityId,
          amount: BigInt(req.amount),
          tokenId: req.tokenId ?? 1,
          }),
        } };
      case 'receive':
        return { id: req.id, ok: true, result: { invoice: buildReceiveInvoice(session) } };
      case 'shutdown':
        return { id: req.id, ok: true, result: { shutdown: true } };
      default:
        return { id: (req as DaemonRequest).id, ok: false, error: 'Unknown op' };
    }
  } catch (err) {
    return {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

export const startDaemonServer = async (
  session: CliSession,
): Promise<{ close: () => Promise<void>; closed: Promise<void> }> => {
  const parent = dirname(session.settings.socketPath);
  const tokenPath = daemonTokenPath(session.settings);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  try {
    await unlink(session.settings.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const authToken = randomBytes(32).toString('hex');
  await writeFile(tokenPath, authToken, { encoding: 'utf8', mode: 0o600 });
  await chmod(tokenPath, 0o600);
  let shuttingDown = false;
  let requestQueue = Promise.resolve();
  const sockets = new Set<Socket>();
  const endSocketsAfterQueueDrain = (): void => {
    queueMicrotask(() => {
      void requestQueue.finally(() => {
        for (const openSocket of sockets) openSocket.end();
      });
    });
  };

  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const decoder = createFrameDecoder();
    socket.on('data', chunk => {
      for (const message of decoder.push(chunk)) {
        const req = message as DaemonRequest;
        // One unlocked CliSession is one financial command lane. Socket data
        // callbacks may overlap across clients, so serialize at process scope;
        // per-socket ordering alone still permits pay/pay and pay/shutdown races.
        requestQueue = requestQueue.then(async () => {
          const response = shuttingDown
            ? { id: req.id, ok: false, error: 'DAEMON_SHUTTING_DOWN' }
            : await handleRequest(session, req, authToken);
          respond(socket, response);
          if (req.op === 'shutdown' && response.ok) {
            // Every command admitted before this shutdown has completed. Stop
            // new connections now; requests already decoded after shutdown are
            // rejected by the same queue instead of racing session teardown.
            shuttingDown = true;
            server.close();
            endSocketsAfterQueueDrain();
          }
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(session.settings.socketPath, () => resolve());
  });
  await chmod(session.settings.socketPath, 0o600);

  const closed = new Promise<void>((resolve, reject) => {
    server.once('close', async () => {
      try {
        for (const path of [session.settings.socketPath, tokenPath]) {
          try {
            await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

  console.log(`[xln daemon] listening on ${session.settings.socketPath}`);
  console.log(`[xln daemon] entity ${session.entityId}`);

  return {
    closed,
    close: async () => {
      shuttingDown = true;
      await requestQueue;
      for (const socket of sockets) socket.end();
      if (server.listening) server.close();
      await closed;
    },
  };
};
