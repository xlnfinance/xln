import {
  collectCrossJurisdictionRemoteEntityHints,
  registerEntityRuntimeHintWithDeps,
} from './entity-routing';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import {
  accountInputAck,
  accountInputProposal,
} from '../account/consensus/flush';
import type { EntityReplica } from '../entity/types';
import type { RoutedEntityInput, RuntimeState } from '../types';
import { commitEntityFrameCandidateState } from '../entity/state-clone';
import { getPerfMs } from '../infra/time';
import { shortId } from '../infra/logger';
import {
  assertExternalEntityInputAllowed,
  collectAppliedAccountSenderHints,
  resolveEntityInputReplica,
} from './entity-input-admission';
import {
  entityInputLog,
  isCommittedEntityInput,
  RuntimeEntityInputApplyError,
  type RuntimeEntityInputApplyOptions,
  type RuntimeEntityInputApplyResult,
  type RuntimeEntityInputBatchContext,
} from './entity-input-contract';
import {
  applyEntityInputToReplica,
  type AppliedEntityReplicaInput,
} from './entity-input-replica';
import {
  collectCommittedEntityResult,
  recordEntityInputProfile,
} from './entity-input-output';

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

export const stageExternalEntityInput = async (
  env: RuntimeState,
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
  env: RuntimeState,
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
  env: RuntimeState,
  staged: StagedEntityInput,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): void => {
  const { input, inputIndex, signerId, replicaKey, result, elapsedMs } = staged;
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
  env: RuntimeState,
  input: RoutedEntityInput,
  inputIndex: number,
  options: RuntimeEntityInputApplyOptions,
  context: RuntimeEntityInputBatchContext,
): Promise<void> => {
  const remote = Boolean(input.from);
  const staged = await stageExternalEntityInput(
    env,
    input,
    inputIndex,
    options,
    !remote,
  );
  if (remote && isCommittedEntityInput(staged.result.outcome)) {
    // Remote bytes stay detached until the whole transition succeeds.
    commitEntityFrameCandidateState(staged.result.nextReplica.state);
  }
  collectStagedEntityInput(env, staged, options, context);
};

export const discardMalformedRemoteEntityInput = (
  env: RuntimeState,
  error: unknown,
  inputIndex: number,
  context: RuntimeEntityInputBatchContext,
  options: RuntimeEntityInputApplyOptions,
): boolean => {
  if (
    env.scenarioMode ||
    options.isReplay ||
    !(error instanceof RuntimeEntityInputApplyError) ||
    !error.isDiscardableIngress
  ) {
    return false;
  }
  context.inputOutcomes.push({
    inputIndex,
    outcome: { kind: 'rejected', code: error.failureKind },
    entityFrameCommitted: false,
    committedAccountFrames: [],
  });
  entityInputLog.info('entity_input.discarded', {
    entityId: error.entityId,
    signerId: error.signerId,
    sourceRuntimeId: error.sourceRuntimeId,
    cause:
      error.cause instanceof Error
        ? error.cause.message
        : String(error.cause),
  });
  return true;
};
