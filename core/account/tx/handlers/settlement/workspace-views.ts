import type { HankoString } from '../../../../types/hanko';
import type { SettlementWorkspace } from '../../../../types/account';

type CompletePostSettlementProof = NonNullable<
  SettlementWorkspace['postSettlementDisputeProof']
> & {
  leftHanko: HankoString;
  rightHanko: HankoString;
};

type PinnedSettlementWorkspace = SettlementWorkspace & {
  compiledDiffs: NonNullable<SettlementWorkspace['compiledDiffs']>;
  compiledForgiveTokenIds: NonNullable<SettlementWorkspace['compiledForgiveTokenIds']>;
  settlementHash: string;
  nonceAtSign: number;
  postSettlementDisputeProof: NonNullable<SettlementWorkspace['postSettlementDisputeProof']>;
};

export type UnsignedSettlementWorkspace = SettlementWorkspace & {
  status: 'draft' | 'awaiting_counterparty';
  compiledDiffs?: never;
  compiledForgiveTokenIds?: never;
  leftHanko?: never;
  rightHanko?: never;
  settlementHash?: never;
  nonceAtSign?: never;
  postSettlementDisputeProof?: never;
};

export type SealingSettlementWorkspace = PinnedSettlementWorkspace & {
  status: 'awaiting_counterparty';
};

type ReadySettlementWorkspaceBase = PinnedSettlementWorkspace & {
  status: 'ready_to_submit';
  postSettlementDisputeProof: CompletePostSettlementProof;
};

export type ReadySettlementWorkspace =
  | (ReadySettlementWorkspaceBase & {
      executorIsLeft: true;
      leftHanko?: never;
      rightHanko: HankoString;
    })
  | (ReadySettlementWorkspaceBase & {
      executorIsLeft: false;
      leftHanko: HankoString;
      rightHanko?: never;
    });

export type SubmittedSettlementWorkspace = Omit<
  ReadySettlementWorkspace,
  'status'
> & { status: 'submitted' };

export type ValidSettlementWorkspacePhase =
  | UnsignedSettlementWorkspace
  | SealingSettlementWorkspace
  | ReadySettlementWorkspace
  | SubmittedSettlementWorkspace;

const hasText = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

const hasPinnedBody = (workspace: SettlementWorkspace): workspace is PinnedSettlementWorkspace =>
  Array.isArray(workspace.compiledDiffs)
    && Array.isArray(workspace.compiledForgiveTokenIds)
    && hasText(workspace.settlementHash)
    && Number.isSafeInteger(workspace.nonceAtSign)
    && workspace.nonceAtSign! > 0
    && workspace.postSettlementDisputeProof !== undefined;

export const isUnsignedSettlementWorkspace = (
  workspace: SettlementWorkspace,
): workspace is UnsignedSettlementWorkspace => (
  workspace.status === 'draft' || workspace.status === 'awaiting_counterparty'
) && workspace.compiledDiffs === undefined
  && workspace.compiledForgiveTokenIds === undefined
  && workspace.leftHanko === undefined
  && workspace.rightHanko === undefined
  && workspace.settlementHash === undefined
  && workspace.nonceAtSign === undefined
  && workspace.postSettlementDisputeProof === undefined;

export const isSealingSettlementWorkspace = (
  workspace: SettlementWorkspace,
): workspace is SealingSettlementWorkspace => workspace.status === 'awaiting_counterparty'
  && hasPinnedBody(workspace)
  && (
    hasText(workspace.postSettlementDisputeProof.leftHanko)
    || hasText(workspace.postSettlementDisputeProof.rightHanko)
  );

const hasCompletePostProof = (
  workspace: PinnedSettlementWorkspace,
): workspace is PinnedSettlementWorkspace & {
  postSettlementDisputeProof: CompletePostSettlementProof;
} => hasText(workspace.postSettlementDisputeProof.leftHanko)
  && hasText(workspace.postSettlementDisputeProof.rightHanko);

const hasExactNonExecutorHanko = (workspace: SettlementWorkspace): boolean =>
  workspace.executorIsLeft
    ? workspace.leftHanko === undefined && hasText(workspace.rightHanko)
    : hasText(workspace.leftHanko) && workspace.rightHanko === undefined;

export const isReadySettlementWorkspace = (
  workspace: SettlementWorkspace,
): workspace is ReadySettlementWorkspace => workspace.status === 'ready_to_submit'
  && hasPinnedBody(workspace)
  && hasCompletePostProof(workspace)
  && hasExactNonExecutorHanko(workspace);

export const isSubmittedSettlementWorkspace = (
  workspace: SettlementWorkspace,
): workspace is SubmittedSettlementWorkspace => workspace.status === 'submitted'
  && hasPinnedBody(workspace)
  && hasCompletePostProof(workspace)
  && hasExactNonExecutorHanko(workspace);

export const assertSettlementWorkspacePhase = (
  workspace: SettlementWorkspace,
  context: string,
): ValidSettlementWorkspacePhase => {
  if (
    isUnsignedSettlementWorkspace(workspace)
    || isSealingSettlementWorkspace(workspace)
    || isReadySettlementWorkspace(workspace)
    || isSubmittedSettlementWorkspace(workspace)
  ) return workspace;
  throw new Error(`${context}_PHASE_INVALID:${workspace.status}`);
};
