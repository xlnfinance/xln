import { encodeCanonicalConsensusValue } from '../../protocol/canonical-consensus-value';
import {
  getJPrefixAttestationTemporalDisposition,
  hasDueLocalJPrefixAdvance,
  mergeJPrefixAttestations,
  verifyOutOfRoundJPrefixAttestation,
} from '../../jurisdiction/j-prefix-consensus';

import {
  commitEntityConsensusInput,
  deferEntityConsensusInput,
  rejectEntityConsensusInput,
  type ApplyEntityInputContext,
  type ApplyEntityInputResult,
} from './input-types';
import { entityLog } from './entity-log';
import { ensureLocalJPrefixAttestation } from './j-prefix-round';

const verifyAttestationRound = (context: ApplyEntityInputContext): 'stale' | 'current' | 'future' => {
  const { env, entityInput, workingReplica } = context;
  const incoming = entityInput.jPrefixAttestations!;
  const authorityConfigs = [
    workingReplica.state.config,
    ...(workingReplica.certifiedFrameAnchor ? [workingReplica.certifiedFrameAnchor.authority.config] : []),
    ...(workingReplica.certifiedFrameLineage ?? []).map(link => link.postAuthority.config),
  ];
  const dispositions = new Set(
    [...incoming.values()].map(attestation =>
      getJPrefixAttestationTemporalDisposition(workingReplica.state, attestation),
    ),
  );
  if (dispositions.size !== 1) throw new Error('J_PREFIX_MIXED_TARGET_HEIGHTS');
  const disposition = dispositions.values().next().value!;
  if (disposition === 'current') return disposition;
  for (const [rawSignerId, rawAttestation] of incoming) {
    const attestation = verifyOutOfRoundJPrefixAttestation(env, workingReplica.state, rawAttestation, authorityConfigs);
    if (rawSignerId.trim().toLowerCase() !== attestation.validatorId) {
      throw new Error(`J_PREFIX_MAP_SIGNER_MISMATCH:${rawSignerId}`);
    }
  }
  return disposition;
};

const rebroadcastLocalAttestation = (context: ApplyEntityInputContext): void => {
  const { entityInput, entityOutbox, workingReplica } = context;
  const incoming = entityInput.jPrefixAttestations!;
  for (const [signerId, attestation] of incoming) {
    const normalizedSignerId = signerId.trim().toLowerCase();
    if (normalizedSignerId !== workingReplica.signerId.trim().toLowerCase()) {
      continue;
    }
    const previous = workingReplica.jPrefixRound?.attestations.get(normalizedSignerId);
    if (previous && encodeCanonicalConsensusValue(previous) === encodeCanonicalConsensusValue(attestation)) {
      continue;
    }
    for (const validatorId of workingReplica.state.config.validators) {
      if (validatorId.trim().toLowerCase() === normalizedSignerId) continue;
      entityOutbox.push({
        entityId: workingReplica.entityId,
        signerId: validatorId,
        jPrefixAttestations: new Map([[normalizedSignerId, structuredClone(attestation)]]),
      });
    }
  }
};

export const handleJPrefixAttestations = (context: ApplyEntityInputContext): ApplyEntityInputResult | null => {
  const { env, entityInput, workingReplica, entityOutbox } = context;
  const incoming = entityInput.jPrefixAttestations;
  if (!incoming) return null;
  if (!(incoming instanceof Map) || incoming.size === 0) {
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_INVALID');
  }

  let disposition: 'stale' | 'current' | 'future';
  try {
    disposition = verifyAttestationRound(context);
  } catch (error) {
    entityLog.error('j_prefix.attestation_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_REJECTED');
  }
  if (disposition === 'future') {
    return deferEntityConsensusInput(context, 'J_PREFIX_FUTURE_HEIGHT');
  }
  if (disposition === 'stale') {
    entityLog.debug('j_prefix.attestation_stale_terminal', {
      targetEntityHeight: incoming.values().next().value!.targetEntityHeight,
      currentEntityHeight: workingReplica.state.height,
    });
    // A queued vote can become stale after unrelated traffic commits. Preserve
    // the observed J obligation by deriving a fresh vote for the current parent.
    if (
      hasDueLocalJPrefixAdvance(workingReplica.state, workingReplica.jHistory) &&
      ensureLocalJPrefixAttestation(env, workingReplica, entityOutbox, false)
    ) {
      return null;
    }
    return commitEntityConsensusInput(context);
  }

  const priorRound = workingReplica.jPrefixRound;
  const priorHeads = encodeCanonicalConsensusValue(priorRound?.attestations ?? new Map());
  let merged;
  try {
    merged = mergeJPrefixAttestations(env, workingReplica.state, priorRound, incoming);
  } catch (error) {
    entityLog.error('j_prefix.attestation_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'J_PREFIX_ATTESTATION_REJECTED');
  }
  const changed = priorHeads !== encodeCanonicalConsensusValue(merged.attestations);
  if (changed && (workingReplica.proposal || workingReplica.lockedFrame)) {
    // A signed/locked frame freezes its J round. A later head belongs to the
    // next Entity height or the validator could authorize two maximum prefixes.
    return rejectEntityConsensusInput(context, 'J_PREFIX_ROUND_FROZEN');
  }
  workingReplica.jPrefixRound = merged;
  if (changed) workingReplica.lastConsensusProgressAt = env.state.timestamp;
  rebroadcastLocalAttestation(context);
  return null;
};
