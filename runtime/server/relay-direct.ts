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
} from '../relay/store';
import { serializeWsMessage } from '../networking/ws-protocol';
import {
  deliveryAccepted,
  deliveryDeferred,
  type DeliveryResult,
} from '../protocol/payments/delivery-result';

export type RelaySocketData = { type: 'relay' | 'rpc'; clientIp: string };
export type RelaySocket = ServerWebSocket<RelaySocketData>;
export type RelayDirectOneShotLog = (
  key: string,
  message: string,
  fields?: Record<string, unknown>,
) => void;

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

const deferredDirectRelayDelivery = (code: string): DeliveryResult =>
  deliveryDeferred({ outcome: 'deferred', code });

const pushDirectRelayDeliveryEvent = (
  relayStore: RelayStore,
  input: {
    fromRuntimeId?: string;
    targetRuntimeId: string;
    entityInput: DeliverableEntityInput;
    status: string;
    reason?: string;
    delivery?: DeliveryResult;
    details?: Record<string, unknown>;
  },
): void => {
  pushDebugEvent(relayStore, {
    event: 'delivery',
    ...(input.fromRuntimeId ? { from: input.fromRuntimeId } : {}),
    to: input.targetRuntimeId,
    msgType: 'entity_input',
    encrypted: true,
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    details: {
      entityId: input.entityInput.entityId,
      txs: input.entityInput.entityTxs?.length ?? 0,
      ...(input.details || {}),
    },
  });
};

export const sendEntityInputDirectViaRelaySocketDelivery = (
  relayStore: RelayStore,
  env: Env,
  targetRuntimeId: string,
  input: DeliverableEntityInput,
  logOneShot: RelayDirectOneShotLog,
  ingressTimestamp?: number,
): DeliveryResult => {
  const fromRuntimeId = String(env.runtimeId || '');
  if (!fromRuntimeId) {
    const delivery = deferredDirectRelayDelivery('ROUTE_DIRECT_SOURCE_RUNTIME_MISSING');
    pushDirectRelayDeliveryEvent(relayStore, {
      targetRuntimeId,
      entityInput: input,
      status: 'direct-miss-fallback',
      reason: delivery.code,
      delivery,
    });
    return delivery;
  }
  const targetKey = normalizeRuntimeKey(targetRuntimeId);
  const targetPubKeyHex = resolveEncryptionPublicKeyHex(relayStore, targetKey);
  if (!targetPubKeyHex) {
    logOneShot(
      `direct-dispatch-missing-key:${targetRuntimeId}`,
      'relay.direct.target_key_missing',
      { targetRuntimeId },
    );
    const delivery = deferredDirectRelayDelivery('ROUTE_DIRECT_TARGET_KEY_MISSING');
    pushDirectRelayDeliveryEvent(relayStore, {
      fromRuntimeId,
      targetRuntimeId,
      entityInput: input,
      status: 'direct-miss-fallback',
      reason: delivery.code,
      delivery,
    });
    return delivery;
  }
  const fromPubKeyHex = resolveEncryptionPublicKeyHex(relayStore, fromRuntimeId);
  if (!fromPubKeyHex) {
    logOneShot(
      `direct-dispatch-missing-source-key:${fromRuntimeId}`,
      'relay.direct.source_key_missing',
      { fromRuntimeId },
    );
    const delivery = deferredDirectRelayDelivery('ROUTE_DIRECT_SOURCE_KEY_MISSING');
    pushDirectRelayDeliveryEvent(relayStore, {
      fromRuntimeId,
      targetRuntimeId,
      entityInput: input,
      status: 'direct-miss-fallback',
      reason: delivery.code,
      delivery,
    });
    return delivery;
  }

  try {
    const payload = encryptJSON(input, hexToPubKey(targetPubKeyHex));
    const target = relayStore.clients.get(targetKey);
    const messageSeq = nextWsTimestamp(relayStore);
    const msg = {
      type: 'entity_input' as const,
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
      const result = target.ws.send(serializeWsMessage(msg));
      if (isRelaySendResultFailure(result)) {
        pushDirectRelayDeliveryEvent(relayStore, {
          fromRuntimeId,
          targetRuntimeId,
          entityInput: input,
          status: 'send-failed',
          reason: 'ROUTE_DIRECT_SEND_FALSE',
        });
        return deferredDirectRelayDelivery('ROUTE_DIRECT_SEND_FAILED');
      }
      pushDirectRelayDeliveryEvent(relayStore, {
        fromRuntimeId,
        targetRuntimeId,
        entityInput: input,
        status: 'delivered-direct-local',
      });
      return deliveryAccepted('ROUTE_DIRECT_DELIVERED');
    }

    // No open local WS client for target runtime in this process.
    // Return false so the runtime can use its normal P2P route; process-local
    // relay queues can blackhole outputs when the relay is external.
    pushDirectRelayDeliveryEvent(relayStore, {
      fromRuntimeId,
      targetRuntimeId,
      entityInput: input,
      status: 'direct-miss-fallback',
    });
    return deferredDirectRelayDelivery('ROUTE_DIRECT_MISS_FALLBACK');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logOneShot(
      `direct-dispatch-send-failed:${targetRuntimeId}`,
      'relay.direct.send_failed',
      { targetRuntimeId, reason },
    );
    pushDirectRelayDeliveryEvent(relayStore, {
      fromRuntimeId,
      targetRuntimeId,
      entityInput: input,
      status: 'send-failed',
      reason: 'ROUTE_DIRECT_SEND_THROW',
      details: { error: reason },
    });
    return deferredDirectRelayDelivery('ROUTE_DIRECT_SEND_FAILED');
  }
};
