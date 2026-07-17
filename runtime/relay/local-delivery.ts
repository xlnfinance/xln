/**
 * Relay Local Delivery — decrypt + enqueue for messages addressed to this runtime.
 *
 * This module touches Env and crypto (p2p-crypto). The relay-router delegates
 * here via a callback so the router itself stays transport/crypto-agnostic.
 */

import {
  handleInboundP2PEntityInput,
  handleInboundReliableReceipt,
} from '../runtime.ts';
import { deriveEncryptionKeyPair, decryptJSON, type P2PKeyPair } from '../networking/p2p-crypto';
import type {
  Env,
  EntityInput,
  EntityReplica,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
} from '../types';
import { validateDeliverableEntityInput } from '../validation-utils';
import {
  type RelayStore,
  normalizeRuntimeKey,
  pushDebugEvent,
} from './store';
import { createStructuredLogger } from '../infra/logger';
import { isDeliveryDelivered } from '../protocol/payments/delivery-result';

const relayLocalDeliveryLog = createStructuredLogger('relay.local_delivery');
const relayLog = process.env['RELAY_VERBOSE_LOGS'] === '1'
  ? (message: string): void => relayLocalDeliveryLog.debug('verbose', { line: message })
  : (_message: string): void => {};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createLocalDeliveryHandler = (
  env: Env,
  store: RelayStore,
  getEntityReplicaById: (env: Env, entityId: string) => EntityReplica | null,
): ((from: string | undefined, msg: {
  type?: unknown;
  payload?: unknown;
  to?: unknown;
  encrypted?: boolean;
  timestamp?: unknown;
}) => Promise<void>) => {
  let serverKeyPair: P2PKeyPair | null = null;
  let serverKeySeedFingerprint: string | null = null;

  const runtimeSeedFingerprint = (): string | null => {
    const seed = env.runtimeSeed;
    if (!seed) return null;
    if (typeof seed === 'string') return seed;
    return null;
  };

  const getServerKeyPair = (): P2PKeyPair => {
    const fingerprint = runtimeSeedFingerprint();
    if (!fingerprint) {
      throw new Error('No server encryption key for local decrypt');
    }
    if (!serverKeyPair || serverKeySeedFingerprint !== fingerprint) {
      serverKeyPair = deriveEncryptionKeyPair(env.runtimeSeed as Uint8Array | string);
      serverKeySeedFingerprint = fingerprint;
      relayLog(`[RELAY] Derived server decryption key`);
    }
    return serverKeyPair;
  };

  return async (from: string | undefined, msg: {
    type?: unknown;
    payload?: unknown;
    to?: unknown;
    encrypted?: boolean;
    timestamp?: unknown;
  }): Promise<void> => {
    const { payload } = msg;
    const to = typeof msg.to === 'string' ? msg.to : undefined;
    const toKey = normalizeRuntimeKey(to);
    if (!toKey) {
      throw new Error('Invalid target runtimeId for local delivery');
    }
    if (!from) throw new Error('Missing source runtimeId for local delivery');

    if (msg.type === 'entity_input_receipt') {
      const receiptResult = handleInboundReliableReceipt(env, from, payload as ReliableDeliveryReceipt);
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to: toKey,
        msgType: 'entity_input_receipt',
        status: receiptResult === 'queued'
          ? 'delivered-local-queued'
          : receiptResult === 'duplicate'
            ? 'delivered-local-duplicate'
            : 'deferred-local-quiescing',
      });
      return;
    }
    if (msg.type !== 'entity_input') {
      throw new Error(`Unsupported local delivery type: ${String(msg.type)}`);
    }

    let input: RoutedEntityInput;
    if (msg.encrypted !== true || typeof payload !== 'string') {
      throw new Error('P2P_UNENCRYPTED: local entity_input must be encrypted');
    }
    const activeKeyPair = getServerKeyPair();
    input = validateDeliverableEntityInput(decryptJSON<EntityInput>(payload, activeKeyPair.privateKey));
    relayLog(`[RELAY] → decrypted entity_input: entityId=${input.entityId?.slice(-8)} txs=${input.entityTxs?.length ?? 0}`);

    // Check if local replica exists
    const localReplicaExists = !!getEntityReplicaById(env, String(input.entityId || ''));

    if (!localReplicaExists) {
      const entityId = String(input.entityId || '');
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to: toKey,
        msgType: 'entity_input',
        encrypted: msg.encrypted === true,
        status: 'rejected-no-local-replica',
        reason: 'NO_LOCAL_REPLICA',
        details: {
          entityId,
        },
      });
      throw new Error(`NO_LOCAL_REPLICA: entityId=${entityId || 'unknown'} runtimeId=${toKey}`);
    }

    // Enqueue to runtime only after receiver-side reliable ingress registration.
    const routedInput: RoutedEntityInput = { ...input, from };
    const result = handleInboundP2PEntityInput(
      env,
      from,
      routedInput,
      typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
    );
    if (result.kind === 'receipt') {
      const delivery = env.runtimeState?.p2p?.enqueueReliableReceiptDelivery(from, result.receipt);
      if (!delivery || !isDeliveryDelivered(delivery)) {
        throw new Error(`RELIABLE_RECEIPT_SEND_DEFERRED:${delivery?.code ?? 'P2P_UNAVAILABLE'}`);
      }
    }
    if (result.kind === 'ignored') {
      throw new Error('INBOUND_ENTITY_INPUT_IGNORED');
    }
    const queueSize = env.runtimeMempool?.entityInputs?.length ?? env.runtimeInput?.entityInputs?.length ?? 0;
    relayLog(`[RELAY] → local entity_input result=${result.kind} (queue=${queueSize})`);
    pushDebugEvent(store, {
      event: 'delivery',
      from,
      to: toKey,
      msgType: 'entity_input',
      encrypted: msg.encrypted === true,
      status: result.kind === 'pending' ? 'delivered-local-pending' : 'delivered-local-queued',
      details: { entityId: input.entityId, txs: input.entityTxs?.length ?? 0, queueSize },
    });
  };
};
