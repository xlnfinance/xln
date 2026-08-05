import { createServer, type Socket } from 'node:net';
import { mkdir, unlink } from 'node:fs/promises';
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

const respond = (socket: Socket, response: DaemonResponse): void => {
  socket.write(encodeMessage(response));
};

const handleRequest = async (session: CliSession, req: DaemonRequest): Promise<DaemonResponse> => {
  try {
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
        await openHubAccount(session, req.hubEntityId, BigInt(req.creditAmount), req.tokenId ?? 1);
        return { id: req.id, ok: true, result: { opened: req.hubEntityId } };
      case 'pay':
        await sendPayment(session, {
          to: req.to,
          amount: BigInt(req.amount),
          tokenId: req.tokenId ?? 1,
          mode: (req.mode as DeliveryMode) || 'direct',
          hub: req.hub,
          description: req.description,
        });
        return { id: req.id, ok: true, result: { paid: req.to, amount: req.amount } };
      case 'swap':
        await placeSwap(session, {
          hubEntityId: req.hubEntityId,
          giveTokenId: req.giveTokenId,
          wantTokenId: req.wantTokenId,
          giveAmount: BigInt(req.giveAmount),
          wantAmount: BigInt(req.wantAmount),
        });
        return { id: req.id, ok: true, result: { swapped: true } };
      case 'move':
        await executeMove(session, {
          kind: req.kind,
          amount: BigInt(req.amount),
          tokenId: req.tokenId ?? 1,
          counterpartyId: req.counterpartyId,
          to: req.to,
        });
        return { id: req.id, ok: true, result: { moved: req.kind } };
      case 'lend':
        await executeLending(session, {
          op: req.lendOp,
          hubEntityId: req.hubEntityId,
          amount: BigInt(req.amount),
          tokenId: req.tokenId ?? 1,
        });
        return { id: req.id, ok: true, result: { lend: req.lendOp } };
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
): Promise<{ close: () => Promise<void> }> => {
  await mkdir(dirname(session.settings.socketPath), { recursive: true });
  try {
    await unlink(session.settings.socketPath);
  } catch {
    /* absent */
  }

  let shuttingDown = false;
  const server = createServer(socket => {
    const decoder = createFrameDecoder();
    socket.on('data', async chunk => {
      for (const message of decoder.push(chunk)) {
        const req = message as DaemonRequest;
        const response = await handleRequest(session, req);
        respond(socket, response);
        if (req.op === 'shutdown') {
          shuttingDown = true;
          socket.end();
          server.close();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(session.settings.socketPath, () => resolve());
  });

  console.log(`[xln daemon] listening on ${session.settings.socketPath}`);
  console.log(`[xln daemon] entity ${session.entityId}`);

  return {
    close: async () => {
      if (shuttingDown) return;
      await new Promise<void>(resolve => server.close(() => resolve()));
      try {
        await unlink(session.settings.socketPath);
      } catch {
        /* ignore */
      }
    },
  };
};
