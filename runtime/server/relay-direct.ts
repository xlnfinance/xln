import type { ServerWebSocket } from 'bun';
import type { DeliverableEntityInput, Env } from '../types';
import { encryptJSON, hexToPubKey } from '../networking/p2p-crypto';
import {
  normalizeRuntimeKey,
  nextWsTimestamp,
  pushDebugEvent,
  resolveEncryptionPublicKeyHex,
  type RelayStore,
} from '../relay-store';
import { safeStringify } from '../serialization-utils';

export type RelaySocketData = { type: 'relay' | 'rpc'; clientIp: string };
export type RelaySocket = ServerWebSocket<RelaySocketData>;

export const resolveRequestClientIp = (request: Request): string => {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  return forwarded || realIp || cfIp || 'direct';
};

export const getRelayClientIp = (ws: RelaySocket): string => String(ws.data?.clientIp || 'unknown');

export const hasConnectedEncryptedRelayClient = (relayStore: RelayStore, targetRuntimeId: string): boolean => {
  const targetKey = normalizeRuntimeKey(targetRuntimeId);
  if (!targetKey) return false;
  return Boolean(
    relayStore.clients.has(targetKey) &&
    resolveEncryptionPublicKeyHex(relayStore, targetKey),
  );
};

export const sendEntityInputDirectViaRelaySocket = (
  relayStore: RelayStore,
  env: Env,
  targetRuntimeId: string,
  input: DeliverableEntityInput,
  logOneShot: (key: string, message: string) => void,
  ingressTimestamp?: number,
): boolean => {
  const fromRuntimeId = String(env.runtimeId || '');
  if (!fromRuntimeId) return false;
  const targetKey = normalizeRuntimeKey(targetRuntimeId);
  const targetPubKeyHex = resolveEncryptionPublicKeyHex(relayStore, targetKey);
  if (!targetPubKeyHex) {
    logOneShot(
      `direct-dispatch-missing-key:${targetRuntimeId}`,
      `[RELAY] Direct dispatch missing encryption key for runtime ${targetRuntimeId.slice(0, 10)}`,
    );
    return false;
  }

  try {
    const payload = encryptJSON(input, hexToPubKey(targetPubKeyHex));
    const target = relayStore.clients.get(targetKey);
    const msg = {
      type: 'entity_input',
      id: `srv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      from: fromRuntimeId,
      to: target?.runtimeId || targetRuntimeId,
      timestamp:
        typeof ingressTimestamp === 'number' && Number.isFinite(ingressTimestamp)
          ? ingressTimestamp
          : nextWsTimestamp(relayStore),
      payload,
      encrypted: true,
    };
    if (target) {
      target.ws.send(safeStringify(msg));
      pushDebugEvent(relayStore, {
        event: 'delivery',
        from: fromRuntimeId,
        to: targetRuntimeId,
        msgType: 'entity_input',
        encrypted: true,
        status: 'delivered-direct-local',
        details: {
          entityId: input.entityId,
          txs: input.entityTxs?.length ?? 0,
        },
      });
      return true;
    }

    // No local WS client for target runtime in this process.
    // Return false so the runtime can use its normal P2P route; process-local
    // relay queues can blackhole outputs when the relay is external.
    pushDebugEvent(relayStore, {
      event: 'delivery',
      from: fromRuntimeId,
      to: targetRuntimeId,
      msgType: 'entity_input',
      encrypted: true,
      status: 'direct-miss-fallback',
      details: {
        entityId: input.entityId,
        txs: input.entityTxs?.length ?? 0,
      },
    });
    return false;
  } catch (error) {
    logOneShot(
      `direct-dispatch-send-failed:${targetRuntimeId}`,
      `[RELAY] Direct dispatch send failed for runtime ${targetRuntimeId.slice(0, 10)}: ${(error as Error).message}`,
    );
    return false;
  }
};
