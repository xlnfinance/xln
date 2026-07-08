import type { ServerWebSocket } from 'bun';
import type { DeliverableEntityInput, Env } from '../types';
import { encryptJSON, hexToPubKey } from '../networking/p2p-crypto';
import {
  isRelaySocketOpen,
  isRelaySendResultFailure,
  normalizeRuntimeKey,
  nextWsTimestamp,
  pushDebugEvent,
  resolveEncryptionPublicKeyHex,
  type RelayStore,
} from '../relay-store';
import { safeStringify } from '../serialization-utils';
import {
  deliveryAccepted,
  deliveryDeferred,
  type DeliveryResult,
} from '../delivery-result';

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
  const target = relayStore.clients.get(targetKey);
  return Boolean(target && isRelaySocketOpen(target.ws) && resolveEncryptionPublicKeyHex(relayStore, targetKey));
};

export const sendEntityInputDirectViaRelaySocketDelivery = (
  relayStore: RelayStore,
  env: Env,
  targetRuntimeId: string,
  input: DeliverableEntityInput,
  logOneShot: (key: string, message: string) => void,
  ingressTimestamp?: number,
): DeliveryResult => {
  const fromRuntimeId = String(env.runtimeId || '');
  if (!fromRuntimeId) {
    return deliveryDeferred({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SOURCE_RUNTIME_MISSING',
    });
  }
  const targetKey = normalizeRuntimeKey(targetRuntimeId);
  const targetPubKeyHex = resolveEncryptionPublicKeyHex(relayStore, targetKey);
  if (!targetPubKeyHex) {
    logOneShot(
      `direct-dispatch-missing-key:${targetRuntimeId}`,
      `[RELAY] Direct dispatch missing encryption key for runtime ${targetRuntimeId.slice(0, 10)}`,
    );
    return deliveryDeferred({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_TARGET_KEY_MISSING',
    });
  }
  const fromPubKeyHex = resolveEncryptionPublicKeyHex(relayStore, fromRuntimeId);
  if (!fromPubKeyHex) {
    logOneShot(
      `direct-dispatch-missing-source-key:${fromRuntimeId}`,
      `[RELAY] Direct dispatch missing source encryption key for runtime ${fromRuntimeId.slice(0, 10)}`,
    );
    return deliveryDeferred({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SOURCE_KEY_MISSING',
    });
  }

  try {
    const payload = encryptJSON(input, hexToPubKey(targetPubKeyHex));
    const target = relayStore.clients.get(targetKey);
    const messageSeq = nextWsTimestamp(relayStore);
    const msg = {
      type: 'entity_input',
      id: `srv_${messageSeq}`,
      from: fromRuntimeId,
      fromEncryptionPubKey: fromPubKeyHex,
      to: target?.runtimeId || targetRuntimeId,
      timestamp:
        typeof ingressTimestamp === 'number' && Number.isFinite(ingressTimestamp)
          ? ingressTimestamp
          : messageSeq,
      payload,
      encrypted: true,
      entityId: input.entityId,
      txs: input.entityTxs?.length ?? 0,
    };
    if (target && isRelaySocketOpen(target.ws)) {
      const result = target.ws.send(safeStringify(msg));
      if (isRelaySendResultFailure(result)) {
        pushDebugEvent(relayStore, {
          event: 'delivery',
          from: fromRuntimeId,
          to: targetRuntimeId,
          msgType: 'entity_input',
          encrypted: true,
          status: 'send-failed',
          reason: 'ROUTE_DIRECT_SEND_FALSE',
          details: {
            entityId: input.entityId,
            txs: input.entityTxs?.length ?? 0,
          },
        });
        return deliveryDeferred({
          outcome: 'deferred',
          code: 'ROUTE_DIRECT_SEND_FAILED',
        });
      }
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
      return deliveryAccepted('ROUTE_DIRECT_DELIVERED');
    }

    // No open local WS client for target runtime in this process.
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
    return deliveryDeferred({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_MISS_FALLBACK',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logOneShot(
      `direct-dispatch-send-failed:${targetRuntimeId}`,
      `[RELAY] Direct dispatch send failed for runtime ${targetRuntimeId.slice(0, 10)}: ${reason}`,
    );
    pushDebugEvent(relayStore, {
      event: 'delivery',
      from: fromRuntimeId,
      to: targetRuntimeId,
      msgType: 'entity_input',
      encrypted: true,
      status: 'send-failed',
      reason: 'ROUTE_DIRECT_SEND_THROW',
      details: {
        entityId: input.entityId,
        txs: input.entityTxs?.length ?? 0,
        error: reason,
      },
    });
    return deliveryDeferred({
      outcome: 'deferred',
      code: 'ROUTE_DIRECT_SEND_FAILED',
    });
  }
};
