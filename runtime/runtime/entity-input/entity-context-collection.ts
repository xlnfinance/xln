import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import { shortHash } from '../../infra/logger';
import type { EntityInfraContext } from '../../types/entity/infra-context';

/** Bounded, non-secret fields that identify which EntityInput produced a commit. */
export type EntityInputCommitShape = {
  from?: string;
  runtimeId?: string;
  entityTxs?: ReadonlyArray<{ type: string }>;
  proposedFrame?: { height?: number; hash?: string } | null;
  hashPrecommits?: { size: number } | null;
  hashPrecommitFrame?: { height?: number } | null;
  jPrefixAttestations?: Map<string, { targetEntityHeight: number }> | null;
  leaderTimeoutVote?: { targetHeight: number } | null;
};

const originId = (value: unknown, empty: string): string => {
  const text = String(value ?? '').trim().toLowerCase();
  return text || empty;
};

const uniqueTxTypes = (input: EntityInputCommitShape): string => {
  const txs = input.entityTxs ?? [];
  if (txs.length === 0) return 'none*0';
  const types = [...new Set(txs.map(tx => tx.type))].slice(0, 8);
  return `${types.join(',')}*${txs.length}`;
};

const jPrefixShape = (input: EntityInputCommitShape): string => {
  const attestations = input.jPrefixAttestations;
  const count = attestations?.size ?? 0;
  if (!attestations || count === 0) return 'none*0';
  const targets = [...new Set([...attestations.values()].map(entry => entry.targetEntityHeight))];
  return `${targets.join(',')}*${count}`;
};

/** Compact collision diagnostic. Hashes are truncated; signatures/bytes stay out. */
export const describeEntityInputCommitShape = (input: EntityInputCommitShape): string => {
  const proposed = input.proposedFrame
    ? `${input.proposedFrame.height ?? 'none'}/${shortHash(input.proposedFrame.hash, 12) || 'none'}`
    : 'none';
  return [
    `from=${originId(input.from, 'local')}`,
    `runtimeId=${originId(input.runtimeId, 'none')}`,
    `txs=${uniqueTxTypes(input)}`,
    `proposed=${proposed}`,
    `precommit=${input.hashPrecommitFrame?.height ?? 'none'}*${input.hashPrecommits?.size ?? 0}`,
    `jPrefix=${jPrefixShape(input)}`,
    `leader=${input.leaderTimeoutVote?.targetHeight ?? 'none'}`,
  ].join(';');
};

/** Commit one proposer-observed slice under the exact local replica that applied it. */
export const collectRuntimeEntityContext = (
  contexts: Map<string, EntityInfraContext>,
  inputEntityId: string,
  appliedReplicaId: string,
  context: EntityInfraContext,
  incomingInputShape = 'unknown',
  commitShapes?: Map<string, string>,
): void => {
  const entityId = context.entityId.toLowerCase();
  const proposerSignerId = context.proposerSignerId.toLowerCase();
  const proposerReplicaId = `${entityId}:${proposerSignerId}`;
  const appliedEntityId = appliedReplicaId.split(':')[0]?.toLowerCase();
  if (
    inputEntityId.toLowerCase() !== entityId ||
    appliedEntityId !== entityId ||
    context.entityId !== entityId ||
    context.proposerSignerId !== proposerSignerId ||
    context.proposerReplicaId !== proposerReplicaId
  ) {
    throw new Error(
      `RUNTIME_ENTITY_CONTEXT_REPLICA_BINDING_INVALID:expected=${proposerReplicaId}:received=${context.proposerReplicaId}`,
    );
  }
  const existing = contexts.get(appliedReplicaId);
  if (
    existing &&
    encodeCanonicalConsensusValue(existing) !== encodeCanonicalConsensusValue(context)
  ) {
    throw new Error(
      `RUNTIME_ENTITY_CONTEXT_COLLISION:${appliedReplicaId}:` +
      `existing=${existing.height}/${existing.parentFrameHash}:` +
      `incoming=${context.height}/${context.parentFrameHash}:` +
      `existingInput=${commitShapes?.get(appliedReplicaId) ?? 'unknown'}:` +
      `incomingInput=${incomingInputShape}`,
    );
  }
  contexts.set(appliedReplicaId, structuredClone(context));
  commitShapes?.set(appliedReplicaId, incomingInputShape);
};
