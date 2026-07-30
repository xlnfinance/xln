import { encodeCanonicalConsensusValue } from '../../protocol/canonical-consensus-value';
import { signAccountFrame, verifyAccountSignature } from '../../account/crypto';
import { shortId } from '../../infra/logger';
import {
  cloneIsolatedEntityLeaderCertificate,
  cloneIsolatedEntityLeaderTimeoutVote,
} from '../input-clone';
import type { EntityLeaderTimeoutVote, ProposedEntityFrame } from '../types';
import {
  assertEntityLeaderVoteMatchesState,
  buildEntityLeaderCertificate,
  hashEntityLeaderVoteBody,
  isLocalEntityLeaderTimeoutVote,
  leaderVoteCollectionKey,
} from './leader';
import { rejectEntityConsensusInput, type ApplyEntityInputContext, type ApplyEntityInputResult } from './input-types';

import {
  hasVerifiedPreparedQuorum,
  selectPreparedFrameFromCertificate,
} from './leader-certificates';
import { entityLog } from './entity-log';
import { calculateQuorumPower } from './replica-validation';

const signAndBroadcastLocalVote = async (
  context: ApplyEntityInputContext,
  incoming: EntityLeaderTimeoutVote,
  voteHash: string,
): Promise<EntityLeaderTimeoutVote | null> => {
  const { env, entityInput, entityOutbox, workingReplica } = context;
  const voterId = incoming.voterId.toLowerCase();
  if (voterId !== workingReplica.signerId.toLowerCase() || incoming.signature) {
    return null;
  }
  const vote = {
    ...incoming,
    signature: await signAccountFrame(env, workingReplica.signerId, voteHash),
  };
  // The scheduler emits a local unsigned intent. Persist the signed protocol
  // value so WAL replay never depends on process-local authorization markers.
  context.canonicalAppliedInput = {
    ...entityInput,
    leaderTimeoutVote: cloneIsolatedEntityLeaderTimeoutVote(vote),
  };
  workingReplica.lastConsensusProgressAt = env.state.timestamp;
  for (const validatorId of workingReplica.state.config.validators) {
    if (validatorId.toLowerCase() === workingReplica.signerId.toLowerCase()) {
      continue;
    }
    entityOutbox.push({
      entityId: entityInput.entityId,
      signerId: validatorId,
      leaderTimeoutVote: vote,
    });
  }
  return vote;
};

const selectPreparedFrame = (
  context: ApplyEntityInputContext,
  certificate: ReturnType<typeof buildEntityLeaderCertificate>,
): ProposedEntityFrame | null => {
  const { env, workingReplica } = context;
  const localLockHasPreparedQuorum = workingReplica.lockedFrame
    ? hasVerifiedPreparedQuorum(env, workingReplica.state, workingReplica.lockedFrame, 'ENTITY_PREPARED_LOCAL_LOCK')
    : false;
  const preparedFrame = selectPreparedFrameFromCertificate(env, workingReplica.state, certificate);
  if (!preparedFrame && localLockHasPreparedQuorum && workingReplica.lockedFrame) {
    throw new Error(`ENTITY_PREPARED_LOCAL_LOCK_OMITTED:${workingReplica.lockedFrame.hash}`);
  }
  if (
    preparedFrame &&
    workingReplica.lockedFrame &&
    localLockHasPreparedQuorum &&
    workingReplica.lockedFrame.hash !== preparedFrame.hash &&
    workingReplica.lockedFrame.leader.view >= preparedFrame.leader.view
  ) {
    throw new Error(
      `ENTITY_PREPARED_LOCK_CONFLICT:local=${workingReplica.lockedFrame.hash}:` + `selected=${preparedFrame.hash}`,
    );
  }
  if (!preparedFrame && workingReplica.lockedFrame && !localLockHasPreparedQuorum) {
    // A sub-threshold local vote is not a QC and must not fence the newly
    // certified leader from proposing.
    delete workingReplica.lockedFrame;
    delete workingReplica.candidate;
  }
  return preparedFrame;
};

const installLeaderCertificate = (
  context: ApplyEntityInputContext,
  vote: EntityLeaderTimeoutVote,
): ApplyEntityInputResult | null => {
  const { env, workingReplica } = context;
  const votes = workingReplica.leaderVotes;
  if (!votes) return null;
  const signers = [...votes.keys()];
  const power = calculateQuorumPower(workingReplica.state.config, signers);
  if (power < workingReplica.state.config.threshold) return null;
  const certificate = buildEntityLeaderCertificate(vote, votes);
  let preparedFrame: ProposedEntityFrame | null;
  try {
    preparedFrame = selectPreparedFrame(context, certificate);
  } catch (error) {
    entityLog.error('leader.prepared_certificate_rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context, 'LEADER_PREPARED_CERTIFICATE_REJECTED');
  }
  if (preparedFrame) {
    certificate.preparedFrameHash = preparedFrame.hash;
    workingReplica.lockedFrame = {
      ...preparedFrame,
      leader: {
        ...preparedFrame.leader,
        relayCertificate: cloneIsolatedEntityLeaderCertificate(certificate),
      },
    };
    if (
      workingReplica.candidate &&
      (workingReplica.candidate.height !== preparedFrame.height ||
        workingReplica.candidate.frameHash.toLowerCase() !== preparedFrame.hash.toLowerCase())
    ) {
      delete workingReplica.candidate;
    }
  }
  workingReplica.pendingLeaderCertificate = certificate;
  workingReplica.lastConsensusProgressAt = env.state.timestamp;
  entityLog.warn('leader.view_change_certified', {
    entity: shortId(workingReplica.entityId),
    from: shortId(vote.previousLeaderId),
    to: shortId(vote.nextLeaderId),
    view: vote.toView,
    power: power.toString(),
  });
  return null;
};

export const handleLeaderTimeoutVote = async (
  context: ApplyEntityInputContext,
): Promise<ApplyEntityInputResult | null> => {
  const { env, entityInput, workingReplica } = context;
  const incoming = entityInput.leaderTimeoutVote;
  if (!incoming) return null;
  try {
    assertEntityLeaderVoteMatchesState(workingReplica.state, incoming);
  } catch (error) {
    entityLog.warn('leader.vote.rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return rejectEntityConsensusInput(context);
  }
  const voterId = incoming.voterId.toLowerCase();
  if (!workingReplica.state.config.validators.some(validator => validator.toLowerCase() === voterId)) {
    return rejectEntityConsensusInput(context);
  }
  const voteHash = hashEntityLeaderVoteBody(incoming);
  const vote = isLocalEntityLeaderTimeoutVote(incoming)
    ? await signAndBroadcastLocalVote(context, incoming, voteHash)
    : verifyAccountSignature(env, voterId, voteHash, incoming.signature)
      ? incoming
      : null;
  if (!vote) return rejectEntityConsensusInput(context);

  const collectionKey = leaderVoteCollectionKey(vote);
  const previous = workingReplica.leaderVotes?.values().next().value;
  if (previous && leaderVoteCollectionKey(previous) !== collectionKey) {
    workingReplica.leaderVotes = new Map();
  }
  if (!workingReplica.leaderVotes) workingReplica.leaderVotes = new Map();
  const previousVote = workingReplica.leaderVotes.get(voterId);
  if (previousVote) {
    if (encodeCanonicalConsensusValue(previousVote) !== encodeCanonicalConsensusValue(vote)) {
      entityLog.error('leader.vote_equivocation', { voter: shortId(voterId) });
      return rejectEntityConsensusInput(context, 'ENTITY_LEADER_VOTE_EQUIVOCATION');
    }
    return null;
  }
  workingReplica.leaderVotes.set(voterId, vote);
  return installLeaderCertificate(context, vote);
};
