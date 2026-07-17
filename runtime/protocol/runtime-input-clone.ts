import type {
  EntityInput,
  EntityLeaderCertificate,
  EntityLeaderTimeoutVote,
  EntityTx,
  JPrefixAttestation,
  JPrefixCertificate,
  JPrefixClaim,
  ProposedEntityFrame,
  RoutedEntityInput,
  RuntimeInput,
  RuntimeTx,
} from '../types';

const cloneEntityInputField = (value: unknown): unknown => structuredClone(value);

const cloneRuntimeTxValue = (value: unknown, active = new Set<object>()): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (active.has(value)) throw new Error('RUNTIME_INPUT_RUNTIME_TX_CYCLE');
  active.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => cloneRuntimeTxValue(entry, active));
    if (value instanceof Map) return new Map(Array.from(value, ([key, entry]) => [
      cloneRuntimeTxValue(key, active),
      cloneRuntimeTxValue(entry, active),
    ]));
    if (value instanceof Set) return new Set(Array.from(value, entry => cloneRuntimeTxValue(entry, active)));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return structuredClone(value);
    const cloned = Object.create(prototype) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) cloned[key] = cloneRuntimeTxValue(entry, active);
    return cloned;
  } finally {
    active.delete(value);
  }
};

const cloneIsolatedRuntimeTx = <T extends RuntimeTx>(tx: T): T =>
  cloneRuntimeTxValue(tx) as T;

export const cloneIsolatedEntityTxs = (txs: readonly EntityTx[]): EntityTx[] =>
  txs.map(tx => structuredClone(tx));

const cloneJPrefixClaim = <T extends JPrefixClaim>(claim: T): T => ({
  ...claim,
  blocks: claim.blocks.map(block => ({
    ...block,
    events: block.events.map(event => structuredClone(event)),
    ...(block.disputeFinalizationEvidence
      ? {
          disputeFinalizationEvidence: block.disputeFinalizationEvidence
            .map(evidence => structuredClone(evidence)),
        }
      : {}),
  })),
});

const cloneJPrefixAttestation = (attestation: JPrefixAttestation): JPrefixAttestation =>
  ({
    ...cloneJPrefixClaim(attestation),
    headers: attestation.headers.map(header => ({ ...header })),
  });

const cloneJPrefixCertificate = (certificate: JPrefixCertificate): JPrefixCertificate => ({
  ...certificate,
  selected: cloneJPrefixClaim(certificate.selected),
  attestations: new Map(Array.from(certificate.attestations, ([signerId, attestation]) => [
    signerId,
    cloneJPrefixAttestation(attestation),
  ])),
});

const cloneLeaderVote = (
  vote: EntityLeaderTimeoutVote,
  activeFrames: Set<object>,
): EntityLeaderTimeoutVote => ({
  ...vote,
  ...(vote.preparedFrame
    ? { preparedFrame: cloneProposedEntityFrame(vote.preparedFrame, activeFrames) }
    : {}),
});

const cloneLeaderCertificate = (
  certificate: EntityLeaderCertificate,
  activeFrames: Set<object>,
): EntityLeaderCertificate => ({
  ...certificate,
  votes: new Map(certificate.votes),
  ...(certificate.preparedVotes
    ? {
        preparedVotes: new Map(Array.from(certificate.preparedVotes, ([signerId, vote]) => [
          signerId,
          cloneLeaderVote(vote, activeFrames),
        ])),
      }
    : {}),
});

const cloneProposedEntityFrame = (
  frame: ProposedEntityFrame,
  activeFrames: Set<object>,
): ProposedEntityFrame => {
  if (activeFrames.has(frame)) throw new Error('RUNTIME_INPUT_PREPARED_FRAME_CYCLE');
  activeFrames.add(frame);
  try {
    return {
      height: frame.height,
      parentFrameHash: frame.parentFrameHash,
      stateRoot: frame.stateRoot,
      authorityRoot: frame.authorityRoot,
      timestamp: frame.timestamp,
      txs: cloneIsolatedEntityTxs(frame.txs),
      hash: frame.hash,
      leader: {
        proposerSignerId: frame.leader.proposerSignerId,
        view: frame.leader.view,
        ...(frame.leader.certificate
          ? { certificate: cloneLeaderCertificate(frame.leader.certificate, activeFrames) }
          : {}),
        ...(frame.leader.relayCertificate
          ? { relayCertificate: cloneLeaderCertificate(frame.leader.relayCertificate, activeFrames) }
          : {}),
      },
      ...(frame.jPrefixCertificate
        ? { jPrefixCertificate: cloneJPrefixCertificate(frame.jPrefixCertificate) }
        : {}),
      ...(frame.hashesToSign
        ? { hashesToSign: frame.hashesToSign.map(hashToSign => ({ ...hashToSign })) }
        : {}),
      ...(frame.collectedSigs
        ? {
            collectedSigs: new Map(Array.from(frame.collectedSigs, ([signerId, signatures]) => [
              signerId,
              [...signatures],
            ])),
          }
        : {}),
      ...(frame.hankos ? { hankos: [...frame.hankos] } : {}),
    };
  } finally {
    activeFrames.delete(frame);
  }
};

export const cloneIsolatedProposedEntityFrame = (
  frame: ProposedEntityFrame,
): ProposedEntityFrame => cloneProposedEntityFrame(frame, new Set());

export const cloneIsolatedEntityLeaderTimeoutVote = (
  vote: EntityLeaderTimeoutVote,
): EntityLeaderTimeoutVote => cloneLeaderVote(vote, new Set());

export const cloneIsolatedEntityLeaderCertificate = (
  certificate: EntityLeaderCertificate,
): EntityLeaderCertificate => cloneLeaderCertificate(certificate, new Set());

/**
 * Bun 1.3.x can corrupt a later repeated reference when one structuredClone
 * spans several protocol values. Runtime inputs never assign meaning to JS
 * object identity, so isolate every EntityInput field and every EntityTx.
 */
export const cloneIsolatedEntityInput = <T extends EntityInput>(input: T): T => {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'entityTxs') {
      if (!Array.isArray(value)) throw new Error('RUNTIME_INPUT_ENTITY_TXS_INVALID');
      cloned[key] = cloneIsolatedEntityTxs(value as EntityTx[]);
      continue;
    }
    if (key === 'proposedFrame') {
      cloned[key] = cloneIsolatedProposedEntityFrame(value as ProposedEntityFrame);
      continue;
    }
    if (key === 'hashPrecommitFrame') {
      if (!value || typeof value !== 'object') {
        throw new Error('RUNTIME_INPUT_HASH_PRECOMMIT_FRAME_INVALID');
      }
      cloned[key] = { ...(value as EntityInput['hashPrecommitFrame']) };
      continue;
    }
    if (key === 'hashPrecommits') {
      if (!(value instanceof Map)) throw new Error('RUNTIME_INPUT_HASH_PRECOMMITS_INVALID');
      cloned[key] = new Map(Array.from(value, ([signerId, signatures]) => [
        signerId,
        [...(signatures as string[])],
      ]));
      continue;
    }
    if (key === 'jPrefixAttestations') {
      if (!(value instanceof Map)) throw new Error('RUNTIME_INPUT_J_PREFIX_ATTESTATIONS_INVALID');
      cloned[key] = new Map(Array.from(value, ([signerId, attestation]) => [
        signerId,
        cloneJPrefixAttestation(attestation as JPrefixAttestation),
      ]));
      continue;
    }
    if (key === 'leaderTimeoutVote') {
      cloned[key] = cloneIsolatedEntityLeaderTimeoutVote(value as EntityLeaderTimeoutVote);
      continue;
    }
    cloned[key] = cloneEntityInputField(value);
  }
  const entityTxs = cloned['entityTxs'];
  if (
    input.entityTxs !== undefined &&
    (!Array.isArray(entityTxs) || entityTxs.length !== input.entityTxs.length)
  ) {
    throw new Error('RUNTIME_INPUT_ENTITY_TX_CLONE_SHAPE_MISMATCH');
  }
  return cloned as T;
};

export const cloneIsolatedRuntimeInput = (input: RuntimeInput): RuntimeInput => {
  if (!Array.isArray(input.runtimeTxs)) throw new Error('RUNTIME_INPUT_RUNTIME_TXS_INVALID');
  if (!Array.isArray(input.entityInputs)) throw new Error('RUNTIME_INPUT_ENTITY_INPUTS_INVALID');
  if (input.jInputs !== undefined && !Array.isArray(input.jInputs)) {
    throw new Error('RUNTIME_INPUT_J_INPUTS_INVALID');
  }
  if (input.reliableReceipts !== undefined && !Array.isArray(input.reliableReceipts)) {
    throw new Error('RUNTIME_INPUT_RELIABLE_RECEIPTS_INVALID');
  }
  const cloned: RuntimeInput = {
    // Bun 1.3 can corrupt a later occurrence of an aliased object even inside
    // one structuredClone call. RuntimeTx object identity has no semantics, so
    // clone every branch independently just as EntityInput fields are isolated.
    runtimeTxs: input.runtimeTxs.map(cloneIsolatedRuntimeTx),
    entityInputs: input.entityInputs.map(cloneIsolatedEntityInput),
    ...(input.jInputs !== undefined
      ? { jInputs: input.jInputs.map(jInput => structuredClone(jInput)) }
      : {}),
    ...(input.reliableReceipts !== undefined
      ? { reliableReceipts: input.reliableReceipts.map(receipt => structuredClone(receipt)) }
      : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    ...(input.queuedAt !== undefined ? { queuedAt: input.queuedAt } : {}),
  };
  if (
    cloned.runtimeTxs.length !== input.runtimeTxs.length ||
    cloned.entityInputs.length !== input.entityInputs.length ||
    (cloned.jInputs?.length ?? 0) !== (input.jInputs?.length ?? 0) ||
    (cloned.reliableReceipts?.length ?? 0) !== (input.reliableReceipts?.length ?? 0)
  ) {
    throw new Error('RUNTIME_INPUT_CLONE_SHAPE_MISMATCH');
  }
  return cloned;
};

export const cloneIsolatedRoutedEntityInputs = (
  inputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => inputs.map(cloneIsolatedEntityInput);

const cloneReplicaCollection = (value: unknown, label: string): unknown => {
  if (value instanceof Map) {
    return new Map(Array.from(value.entries(), ([key, replica]) => [
      structuredClone(key),
      structuredClone(replica),
    ]));
  }
  if (!Array.isArray(value)) throw new Error(`RUNTIME_SNAPSHOT_${label}_INVALID`);
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`RUNTIME_SNAPSHOT_${label}_ENTRY_INVALID:${index}`);
    }
    return [structuredClone(entry[0]), structuredClone(entry[1])];
  });
};

/** Clone known checkpoint components independently; alias identity is not durable state. */
export const cloneIsolatedRuntimeSnapshot = <T extends Record<string, unknown>>(snapshot: T): T => {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'runtimeInput') {
      if (!value || typeof value !== 'object') throw new Error('RUNTIME_SNAPSHOT_INPUT_INVALID');
      cloned[key] = cloneIsolatedRuntimeInput(value as RuntimeInput);
    } else if (key === 'eReplicas' || key === 'jReplicas') {
      cloned[key] = cloneReplicaCollection(value, key.toUpperCase());
    } else if (key === 'pendingOutputs' || key === 'networkInbox' || key === 'pendingNetworkOutputs') {
      if (!Array.isArray(value)) throw new Error(`RUNTIME_SNAPSHOT_${key.toUpperCase()}_INVALID`);
      cloned[key] = cloneIsolatedRoutedEntityInputs(value as RoutedEntityInput[]);
    } else {
      cloned[key] = structuredClone(value);
    }
  }
  return cloned as T;
};
