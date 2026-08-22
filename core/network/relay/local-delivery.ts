/**
 * Relay Local Delivery — decrypt + enqueue for messages addressed to this runtime.
 *
 * This module touches RuntimeReplica and crypto (p2p-crypto). The relay-router delegates
 * here via a callback so the router itself stays transport/crypto-agnostic.
 */

import { handleInboundP2PEntityInputs } from '../../runtime.ts';
import { deriveEncryptionKeyPair, decryptPayload, type P2PKeyPair } from '../../protocol/crypto/p2p-crypto';
import type { RuntimeReplica } from '../../runtime/types';
import type { EntityReplica } from '../../entity/types';
import {
  type RelayStore,
  normalizeRuntimeKey,
  pushDebugEvent,
} from './store';
import { createStructuredLogger } from '../../support/logger';
import { withRuntimeCommittedRead } from '../../runtime/frame/lifecycle/writer-lock';
import { decodeRuntimeEntityInputsEnvelope } from '../p2p/auth/entity-input-envelope';
import { assertRuntimeEntityInputsEnvelopeSource } from '../../runtime/admit/entity-input-envelope-auth.ts';

const relayLocalDeliveryLog = createStructuredLogger('relay.local_delivery');
const relayLog = process.env['RELAY_VERBOSE_LOGS'] === '1'
  ? (message: string): void => relayLocalDeliveryLog.debug('verbose', { line: message })
  : (_message: string): void => {};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createLocalDeliveryHandler = (
  env: RuntimeReplica,
  store: RelayStore,
  getEntityReplicaById: (env: RuntimeReplica, entityId: string) => EntityReplica | null,
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

    if (msg.type !== 'entity_inputs') {
      throw new Error(`Unsupported local delivery type: ${String(msg.type)}`);
    }

    if (msg.encrypted !== true || !(payload instanceof Uint8Array)) {
      throw new Error('P2P_UNENCRYPTED: local entity_inputs must be encrypted');
    }
    const activeKeyPair = getServerKeyPair();
    const envelope = decodeRuntimeEntityInputsEnvelope(
      decryptPayload(payload, activeKeyPair.privateKey),
    );
    assertRuntimeEntityInputsEnvelopeSource(env, from, envelope);
    relayLog(`[RELAY] → decrypted entity_inputs: inputs=${envelope.entityInputs?.length ?? 0}`);

    await withRuntimeCommittedRead(env, () => {
      const missingEntityIds = (envelope.entityInputs || [])
        .map(input => String(input.entityId || ''))
        .filter(entityId => !getEntityReplicaById(env, entityId));
      if (missingEntityIds.length === 0) {
        const result = handleInboundP2PEntityInputs(
          env,
          from,
          envelope,
          typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
          {
            envelopeSourceVerified: true,
            entityInputsValidated: true,
          },
        );
        if (result.kind === 'ignored') {
          throw new Error('INBOUND_ENTITY_INPUTS_IGNORED');
        }
        const queueSize = env.runtimeMempool.entityInputs.length;
        relayLog(
          `[RELAY] → local entity_inputs result=${result.kind} (queue=${queueSize})`,
        );
        pushDebugEvent(store, {
          event: 'delivery',
          from,
          to: toKey,
          msgType: 'entity_inputs',
          encrypted: msg.encrypted === true,
          status: 'delivered-local-queued',
          details: {
            entityIds: envelope.entityInputs.map(input => input.entityId),
            txs: envelope.entityInputs.reduce(
              (count, input) => count + (input.entityTxs?.length ?? 0),
              0,
            ),
            queueSize,
          },
        });
        return;
      }
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
    });
  };
};
