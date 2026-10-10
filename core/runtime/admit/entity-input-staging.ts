import {
  collectCrossJurisdictionRemoteEntityHints,
  registerEntityRuntimeHintWithDeps,
} from '../delivery/topology/entity-routing.ts';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output/envelope';
import {
  accountInputAck,
  accountInputProposal,
} from '../../account/consensus/flush.ts';
import type { EntityReplica } from '../../entity/types.ts';
import type { RoutedEntityInput, RuntimeReplica } from '../types.ts';
import { commitEntityFrameCandidateState } from '../../entity/state-clone.ts';
import { getPerfMs } from '../../support/time.ts';
import { shortId } from '../../support/logger.ts';
import {
  assertExternalEntityInputAllowed,
  resolveEntityInputReplica,
} from './entity-input-admission.ts';
import {
  entityInputLog,
  isCommittedEntityInput,
  RuntimeEntityInputApplyError,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
  type RuntimeEntityInputBatchContext,
} from './entity-input-contract.ts';
import {
  applyEntityInputToReplica,
  type AppliedEntityReplicaInput,
} from './entity-input-replica.ts';
import {
  collectCommittedEntityResult,
  recordEntityInputProfile,
} from './entity-input-output.ts';
import { cacheCommittedAccountJClaimNodeChanges } from '../../entity/account/account-j-claim-node-store';
import {
  collectRuntimeEntityContext,
  describeEntityInputCommitShape,
} from './entity-context-collection';
import {
  acceptAuthorityEntityStage,
  discardAuthorityEntityStage,
} from '../../rscore/authority-driver.ts';

export const collectCommittedAccountFrames = (
  input: RoutedEntityInput,
  replica: EntityReplica,
): RuntimeEntityInputApplyResult['inputOutcomes'][number]['committedAccountFrames'] => {
  const accountInputs = getEffectiveEntityInputTxs(input).flatMap(tx =>
    tx.type === 'accountInput' &&
    (accountInputProposal(tx.data) || accountInputAck(tx.data))
      ? [tx.data]
      : [],
  );
  return accountInputs.flatMap(accountInput => {
    const counterpartyEntityId = accountInput.fromEntityId.toLowerCase();
    const account = replica.state.accounts.get(counterpartyEntityId);
    if (!account) return [];
    const height = account.currentFrame.height;
    const stateHash = String(account.currentFrame.stateHash || '').toLowerCase();
    const proposal = accountInputProposal(accountInput);
    const ack = accountInputAck(accountInput);
    const proposalCommitted =
      proposal?.frame.height === height &&
      String(proposal.frame.stateHash || '').toLowerCase() === stateHash;
    const ackCommitted =
      ack &&
      ((ack.height === height &&
        String(ack.frameHash || '').toLowerCase() === stateHash) ||
        (proposalCommitted &&
          proposal.frame.height === ack.height + 1 &&
          String(proposal.frame.prevFrameHash || '').toLowerCase() ===
            String(ack.frameHash || '').toLowerCase()));
    return [
      ...(ackCommitted
        ? [{
            counterpartyEntityId,
            height: ack.height,
            stateHash: String(ack.frameHash || '').toLowerCase(),
          }]
        : []),
      ...(proposalCommitted
        ? [{
            counterpartyEntityId,
            height: proposal.frame.height,
            stateHash: String(proposal.frame.stateHash || '').toLowerCase(),
          }]
        : []),
    ];
  });
};

export type StagedEntityInput = {
  input: RoutedEntityInput;
  inputIndex: number;
  signerId: string;
  replicaKey: string;
  result: AppliedEntityReplicaInput;
  elapsedMs: number;
};

export const publishStagedEntityNodeChanges = (
  env: RuntimeReplica,
  stagedInputs: readonly StagedEntityInput[],
): void => {
  for (const { result } of stagedInputs) {
    if (!isCommittedEntityInput(result.outcome)) {
      if (result.accountJClaimNodeChanges) {
        throw new Error('ENTITY_REJECTED_INPUT_NODE_CHANGES_FORBIDDEN');
      }
      continue;
    }
    cacheCommittedAccountJClaimNodeChanges(env, result.accountJClaimNodeChanges);
  }
};

export const stageExternalEntityInput = async (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  inputIndex: number,
  options: RuntimeEntityInputApplyOptions,
  promoteCandidateState: boolean,
  deferProposal = false,
  requiredEntityTxIndex?: number,
): Promise<StagedEntityInput> => {
  const startedAt = getPerfMs();
  if (options.isReplay) {
    entityInputLog.debug('replay.merged_input', {
      entity: shortId(input.entityId, 8),
      signer: shortId(input.signerId ?? '', 8),
      txs: input.entityTxs?.length ?? 0,
      types: (input.entityTxs ?? []).map(tx => tx.type),
    });
  }
  let resolved: ReturnType<typeof resolveEntityInputReplica>;
  try {
    assertExternalEntityInputAllowed(input);
    resolved = resolveEntityInputReplica(env, input);
  } catch (error) {
    // Admission precedes mutation; provenance identifies the rejected lane.
    throw new RuntimeEntityInputApplyError(
      input,
      false,
      error,
      'unroutable-ingress',
    );
  }
  const { signerId, replicaKey, replica } = resolved;
  // A deferred input can only append transactions to the isolated Entity
  // mempool; by contract it cannot publish an Entity frame. Refreshing the
  // certified checkpoint lineage here used to hash the complete Hub Entity
  // once per AccountInput (3059 times in a 37-R-frame HLT tail). The batch's
  // single non-deferred flush performs the one required refresh immediately
  // before the actual E-frame transition.
  if (!deferProposal) options.beforeEntityApply?.(input.entityId);
  const result = await applyEntityInputToReplica(
    env,
    replica,
    replicaKey,
    input,
    signerId,
    options.isReplay,
    promoteCandidateState,
    undefined,
    deferProposal,
    requiredEntityTxIndex,
    { kind: 'runtime-input', inputIndex },
  );
  return {
    input,
    inputIndex,
    signerId,
    replicaKey,
    result,
    elapsedMs: Math.round(getPerfMs() - startedAt),
  };
};

/**
 * A raw accountInput's fromEntityId is unverified until its frame Hanko checks
 * out, so an Account route is learned only from a frame the Entity committed.
 * A deferred proposal commits at the batch flush, which calls this again.
 */
export const registerCommittedAccountRoutes = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  committedAccountFrames: RuntimeEntityInputApplyResult['inputOutcomes'][number]['committedAccountFrames'],
  options: RuntimeEntityInputApplyOptions,
): void => {
  if (!input.from) return;
  for (const { counterpartyEntityId } of committedAccountFrames) {
    registerEntityRuntimeHintWithDeps(env, counterpartyEntityId, input.from, options.routingDeps);
  }
};

const registerCommittedInputRoutes = (
  env: RuntimeReplica,
  staged: StagedEntityInput,
  committedAccountFrames: RuntimeEntityInputApplyResult['inputOutcomes'][number]['committedAccountFrames'],
  options: RuntimeEntityInputApplyOptions,
): void => {
  if (!isCommittedEntityInput(staged.result.outcome) || !staged.input.from) {
    return;
  }
  registerCommittedAccountRoutes(env, staged.input, committedAccountFrames, options);
  const crossJurisdictionHints = collectCrossJurisdictionRemoteEntityHints(
    env,
    staged.input,
    staged.input.from,
    options.routingDeps,
  );
  for (const entityId of new Set(crossJurisdictionHints)) {
    registerEntityRuntimeHintWithDeps(
      env,
      entityId,
      staged.input.from,
      options.routingDeps,
    );
  }
};

export const collectStagedEntityInput = (
  env: RuntimeReplica,
  staged: StagedEntityInput,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): void => {
  const { input, inputIndex, signerId, replicaKey, result, elapsedMs } = staged;
  if (result.entityContext) {
    collectRuntimeEntityContext(
      context.entityContexts,
      input.entityId,
      replicaKey,
      result.entityContext,
      describeEntityInputCommitShape(input),
      context.entityCommitInputShapes,
    );
  }
  const committedAccountFrames = isCommittedEntityInput(result.outcome)
    ? collectCommittedAccountFrames(input, result.nextReplica)
    : [];
  context.inputOutcomes.push({
    inputIndex,
    outcome: result.outcome,
    entityFrameCommitted: result.entityFrameCommitted,
    committedAccountFrames,
  });
  context.entityFrameCommitted ||= result.entityFrameCommitted;
  registerCommittedInputRoutes(env, staged, committedAccountFrames, options);
  context.externalApplyMs += elapsedMs;
  recordEntityInputProfile(context, input, signerId, elapsedMs, result);
  if (isCommittedEntityInput(result.outcome)) {
    context.appliedEntityInputs.push(result.appliedInput);
  }
  collectCommittedEntityResult(env, replicaKey, result, context);
};

export const settleStagedAuthority = async (
  env: RuntimeReplica,
  staged: StagedEntityInput,
  accept: boolean,
): Promise<void> => {
  if (accept) {
    await acceptAuthorityEntityStage(env, staged.result.authorityStage);
  } else {
    await discardAuthorityEntityStage(env, staged.result.authorityStage);
  }
};

export const applyExternalEntityInput = async (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  inputIndex: number,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
  deferProposal = false,
): Promise<StagedEntityInput> => {
  if (env.infrastructure) env.infrastructure.runtimeFramePhase = 'apply.entity.stage';
  const staged = await stageExternalEntityInput(
    env,
    input,
    inputIndex,
    options,
    false,
    deferProposal,
  );
  if (isCommittedEntityInput(staged.result.outcome)) {
    // Local commands and remote bytes share one isolated candidate boundary.
    // Expected rejection cannot partially mutate the Runtime-owned Entity State.
    if (env.infrastructure) env.infrastructure.runtimeFramePhase = 'apply.entity.commit-root';
    commitEntityFrameCandidateState(staged.result.nextReplica.state);
  }
  if (env.infrastructure) env.infrastructure.runtimeFramePhase = 'apply.entity.authority-settle';
  await settleStagedAuthority(
    env,
    staged,
    isCommittedEntityInput(staged.result.outcome),
  );
  if (env.infrastructure) env.infrastructure.runtimeFramePhase = 'apply.entity.collect';
  collectStagedEntityInput(env, staged, options, context);
  publishStagedEntityNodeChanges(env, [staged]);
  return staged;
};

/**
 * Reject a typed command/frame error after isolated Entity application.
 *
 * The candidate has no live State or node-cache ownership, so a malformed
 * local command is no more fatal than malformed peer bytes. Storage failures,
 * reducer invariants, and unknown bugs retain their distinct fatal classes.
 *
 * Scenarios take this same path: the Runtime loop applies the reject policy
 * (fail-fast or log-and-drop) once per frame from the recorded outcome, so a
 * scenario never needs a private halt branch here. Replay never rejects: a
 * rejected input has no WAL row, so meeting one in replay must surface.
 */
export const rejectMalformedEntityInput = (
  _env: RuntimeReplica,
  error: unknown,
  inputIndex: number,
  context: RuntimeEntityInputBatchContext,
  options: RuntimeEntityInputApplyOptions,
): boolean => {
  if (
    options.isReplay ||
    !(error instanceof RuntimeEntityInputApplyError) ||
    (error.failureKind !== 'malformed-ingress' &&
      error.failureKind !== 'unroutable-ingress')
  ) {
    return false;
  }
  context.inputOutcomes.push({
    inputIndex,
    outcome: { kind: 'rejected', code: error.rejectionCode },
    entityFrameCommitted: false,
    committedAccountFrames: [],
  });
  // Rejected financial ingress has no committed WAL row; WARN log thresholds
  // must still retain the exact input position and classification evidence.
  entityInputLog.error(
    error.isRemoteIngress ? 'entity_input.discarded' : 'entity_input.rejected',
    {
      entityId: error.entityId,
      signerId: error.signerId,
      sourceRuntimeId: error.sourceRuntimeId,
      sourceRuntimeHeight: error.sourceRuntimeHeight,
      inputIndex,
      rejectionCode: error.rejectionCode,
      cause:
        error.cause instanceof Error
          ? error.cause.message
          : String(error.cause),
    },
  );
  return true;
};
