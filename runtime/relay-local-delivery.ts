/**
 * Relay Local Delivery — decrypt + enqueue for messages addressed to this runtime.
 *
 * This module touches Env and crypto (p2p-crypto). The relay-router delegates
 * here via a callback so the router itself stays transport/crypto-agnostic.
 */

import { enqueueRuntimeInput, registerEntityRuntimeHint } from './runtime.ts';
import { deriveEncryptionKeyPair, decryptJSON, type P2PKeyPair } from './networking/p2p-crypto';
import type { Env, EntityInput, EntityReplica, RoutedEntityInput } from './types';
import {
  type RelayStore,
  normalizeRuntimeKey,
  pushDebugEvent,
} from './relay-store';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createLocalDeliveryHandler = (
  env: Env,
  store: RelayStore,
  getEntityReplicaById: (env: Env, entityId: string) => EntityReplica | null,
): ((from: string | undefined, msg: { payload?: unknown; to?: unknown; encrypted?: boolean }) => Promise<void>) => {
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
      console.log(`[RELAY] Derived server decryption key`);
    }
    return serverKeyPair;
  };

  return async (from: string | undefined, msg: { payload?: unknown; to?: unknown; encrypted?: boolean }): Promise<void> => {
    const { payload } = msg;
    const to = typeof msg.to === 'string' ? msg.to : undefined;
    const toKey = normalizeRuntimeKey(to);
    if (!toKey) {
      throw new Error('Invalid target runtimeId for local delivery');
    }

    let input: EntityInput;
    if (msg.encrypted !== true || typeof payload !== 'string') {
      throw new Error('P2P_UNENCRYPTED: local entity_input must be encrypted');
    }
    const activeKeyPair = getServerKeyPair();
    input = decryptJSON<EntityInput>(payload, activeKeyPair.privateKey);
    console.log(`[RELAY] → decrypted entity_input: entityId=${input.entityId?.slice(-8)} txs=${input.entityTxs?.length ?? 0}`);

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

    // Register sender runtime hint BEFORE processing so ACK/response can route back.
    if (from && input.entityTxs) {
      const localEntityId = String(input.entityId || '').toLowerCase();
      for (const tx of input.entityTxs) {
        const data = tx.data as Record<string, unknown> | undefined;
        if (!data) continue;
        if (tx.type !== 'accountInput') continue;

        const fromEntityId =
          typeof data['fromEntityId'] === 'string' ? String(data['fromEntityId']).toLowerCase() : '';
        const toEntityId =
          typeof data['toEntityId'] === 'string' ? String(data['toEntityId']).toLowerCase() : '';

        let senderEntityId = '';
        if (fromEntityId && toEntityId) {
          if (toEntityId === localEntityId && fromEntityId !== localEntityId) {
            senderEntityId = fromEntityId;
          } else if (fromEntityId === localEntityId && toEntityId !== localEntityId) {
            senderEntityId = toEntityId;
          } else {
            senderEntityId = fromEntityId;
          }
        } else {
          senderEntityId = fromEntityId;
        }

        if (senderEntityId) {
          registerEntityRuntimeHint(env, senderEntityId, from);
        }
      }
    }

    // Enqueue to runtime
    const routedInput: RoutedEntityInput = from ? { ...input, from } : { ...input };
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [routedInput] });
    const queueSize = env.runtimeMempool?.entityInputs?.length ?? env.runtimeInput?.entityInputs?.length ?? 0;
    console.log(`[RELAY] → enqueued to runtime (queue=${queueSize})`);
    pushDebugEvent(store, {
      event: 'delivery',
      from,
      to: toKey,
      msgType: 'entity_input',
      encrypted: msg.encrypted === true,
      status: 'delivered-local-queued',
      details: { entityId: input.entityId, txs: input.entityTxs?.length ?? 0, queueSize },
    });
  };
};
