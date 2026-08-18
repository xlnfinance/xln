import { logError } from '../../../support/logger';
import type { ConsensusOutputOrigin, EntityTx } from '../../../types/entity-tx';
import type { HankoString } from '../../../types/hanko';
import {
  applyConsumptionOutput,
  createConsumptionProof,
  createEmptyConsumptionAccumulator,
  getConsumptionKey,
  type ConsumptionNode,
  type ConsumptionOutputIdentity,
} from '../../consumption/consumption-accumulator';
import { getConsumptionNodeStore } from '../../consumption/consumption-store';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityOutput, EntityState, HashToSign, EntityFrame } from '../../types';
import {
  assertCertifiedOutputSemanticIdentity,
  buildCertifiedEntityOutputHashes,
  buildConsensusOutputOriginForState,
  hashCertifiedEntityOutput,
  isLocalRuntimeProtocolOutput,
  isNonMutatingEntityWakeOutput,
  normalizeConsensusOutputOrigin,
} from './certification';
import { orderCertifiedOutputsBySequence } from './envelope';
import { entityLog } from '../entity-log';
import { cloneIsolatedEntityTxs } from '../../state/input-clone';

/**
 * Gap deferral can fire on every proposal tick while the missing predecessor
 * is still in flight. Logging each repeat turned one lost sequence into tens
 * of thousands of warn lines and starved hub/MM bootstrap under E2E load.
 * Ops only needs the first sighting per (source,target,lane,received).
 */
const sequenceGapWarnSeen = new Set<string>();

export const buildConsumptionOutputIdentity = (
  origin: ConsensusOutputOrigin,
  targetEntityId: string,
  outputHash: string,
  outputHanko: string,
): ConsumptionOutputIdentity => ({
  targetEntityId,
  sourceEntityId: origin.sourceEntityId,
  lane: origin.lane,
  sequence: origin.sequence,
  semanticHash: origin.semanticHash,
  outputHash,
  outputHanko,
});

/**
 * Add target-local accumulator proofs before proposal. A remote source may
 * certify output semantics, but it can never choose the target's pre-state
 * witness.
 */
export const attachTargetConsumptionProofs = (
  env: EntityRuntimeContext,
  state: EntityState,
  txs: readonly EntityTx[],
): EntityTx[] => {
  let accumulator = state.consumptionAccumulator ?? createEmptyConsumptionAccumulator();
  const overlay = new Map<string, ConsumptionNode>(getConsumptionNodeStore(env));
  const selected: EntityTx[] = [];
  for (const tx of orderCertifiedOutputsBySequence(txs)) {
    if (tx.type !== 'consensusOutput') {
      selected.push(tx);
      continue;
    }
    const origin = normalizeConsensusOutputOrigin(tx.data.origin);
    const targetEntityId = String(tx.data.targetEntityId ?? '')
      .trim()
      .toLowerCase();
    const outputHash = hashCertifiedEntityOutput(origin, targetEntityId, tx.data.entityTxs);
    assertCertifiedOutputSemanticIdentity(origin, targetEntityId, tx.data.entityTxs);
    const identity = buildConsumptionOutputIdentity(origin, targetEntityId, outputHash, tx.data.outputHanko);
    const key = getConsumptionKey(identity);
    const proof = createConsumptionProof(overlay, accumulator.root, key);
    const applied = applyConsumptionOutput(accumulator, identity, proof);
    if (applied.status === 'gap') {
      const gapKey = [
        origin.sourceEntityId,
        targetEntityId,
        origin.lane,
        origin.sequence.toString(),
      ].join('\u0000');
      if (!sequenceGapWarnSeen.has(gapKey)) {
        sequenceGapWarnSeen.add(gapKey);
        entityLog.warn('consensus_output.sequence_gap_deferred', {
          sourceEntityId: origin.sourceEntityId,
          targetEntityId,
          lane: origin.lane,
          received: origin.sequence.toString(),
        });
      }
      continue;
    }
    if (applied.status === 'quarantined' && applied.newNodes.length === 0) {
      logError('FRAME_CONSENSUS', 'Certified output excluded for quarantined relationship', {
        sourceEntityId: origin.sourceEntityId,
        targetEntityId,
        lane: origin.lane,
      });
      continue;
    }
    for (const { hash, node } of applied.newNodes) overlay.set(hash, node);
    for (const hash of applied.replacedNodeHashes) overlay.delete(hash);
    accumulator = applied.state;
    // Nested Account frames are immutable certified evidence. Copy the
    // consensusOutput envelope to attach the proof; do not walk offer bodies.
    selected.push({
      ...tx,
      data: { ...tx.data, consumptionProof: proof },
    });
  }
  return selected;
};

/** Convert committed Entity outputs into their exact Runtime-routable form. */
export const wrapCertifiedEntityOutputs = (
  outputs: EntityOutput[],
  frame: EntityFrame,
  sourceState: EntityState,
  env: EntityRuntimeContext,
  hashesToSign: HashToSign[],
  hankos: HankoString[],
  emitLocalRuntimeOutputs: boolean,
): EntityOutput[] => {
  const outputHashes = buildCertifiedEntityOutputHashes(sourceState, env, frame.height, frame.hash, outputs);
  return outputs.flatMap((output, outputIndex): EntityOutput[] => {
    if (isNonMutatingEntityWakeOutput(output)) return [structuredClone(output)];
    if (isLocalRuntimeProtocolOutput(output)) {
      if (!emitLocalRuntimeOutputs) return [];
      const targetEntityId = output.entityId.trim().toLowerCase();
      const localTarget = Array.from(env.state.eReplicas.values()).some(
        replica =>
          replica.entityId.toLowerCase() === targetEntityId &&
          replica.signerId.toLowerCase() === output.signerId.toLowerCase(),
      );
      if (!localTarget) {
        throw new Error(`RUNTIME_OUTPUT_TARGET_NOT_LOCAL:${targetEntityId}:${output.signerId}`);
      }
      if (!output.entityTxs?.length) throw new Error(`RUNTIME_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
      return [{
        entityId: targetEntityId,
        signerId: output.signerId.toLowerCase(),
        entityTxs: [{
          type: 'runtimeOutput',
          data: {
            protocol: 'cross-j',
            sourceEntityId: sourceState.entityId.toLowerCase(),
            targetEntityId,
            entityTxs: cloneIsolatedEntityTxs(output.entityTxs),
          },
        }],
      }];
    }
    const outputHash = outputHashes.find(
      hashInfo => hashInfo.context === `entity-output:${frame.height}:${outputIndex}`,
    );
    if (!outputHash) throw new Error(`CONSENSUS_OUTPUT_HASH_MISSING:index=${outputIndex}`);
    const manifestIndex = hashesToSign.findIndex(
      hashInfo =>
        hashInfo.type === 'entityOutput' &&
        hashInfo.hash.toLowerCase() === outputHash.hash.toLowerCase() &&
        hashInfo.context === outputHash.context,
    );
    if (manifestIndex < 0) {
      throw new Error(`CONSENSUS_OUTPUT_MANIFEST_ENTRY_MISSING:index=${outputIndex}:hash=${outputHash.hash}`);
    }
    const outputHanko = hankos[manifestIndex];
    if (!outputHanko) {
      throw new Error(`CONSENSUS_OUTPUT_HANKO_MISSING:index=${outputIndex}:hash=${outputHash.hash}`);
    }
    const semanticIdentity = output.certifiedOutputIdentity;
    if (!semanticIdentity) throw new Error(`CONSENSUS_OUTPUT_SEMANTIC_IDENTITY_MISSING:index=${outputIndex}`);
    const origin = buildConsensusOutputOriginForState(
      sourceState,
      env,
      frame.height,
      frame.hash,
      outputIndex,
      semanticIdentity,
    );
    const targetEntityId = output.entityId.toLowerCase();
    const entityTxs = output.entityTxs;
    if (!entityTxs) throw new Error(`CONSENSUS_OUTPUT_ENTITY_TXS_MISSING:index=${outputIndex}`);
    const { certifiedOutputIdentity: _certifiedOutputIdentity, entityTxs: _entityTxs, ...route } = output;
    return [{
      ...route,
      entityTxs: [{
        type: 'consensusOutput',
        data: {
          origin,
          outputHanko,
          targetEntityId,
          entityTxs: cloneIsolatedEntityTxs(entityTxs),
        },
      }],
    }];
  });
};
