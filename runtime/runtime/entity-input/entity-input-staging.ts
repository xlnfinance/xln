import {
  collectCrossJurisdictionRemoteEntityHints,
  registerEntityRuntimeHintWithDeps,
} from '../routing/entity-routing.ts';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output/envelope';
import {
  accountInputAck,
  accountInputProposal,
} from '../../account/consensus/flush.ts';
import type { EntityReplica } from '../../entity/types.ts';
import type { RoutedEntityInput, RuntimeReplica } from '../types.ts';
import { commitEntityFrameCandidateState } from '../../entity/state-clone.ts';
import { getPerfMs } from '../../infra/time.ts';
import { shortId } from '../../infra/logger.ts';
import {
  assertExternalEntityInputAllowed,
  collectAppliedAccountSenderHints,
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
import { cacheCommittedConsumptionNodeChanges } from '../../entity/consumption/consumption-store';
import { cacheCommittedAccountJClaimNodeChanges } from '../../entity/account/account-j-claim-node-store';
import { collectRuntimeEntityContext } from './entity-context-collection';

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
    const account = [...replica.state.accounts.entries()].find(
      ([entityId]) => entityId.toLowerCase() === counterpartyEntityId,
    )?.[1];
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
      if (result.consumptionNodeChanges || result.accountJClaimNodeChanges) {
        throw new Error('ENTITY_REJECTED_INPUT_NODE_CHANGES_FORBIDDEN');
      }
      continue;
    }
    cacheCommittedConsumptionNodeChanges(env, result.consumptionNodeChanges);
    cacheCommittedAccountJClaimNodeChanges(env, result.accountJClaimNodeChanges);
  }
};

export const stageExternalEntityInput = async (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  inputIndex: number,
  options: RuntimeEntityInputApplyOptions,
  promoteCandidateState: boolean,
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
  options.beforeEntityApply?.(input.entityId);
  const result = await applyEntityInputToReplica(
    env,
    replica,
    replicaKey,
    input,
    signerId,
    options.isReplay,
    promoteCandidateState,
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

const registerCommittedInputRoutes = (
  env: RuntimeReplica,
  staged: StagedEntityInput,
  options: RuntimeEntityInputApplyOptions,
): void => {
  if (!isCommittedEntityInput(staged.result.outcome) || !staged.input.from) {
    return;
  }
  const hints = new Set([
    ...collectAppliedAccountSenderHints(staged.input),
    ...collectCrossJurisdictionRemoteEntityHints(
      env,
      staged.input,
      staged.input.from,
      options.routingDeps,
    ),
  ]);
  for (const entityId of hints) {
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
  if (result.entityContext && !result.entityFrameCommitted) {
    throw new Error(`RUNTIME_ENTITY_CONTEXT_WITHOUT_COMMITTED_FRAME:${replicaKey}`);
  }
  if (result.entityFrameCommitted && result.entityContext) {
    collectRuntimeEntityContext(context.entityContexts, input.entityId, replicaKey, result.entityContext);
  }
  context.inputOutcomes.push({
    inputIndex,
    outcome: result.outcome,
    entityFrameCommitted: result.entityFrameCommitted,
    committedAccountFrames: isCommittedEntityInput(result.outcome)
      ? collectCommittedAccountFrames(input, result.nextReplica)
      : [],
  });
  context.entityFrameCommitted ||= result.entityFrameCommitted;
  registerCommittedInputRoutes(env, staged, options);
  context.externalApplyMs += elapsedMs;
  recordEntityInputProfile(context, input, signerId, elapsedMs, result);
  if (isCommittedEntityInput(result.outcome)) {
    context.appliedEntityInputs.push(result.appliedInput);
  }
  collectCommittedEntityResult(env, replicaKey, result, context);
};

export const applyExternalEntityInput = async (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  inputIndex: number,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): Promise<void> => {
  const staged = await stageExternalEntityInput(
    env,
    input,
    inputIndex,
    options,
    false,
  );
  if (isCommittedEntityInput(staged.result.outcome)) {
    // Local commands and remote bytes share one isolated candidate boundary.
    // Expected rejection cannot partially mutate the Runtime-owned Entity State.
    commitEntityFrameCandidateState(staged.result.nextReplica.state);
  }
  collectStagedEntityInput(env, staged, options, context);
  publishStagedEntityNodeChanges(env, [staged]);
};

/**
 * Reject a typed command/frame error after isolated Entity application.
 *
 * The candidate has no live State or node-cache ownership, so a malformed
 * local command is no more fatal than malformed peer bytes. Storage failures,
 * reducer invariants, and unknown bugs retain their distinct fatal classes.
 */
export const rejectMalformedEntityInput = (
  env: RuntimeReplica,
  error: unknown,
  inputIndex: number,
  context: RuntimeEntityInputBatchContext,
  options: RuntimeEntityInputApplyOptions,
): boolean => {
  if (
    env.scenarioMode ||
    options.isReplay ||
    !(error instanceof RuntimeEntityInputApplyError) ||
    error.failureKind !== 'malformed-ingress'
  ) {
    return false;
  }
  context.inputOutcomes.push({
    inputIndex,
    outcome: { kind: 'rejected', code: error.failureKind },
    entityFrameCommitted: false,
    committedAccountFrames: [],
  });
  entityInputLog.info(
    error.isRemoteIngress ? 'entity_input.discarded' : 'entity_input.rejected',
    {
      entityId: error.entityId,
      signerId: error.signerId,
      sourceRuntimeId: error.sourceRuntimeId,
      cause:
        error.cause instanceof Error
          ? error.cause.message
          : String(error.cause),
    },
  );
  return true;
};
