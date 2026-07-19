/**
 * Relay Local Delivery — decrypt + enqueue for messages addressed to this runtime.
 *
 * This module touches Env and crypto (p2p-crypto). The relay-router delegates
 * here via a callback so the router itself stays transport/crypto-agnostic.
 */

import {
  handleInboundP2PEntityInputs,
  handleInboundReliableReceipt,
} from '../runtime.ts';
import { deriveEncryptionKeyPair, decryptJSON, type P2PKeyPair } from '../networking/p2p-crypto';
import type {
  Env,
  EntityReplica,
  ReliableDeliveryReceipt,
  RuntimeEntityInputsEnvelope,
} from '../types';
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
    if (msg.type !== 'entity_inputs') {
      throw new Error(`Unsupported local delivery type: ${String(msg.type)}`);
    }

    if (msg.encrypted !== true || typeof payload !== 'string') {
      throw new Error('P2P_UNENCRYPTED: local entity_inputs must be encrypted');
    }
    const activeKeyPair = getServerKeyPair();
    const envelope = decryptJSON<RuntimeEntityInputsEnvelope>(payload, activeKeyPair.privateKey);
    relayLog(`[RELAY] → decrypted entity_inputs: inputs=${envelope.entityInputs?.length ?? 0}`);

    const missingEntityIds = (envelope.entityInputs || [])
      .map(input => String(input.entityId || ''))
      .filter(entityId => !getEntityReplicaById(env, entityId));
    if (missingEntityIds.length > 0) {
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to: toKey,
        msgType: 'entity_inputs',
        encrypted: msg.encrypted === true,
        status: 'rejected-no-local-replica',
        reason: 'NO_LOCAL_REPLICA',
        details: {
          entityIds: missingEntityIds,
        },
      });
      throw new Error(`NO_LOCAL_REPLICA: entityIds=${missingEntityIds.join(',')} runtimeId=${toKey}`);
    }

    const result = handleInboundP2PEntityInputs(
      env,
      from,
      envelope,
      typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
    );
    for (const receipt of result.receipts) {
      const delivery = env.runtimeState?.p2p?.enqueueReliableReceiptDelivery(from, receipt);
      if (!delivery || !isDeliveryDelivered(delivery)) {
        throw new Error(`RELIABLE_RECEIPT_SEND_DEFERRED:${delivery?.code ?? 'P2P_UNAVAILABLE'}`);
      }
    }
    if (result.kind === 'ignored' && result.receipts.length === 0) {
      throw new Error('INBOUND_ENTITY_INPUTS_IGNORED');
    }
    const queueSize = env.runtimeMempool?.entityInputs?.length ?? env.runtimeInput?.entityInputs?.length ?? 0;
    relayLog(`[RELAY] → local entity_inputs result=${result.kind} (queue=${queueSize})`);
    pushDebugEvent(store, {
      event: 'delivery',
      from,
      to: toKey,
      msgType: 'entity_inputs',
      encrypted: msg.encrypted === true,
      status: result.kind === 'pending' ? 'delivered-local-pending' : 'delivered-local-queued',
      details: {
        entityIds: envelope.entityInputs.map(input => input.entityId),
        txs: envelope.entityInputs.reduce((count, input) => count + (input.entityTxs?.length ?? 0), 0),
        queueSize,
      },
    });
  };
};
