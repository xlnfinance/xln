import type { AccountInput, AccountFrame, AccountTx } from '../types/account';
import type { EntityInput, EntityReplica } from '../entity/types';
import type { RuntimeReplica, ReliableDeliveryReceipt, RoutedEntityInput, RuntimeEntityInputsEnvelope, RuntimeTx } from './types';
import type { JInput } from '../jurisdiction/input';
import type { EntityTx } from '../types/entity-tx';
import type { Profile } from '../entity/profile';
import type { RuntimeOutputRoutingDeps } from './output-routing';
import { extractCrossJurisdictionRouteFromTx } from '../extensions/cross-j/boundary';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { advanceEntityCommandNonce, assertSignedEntityCommand } from '../entity/command';
import { validateDeliverableEntityInput } from './routing-validation';
import { accountInputAck, accountInputProposal } from '../account/consensus/flush';
import { safeStringify } from '../protocol/serialization';
import {
  cloneCrossJurisdictionRoute,
  withCanonicalCrossJurisdictionRouteHash,
} from '../extensions/cross-j';
import { recordRuntimeSecurityIncident } from './security-incidents';

type RuntimeLifecycleState = NonNullable<RuntimeReplica['runtimeState']>;

export type RuntimeInboundEntityInputOptions = {
  /** The transport accepted this exact input before persistence quiescing began. */
  acceptedBeforeQuiesce?: boolean;
};

export type RuntimeEntityRoutingDeps = {
  ensureRuntimeState(env: RuntimeReplica): RuntimeLifecycleState;
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
  receipts: ReliableDeliveryReceipt[];
};

export type RuntimeInboundEntityInputValidation =
  | { kind: 'accepted' }
  | { kind: 'ignored' };

const normalizeEntityKey = (value: string): string => String(value || '').toLowerCase();
const RUNTIME_HINT_TTL_MS = 60_000;

type CrossJAdmissionCandidate = {
  inputIndex: number;
  routeKeys: string[];
  pairKey: string;
  phase: 'proposal' | 'ack';
  leg: 'source' | 'target';
  accountInput: AccountInput;
  frame: AccountFrame;
  pulls: Array<Extract<AccountTx, { type: 'pull_lock' }>>;
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

const crossPulls = (
  accountTxs: readonly AccountTx[],
  leg: 'source' | 'target',
): Array<Extract<AccountTx, { type: 'pull_lock' }>> =>
  accountTxs.filter((tx): tx is Extract<AccountTx, { type: 'pull_lock' }> =>
    tx.type === 'pull_lock' && tx.data.crossJurisdiction?.leg === leg);

type CrossJCloseTx = Extract<AccountTx, { type: 'cross_pull_close' }>;

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

const effectiveAccountInputs = (input: RoutedEntityInput): AccountInput[] =>
  getEffectiveEntityInputTxs(input).flatMap(tx => tx.type === 'accountInput' ? [tx.data] : []);

const sourceAdmissionCandidate = (
  input: RoutedEntityInput,
  inputIndex: number,
  accountInput: AccountInput,
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
  accountInput: AccountInput,
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
  accountInput: AccountInput,
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
  pull: Extract<AccountTx, { type: 'pull_lock' }>,
): NonNullable<Extract<AccountTx, { type: 'pull_lock' }>['data']['crossJurisdictionRoute']> | null =>
  pull.data.crossJurisdictionRoute ?? null;

const pairedPullListsMatch = (
  sourcePulls: readonly Extract<AccountTx, { type: 'pull_lock' }>[],
  targetPulls: readonly Extract<AccountTx, { type: 'pull_lock' }>[],
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

export type CrossJAccountInputPair = {
  pairKey: string;
  phase: 'proposal' | 'ack';
  sourceInputIndex: number;
  targetInputIndex: number;
  sourceAccountFrame: CrossJAccountFrameExpectation;
  targetAccountFrame: CrossJAccountFrameExpectation;
};

export type CrossJAccountFrameExpectation = {
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

export type CrossJRejectedAccountInput = {
  inputIndex: number;
  accountInput: AccountInput;
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
  accountInput: AccountInput;
  frame: AccountFrame;
  sourcePulls: Array<Extract<AccountTx, { type: 'pull_lock' }>>;
  targetPulls: Array<Extract<AccountTx, { type: 'pull_lock' }>>;
  sourceCloses: CrossJCloseTx[];
  targetCloses: CrossJCloseTx[];
  alreadyCommitted: boolean;
  valid: boolean;
};

const buildCrossJProposalFrameCandidate = (
  input: RoutedEntityInput,
  inputIndex: number,
  accountInput: AccountInput,
): CrossJAdmissionFrameCandidate | null => {
  const proposal = accountInputProposal(accountInput);
  if (!proposal) return null;
  const sourcePulls = crossPulls(proposal.frame.accountTxs, 'source');
  const targetPulls = crossPulls(proposal.frame.accountTxs, 'target');
  const sourceCloses = crossCloses(proposal.frame.accountTxs, 'source');
  const targetCloses = crossCloses(proposal.frame.accountTxs, 'target');
  if (
    sourcePulls.length === 0 &&
    targetPulls.length === 0 &&
    sourceCloses.length === 0 &&
    targetCloses.length === 0
  ) return null;
  const source = sourceAdmissionCandidate(input, inputIndex, accountInput);
  const target = targetProposalCandidate(input, inputIndex, accountInput);
  const routeKeys = [
    ...[...sourcePulls, ...targetPulls].map(pull => `open\u0000${admissionKey(
      pull.data.crossJurisdiction!.orderId,
      pull.data.crossJurisdiction!.routeHash,
    )}`),
    ...[...sourceCloses, ...targetCloses].map(crossCloseKey),
  ];
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
    alreadyCommitted: false,
    valid: new Set(routeKeys).size === routeKeys.length &&
      (sourcePulls.length === 0 || source !== null) &&
      (targetPulls.length === 0 || target !== null),
  };
};

const buildCrossJAckFrameCandidate = (
  env: RuntimeReplica,
  input: RoutedEntityInput,
  inputIndex: number,
  accountInput: AccountInput,
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
  if (
    sourcePulls.length === 0 &&
    targetPulls.length === 0 &&
    sourceCloses.length === 0 &&
    targetCloses.length === 0
  ) return null;
  const routeKeys = [
    ...[...sourcePulls, ...targetPulls].map(pull => `open\u0000${admissionKey(
      pull.data.crossJurisdiction!.orderId,
      pull.data.crossJurisdiction!.routeHash,
    )}`),
    ...[...sourceCloses, ...targetCloses].map(crossCloseKey),
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
    alreadyCommitted: frame === account?.currentFrame,
    valid: new Set(routeKeys).size === routeKeys.length,
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
  pairedCloseListsMatch(right.sourceCloses, left.targetCloses);

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
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!;
    const matches = candidates.filter((right, rightIndex) =>
      rightIndex > leftIndex &&
      right.inputIndex !== left.inputIndex &&
      normalizeRuntimeId(inputs[right.inputIndex]!.runtimeId) ===
        normalizeRuntimeId(inputs[left.inputIndex]!.runtimeId) &&
        (options.allowDifferentSourceRuntimeFrames === true ||
          sameSourceRuntimeFrame(inputs[right.inputIndex]!, inputs[left.inputIndex]!)) &&
      admissionOriginKey(inputs[right.inputIndex]!) === admissionOriginKey(inputs[left.inputIndex]!) &&
      admissionFramesMatch(left, right));
    if (matches.length !== 1) continue;
    const right = matches[0]!;
    pairs.push({
      pairKey: left.pairKey,
      sourceInputIndex: left.inputIndex,
      targetInputIndex: right.inputIndex,
    });
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
    if (ackIndexes.length === 2) {
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
  return `${phase}\u0000${pairKey}\u0000${admissionOriginKey(input)}` +
    `\u0000${frame?.height ?? ''}\u0000${frame?.timestamp ?? ''}`;
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
  const invalidIndexes = new Set([...counts]
    .filter(([, count]) => count !== 1)
    .map(([inputIndex]) => inputIndex));
  uncommitted
    .filter(candidate => !candidate.valid)
    .forEach(candidate => invalidIndexes.add(candidate.inputIndex));
  return { candidates: uncommitted, byCohort, invalidIndexes };
};

const matchCrossJCandidateGroups = (
  groups: Iterable<CrossJAdmissionFrameCandidate[]>,
  inputs: readonly RoutedEntityInput[],
  invalidIndexes: Set<number>,
): CrossJAccountInputPair[] => {
  const pairs: CrossJAccountInputPair[] = [];
  for (const group of groups) {
    const groupIndexes = new Set(group.map(candidate => candidate.inputIndex));
    if (
      group.length !== 2 ||
      groupIndexes.size !== 2 ||
      [...groupIndexes].some(inputIndex => invalidIndexes.has(inputIndex))
    ) {
      groupIndexes.forEach(inputIndex => invalidIndexes.add(inputIndex));
      continue;
    }
    const [source, target] = [...group].sort((left, right) => left.inputIndex - right.inputIndex);
    const sourceInput = inputs[source!.inputIndex]!;
    const targetInput = inputs[target!.inputIndex]!;
    if (!sameSourceRuntimeFrame(sourceInput, targetInput) || !admissionFramesMatch(source!, target!)) {
      groupIndexes.forEach(inputIndex => invalidIndexes.add(inputIndex));
      continue;
    }
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
  rejected: ReadonlySet<AccountInput>,
): RoutedEntityInput | null => {
  const entityTxs: EntityTx[] = [];
  for (const tx of input.entityTxs ?? []) {
    if (tx.type === 'accountInput') {
      if (!rejected.has(tx.data)) entityTxs.push(tx);
      continue;
    }
    if (tx.type !== 'consensusOutput' && tx.type !== 'runtimeOutput') {
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
    if (tx.type === 'consensusOutput') {
      // A certified reliable Account output is required to contain exactly one
      // nested transaction. Rewriting a signed mixed payload would invalidate
      // its Hanko, so malformed producers fail loudly instead.
      throw new Error('CROSS_J_CERTIFIED_OUTPUT_PARTIAL_REWRITE_FORBIDDEN');
    }
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
): RoutedEntityInput[] => {
  const rejectedByInput = new Map<number, Set<AccountInput>>();
  for (const candidate of rejectedLegs) {
    const rejected = rejectedByInput.get(candidate.inputIndex) ?? new Set();
    rejected.add(candidate.accountInput);
    rejectedByInput.set(candidate.inputIndex, rejected);
  }
  return inputs.flatMap((input, inputIndex) => {
    const rejected = rejectedByInput.get(inputIndex);
    if (!rejected) return [input];
    const retained = stripRejectedAccountTxs(input, rejected);
    return retained ? [retained] : [];
  });
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
    return accountInputs.map(accountInput => ({ inputIndex, accountInput }));
  });
  return removeRejectedCrossJAccountInputs(inputs, rejectedLegs);
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
  const pairs = matchCrossJCandidateGroups(
    grouped.byCohort.values(),
    inputs,
    grouped.invalidIndexes,
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
  const rejectedInputIndexes = [...new Set([
    ...[...allCandidateIndexes]
      .filter(inputIndex => grouped.invalidIndexes.has(inputIndex) || !pairedIndexes.has(inputIndex)),
    ...atomicInvalidIndexes,
  ])].sort((left, right) => left - right);
  const rejected = new Set(rejectedInputIndexes);
  const rejectedLegs = rejectedInputIndexes.flatMap(inputIndex => {
    const matched = candidates.filter(candidate =>
      candidate.inputIndex === inputIndex);
    const input = inputs[inputIndex];
    const accountInputs = matched.length > 0
      ? matched.map(candidate => candidate.accountInput)
      : input
        ? effectiveAccountInputs(input)
        : [];
    return accountInputs.map(accountInput => ({ inputIndex, accountInput }));
  });
  return {
    inputs: removeRejectedCrossJAccountInputs(
      inputs,
      rejectedLegs,
    ),
    pairs: pairs.filter(pair =>
      !rejected.has(pair.sourceInputIndex) &&
      !rejected.has(pair.targetInputIndex)),
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
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeState'>,
): string | null => {
  const target = normalizeEntityKey(entityId);
  const state = deps.ensureRuntimeState(env);
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
  if (env.gossip?.getProfiles) {
    const profiles = env.gossip.getProfiles() as Profile[];
    const profile = profiles.find((p: Profile) => normalizeEntityKey(String(p.entityId || '')) === target);
    const resolved = resolveRuntimeIdFromProfile(profile);
    if (resolved) {
      hints?.set(target, { runtimeId: resolved, seenAt: now });
      return resolved;
    }
  }
  return null;
};

export const resolveRuntimeIdForCrossJurisdictionEntity = (
  env: RuntimeReplica,
  entityId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeState' | 'extractEntityId' | 'hasLocalSignerForEntity'>,
): string | null => {
  const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  if (localRuntimeId && deps.hasLocalSignerForEntity(env, entityId)) return localRuntimeId;
  return resolveRuntimeIdForEntity(env, entityId, deps);
};

export const registerEntityRuntimeHintWithDeps = (
  env: RuntimeReplica,
  entityId: string,
  runtimeId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeState'>,
): void => {
  if (!entityId || !runtimeId) return;
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  const state = deps.ensureRuntimeState(env);
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
    if (tx.type === 'consensusOutput') continue;
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

export const validateInboundP2PEntityInput = (
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

  const runtimeState = deps.ensureRuntimeState(env);
  if (runtimeState.halted && !env.scenarioMode) {
    return rejectUnavailableInboundTarget(env, input, 'INBOUND_ENTITY_RUNTIME_HALTED', {
      fromRuntimeId: from,
      entityId: input.entityId,
      txTypes: context.txTypes,
    }, context);
  }

  if (
    runtimeState.persistenceQuiescing &&
    !env.scenarioMode &&
    options.acceptedBeforeQuiesce !== true
  ) {
    // Persistence quiesce is bounded transport backpressure, not corruption.
    // The durable sender retries the exact input after publication completes.
    return rejectUnavailableInboundTarget(env, input, 'INBOUND_ENTITY_RUNTIME_QUIESCING', {
      fromRuntimeId: from,
      entityId: input.entityId,
      txTypes: context.txTypes,
    }, context, 'info');
  }

  validateInboundEntityCommands(env, from, input);
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
type CrossJIntent = NonNullable<RuntimeEntityInputsEnvelope['crossJurisdictionIntent']>;

const validateEntityInputsEnvelopeHeader = (
  env: RuntimeReplica,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
): {
  transportSource: string;
  localRuntimeId: string;
  atomicPair: AtomicCrossJPair | undefined;
  rawIntent: CrossJIntent | undefined;
} => {
  const sourceRuntimeId = normalizeRuntimeId(envelope?.sourceRuntimeId);
  const transportSource = normalizeRuntimeId(from);
  if (!sourceRuntimeId || sourceRuntimeId !== transportSource) {
    throw new Error('INBOUND_ENTITY_INPUTS_SOURCE_RUNTIME_MISMATCH');
  }
  if (
    !Number.isSafeInteger(envelope.sourceRuntimeHeight) || envelope.sourceRuntimeHeight < 0 ||
    !Number.isSafeInteger(envelope.sourceRuntimeTimestamp) || envelope.sourceRuntimeTimestamp < 0
  ) {
    throw new Error('INBOUND_ENTITY_INPUTS_SOURCE_FRAME_INVALID');
  }
  if (!Array.isArray(envelope.entityInputs)) throw new Error('INBOUND_ENTITY_INPUTS_INVALID');
  const rawIntent = envelope.crossJurisdictionIntent;
  const atomicPair = envelope.atomicCrossJurisdictionPair;
  if (atomicPair && (
    (atomicPair.phase !== 'proposal' && atomicPair.phase !== 'ack') ||
    typeof atomicPair.pairKey !== 'string' ||
    atomicPair.pairKey.length === 0 ||
    envelope.entityInputs.length !== 2
  )) {
    throw new Error('INBOUND_CROSS_J_ATOMIC_COHORT_INVALID');
  }
  if (rawIntent && envelope.entityInputs.length > 0) {
    throw new Error('INBOUND_CROSS_J_INTENT_MIXED_ENVELOPE');
  }
  if (!rawIntent && envelope.entityInputs.length === 0) {
    throw new Error('INBOUND_ENTITY_INPUTS_EMPTY');
  }
  return {
    transportSource,
    localRuntimeId: normalizeRuntimeId(env.runtimeId),
    atomicPair,
    rawIntent,
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
  const input = validateDeliverableEntityInput(rawInput);
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

const appendCrossJurisdictionIntentInput = (
  env: RuntimeReplica,
  rawIntent: CrossJIntent,
  deps: RuntimeEntityRoutingDeps,
  transportSource: string,
  localRuntimeId: string,
  validatedInputs: RoutedEntityInput[],
): void => {
  const route = withCanonicalCrossJurisdictionRouteHash(rawIntent);
  if (safeStringify(route) !== safeStringify(cloneCrossJurisdictionRoute(rawIntent))) {
    throw new Error('INBOUND_CROSS_J_INTENT_NON_CANONICAL');
  }
  if (route.status !== 'intent' || route.sourcePull || route.targetPull) {
    throw new Error('INBOUND_CROSS_J_INTENT_STATE_INVALID');
  }
  const sourceHubEntityId = normalizeEntityKey(route.source.counterpartyEntityId);
  const targetHubEntityId = normalizeEntityKey(route.target.entityId);
  const sourceHubSignerId = normalizeEntityKey(route.sourceHubSignerId || '');
  const targetHubSignerId = normalizeEntityKey(route.targetHubSignerId || '');
  if (
    !sourceHubEntityId ||
    !targetHubEntityId ||
    !sourceHubSignerId ||
    !targetHubSignerId ||
    !deps.hasLocalSignerForEntitySigner(env, sourceHubEntityId, sourceHubSignerId) ||
    !deps.hasLocalSignerForEntitySigner(env, targetHubEntityId, targetHubSignerId)
  ) {
    throw new Error('INBOUND_CROSS_J_INTENT_HUB_SIBLINGS_NOT_LOCAL');
  }
  const sourceHubReplica = [...env.state.eReplicas.values()].find(replica =>
    normalizeEntityKey(replica.entityId) === sourceHubEntityId &&
    normalizeEntityKey(replica.signerId) === sourceHubSignerId);
  const targetHubReplica = [...env.state.eReplicas.values()].find(replica =>
    normalizeEntityKey(replica.entityId) === targetHubEntityId &&
    normalizeEntityKey(replica.signerId) === targetHubSignerId);
  if (sourceHubReplica?.state.profile.isHub !== true || targetHubReplica?.state.profile.isHub !== true) {
    throw new Error('INBOUND_CROSS_J_INTENT_TARGET_NOT_HUB');
  }
  const sourceUserRuntimeId = resolveRuntimeIdForEntity(env, route.source.entityId, deps);
  const targetUserRuntimeId = resolveRuntimeIdForEntity(env, route.target.counterpartyEntityId, deps);
  if (sourceUserRuntimeId !== transportSource || targetUserRuntimeId !== transportSource) {
    throw new Error('INBOUND_CROSS_J_INTENT_USER_RUNTIME_MISMATCH');
  }
  const existingRoute = sourceHubReplica.state.crossJurisdictionSwaps?.get(route.orderId);
  const queuedRoute = (env.runtimeMempool?.entityInputs ?? []).flatMap(input =>
    (input.entityTxs ?? []).flatMap(tx =>
      tx.type === 'prepareCrossJurisdictionSwap' && tx.data.route.orderId === route.orderId
        ? [tx.data.route]
        : []),
  )[0];
  const priorRoute = existingRoute ?? queuedRoute;
  if (priorRoute && priorRoute.routeHash?.toLowerCase() !== route.routeHash?.toLowerCase()) {
    recordRuntimeSecurityIncident(env, {
      domain: 'cross-j',
      code: 'CROSS_J_INTENT_ORDER_ID_CONFLICT',
      source: 'remote-ingress',
      severity: 'warning',
      summary: 'A repeated unsigned cross-j intent reused an orderId with different immutable terms',
      entityId: sourceHubEntityId,
      routeHash: route.routeHash || '',
    });
    throw new Error(`INBOUND_CROSS_J_INTENT_ORDER_ID_CONFLICT:${route.orderId}`);
  }
  if (!priorRoute) {
    validatedInputs.push({
      entityId: sourceHubEntityId,
      signerId: sourceHubSignerId,
      ...(localRuntimeId ? { runtimeId: localRuntimeId } : {}),
      entityTxs: [{ type: 'prepareCrossJurisdictionSwap', data: { route } }],
    });
  }
};

const assertAtomicCrossJEnvelope = (
  inputs: RoutedEntityInput[],
  atomicPair: AtomicCrossJPair | undefined,
): void => {
  const hasCrossJProposal = inputs.some(input =>
    effectiveAccountInputs(input).some(accountInput => {
      const proposal = accountInputProposal(accountInput);
      return proposal?.frame.accountTxs.some(tx =>
        (tx.type === 'pull_lock' && tx.data.crossJurisdiction) ||
        tx.type === 'cross_pull_close') === true;
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
  const { transportSource, localRuntimeId, atomicPair, rawIntent } =
    validateEntityInputsEnvelopeHeader(env, from, envelope);
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
  if (rawIntent) {
    appendCrossJurisdictionIntentInput(
      env,
      rawIntent,
      deps,
      transportSource,
      localRuntimeId,
      validatedInputs,
    );
  }
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
  ingressTimestamp?: number,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputsResult => {
  // Validate the complete envelope before appending any bytes. Reliable
  // registration is deferred to the isolated Runtime frame for atomic rollback.
  const inputs = validateInboundP2PEntityInputsEnvelope(env, from, envelope, deps, options);
  if (inputs.length > 0) {
    deps.enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp, options);
    env.info('network', 'INBOUND_ENTITY_INPUTS', {
      fromRuntimeId: from,
      sourceRuntimeHeight: envelope.sourceRuntimeHeight,
      inputCount: inputs.length,
    });
  }
  return {
    kind: inputs.length > 0 ? 'queued' : 'ignored',
    receipts: [],
  };
};

export const createRuntimeOutputRoutingDeps = (
  deps: RuntimeEntityRoutingDeps,
): RuntimeOutputRoutingDeps => ({
  ensureRuntimeState: deps.ensureRuntimeState,
  getP2P: deps.getP2P,
  enqueueRuntimeInputs: (env, inputs, _runtimeTxs, _jInputs, ingressTimestamp) => {
    deps.enqueueRuntimeInputs(env, inputs, undefined, undefined, ingressTimestamp);
  },
  extractEntityId: deps.extractEntityId,
  hasLocalSignerForEntity: deps.hasLocalSignerForEntity,
  hasLocalSignerForEntitySigner: deps.hasLocalSignerForEntitySigner,
  resolveSoleLocalSignerForEntity: deps.resolveSoleLocalSignerForEntity,
  resolveRuntimeIdForEntity: (env, entityId) => resolveRuntimeIdForEntity(env, entityId, deps),
  resolveRuntimeIdForCrossJurisdictionEntity: (env, entityId) =>
    resolveRuntimeIdForCrossJurisdictionEntity(env, entityId, deps),
});
