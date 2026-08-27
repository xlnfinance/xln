import type { AccountPeerInput, AccountFrame, AccountTx } from '../../../types/account';
import type { EntityInput, EntityReplica } from '../../../entity/types';
import type { RuntimeReplica, RoutedEntityInput, RuntimeEntityInputsEnvelope, RuntimeTx } from '../../types';
import type { JInput } from '../../../jurisdiction/machine/input';
import type { EntityTx } from '../../../types/entity-tx';
import type { Profile } from '../../../entity/profile';
import type { RuntimeOutputRoutingDeps } from './output-routing';
import { extractCrossJurisdictionRouteFromTx } from '../../../extensions/cross-j/boundary';
import { getEffectiveEntityInputTxs } from '../../../entity/consensus/output/envelope';
import { normalizeRuntimeId } from '../../../network/p2p/auth/runtime-id';
import { advanceEntityCommandNonce, assertSignedEntityCommand } from '../../../entity/command';
import { validateDeliverableEntityInput } from './routing-validation';
import { accountInputAck, accountInputProposal } from '../../../account/consensus/flush';
import { safeStringify } from '../../../protocol/serialization';
import { cloneCrossJurisdictionRoute } from '../../../extensions/cross-j';
import { validatePreparedCrossJurisdictionRoute } from '../../../extensions/cross-j/prepared-route';
import { assertRuntimeEntityInputsEnvelopeSource } from '../../admit/entity-input-envelope-auth.ts';
import { traceAccountDeliveryHop } from '../../../support/performance/account-delivery-trace';
import { assertInboundCrossJRuntimeTopology } from './cross-j-topology.ts';

type RuntimeLifecycleState = NonNullable<RuntimeReplica['infrastructure']>;

export type RuntimeInboundEntityInputOptions = {
  /** The transport accepted this exact input before persistence quiescing began. */
  acceptedBeforeQuiesce?: boolean;
  /** Caller already verified envelope sourceSignature for this transport `from`. */
  envelopeSourceVerified?: boolean;
  /** Caller already ran validateDeliverableEntityInput on every envelope input. */
  entityInputsValidated?: boolean;
};

export type RuntimeEntityRoutingDeps = {
  ensureRuntimeInfrastructure(env: RuntimeReplica): RuntimeLifecycleState;
  enqueueRuntimeInputs(
    env: RuntimeReplica,
    inputs?: EntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: JInput[],
    ingressTimestamp?: number,
    options?: RuntimeInboundEntityInputOptions,
  ): void;
  extractEntityId(replicaKey: string): string;
  hasLocalSignerForEntity(env: RuntimeReplica, entityId: string): boolean;
  hasLocalSignerForEntitySigner(env: RuntimeReplica, entityId: string, signerId: string): boolean;
  resolveSoleLocalSignerForEntity(env: RuntimeReplica, entityId: string): string | null;
  getP2P: RuntimeOutputRoutingDeps['getP2P'];
};

export type RuntimeInboundEntityInputResult =
  | { kind: 'queued' }
  | { kind: 'ignored' };

export type RuntimeInboundEntityInputsResult = {
  kind: 'queued' | 'ignored';
  queuedInputs: RoutedEntityInput[];
};

type RuntimeInboundEntityInputValidation =
  | { kind: 'accepted' }
  | { kind: 'ignored' };

export const normalizeEntityKey = (value: string): string => String(value || '').toLowerCase();
const RUNTIME_HINT_TTL_MS = 60_000;

type CrossJAdmissionCandidate = {
  inputIndex: number;
  routeKeys: string[];
  pairKey: string;
  phase: 'proposal' | 'ack';
  leg: 'source' | 'target';
  accountInput: AccountPeerInput;
  frame: AccountFrame;
  pulls: Array<Extract<AccountTx, { type: 'cross_pull_lock' }>>;
  alreadyCommitted: boolean;
};

const admissionKey = (orderId: string, routeHash: string): string =>
  `${String(orderId || '').trim()}\u0000${String(routeHash || '').trim().toLowerCase()}`;

const admissionOriginKey = (input: RoutedEntityInput): string => {
  if (!input.from) return 'local';
  const runtimeId = normalizeRuntimeId(input.from);
  return runtimeId ? `remote:${runtimeId}` : 'remote:missing';
};

// This key crosses the runtime boundary inside the atomic envelope. Transport
// provenance is deliberately checked beside it, not encoded into it: the same
// cohort is "local" at the sender and "remote:<sender>" at the receiver.
const admissionPairKey = (_input: RoutedEntityInput, routeKeys: readonly string[]): string =>
  [...routeKeys].sort().join('\u0001');

const exactAdmissionPairKey = (
  input: RoutedEntityInput,
  routeKeys: readonly string[],
  phase: CrossJAdmissionCandidate['phase'],
): string => `${phase}\u0000${admissionPairKey(input, routeKeys)}`;

const sameSourceRuntimeFrame = (
  source: RoutedEntityInput,
  target: RoutedEntityInput,
): boolean => {
  const sourceFrame = source.sourceRuntimeFrame;
  const targetFrame = target.sourceRuntimeFrame;
  if (!sourceFrame || !targetFrame) return true;
  return sourceFrame.height === targetFrame.height &&
    sourceFrame.timestamp === targetFrame.timestamp;
};

const targetsDistinctSiblingEntities = (
  inputs: readonly RoutedEntityInput[],
  leftIndex: number,
  rightIndex: number,
): boolean => normalizeEntityKey(inputs[leftIndex]!.entityId) !==
  normalizeEntityKey(inputs[rightIndex]!.entityId);

const crossPulls = (
  accountTxs: readonly AccountTx[],
  leg: 'source' | 'target',
): Array<Extract<AccountTx, { type: 'cross_pull_lock' }>> =>
  accountTxs.filter((tx): tx is Extract<AccountTx, { type: 'cross_pull_lock' }> =>
    tx.type === 'cross_pull_lock' && tx.data.crossJurisdiction?.leg === leg);

type CrossJCloseTx = Extract<AccountTx, { type: 'cross_pull_close' }>;
type CrossJFillAckTx = Extract<AccountTx, { type: 'cross_swap_fill_ack' }>;
type CrossJPullProgressTx = Extract<AccountTx, { type: 'cross_pull_progress' }>;

const crossCloses = (
  accountTxs: readonly AccountTx[],
  leg: 'source' | 'target',
): CrossJCloseTx[] => accountTxs.filter((tx): tx is CrossJCloseTx => {
  if (tx.type !== 'cross_pull_close') return false;
  return tx.data.pullId === (
    leg === 'source'
      ? tx.data.proof.sourcePullId
      : tx.data.proof.targetPullId
  );
});

const crossCloseKey = (tx: CrossJCloseTx): string => safeStringify({
  operation: 'close',
  orderId: tx.data.proof.orderId,
  routeHash: String(tx.data.proof.routeHash || '').toLowerCase(),
  sourcePullId: tx.data.proof.sourcePullId,
  targetPullId: tx.data.proof.targetPullId,
  fillRatio: tx.data.proof.fillRatio,
  cumulativeSourceAmount: tx.data.proof.cumulativeSourceAmount,
  cumulativeTargetAmount: tx.data.proof.cumulativeTargetAmount,
  binaryHash: String(tx.data.proof.binaryHash || '').toLowerCase(),
  closeMode: tx.data.proof.closeMode,
  binary: tx.data.binary,
});

const crossProgressKey = (fill: CrossJFillAckTx['data']): string => safeStringify({
  operation: 'progress',
  offerId: fill.offerId,
  routeHash: String(fill.routeHash || '').toLowerCase(),
  previousFillSeq: fill.previousFillSeq,
  fillSeq: fill.fillSeq,
  incrementalSourceAmount: fill.incrementalSourceAmount,
  incrementalTargetAmount: fill.incrementalTargetAmount,
  cumulativeSourceAmount: fill.cumulativeSourceAmount,
  cumulativeTargetAmount: fill.cumulativeTargetAmount,
  cumulativeFillRatio: fill.cumulativeFillRatio,
  fillNumerator: fill.fillNumerator,
  fillDenominator: fill.fillDenominator,
  ackKind: fill.ackKind,
  executionSourceAmount: fill.executionSourceAmount,
  executionTargetAmount: fill.executionTargetAmount,
  priceImprovementMode: fill.priceImprovementMode,
  priceImprovementAmount: fill.priceImprovementAmount,
  priceImprovementTokenId: fill.priceImprovementTokenId,
  cancelRemainder: fill.cancelRemainder,
  comment: fill.comment,
  priceTicks: fill.priceTicks,
  pairId: fill.pairId,
});

const sourceProgresses = (accountTxs: readonly AccountTx[]): CrossJFillAckTx[] =>
  accountTxs.filter((tx): tx is CrossJFillAckTx => tx.type === 'cross_swap_fill_ack');

const targetProgresses = (accountTxs: readonly AccountTx[]): CrossJPullProgressTx[] =>
  accountTxs.filter((tx): tx is CrossJPullProgressTx => tx.type === 'cross_pull_progress');

const pairedProgressListsMatch = (
  source: readonly CrossJFillAckTx[],
  target: readonly CrossJPullProgressTx[],
): boolean => source.length === target.length && source.every(sourceTx =>
  target.filter(targetTx => crossProgressKey(targetTx.data.fill) === crossProgressKey(sourceTx.data)).length === 1);

const effectiveAccountInputs = (input: RoutedEntityInput): AccountPeerInput[] =>
  getEffectiveEntityInputTxs(input).flatMap(tx => tx.type === 'accountInput' ? [tx.data] : []);

const sourceAdmissionCandidate = (
  input: RoutedEntityInput,
  inputIndex: number,
  accountInput: AccountPeerInput,
): CrossJAdmissionCandidate | null => {
  const proposal = accountInputProposal(accountInput);
  if (!proposal) return null;
  const pulls = crossPulls(proposal.frame.accountTxs, 'source');
  if (pulls.length === 0) return null;
  const bindings = pulls.map(pull => pull.data.crossJurisdiction!);
  const routeKeys = bindings.map(binding => admissionKey(binding.orderId, binding.routeHash));
  if (new Set(routeKeys).size !== routeKeys.length) return null;
  const everyPullHasOffer = bindings.every(binding => proposal.frame.accountTxs.some(tx =>
    tx.type === 'swap_offer' &&
    tx.data.crossJurisdiction?.orderId === binding.orderId &&
    String(tx.data.crossJurisdiction?.routeHash || '').toLowerCase() ===
      String(binding.routeHash || '').toLowerCase()));
  if (!everyPullHasOffer) return null;
  return {
    inputIndex,
    routeKeys,
    pairKey: exactAdmissionPairKey(input, routeKeys, 'proposal'),
    phase: 'proposal',
    leg: 'source',
    accountInput,
    frame: proposal.frame,
    pulls,
    alreadyCommitted: false,
  };
};

const findInputReplica = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
): EntityReplica | null =>
  env.state.eReplicas.get(
    `${normalizeEntityKey(input.entityId)}:${normalizeEntityKey(input.signerId)}`,
  ) ?? null;

const findReplicaAccount = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  counterpartyId: string,
) => {
  const replica = findInputReplica(env, input);
  if (!replica) return null;
  return replica.state.accounts.get(normalizeEntityKey(counterpartyId)) ?? null;
};

const proposalAlreadyCommitted = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  accountInput: AccountPeerInput,
): boolean => {
  const proposal = accountInputProposal(accountInput);
  if (!proposal) return false;
  const account = findReplicaAccount(env, input, accountInput.fromEntityId);
  return account?.currentFrame.height === proposal.frame.height &&
    String(account.currentFrame.stateHash || '').toLowerCase() ===
      String(proposal.frame.stateHash || '').toLowerCase();
};

const targetProposalCandidate = (
  input: RoutedEntityInput,
  inputIndex: number,
  accountInput: AccountPeerInput,
): CrossJAdmissionCandidate | null => {
  const proposal = accountInputProposal(accountInput);
  if (!proposal) return null;
  const pulls = crossPulls(proposal.frame.accountTxs, 'target');
  if (pulls.length === 0) return null;
  const bindings = pulls.map(pull => pull.data.crossJurisdiction!);
  const routeKeys = bindings.map(binding => admissionKey(binding.orderId, binding.routeHash));
  if (new Set(routeKeys).size !== routeKeys.length) return null;
  return {
    inputIndex,
    routeKeys,
    pairKey: exactAdmissionPairKey(input, routeKeys, 'proposal'),
    phase: 'proposal',
    leg: 'target',
    accountInput,
    frame: proposal.frame,
    pulls,
    alreadyCommitted: false,
  };
};

const routeForCrossJPull = (
  pull: Extract<AccountTx, { type: 'cross_pull_lock' }>,
): NonNullable<Extract<AccountTx, { type: 'cross_pull_lock' }>['data']['crossJurisdictionRoute']> | null =>
  pull.data.crossJurisdictionRoute ?? null;

const pairedPullListsMatch = (
  sourcePulls: readonly Extract<AccountTx, { type: 'cross_pull_lock' }>[],
  targetPulls: readonly Extract<AccountTx, { type: 'cross_pull_lock' }>[],
): boolean => {
  if (sourcePulls.length !== targetPulls.length) return false;
  for (const sourcePull of sourcePulls) {
    const sourceBinding = sourcePull.data.crossJurisdiction;
    const sourceRoute = routeForCrossJPull(sourcePull);
    if (!sourceBinding || !sourceRoute) return false;
    const key = admissionKey(sourceBinding.orderId, sourceBinding.routeHash);
    const matchingTargets = targetPulls.filter(targetPull => {
      const targetBinding = targetPull.data.crossJurisdiction;
      return targetBinding && admissionKey(targetBinding.orderId, targetBinding.routeHash) === key;
    });
    if (matchingTargets.length !== 1) return false;
    const targetPull = matchingTargets[0]!;
    const targetBinding = targetPull.data.crossJurisdiction;
    const targetRoute = routeForCrossJPull(targetPull);
    if (!targetBinding || !targetRoute) return false;
    if (safeStringify(sourceRoute) !== safeStringify(targetRoute)) return false;
    if (
      sourceBinding.leg !== 'source' ||
      targetBinding.leg !== 'target' ||
      sourcePull.data.pullId !== sourceRoute.sourcePull?.pullId ||
      targetPull.data.pullId !== sourceRoute.targetPull?.pullId ||
      String(sourcePull.data.fullHash || '').toLowerCase() !== String(targetPull.data.fullHash || '').toLowerCase() ||
      String(sourcePull.data.partialRoot || '').toLowerCase() !== String(targetPull.data.partialRoot || '').toLowerCase()
    ) return false;
  }
  return true;
};

const pairedCloseListsMatch = (
  sourceCloses: readonly CrossJCloseTx[],
  targetCloses: readonly CrossJCloseTx[],
): boolean => {
  if (sourceCloses.length !== targetCloses.length) return false;
  for (const sourceClose of sourceCloses) {
    const key = crossCloseKey(sourceClose);
    const matchingTargets = targetCloses.filter(targetClose =>
      crossCloseKey(targetClose) === key);
    if (matchingTargets.length !== 1) return false;
    const targetClose = matchingTargets[0]!;
    if (
      sourceClose.data.pullId !== sourceClose.data.proof.sourcePullId ||
      targetClose.data.pullId !== targetClose.data.proof.targetPullId
    ) return false;
  }
  return true;
};

type CrossJAccountInputPair = {
  pairKey: string;
  phase: 'proposal' | 'ack';
  sourceInputIndex: number;
  targetInputIndex: number;
  sourceAccountFrame: CrossJAccountFrameExpectation;
  targetAccountFrame: CrossJAccountFrameExpectation;
};

type CrossJAccountFrameExpectation = {
  entityId: string;
  signerId: string;
  counterpartyEntityId: string;
  height: number;
  stateHash: string;
};

export type CrossJAccountInputPairSelection = {
  inputs: RoutedEntityInput[];
  pairs: CrossJAccountInputPair[];
  rejectedLegs: CrossJRejectedAccountInput[];
};

/**
 * Why one leg was dropped. A leg reaches `rejectedInputIndexes` through three
 * independent paths and the operator cannot tell them apart from the outside:
 * `unpaired` means no sibling candidate matched, `candidate-invalid` means the
 * leg itself failed admission before matching was attempted, `pair-match-failed`
 * means both legs were individually admissible but the cohort did not match, and
 * `atomic-group-invalid` means the leg carried an atomicCrossJurisdictionPair
 * marker whose declared cohort did not survive. Reporting one assumed cause for
 * all four sends every investigation to the wrong layer.
 */
type CrossJRejectedAccountInputReason =
  | 'unpaired'
  | 'multiple-candidates-per-input'
  | 'candidate-invalid'
  | 'pair-match-failed'
  | 'atomic-group-invalid';

type CrossJRejectedAccountInput = {
  inputIndex: number;
  accountInput: AccountPeerInput;
  reason: CrossJRejectedAccountInputReason;
  /** Sub-causes when `reason` is 'candidate-invalid'; empty otherwise. */
  detail: string[];
};

export type PotentialCrossJAccountInputPair = {
  pairKey: string;
  sourceInputIndex: number;
  targetInputIndex: number;
};

export type PotentialCrossJAccountInputPairOptions = {
  /**
   * Sender-side Account legs may be certified by sibling Entities in adjacent
   * Runtime frames. They remain private in the durable outbox until the exact
   * structural pair exists, then transport gives both one envelope frame.
   * Inbound selection must keep the default and require that shared envelope.
   */
  allowDifferentSourceRuntimeFrames?: boolean;
};

type CrossJAdmissionFrameCandidate = {
  inputIndex: number;
  pairKey: string;
  originKey: string;
  phase: 'proposal' | 'ack';
  accountInput: AccountPeerInput;
  frame: AccountFrame;
  sourcePulls: Array<Extract<AccountTx, { type: 'cross_pull_lock' }>>;
  targetPulls: Array<Extract<AccountTx, { type: 'cross_pull_lock' }>>;
  sourceCloses: CrossJCloseTx[];
  targetCloses: CrossJCloseTx[];
  sourceProgresses: CrossJFillAckTx[];
  targetProgresses: CrossJPullProgressTx[];
  alreadyCommitted: boolean;
  valid: boolean;
  /**
   * Which of the validity conditions failed, empty when the candidate is valid.
   * `valid` alone cannot be acted on: a duplicated route key is a producer bug,
   * an unresolved sibling binding is a topology or gossip problem, and the two
   * are fixed in different places.
   */
  invalidReasons: string[];
};

const proposalCandidateInvalidReasons = (
  routeKeys: readonly string[],
  sourcePullCount: number,
  targetPullCount: number,
  source: unknown,
  target: unknown,
): string[] => {
  const reasons: string[] = [];
  if (new Set(routeKeys).size !== routeKeys.length) reasons.push('duplicate-route-key');
  if (sourcePullCount > 0 && source === null) reasons.push('source-sibling-unresolved');
  if (targetPullCount > 0 && target === null) reasons.push('target-sibling-unresolved');
  return reasons;
};

const buildCrossJProposalFrameCandidate = (
  input: RoutedEntityInput,
  inputIndex: number,
  accountInput: AccountPeerInput,
): CrossJAdmissionFrameCandidate | null => {
  const proposal = accountInputProposal(accountInput);
  if (!proposal) return null;
  const sourcePulls = crossPulls(proposal.frame.accountTxs, 'source');
  const targetPulls = crossPulls(proposal.frame.accountTxs, 'target');
  const sourceCloses = crossCloses(proposal.frame.accountTxs, 'source');
  const targetCloses = crossCloses(proposal.frame.accountTxs, 'target');
  const sourceFillProgresses = sourceProgresses(proposal.frame.accountTxs);
  const targetFillProgresses = targetProgresses(proposal.frame.accountTxs);
  if (
    sourcePulls.length === 0 &&
    targetPulls.length === 0 &&
    sourceCloses.length === 0 &&
    targetCloses.length === 0 &&
    sourceFillProgresses.length === 0 &&
    targetFillProgresses.length === 0
  ) return null;
  const source = sourceAdmissionCandidate(input, inputIndex, accountInput);
  const target = targetProposalCandidate(input, inputIndex, accountInput);
  const routeKeys = [
    ...[...sourcePulls, ...targetPulls].map(pull => `open\u0000${admissionKey(
      pull.data.crossJurisdiction!.orderId,
      pull.data.crossJurisdiction!.routeHash,
    )}`),
    ...[...sourceCloses, ...targetCloses].map(crossCloseKey),
    ...sourceFillProgresses.map(tx => crossProgressKey(tx.data)),
    ...targetFillProgresses.map(tx => crossProgressKey(tx.data.fill)),
  ];
  const invalidReasons = proposalCandidateInvalidReasons(
    routeKeys,
    sourcePulls.length,
    targetPulls.length,
    source,
    target,
  );
  return {
    inputIndex,
    pairKey: exactAdmissionPairKey(input, routeKeys, 'proposal'),
    originKey: admissionOriginKey(input),
    phase: 'proposal',
    accountInput,
    frame: proposal.frame,
    sourcePulls,
    targetPulls,
    sourceCloses,
    targetCloses,
    sourceProgresses: sourceFillProgresses,
    targetProgresses: targetFillProgresses,
    alreadyCommitted: false,
    valid: invalidReasons.length === 0,
    invalidReasons,
  };
};

const buildCrossJAckFrameCandidate = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  inputIndex: number,
  accountInput: AccountPeerInput,
): CrossJAdmissionFrameCandidate | null => {
  const ack = accountInputAck(accountInput);
  if (!ack) return null;
  const account = findReplicaAccount(env, input, accountInput.fromEntityId);
  const frameMatchesAck = (frame: NonNullable<typeof account>['currentFrame'] | undefined): boolean =>
    frame?.height === ack.height &&
    String(frame.stateHash || '').toLowerCase() === String(ack.frameHash || '').toLowerCase();
  const frame = frameMatchesAck(account?.pendingFrame)
    ? account!.pendingFrame!
    : frameMatchesAck(account?.currentFrame)
      ? account!.currentFrame
      : null;
  if (!frame) return null;
  const sourcePulls = crossPulls(frame.accountTxs, 'source');
  const targetPulls = crossPulls(frame.accountTxs, 'target');
  const sourceCloses = crossCloses(frame.accountTxs, 'source');
  const targetCloses = crossCloses(frame.accountTxs, 'target');
  const sourceFillProgresses = sourceProgresses(frame.accountTxs);
  const targetFillProgresses = targetProgresses(frame.accountTxs);
  if (
    sourcePulls.length === 0 &&
    targetPulls.length === 0 &&
    sourceCloses.length === 0 &&
    targetCloses.length === 0 &&
    sourceFillProgresses.length === 0 &&
    targetFillProgresses.length === 0
  ) return null;
  const routeKeys = [
    ...[...sourcePulls, ...targetPulls].map(pull => `open\u0000${admissionKey(
      pull.data.crossJurisdiction!.orderId,
      pull.data.crossJurisdiction!.routeHash,
    )}`),
    ...[...sourceCloses, ...targetCloses].map(crossCloseKey),
    ...sourceFillProgresses.map(tx => crossProgressKey(tx.data)),
    ...targetFillProgresses.map(tx => crossProgressKey(tx.data.fill)),
  ];
  return {
    inputIndex,
    pairKey: exactAdmissionPairKey(input, routeKeys, 'ack'),
    originKey: admissionOriginKey(input),
    phase: 'ack',
    accountInput,
    frame,
    sourcePulls,
    targetPulls,
    sourceCloses,
    targetCloses,
    sourceProgresses: sourceFillProgresses,
    targetProgresses: targetFillProgresses,
    alreadyCommitted: frame === account?.currentFrame,
    valid: new Set(routeKeys).size === routeKeys.length,
    invalidReasons: new Set(routeKeys).size === routeKeys.length ? [] : ['duplicate-route-key'],
  };
};

const admissionFramesMatch = (
  left: CrossJAdmissionFrameCandidate,
  right: CrossJAdmissionFrameCandidate,
): boolean => left.valid && right.valid &&
  left.phase === right.phase &&
  left.pairKey === right.pairKey &&
  left.originKey === right.originKey &&
  pairedPullListsMatch(left.sourcePulls, right.targetPulls) &&
  pairedPullListsMatch(right.sourcePulls, left.targetPulls) &&
  pairedCloseListsMatch(left.sourceCloses, right.targetCloses) &&
  pairedCloseListsMatch(right.sourceCloses, left.targetCloses) &&
  pairedProgressListsMatch(left.sourceProgresses, right.targetProgresses) &&
  pairedProgressListsMatch(right.sourceProgresses, left.targetProgresses);

/** Structural only; monetary approval happens in the state-aware selector. */
export const selectPotentialCrossJAccountInputPairs = (
  inputs: readonly RoutedEntityInput[],
  options: PotentialCrossJAccountInputPairOptions = {},
): PotentialCrossJAccountInputPair[] => {
  const candidates = inputs.flatMap((input, inputIndex) =>
    effectiveAccountInputs(input).flatMap(accountInput => {
      const candidate = buildCrossJProposalFrameCandidate(input, inputIndex, accountInput);
      return candidate ? [candidate] : [];
    }));
  const pairs: PotentialCrossJAccountInputPair[] = [];
  const pairedInputs = new Set<number>();
  const matchesForLeft = (
    left: CrossJAdmissionFrameCandidate,
    leftIndex: number,
    requireSameSourceRuntimeFrame: boolean,
  ): CrossJAdmissionFrameCandidate[] =>
    candidates.filter((right, rightIndex) =>
      rightIndex > leftIndex &&
      right.inputIndex !== left.inputIndex &&
      !pairedInputs.has(right.inputIndex) &&
      targetsDistinctSiblingEntities(inputs, left.inputIndex, right.inputIndex) &&
      normalizeRuntimeId(inputs[right.inputIndex]!.runtimeId) ===
        normalizeRuntimeId(inputs[left.inputIndex]!.runtimeId) &&
        (requireSameSourceRuntimeFrame
          ? sameSourceRuntimeFrame(inputs[right.inputIndex]!, inputs[left.inputIndex]!)
          : options.allowDifferentSourceRuntimeFrames === true ||
            sameSourceRuntimeFrame(inputs[right.inputIndex]!, inputs[left.inputIndex]!)) &&
      admissionOriginKey(inputs[right.inputIndex]!) === admissionOriginKey(inputs[left.inputIndex]!) &&
      admissionFramesMatch(left, right));

  // Two passes, same-source-frame first.
  //
  // `allowDifferentSourceRuntimeFrames` exists because sibling Entity consensus
  // may certify the two legs of ONE cohort in adjacent Runtime frames. But it
  // drops `sameSourceRuntimeFrame` for every comparison, and that predicate is
  // also the only thing telling two *concurrent* cohorts apart when they carry
  // identical route sets. Both legs of cohort A (frame h) then match both legs
  // of cohort B (frame h'), every candidate sees two partners, and the
  // uniqueness rule below discards all of them — even though each cohort was
  // perfectly unambiguous within its own frame. Downstream that is not a
  // harmless skip: `groupAtomicCrossJAdmissionOutputs` leaves the unclaimed
  // legs as lone cross-j proposals, which dispatch classifies as incomplete
  // atomic cohorts and defers forever (they are excluded from retry scheduling
  // and parked in `waiting` unconditionally). That wedged MM bootstrap-cross at
  // 0 of 6 routes until the harness deadline fired.
  //
  // So resolve within a frame before reaching across frames. Pairs found here
  // are claimed, which is what keeps two sequential cohorts in separate
  // envelopes instead of cross-linking them under one misleading pairKey.
  for (const requireSameSourceRuntimeFrame of [true, false]) {
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      const left = candidates[leftIndex]!;
      if (pairedInputs.has(left.inputIndex)) continue;
      const matches = matchesForLeft(left, leftIndex, requireSameSourceRuntimeFrame);
      if (matches.length !== 1) continue;
      const right = matches[0]!;
      pairedInputs.add(left.inputIndex);
      pairedInputs.add(right.inputIndex);
      pairs.push({
        pairKey: left.pairKey,
        sourceInputIndex: left.inputIndex,
        targetInputIndex: right.inputIndex,
      });
    }
  }
  if (pairs.length === 0 && inputs.length === 2) {
    const cohort = inputs[0]?.atomicCrossJurisdictionPair;
    const sameAckCohort = cohort?.phase === 'ack' && inputs.every(input =>
      input.atomicCrossJurisdictionPair?.phase === 'ack' &&
      input.atomicCrossJurisdictionPair.pairKey === cohort.pairKey &&
      sameSourceRuntimeFrame(inputs[0]!, input));
    const ackIndexes = sameAckCohort ? inputs.flatMap((input, inputIndex) =>
      effectiveAccountInputs(input).some(accountInput => Boolean(accountInputAck(accountInput)))
        ? [inputIndex]
        : []) : [];
    if (
      ackIndexes.length === 2 &&
      targetsDistinctSiblingEntities(inputs, ackIndexes[0]!, ackIndexes[1]!)
    ) {
      pairs.push({
        pairKey: cohort!.pairKey,
        sourceInputIndex: ackIndexes[0]!,
        targetInputIndex: ackIndexes[1]!,
      });
    }
  }
  return pairs;
};

const collectCrossJAdmissionCandidates = (
  env: RuntimeReplica,
  inputs: readonly RoutedEntityInput[],
): CrossJAdmissionFrameCandidate[] => inputs.flatMap((input, inputIndex) => {
  const replica = findInputReplica(env, input);
  if (!replica) return [];
  const receivingHub = replica.state.profile?.isHub === true;
  return effectiveAccountInputs(input).flatMap(accountInput => {
    const candidate = receivingHub
      ? buildCrossJAckFrameCandidate(env, input, inputIndex, accountInput)
      : buildCrossJProposalFrameCandidate(input, inputIndex, accountInput);
    if (!candidate) return [];
    if (!receivingHub) {
      candidate.alreadyCommitted = proposalAlreadyCommitted(env, input, accountInput);
    }
    return [candidate];
  });
});

const crossJAdmissionCohortKey = (
  input: RoutedEntityInput,
  phase: 'proposal' | 'ack',
  pairKey: string,
): string => {
  const frame = input.sourceRuntimeFrame;
  return JSON.stringify([
    phase,
    pairKey,
    admissionOriginKey(input),
    frame?.height ?? null,
    frame?.timestamp ?? null,
  ]);
};

export const atomicCrossJInputCohortKey = (
  input: RoutedEntityInput,
): string | null => {
  const marker = input.atomicCrossJurisdictionPair;
  return marker
    ? crossJAdmissionCohortKey(input, marker.phase, marker.pairKey)
    : null;
};

const collectAtomicCrossJGroups = (
  inputs: readonly RoutedEntityInput[],
): Map<string, number[]> => {
  const groups = new Map<string, number[]>();
  for (const [inputIndex, input] of inputs.entries()) {
    const marker = input.atomicCrossJurisdictionPair;
    if (!marker) continue;
    const key = crossJAdmissionCohortKey(input, marker.phase, marker.pairKey);
    const group = groups.get(key) ?? [];
    group.push(inputIndex);
    groups.set(key, group);
  }
  return groups;
};

const groupUncommittedCrossJCandidates = (
  candidates: readonly CrossJAdmissionFrameCandidate[],
  inputs: readonly RoutedEntityInput[],
): {
  candidates: CrossJAdmissionFrameCandidate[];
  byCohort: Map<string, CrossJAdmissionFrameCandidate[]>;
  invalidIndexes: Set<number>;
  multiCandidateIndexes: Set<number>;
  invalidDetails: Map<number, string[]>;
} => {
  // A byte-exact Account frame already present in durable state is transport
  // replay. Its missing ACK may be emitted without receiving its sibling again.
  const uncommitted = candidates.filter(candidate => !candidate.alreadyCommitted);
  const byCohort = new Map<string, CrossJAdmissionFrameCandidate[]>();
  const counts = new Map<number, number>();
  for (const candidate of uncommitted) {
    const input = inputs[candidate.inputIndex]!;
    const key = crossJAdmissionCohortKey(input, candidate.phase, candidate.pairKey);
    const group = byCohort.get(key) ?? [];
    group.push(candidate);
    byCohort.set(key, group);
    counts.set(candidate.inputIndex, (counts.get(candidate.inputIndex) ?? 0) + 1);
  }
  // One Entity input must carry exactly one cross-j leg: a second leg in the
  // same input would make the cohort ambiguous. That is a producer-side batching
  // defect and is nothing like a leg whose own route bindings failed to resolve,
  // so the two are reported apart.
  const multiCandidateIndexes = new Set([...counts]
    .filter(([, count]) => count !== 1)
    .map(([inputIndex]) => inputIndex));
  const invalidIndexes = new Set(multiCandidateIndexes);
  const invalidDetails = new Map<number, string[]>();
  uncommitted
    .filter(candidate => !candidate.valid)
    .forEach(candidate => {
      invalidIndexes.add(candidate.inputIndex);
      invalidDetails.set(candidate.inputIndex, [
        ...(invalidDetails.get(candidate.inputIndex) ?? []),
        ...candidate.invalidReasons,
      ]);
    });
  return { candidates: uncommitted, byCohort, invalidIndexes, multiCandidateIndexes, invalidDetails };
};

/**
 * Returns null when the opening cohort is authorized, otherwise the specific
 * unmet condition. A bare boolean here is unactionable: an unresolved sibling
 * replica is a topology problem, a mismatched authorization is a state problem,
 * and a rejected prepared route is a protocol problem. Swallowing the thrown
 * validation error into `false` sent every such rejection to the wrong layer.
 */
type OpeningPullLock = Extract<AccountTx, { type: 'cross_pull_lock' }>;

const normalizeOpeningHash = (value: string): string => String(value || '').trim().toLowerCase();

/**
 * INVARIANT: unique hashladder root per canonical routeHash — globally in live
 * Runtime state. Distinct routes must never share `partialRoot` or `fullHash`
 * anywhere (any Entity, any Account, any retained swap/authorization). One
 * reveal would otherwise close an opposing swap. Source/target legs of the
 * same route intentionally share one ladder. `orderId` is only book-scoped and
 * cannot authorize reuse across unrelated Entities.
 */
const rememberHashLadderOwner = (
  byFullHash: Map<string, string>,
  byPartialRoot: Map<string, string>,
  routeHash: string,
  fullHash: string,
  partialRoot: string,
): string | null => {
  const conflictFull = byFullHash.get(fullHash);
  if (conflictFull && conflictFull !== routeHash) {
    return `opening-shared-hash-material:${conflictFull}/${routeHash}:fullHash`;
  }
  const conflictPartial = byPartialRoot.get(partialRoot);
  if (conflictPartial && conflictPartial !== routeHash) {
    return `opening-shared-hash-material:${conflictPartial}/${routeHash}:partialRoot`;
  }
  byFullHash.set(fullHash, routeHash);
  byPartialRoot.set(partialRoot, routeHash);
  return null;
};

const collectRuntimeHashLadderOwners = (
  env: RuntimeReplica,
): { byFullHash: Map<string, string>; byPartialRoot: Map<string, string> } => {
  const byFullHash = new Map<string, string>();
  const byPartialRoot = new Map<string, string>();
  const rememberRoutePulls = (
    routeHash: string,
    pulls: ReadonlyArray<{ fullHash?: string; partialRoot?: string } | undefined>,
  ): void => {
    for (const pull of pulls) {
      if (!pull) continue;
      const fullHash = normalizeOpeningHash(pull.fullHash || '');
      const partialRoot = normalizeOpeningHash(pull.partialRoot || '');
      if (!fullHash || !partialRoot) continue;
      rememberHashLadderOwner(byFullHash, byPartialRoot, routeHash, fullHash, partialRoot);
    }
  };
  for (const replica of env.state.eReplicas.values()) {
    for (const account of replica.state.accounts.values()) {
      for (const pull of account.state.pulls?.values() ?? []) {
        const routeHash = normalizeOpeningHash(pull.crossJurisdiction?.routeHash || '');
        if (!routeHash) continue;
        rememberHashLadderOwner(
          byFullHash,
          byPartialRoot,
          routeHash,
          normalizeOpeningHash(pull.fullHash),
          normalizeOpeningHash(pull.partialRoot),
        );
      }
    }
    for (const route of replica.state.crossJurisdictionSwaps?.values() ?? []) {
      rememberRoutePulls(normalizeOpeningHash(route.routeHash || ''), [route.sourcePull, route.targetPull]);
    }
    for (const route of replica.state.crossJurisdictionAuthorizations?.values() ?? []) {
      rememberRoutePulls(normalizeOpeningHash(route.routeHash || ''), [route.sourcePull, route.targetPull]);
    }
  }
  return { byFullHash, byPartialRoot };
};

const openingSharedHashMaterialFailure = (
  env: RuntimeReplica,
  group: readonly CrossJAdmissionFrameCandidate[],
): string | null => {
  const byRoute = new Map<string, { fullHash: string; partialRoot: string }>();
  const { byFullHash, byPartialRoot } = collectRuntimeHashLadderOwners(env);
  for (const candidate of group) {
    for (const pull of [...candidate.sourcePulls, ...candidate.targetPulls]) {
      const orderId = String(pull.data.crossJurisdiction?.orderId || '').trim();
      if (!orderId) return 'opening-order-id-missing';
      const routeHash = normalizeOpeningHash(pull.data.crossJurisdiction?.routeHash || '');
      if (!routeHash) return `opening-route-hash-missing:${orderId}`;
      const fullHash = normalizeOpeningHash(pull.data.fullHash);
      const partialRoot = normalizeOpeningHash(pull.data.partialRoot);
      const existing = byRoute.get(routeHash);
      if (existing) {
        if (existing.fullHash !== fullHash || existing.partialRoot !== partialRoot) {
          return `opening-intra-route-hash-divergent:${routeHash}`;
        }
        continue;
      }
      const conflict = rememberHashLadderOwner(
        byFullHash,
        byPartialRoot,
        routeHash,
        fullHash,
        partialRoot,
      );
      if (conflict) return conflict;
      byRoute.set(routeHash, { fullHash, partialRoot });
    }
  }
  return null;
};

const authorizeOpeningSourcePull = (
  env: RuntimeReplica,
  sourceCandidate: CrossJAdmissionFrameCandidate,
  targetCandidate: CrossJAdmissionFrameCandidate,
  sourceInput: RoutedEntityInput,
  targetInput: RoutedEntityInput,
  sourcePull: OpeningPullLock,
): string | null => {
  const binding = sourcePull.data.crossJurisdiction;
  const route = routeForCrossJPull(sourcePull);
  if (!binding || !route) return 'opening-route-missing';
  const key = admissionKey(binding.orderId, binding.routeHash);
  const matchingTargets = targetCandidate.targetPulls.filter(targetPull => {
    const targetBinding = targetPull.data.crossJurisdiction;
    return Boolean(targetBinding && admissionKey(targetBinding.orderId, targetBinding.routeHash) === key);
  });
  if (matchingTargets.length !== 1) return `opening-target-pull-mismatch:${binding.orderId}`;

  const sourceReplica = findInputReplica(env, sourceInput);
  const targetReplica = findInputReplica(env, targetInput);
  if (!sourceReplica || !targetReplica) return 'opening-replica-unresolved';

  const routeHash = normalizeEntityKey(route.routeHash || '');
  if (!routeHash) return 'opening-route-hash-missing';
  const sourceAuth = sourceReplica.state.crossJurisdictionAuthorizations?.get(route.orderId);
  const targetAuth = targetReplica.state.crossJurisdictionAuthorizations?.get(route.orderId);
  if (!sourceAuth || !targetAuth) return 'opening-authorization-absent';
  if (sourceAuth.status !== 'intent' || targetAuth.status !== 'intent') {
    return `opening-authorization-status:${sourceAuth.status}/${targetAuth.status}`;
  }
  if (
    sourceAuth.sourcePull || sourceAuth.targetPull ||
    targetAuth.sourcePull || targetAuth.targetPull
  ) return 'opening-authorization-already-pulled';
  if (
    normalizeEntityKey(sourceAuth.routeHash || '') !== routeHash ||
    normalizeEntityKey(targetAuth.routeHash || '') !== routeHash
  ) return 'opening-authorization-route-hash-mismatch';
  if (safeStringify(sourceAuth) !== safeStringify(targetAuth)) {
    return 'opening-authorization-divergent';
  }
  if (
    normalizeEntityKey(sourceInput.entityId) !== normalizeEntityKey(route.source.entityId) ||
    normalizeEntityKey(sourceInput.signerId) !== normalizeEntityKey(route.sourceSignerId || '') ||
    normalizeEntityKey(sourceCandidate.accountInput.fromEntityId) !==
      normalizeEntityKey(route.source.counterpartyEntityId) ||
    normalizeEntityKey(targetInput.entityId) !== normalizeEntityKey(route.target.counterpartyEntityId) ||
    normalizeEntityKey(targetInput.signerId) !== normalizeEntityKey(route.targetSignerId || '') ||
    normalizeEntityKey(targetCandidate.accountInput.fromEntityId) !==
      normalizeEntityKey(route.target.entityId)
  ) return 'opening-route-participant-mismatch';
  try {
    validatePreparedCrossJurisdictionRoute({
      ...sourceReplica.state,
      timestamp: Math.max(sourceReplica.state.timestamp, env.state.timestamp),
    }, {
      ...cloneCrossJurisdictionRoute(route),
      status: 'target_prepared',
    });
  } catch (error) {
    return `opening-prepared-route-rejected:${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
};

/**
 * Fat frames may mix any number of source and target pulls for distinct swaps.
 * Authorization is per orderId: each sourcePull on either sibling leg must find
 * exactly one matching targetPull on the other leg and pass intent checks.
 * Shape-level "source-only / target-only" was a false gate and rejected valid
 * MM bootstrap batches (e.g. s8/t45 mirrored with s45/t8).
 */
const openingPairAuthorizationFailure = (
  env: RuntimeReplica,
  group: readonly CrossJAdmissionFrameCandidate[],
  inputs: readonly RoutedEntityInput[],
): string | null => {
  if (group[0]?.phase !== 'proposal') return null;
  const hasOpening = group.some(candidate =>
    candidate.sourcePulls.length > 0 || candidate.targetPulls.length > 0);
  if (!hasOpening) return null;
  if (group.length !== 2) return `opening-cohort-size:${group.length}`;

  const sharedHashFailure = openingSharedHashMaterialFailure(env, group);
  if (sharedHashFailure) return sharedHashFailure;

  const left = group[0]!;
  const right = group[1]!;
  // Walk both orientations so dual-pull mirrored frames authorize every
  // sourcePull, not only those that happen to sit on a uni-directional leg.
  for (const [sourceCandidate, targetCandidate] of [
    [left, right],
    [right, left],
  ] as const) {
    const sourceInput = inputs[sourceCandidate.inputIndex];
    const targetInput = inputs[targetCandidate.inputIndex];
    if (!sourceInput || !targetInput) return 'opening-input-missing';
    for (const sourcePull of sourceCandidate.sourcePulls) {
      const failure = authorizeOpeningSourcePull(
        env,
        sourceCandidate,
        targetCandidate,
        sourceInput,
        targetInput,
        sourcePull,
      );
      if (failure) return failure;
    }
  }
  return null;
};

const cohortShapeFailure = (
  group: readonly CrossJAdmissionFrameCandidate[],
  groupIndexes: ReadonlySet<number>,
  invalidIndexes: ReadonlySet<number>,
): string | null => {
  if (group.length !== 2) return `cohort-size:${group.length}`;
  if (groupIndexes.size !== 2) return 'cohort-legs-share-one-input';
  return [...groupIndexes].some(inputIndex => invalidIndexes.has(inputIndex))
    ? 'cohort-leg-already-invalid'
    : null;
};

const pairMatchFailure = (
  env: RuntimeReplica,
  group: readonly CrossJAdmissionFrameCandidate[],
  inputs: readonly RoutedEntityInput[],
  source: CrossJAdmissionFrameCandidate,
  target: CrossJAdmissionFrameCandidate,
): string | null => {
  const sourceInput = inputs[source.inputIndex]!;
  const targetInput = inputs[target.inputIndex]!;
  if (!targetsDistinctSiblingEntities(inputs, source.inputIndex, target.inputIndex)) {
    return 'legs-target-same-entity';
  }
  if (!sameSourceRuntimeFrame(sourceInput, targetInput)) return 'legs-source-frame-differs';
  if (!admissionFramesMatch(source, target)) return 'legs-frames-do-not-pair';
  return openingPairAuthorizationFailure(env, group, inputs);
};

/**
 * Records why each leg was dropped. This used to fold group-level failures into
 * the caller's candidate-level `invalidIndexes` with no detail, so a cohort that
 * failed *matching* was reported as a leg that failed its own admission — a
 * different layer, a different fix, and no way to tell them apart from a log.
 */
const matchCrossJCandidateGroups = (
  env: RuntimeReplica,
  groups: Iterable<CrossJAdmissionFrameCandidate[]>,
  inputs: readonly RoutedEntityInput[],
  invalidIndexes: Set<number>,
  pairMatchFailures: Map<number, string[]>,
): CrossJAccountInputPair[] => {
  const pairs: CrossJAccountInputPair[] = [];
  const rejectGroup = (groupIndexes: ReadonlySet<number>, reason: string): void => {
    for (const inputIndex of groupIndexes) {
      invalidIndexes.add(inputIndex);
      pairMatchFailures.set(inputIndex, [...(pairMatchFailures.get(inputIndex) ?? []), reason]);
    }
  };
  for (const group of groups) {
    const groupIndexes = new Set(group.map(candidate => candidate.inputIndex));
    const shapeFailure = cohortShapeFailure(group, groupIndexes, invalidIndexes);
    if (shapeFailure) {
      rejectGroup(groupIndexes, shapeFailure);
      continue;
    }
    const [source, target] = [...group].sort((left, right) => left.inputIndex - right.inputIndex);
    const matchFailure = pairMatchFailure(env, group, inputs, source!, target!);
    if (matchFailure) {
      rejectGroup(groupIndexes, matchFailure);
      continue;
    }
    const sourceInput = inputs[source!.inputIndex]!;
    const targetInput = inputs[target!.inputIndex]!;
    pairs.push({
      pairKey: source!.pairKey,
      phase: source!.phase,
      sourceInputIndex: source!.inputIndex,
      targetInputIndex: target!.inputIndex,
      sourceAccountFrame: {
        entityId: sourceInput.entityId,
        signerId: sourceInput.signerId,
        counterpartyEntityId: source!.accountInput.fromEntityId,
        height: source!.frame.height,
        stateHash: source!.frame.stateHash,
      },
      targetAccountFrame: {
        entityId: targetInput.entityId,
        signerId: targetInput.signerId,
        counterpartyEntityId: target!.accountInput.fromEntityId,
        height: target!.frame.height,
        stateHash: target!.frame.stateHash,
      },
    });
  }
  return pairs;
};

const findInvalidAtomicCrossJIndexes = (
  atomicGroups: Iterable<number[]>,
  committedIndexes: ReadonlySet<number>,
  pairs: readonly CrossJAccountInputPair[],
): Set<number> => {
  const invalid = new Set<number>();
  for (const group of atomicGroups) {
    const allCommitted = group.length === 2 &&
      group.every(inputIndex => committedIndexes.has(inputIndex));
    const exactPairExists = group.length === 2 && pairs.some(pair =>
      group.includes(pair.sourceInputIndex) && group.includes(pair.targetInputIndex));
    // The authenticated envelope marker survives even when a corrupt ACK no
    // longer resolves to pending state. It must not escape the atomic gate.
    if (!allCommitted && !exactPairExists) {
      group.forEach(inputIndex => invalid.add(inputIndex));
    }
  }
  return invalid;
};

const stripRejectedAccountTxs = (
  input: RoutedEntityInput,
  rejected: ReadonlySet<AccountPeerInput>,
): RoutedEntityInput | null => {
  const entityTxs: EntityTx[] = [];
  for (const tx of input.entityTxs ?? []) {
    if (tx.type === 'accountInput') {
      if (!rejected.has(tx.data)) entityTxs.push(tx);
      continue;
    }
    if (tx.type !== 'runtimeOutput') {
      entityTxs.push(tx);
      continue;
    }
    const retained = tx.data.entityTxs.filter(candidate =>
      candidate.type !== 'accountInput' || !rejected.has(candidate.data));
    if (retained.length === tx.data.entityTxs.length) {
      entityTxs.push(tx);
      continue;
    }
    if (retained.length === 0) continue;
    entityTxs.push({
      ...tx,
      data: {
        ...tx.data,
        entityTxs: retained,
      },
    });
  }
  const hasOtherProtocolPayload = Boolean(
    entityTxs.length > 0 ||
    input.proposedFrame ||
    input.hashPrecommitFrame ||
    input.hashPrecommits ||
    input.jPrefixAttestations ||
    input.leaderTimeoutVote,
  );
  if (!hasOtherProtocolPayload) return null;
  const retained: RoutedEntityInput = {
    ...input,
    entityTxs,
  };
  delete retained.atomicCrossJurisdictionPair;
  return retained;
};

const removeRejectedCrossJAccountInputs = (
  inputs: readonly RoutedEntityInput[],
  rejectedLegs: readonly CrossJRejectedAccountInput[],
): { inputs: RoutedEntityInput[]; retainedIndexes: number[] } => {
  const rejectedByInput = new Map<number, Set<AccountPeerInput>>();
  for (const candidate of rejectedLegs) {
    const rejected = rejectedByInput.get(candidate.inputIndex) ?? new Set();
    rejected.add(candidate.accountInput);
    rejectedByInput.set(candidate.inputIndex, rejected);
  }
  const retainedInputs: RoutedEntityInput[] = [];
  const retainedIndexes: number[] = [];
  inputs.forEach((input, inputIndex) => {
    const rejected = rejectedByInput.get(inputIndex);
    const retained = rejected ? stripRejectedAccountTxs(input, rejected) : input;
    if (!retained) return;
    retainedInputs.push(retained);
    retainedIndexes.push(inputIndex);
  });
  return { inputs: retainedInputs, retainedIndexes };
};

export const removeRejectedCrossJAccountInputsByIndex = (
  env: RuntimeReplica,
  inputs: readonly RoutedEntityInput[],
  rejectedInputIndexes: ReadonlySet<number>,
): RoutedEntityInput[] => {
  const candidates = collectCrossJAdmissionCandidates(env, inputs);
  const rejectedLegs = [...rejectedInputIndexes].flatMap(inputIndex => {
    const matched = candidates.filter(candidate =>
      candidate.inputIndex === inputIndex);
    const input = inputs[inputIndex];
    const accountInputs = matched.length > 0
      ? matched.map(candidate => candidate.accountInput)
      : input
        ? effectiveAccountInputs(input)
        : [];
    // Callers reach here only after an atomic pair already failed, so the
    // cohort is the established cause; nothing here re-derives it.
    return accountInputs.map(accountInput => ({
      inputIndex,
      accountInput,
      reason: 'atomic-group-invalid' as const,
      detail: [],
    }));
  });
  return removeRejectedCrossJAccountInputs(inputs, rejectedLegs).inputs;
};

/**
 * Opening and closing both cross-j legs are atomic Runtime cohorts. Proposals
 * and ACKs must carry the exact source/target pair from one source Runtime
 * frame. A standalone monetary leg is removed before Account consensus while
 * unrelated Entity transactions in the same Runtime input remain eligible.
 */
export const selectMatchedCrossJAccountInputPairs = (
  env: RuntimeReplica,
  inputs: readonly RoutedEntityInput[],
): CrossJAccountInputPairSelection => {
  const candidates = collectCrossJAdmissionCandidates(env, inputs);
  const atomicGroups = collectAtomicCrossJGroups(inputs);
  if (candidates.length === 0 && atomicGroups.size === 0) {
    return { inputs: [...inputs], pairs: [], rejectedLegs: [] };
  }

  const grouped = groupUncommittedCrossJCandidates(candidates, inputs);
  const pairMatchFailures = new Map<number, string[]>();
  const pairs = matchCrossJCandidateGroups(
    env,
    grouped.byCohort.values(),
    inputs,
    grouped.invalidIndexes,
    pairMatchFailures,
  );
  const allCandidateIndexes = new Set(grouped.candidates.map(candidate => candidate.inputIndex));
  const pairedIndexes = new Set(pairs.flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]));
  const committedCandidateIndexes = new Set(candidates
    .filter(candidate => candidate.alreadyCommitted)
    .map(candidate => candidate.inputIndex));
  const atomicInvalidIndexes = findInvalidAtomicCrossJIndexes(
    atomicGroups.values(),
    committedCandidateIndexes,
    pairs,
  );
  const atomicInvalid = new Set(atomicInvalidIndexes);
  const rejectedInputIndexes = [...new Set([
    ...[...allCandidateIndexes]
      .filter(inputIndex => grouped.invalidIndexes.has(inputIndex) || !pairedIndexes.has(inputIndex)),
    ...atomicInvalidIndexes,
  ])].sort((left, right) => left - right);
  const rejected = new Set(rejectedInputIndexes);
  // Candidate-level invalidity is checked by its own detail map, never by
  // `invalidIndexes`: pair matching also writes into that set, so testing it
  // here reported every cohort-matching failure as a bad candidate.
  const rejectionReason = (inputIndex: number): CrossJRejectedAccountInputReason =>
    grouped.multiCandidateIndexes.has(inputIndex)
      ? 'multiple-candidates-per-input'
      : grouped.invalidDetails.has(inputIndex)
        ? 'candidate-invalid'
        : pairMatchFailures.has(inputIndex)
          ? 'pair-match-failed'
          : atomicInvalid.has(inputIndex)
            ? 'atomic-group-invalid'
            : 'unpaired';
  const rejectedLegs = rejectedInputIndexes.flatMap(inputIndex => {
    const matched = candidates.filter(candidate =>
      candidate.inputIndex === inputIndex);
    const input = inputs[inputIndex];
    const accountInputs = matched.length > 0
      ? matched.map(candidate => candidate.accountInput)
      : input
        ? effectiveAccountInputs(input)
        : [];
    const reason = rejectionReason(inputIndex);
    const detail = reason === 'pair-match-failed'
      ? pairMatchFailures.get(inputIndex) ?? []
      : grouped.invalidDetails.get(inputIndex) ?? [];
    return accountInputs.map(accountInput => ({ inputIndex, accountInput, reason, detail }));
  });
  const retained = removeRejectedCrossJAccountInputs(inputs, rejectedLegs);
  const remappedIndexes = new Map(
    retained.retainedIndexes.map((oldIndex, newIndex) => [oldIndex, newIndex]),
  );
  return {
    inputs: retained.inputs,
    pairs: pairs.flatMap(pair => {
      if (rejected.has(pair.sourceInputIndex) || rejected.has(pair.targetInputIndex)) return [];
      const sourceInputIndex = remappedIndexes.get(pair.sourceInputIndex);
      const targetInputIndex = remappedIndexes.get(pair.targetInputIndex);
      return sourceInputIndex === undefined || targetInputIndex === undefined
        ? []
        : [{ ...pair, sourceInputIndex, targetInputIndex }];
    }),
    rejectedLegs,
  };
};

const runtimeRoutingTimestamp = (env: RuntimeReplica): number => {
  const timestamp = Math.floor(Number(env.state.timestamp ?? 0));
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
};

const resolveRuntimeIdFromProfile = (profile: Profile | undefined): string | null => {
  const runtimeId = normalizeRuntimeId(String(profile?.runtimeId || ''));
  return runtimeId || null;
};

export const resolveRuntimeIdForEntity = (
  env: RuntimeReplica,
  entityId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeInfrastructure'>,
): string | null => {
  const target = normalizeEntityKey(entityId);
  const state = deps.ensureRuntimeInfrastructure(env);
  if (!state.entityRuntimeHints) {
    state.entityRuntimeHints = new Map();
  }
  const hints = state.entityRuntimeHints;
  const now = runtimeRoutingTimestamp(env);

  const hinted = hints?.get(target);
  const hintAge = Number.isFinite(hinted?.seenAt)
    ? (now >= Number(hinted?.seenAt) ? now - Number(hinted?.seenAt) : Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
  if (
    hinted &&
    typeof hinted.runtimeId === 'string' &&
    hinted.runtimeId.length > 0 &&
    hintAge <= RUNTIME_HINT_TTL_MS
  ) {
    const normalizedHint = normalizeRuntimeId(hinted.runtimeId);
    if (normalizedHint) return normalizedHint;
  }

  // This is routing metadata, not consensus state. Gossip can only decide where
  // to send the next encrypted entity_input; local REA still rejects unknown
  // entities and cross-j topology is validated again before remote dispatch.
  if (env.gossip?.getProfile) {
    const profile = env.gossip.getProfile(target) as Profile | undefined;
    const resolved = resolveRuntimeIdFromProfile(profile);
    if (resolved) {
      hints?.set(target, { runtimeId: resolved, seenAt: now });
      return resolved;
    }
  }
  return null;
};

const resolveRuntimeIdForCrossJurisdictionEntity = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'hasLocalSignerForEntitySigner'>,
): string | null => {
  const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  if (localRuntimeId && deps.hasLocalSignerForEntitySigner(env, entityId, signerId)) return localRuntimeId;
  const verified = env.infrastructure?.verifiedProfileRoutes?.get(normalizeEntityKey(entityId));
  if (normalizeEntityKey(verified?.runtimeSignerId || '') !== normalizeEntityKey(signerId)) return null;
  return normalizeRuntimeId(String(verified?.runtimeId || '')) || null;
};

export const registerEntityRuntimeHintWithDeps = (
  env: RuntimeReplica,
  entityId: string,
  runtimeId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeInfrastructure'>,
): void => {
  if (!entityId || !runtimeId) return;
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  const state = deps.ensureRuntimeInfrastructure(env);
  const hints = state.entityRuntimeHints!;
  hints.set(normalizeEntityKey(entityId), {
    runtimeId: normalizedRuntimeId,
    seenAt: runtimeRoutingTimestamp(env),
  });
};

export const collectCrossJurisdictionRemoteEntityHints = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  fromRuntimeId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'extractEntityId' | 'hasLocalSignerForEntity'>,
): string[] => {
  const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  const from = normalizeRuntimeId(fromRuntimeId);
  if (!localRuntimeId || !from || localRuntimeId === from) return [];
  const hints = new Set<string>();
  for (const tx of getEffectiveEntityInputTxs(input)) {
    const route = extractCrossJurisdictionRouteFromTx(tx);
    if (!route) continue;
    const sourceUserId = String(route.source?.entityId || '').toLowerCase();
    const targetUserId = String(route.target?.counterpartyEntityId || '').toLowerCase();
    const sourceHubId = String(route.source?.counterpartyEntityId || '').toLowerCase();
    const targetHubId = String(route.target?.entityId || '').toLowerCase();
    const localIsHubSide = [sourceHubId, targetHubId].some(entityId => entityId && deps.hasLocalSignerForEntity(env, entityId));
    const localIsUserSide = [sourceUserId, targetUserId].some(entityId => entityId && deps.hasLocalSignerForEntity(env, entityId));
    const remoteIds = localIsHubSide && !localIsUserSide
      ? [sourceUserId, targetUserId]
      : localIsUserSide && !localIsHubSide
        ? [sourceHubId, targetHubId]
        : [];
    for (const entityId of remoteIds) {
      if (entityId) hints.add(entityId);
    }
  }
  return [...hints];
};

type InboundEntityContext = {
  targetEntityId: string;
  txTypes: string;
  hasTransactions: boolean;
};

const inboundEntityContext = (input: RoutedEntityInput): InboundEntityContext => ({
  targetEntityId: String(input.entityId || '').toLowerCase(),
  txTypes: input.entityTxs?.map(tx => tx.type).join(',') || 'none',
  hasTransactions: (input.entityTxs?.length ?? 0) > 0,
});

const rejectUnavailableInboundTarget = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  code: string,
  payload: Record<string, unknown>,
  context: InboundEntityContext,
  transactionalLevel: 'error' | 'info' = 'error',
): RuntimeInboundEntityInputValidation => {
  if (context.hasTransactions) {
    env[transactionalLevel]?.('network', code, payload, input.entityId);
    throw new Error(
      `${code}: entity=${input.entityId} signer=${input.signerId} txTypes=${context.txTypes}`,
    );
  }
  env.warn('network', code, payload, input.entityId);
  return { kind: 'ignored' };
};

const findInboundTargetReplica = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
): EntityReplica | undefined => {
  const entityId = normalizeEntityKey(input.entityId);
  const signerId = normalizeEntityKey(input.signerId);
  return [...env.state.eReplicas.values()].find(replica =>
    normalizeEntityKey(replica.entityId) === entityId &&
    normalizeEntityKey(replica.signerId) === signerId);
};

const validateInboundEntityCommands = (
  env: RuntimeReplica,
  from: string,
  input: RoutedEntityInput,
): void => {
  let commandState = findInboundTargetReplica(env, input)?.state;
  for (const tx of input.entityTxs ?? []) {
    if (tx.type === 'accountInput') {
      // AccountPeerInput is the raw cross-runtime protocol input. Runtime routing
      // may batch many independent Account lanes for one target Entity/Runtime;
      // each frame/ACK Hanko is still verified independently by
      // applyAccountInput inside the one target Entity frame.
      if (normalizeEntityKey(tx.data.toEntityId) === normalizeEntityKey(input.entityId)) continue;
      throw new Error(
        `INBOUND_ACCOUNT_TARGET_MISMATCH:route=${input.entityId}:claimed=${tx.data.toEntityId}`,
      );
    }
    if (tx.type === 'runtimeOutput') {
      throw new Error(`INBOUND_RUNTIME_OUTPUT_FORBIDDEN:entity=${input.entityId}:from=${from}`);
    }
    if (tx.type !== 'entityCommand') {
      const payload = { fromRuntimeId: from, entityId: input.entityId, txType: tx.type };
      env.error?.('network', 'INBOUND_ENTITY_UNSIGNED_USER_COMMAND', payload, input.entityId);
      throw new Error(`INBOUND_ENTITY_UNSIGNED_USER_COMMAND:entity=${input.entityId}:txType=${tx.type}`);
    }
    if (!commandState) {
      throw new Error(`INBOUND_ENTITY_COMMAND_STATE_MISSING:${input.entityId}:${input.signerId}`);
    }
    const command = assertSignedEntityCommand(env, commandState, tx.data);
    commandState = advanceEntityCommandNonce(commandState, command);
  }
};

const assertInboundCrossJCommandsUseCanonicalTopology = (
  env: RuntimeReplica,
  authenticatedRuntimeId: string,
  input: RoutedEntityInput,
  deps: RuntimeEntityRoutingDeps,
): void => {
  for (const tx of getEffectiveEntityInputTxs(input)) {
    if (tx.type !== 'prepareCrossJurisdictionSwap') continue;
    const route = extractCrossJurisdictionRouteFromTx(tx);
    if (!route) throw new Error('CROSS_J_RUNTIME_TOPOLOGY_INVALID:route-missing');
    assertInboundCrossJRuntimeTopology(env, route, authenticatedRuntimeId, {
      hasLocalSignerForEntitySigner: deps.hasLocalSignerForEntitySigner,
      resolveRuntimeId: (entityId, signerId) =>
        resolveRuntimeIdForCrossJurisdictionEntity(env, entityId, signerId, deps),
    });
  }
};

const validateInboundP2PEntityInput = (
  env: RuntimeReplica,
  from: string,
  input: RoutedEntityInput,
  deps: RuntimeEntityRoutingDeps,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputValidation => {
  const context = inboundEntityContext(input);
  const localReplicaExists = Array.from(env.state.eReplicas.keys()).some(key => {
    const [entityKey] = String(key).split(':');
    return normalizeEntityKey(entityKey || '') === context.targetEntityId;
  });
  if (!localReplicaExists) {
    return rejectUnavailableInboundTarget(env, input, 'INBOUND_ENTITY_UNKNOWN_TARGET', {
      fromRuntimeId: from,
      entityId: input.entityId,
      txTypes: context.txTypes,
    }, context);
  }
  if (!deps.hasLocalSignerForEntitySigner(env, input.entityId, input.signerId)) {
    return rejectUnavailableInboundTarget(env, input, 'INBOUND_ENTITY_SIGNER_MISMATCH', {
      fromRuntimeId: from,
      entityId: input.entityId,
      signerId: input.signerId,
      txTypes: context.txTypes,
    }, context);
  }

  const infrastructure = deps.ensureRuntimeInfrastructure(env);
  if (infrastructure.halted && !env.scenarioMode) {
    return rejectUnavailableInboundTarget(env, input, 'INBOUND_ENTITY_RUNTIME_HALTED', {
      fromRuntimeId: from,
      entityId: input.entityId,
      txTypes: context.txTypes,
    }, context);
  }

  if (
    infrastructure.persistenceQuiescing &&
    !env.scenarioMode &&
    options.acceptedBeforeQuiesce !== true
  ) {
    // Quiesce cannot silently absorb or defer a committed Account envelope.
    // There is no transport retry contract: reject it loudly so both Runtimes
    // halt with the exact envelope and socket identity available for audit.
    return rejectUnavailableInboundTarget(env, input, 'INBOUND_ENTITY_RUNTIME_QUIESCING', {
      fromRuntimeId: from,
      entityId: input.entityId,
      txTypes: context.txTypes,
    }, context);
  }

  validateInboundEntityCommands(env, from, input);
  assertInboundCrossJCommandsUseCanonicalTopology(env, from, input, deps);
  // Never learn sender routes from raw payload fields. The authenticated
  // account/entity transition registers them only after successful apply.
  return { kind: 'accepted' };
};

export const routeInboundP2PEntityInput = (
  env: RuntimeReplica,
  from: string,
  input: RoutedEntityInput,
  deps: RuntimeEntityRoutingDeps,
  ingressTimestamp?: number,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputResult => {
  const validation = validateInboundP2PEntityInput(env, from, input, deps, options);
  if (validation.kind === 'ignored') return validation;

  // Transport admission only appends authenticated bytes. Reliable frontier
  // registration is a Runtime-frame mutation and must happen inside isolation.
  // `from` is trusted transport provenance. Never retain a peer-supplied value.
  deps.enqueueRuntimeInputs(
    env,
    [{ ...input, from }],
    undefined,
    undefined,
    ingressTimestamp,
    options,
  );
  env.info('network', 'INBOUND_ENTITY_INPUT', { fromRuntimeId: from, entityId: input.entityId }, input.entityId);
  return { kind: 'queued' };
};

type AtomicCrossJPair = NonNullable<RuntimeEntityInputsEnvelope['atomicCrossJurisdictionPair']>;

const validateEntityInputsEnvelopeHeader = (
  env: RuntimeReplica,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  options: RuntimeInboundEntityInputOptions,
): {
  transportSource: string;
  localRuntimeId: string;
  atomicPair: AtomicCrossJPair | undefined;
} => {
  const authenticated = options.envelopeSourceVerified === true
    ? {
        sourceRuntimeId: normalizeRuntimeId(from),
        localRuntimeId: normalizeRuntimeId(env.runtimeId),
      }
    : assertRuntimeEntityInputsEnvelopeSource(env, from, envelope);
  if (!authenticated.sourceRuntimeId || !authenticated.localRuntimeId) {
    throw new Error('INBOUND_ENTITY_INPUTS_TARGET_RUNTIME_INVALID');
  }
  if (
    options.envelopeSourceVerified === true &&
    normalizeRuntimeId(envelope.sourceRuntimeId) !== authenticated.sourceRuntimeId
  ) {
    throw new Error('INBOUND_ENTITY_INPUTS_SOURCE_RUNTIME_MISMATCH');
  }
  if (
    !Number.isSafeInteger(envelope.sourceRuntimeHeight) || envelope.sourceRuntimeHeight < 0 ||
    !Number.isSafeInteger(envelope.sourceRuntimeTimestamp) || envelope.sourceRuntimeTimestamp < 0
  ) {
    throw new Error('INBOUND_ENTITY_INPUTS_SOURCE_FRAME_INVALID');
  }
  if (!Array.isArray(envelope.entityInputs)) throw new Error('INBOUND_ENTITY_INPUTS_INVALID');
  const atomicPair = envelope.atomicCrossJurisdictionPair;
  if (atomicPair && (
    (atomicPair.phase !== 'proposal' && atomicPair.phase !== 'ack') ||
    typeof atomicPair.pairKey !== 'string' ||
    atomicPair.pairKey.length === 0 ||
    envelope.entityInputs.length !== 2
  )) {
    throw new Error('INBOUND_CROSS_J_ATOMIC_COHORT_INVALID');
  }
  if (envelope.entityInputs.length === 0) {
    throw new Error('INBOUND_ENTITY_INPUTS_EMPTY');
  }
  return {
    transportSource: authenticated.sourceRuntimeId,
    localRuntimeId: authenticated.localRuntimeId,
    atomicPair,
  };
};

const validateEnvelopeEntityInputs = (
  env: RuntimeReplica,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeEntityRoutingDeps,
  options: RuntimeInboundEntityInputOptions,
  transportSource: string,
  localRuntimeId: string,
  atomicPair: AtomicCrossJPair | undefined,
): RoutedEntityInput[] => envelope.entityInputs.flatMap(rawInput => {
  const input = options.entityInputsValidated === true
    ? rawInput as RoutedEntityInput
    : validateDeliverableEntityInput(rawInput);
  if (localRuntimeId && normalizeRuntimeId(input.runtimeId) !== localRuntimeId) {
    throw new Error(
      `INBOUND_ENTITY_INPUTS_TARGET_RUNTIME_MISMATCH:expected=${localRuntimeId}:actual=${input.runtimeId}`,
    );
  }
  const validation = validateInboundP2PEntityInput(env, from, input, deps, options);
  return validation.kind === 'accepted'
    ? [{
        ...input,
        from: transportSource,
        sourceRuntimeFrame: {
          height: envelope.sourceRuntimeHeight,
          timestamp: envelope.sourceRuntimeTimestamp,
        },
        ...(atomicPair ? { atomicCrossJurisdictionPair: { ...atomicPair } } : {}),
      }]
    : [];
});

const assertAtomicCrossJEnvelope = (
  inputs: RoutedEntityInput[],
  atomicPair: AtomicCrossJPair | undefined,
): void => {
  const hasCrossJProposal = inputs.some(input =>
    effectiveAccountInputs(input).some(accountInput => {
      const proposal = accountInputProposal(accountInput);
      return proposal?.frame.accountTxs.some(tx =>
        (tx.type === 'cross_pull_lock' && tx.data.crossJurisdiction) ||
        tx.type === 'cross_pull_close' ||
        tx.type === 'cross_swap_fill_ack' ||
        tx.type === 'cross_pull_progress') === true;
    }),
  );
  if (!hasCrossJProposal && !atomicPair) return;
  const pairs = selectPotentialCrossJAccountInputPairs(inputs);
  const exactPair = atomicPair !== undefined &&
    inputs.length === 2 &&
    pairs.length === 1 &&
    pairs[0]!.pairKey === atomicPair.pairKey &&
    new Set([pairs[0]!.sourceInputIndex, pairs[0]!.targetInputIndex]).size === 2;
  if (!exactPair) throw new Error('INBOUND_CROSS_J_ATOMIC_ENVELOPE_INVALID');
};

export const validateInboundP2PEntityInputsEnvelope = (
  env: RuntimeReplica,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeEntityRoutingDeps,
  options: RuntimeInboundEntityInputOptions = {},
): RoutedEntityInput[] => {
  const { transportSource, localRuntimeId, atomicPair } =
    validateEntityInputsEnvelopeHeader(env, from, envelope, options);
  const validatedInputs = validateEnvelopeEntityInputs(
    env,
    from,
    envelope,
    deps,
    options,
    transportSource,
    localRuntimeId,
    atomicPair,
  );
  assertAtomicCrossJEnvelope(validatedInputs, atomicPair);
  // Pairing is state-dependent: an older Account ACK from the same ordered
  // transport may still be queued immediately before this envelope. Filtering
  // here would inspect stale Account pendingFrame state and destroy one leg of
  // an otherwise valid atomic admission. Runtime apply performs the two-phase
  // atomic admission after earlier inputs have advanced state, then commits both legs
  // or ignores both with a security incident.
  return validatedInputs;
};

export const routeInboundP2PEntityInputs = (
  env: RuntimeReplica,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeEntityRoutingDeps,
  _ingressTimestamp?: number,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputsResult => {
  // Validate the complete envelope before appending any bytes.
  const inputs = validateInboundP2PEntityInputsEnvelope(env, from, envelope, deps, options);
  if (inputs.length > 0) {
    deps.enqueueRuntimeInputs(env, inputs, undefined, undefined, envelope.sourceRuntimeTimestamp, options);
    traceAccountDeliveryHop('runtime-mempool', envelope, {
      runtimeId: env.runtimeId,
      peerRuntimeId: from,
      queuedInputs: inputs.length,
      runtimeMempoolEntityInputs: env.runtimeMempool?.entityInputs.length ?? null,
    });
    env.info('network', 'INBOUND_ENTITY_INPUTS', {
      fromRuntimeId: from,
      sourceRuntimeHeight: envelope.sourceRuntimeHeight,
      inputCount: inputs.length,
    });
  }
  return {
    kind: inputs.length > 0 ? 'queued' : 'ignored',
    queuedInputs: inputs,
  };
};

export const createRuntimeOutputRoutingDeps = (
  deps: RuntimeEntityRoutingDeps,
): RuntimeOutputRoutingDeps => ({
  ensureRuntimeInfrastructure: deps.ensureRuntimeInfrastructure,
  getP2P: deps.getP2P,
  enqueueRuntimeInputs: (env, inputs, _runtimeTxs, _jInputs, ingressTimestamp) => {
    deps.enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp);
  },
  extractEntityId: deps.extractEntityId,
  hasLocalSignerForEntity: deps.hasLocalSignerForEntity,
  hasLocalSignerForEntitySigner: deps.hasLocalSignerForEntitySigner,
  resolveSoleLocalSignerForEntity: deps.resolveSoleLocalSignerForEntity,
  resolveRuntimeIdForEntity: (env, entityId) => resolveRuntimeIdForEntity(env, entityId, deps),
  resolveRuntimeIdForCrossJurisdictionEntity: (env, entityId, signerId) =>
    resolveRuntimeIdForCrossJurisdictionEntity(env, entityId, signerId, deps),
});
