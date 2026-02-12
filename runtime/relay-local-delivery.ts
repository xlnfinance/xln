/**
 * Relay Local Delivery — decrypt + enqueue for messages addressed to this runtime.
 *
 * This module touches Env and crypto (p2p-crypto). The relay-router delegates
 * here via a callback so the router itself stays transport/crypto-agnostic.
 */

import { enqueueRuntimeInput, registerEntityRuntimeHint } from './runtime';
import { deriveEncryptionKeyPair, decryptJSON, type P2PKeyPair } from './networking/p2p-crypto';
import type { Env, EntityInput } from './types';
import {
  type RelayStore,
  normalizeRuntimeKey,
  pushDebugEvent,
  enqueueMessage,
} from './relay-store';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createLocalDeliveryHandler = (
  env: Env,
  store: RelayStore,
  getEntityReplicaById: (env: Env, entityId: string) => any | null,
): ((from: string | undefined, msg: any) => Promise<void>) => {
  let serverKeyPair: P2PKeyPair | null = null;

  return async (from: string | undefined, msg: any): Promise<void> => {
    const { payload, to } = msg;
    const toKey = normalizeRuntimeKey(to);

    // Decrypt or parse plaintext
    let input: EntityInput;
    if (msg.encrypted && typeof payload === 'string') {
      if (!serverKeyPair && env.runtimeSeed) {
        serverKeyPair = deriveEncryptionKeyPair(env.runtimeSeed);
        console.log(`[RELAY] Derived server decryption key`);
      }
      if (!serverKeyPair) throw new Error('No server encryption key for local decrypt');
      input = decryptJSON<EntityInput>(payload, serverKeyPair.privateKey);
      console.log(`[RELAY] → decrypted entity_input: entityId=${input.entityId?.slice(-8)} txs=${input.entityTxs?.length ?? 0}`);
    } else {
      input = payload as EntityInput;
      console.log(`[RELAY] → plaintext entity_input: entityId=${input.entityId?.slice(-8)}`);
    }

    // Check if local replica exists
    const localRuntimeKey = normalizeRuntimeKey(env.runtimeId);
    const targetIsServerRuntime = !!toKey && !!localRuntimeKey && toKey === localRuntimeKey;
    const localReplicaExists = !!getEntityReplicaById(env, String(input.entityId || ''));

    if (!localReplicaExists) {
      const queueSize = enqueueMessage(store, toKey, msg);
      pushDebugEvent(store, {
        event: 'delivery',
        from,
        to,
        msgType: 'entity_input',
        encrypted: msg.encrypted === true,
        status: targetIsServerRuntime ? 'queued-unknown-local-entity' : 'queued-nonlocal-target',
        details: {
          entityId: input.entityId,
          queueSize,
          targetIsServerRuntime,
        },
      });
      // Signal to router that we queued (not an error, but not delivered either)
      // Router will send appropriate ack
      return;
    }

    // Register sender runtime hint BEFORE processing so ACK/response can route back.
    if (from && input.entityTxs) {
      const localEntityId = String(input.entityId || '').toLowerCase();
      for (const tx of input.entityTxs) {
        const data = tx.data as Record<string, unknown> | undefined;
        if (!data) continue;
        if (tx.type !== 'accountInput') continue;

        const fromEntityId =
          typeof data.fromEntityId === 'string' ? String(data.fromEntityId).toLowerCase() : '';
        const toEntityId =
          typeof data.toEntityId === 'string' ? String(data.toEntityId).toLowerCase() : '';

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
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: [{ ...input, from }] });
    const queueSize = (env as any).runtimeMempool?.entityInputs?.length ?? env.runtimeInput?.entityInputs?.length ?? 0;
    console.log(`[RELAY] → enqueued to runtime (queue=${queueSize})`);
    pushDebugEvent(store, {
      event: 'delivery',
      from,
      to,
      msgType: 'entity_input',
      encrypted: msg.encrypted === true,
      status: 'delivered-local-queued',
      details: { entityId: input.entityId, txs: input.entityTxs?.length ?? 0, queueSize },
    });
  };
};
