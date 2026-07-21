import type {
  AccountInput,
  AccountTx,
  CrossJurisdictionBookAdmissionReceipt,
  EntityInput,
  EntityReplica,
  Env,
  JInput,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
  RuntimeEntityInputsEnvelope,
  RuntimeTx,
} from '../types';
import type { Profile } from '../networking/gossip';
import type { RuntimeOutputRoutingDeps } from './output-routing';
import { extractCrossJurisdictionRouteFromTx } from '../extensions/cross-j/boundary';
import { getEffectiveEntityInputTxs } from '../entity/consensus/output-envelope';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { registerReliableIngress } from './reliable-delivery';
import { advanceEntityCommandNonce, assertSignedEntityCommand } from '../entity/command';
import { validateDeliverableEntityInput } from '../validation-utils';
import { accountInputAck, accountInputProposal } from '../account/consensus/flush';
import { createStructuredLogger } from '../infra/logger';

const routingLog = createStructuredLogger('network.entity-routing');

type RuntimeState = NonNullable<Env['runtimeState']>;

export type RuntimeInboundEntityInputOptions = {
  /** The transport accepted this exact input before persistence quiescing began. */
  acceptedBeforeQuiesce?: boolean;
};

export type RuntimeEntityRoutingDeps = {
  ensureRuntimeState(env: Env): RuntimeState;
  enqueueRuntimeInputs(
    env: Env,
    inputs?: EntityInput[],
    runtimeTxs?: RuntimeTx[],
    jInputs?: JInput[],
    ingressTimestamp?: number,
    options?: RuntimeInboundEntityInputOptions,
  ): void;
  extractEntityId(replicaKey: string): string;
  hasLocalSignerForEntity(env: Env, entityId: string): boolean;
  hasLocalSignerForEntitySigner(env: Env, entityId: string, signerId: string): boolean;
  resolveSoleLocalSignerForEntity(env: Env, entityId: string): string | null;
  getP2P: RuntimeOutputRoutingDeps['getP2P'];
};

export type RuntimeInboundEntityInputResult =
  | { kind: 'queued' }
  | { kind: 'pending' }
  | { kind: 'ignored' }
  | { kind: 'receipt'; receipt: ReliableDeliveryReceipt };

export type RuntimeInboundEntityInputsResult = {
  kind: 'queued' | 'pending' | 'ignored';
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
  leg: 'source' | 'target';
  accountInput: AccountInput;
  pulls: Array<Extract<AccountTx, { type: 'pull_lock' }>>;
  targetReceipts: CrossJurisdictionBookAdmissionReceipt[];
  alreadyCommitted: boolean;
};

const admissionKey = (orderId: string, routeHash: string): string =>
  `${String(orderId || '').trim()}\u0000${String(routeHash || '').trim().toLowerCase()}`;

const admissionOriginKey = (input: RoutedEntityInput): string => {
  if (!input.from) return 'local';
  const runtimeId = normalizeRuntimeId(input.from);
  return runtimeId ? `remote:${runtimeId}` : 'remote:missing';
};

const admissionPairKey = (input: RoutedEntityInput, routeKeys: readonly string[]): string =>
  `${admissionOriginKey(input)}\u0000${[...routeKeys].sort().join('\u0001')}`;

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
  if (bindings.some(binding => !binding.targetReceipt)) return null;
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
    pairKey: admissionPairKey(input, routeKeys),
    leg: 'source',
    accountInput,
    pulls,
    targetReceipts: bindings.map(binding => binding.targetReceipt!),
    alreadyCommitted: false,
  };
};

const findInputReplica = (
  env: Env,
  input: RoutedEntityInput,
): EntityReplica | null =>
  ([...env.eReplicas.values()].find(candidate =>
    normalizeEntityKey(candidate.entityId) === normalizeEntityKey(input.entityId) &&
    normalizeEntityKey(candidate.signerId) === normalizeEntityKey(input.signerId)) ?? null);

const findReplicaAccount = (
  env: Env,
  input: RoutedEntityInput,
  counterpartyId: string,
) => {
  const replica = findInputReplica(env, input);
  if (!replica) return null;
  const target = normalizeEntityKey(counterpartyId);
  return [...replica.state.accounts.entries()].find(([key]) => normalizeEntityKey(key) === target)?.[1] ?? null;
};

const proposalAlreadyCommitted = (
  env: Env,
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

const targetAdmissionCandidate = (
  env: Env,
  input: RoutedEntityInput,
  inputIndex: number,
  accountInput: AccountInput,
): CrossJAdmissionCandidate | null => {
  const ack = accountInputAck(accountInput);
  if (!ack) return null;
  const account = findReplicaAccount(env, input, accountInput.fromEntityId);
  const frameMatchesAck = (frame: NonNullable<typeof account>['currentFrame'] | undefined): boolean =>
    frame?.height === ack.height &&
    String(frame.stateHash || '').toLowerCase() === String(ack.frameHash || '').toLowerCase();
  const pending = account?.pendingFrame;
  const current = account?.currentFrame;
  const frame = frameMatchesAck(pending)
    ? pending
    : frameMatchesAck(current)
      ? current
      : null;
  if (!frame) return null;
  const pulls = crossPulls(frame.accountTxs, 'target');
  if (pulls.length === 0) return null;
  const routeKeys = pulls.map(pull => admissionKey(
    pull.data.crossJurisdiction!.orderId,
    pull.data.crossJurisdiction!.routeHash,
  ));
  if (new Set(routeKeys).size !== routeKeys.length) return null;
  return {
    inputIndex,
    routeKeys,
    pairKey: admissionPairKey(input, routeKeys),
    leg: 'target',
    accountInput,
    pulls,
    targetReceipts: [],
    alreadyCommitted: frame === current,
  };
};

const targetPullMatchesReceipt = (
  candidate: CrossJAdmissionCandidate,
  pull: Extract<AccountTx, { type: 'pull_lock' }>,
  receipt: CrossJurisdictionBookAdmissionReceipt,
): boolean => {
  const binding = pull.data.crossJurisdiction;
  return candidate.leg === 'target' && Boolean(binding) &&
    receipt.leg === 'target' &&
    admissionKey(receipt.orderId, receipt.routeHash) ===
      admissionKey(binding!.orderId, binding!.routeHash) &&
    normalizeEntityKey(receipt.hubEntityId) === normalizeEntityKey(candidate.accountInput.toEntityId) &&
    normalizeEntityKey(receipt.counterpartyEntityId) === normalizeEntityKey(candidate.accountInput.fromEntityId) &&
    receipt.pullId === pull.data.pullId &&
    receipt.tokenId === pull.data.tokenId &&
    receipt.signedAmount === pull.data.amount &&
    receipt.revealedUntilTimestamp === pull.data.revealedUntilTimestamp &&
    receipt.fullHash.toLowerCase() === String(pull.data.fullHash || '').toLowerCase() &&
    receipt.partialRoot.toLowerCase() === String(pull.data.partialRoot || '').toLowerCase();
};

const targetFrameMatchesReceipts = (
  target: CrossJAdmissionCandidate,
  receipts: readonly CrossJurisdictionBookAdmissionReceipt[],
): boolean => target.pulls.length === receipts.length &&
  target.pulls.every(pull =>
    receipts.filter(receipt => targetPullMatchesReceipt(target, pull, receipt)).length === 1);

export type CrossJAccountInputPair = {
  pairKey: string;
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
  droppedInputIndexes: number[];
};

export type PotentialCrossJAccountInputPair = {
  sourceInputIndex: number;
  targetInputIndex: number;
};

/**
 * Structural pairing used only to keep a contiguous reliable ACK in the same
 * Runtime candidate batch as its source leg. It deliberately does not approve
 * money: the strict selector below re-checks the ACK against the target Hub's
 * pending Account frame after earlier causal ACKs have advanced that state.
 */
export const selectPotentialCrossJAccountInputPairs = (
  inputs: readonly RoutedEntityInput[],
): PotentialCrossJAccountInputPair[] => {
  const sources = inputs.flatMap((input, inputIndex) =>
    effectiveAccountInputs(input).flatMap(accountInput => {
      const source = sourceAdmissionCandidate(input, inputIndex, accountInput);
      return source ? [source] : [];
    }));
  const claimedTargets = new Set<number>();
  const pairs: PotentialCrossJAccountInputPair[] = [];
  for (const source of sources) {
    const receipts = source.targetReceipts;
    if (receipts.length === 0) continue;
    const sourceInput = inputs[source.inputIndex]!;
    const targets = inputs.flatMap((input, inputIndex) => {
      if (inputIndex === source.inputIndex || claimedTargets.has(inputIndex)) return [];
      if (!sameSourceRuntimeFrame(sourceInput, input)) return [];
      if (admissionOriginKey(input) !== admissionOriginKey(sourceInput)) return [];
      if (receipts.some(receipt =>
        normalizeEntityKey(input.entityId) !== normalizeEntityKey(receipt.hubEntityId))) return [];
      const matchingAcks = effectiveAccountInputs(input).filter(accountInput =>
        Boolean(accountInputAck(accountInput)) &&
        receipts.every(receipt =>
          normalizeEntityKey(accountInput.toEntityId) === normalizeEntityKey(receipt.hubEntityId) &&
          normalizeEntityKey(accountInput.fromEntityId) === normalizeEntityKey(receipt.counterpartyEntityId)));
      return matchingAcks.length === 1 ? [inputIndex] : [];
    });
    if (targets.length !== 1) continue;
    claimedTargets.add(targets[0]!);
    pairs.push({ sourceInputIndex: source.inputIndex, targetInputIndex: targets[0]! });
  }
  return pairs;
};

const collectCrossJAdmissionCandidates = (
  env: Env,
  inputs: readonly RoutedEntityInput[],
): CrossJAdmissionCandidate[] => inputs.flatMap((input, inputIndex) => {
  const replica = findInputReplica(env, input);
  if (replica?.state.profile?.isHub !== true) return [];
  return effectiveAccountInputs(input).flatMap(accountInput => {
    const source = sourceAdmissionCandidate(input, inputIndex, accountInput);
    if (source) source.alreadyCommitted = proposalAlreadyCommitted(env, input, accountInput);
    return [
      source,
      targetAdmissionCandidate(env, input, inputIndex, accountInput),
    ].filter((candidate): candidate is CrossJAdmissionCandidate => candidate !== null);
  });
});

/**
 * Cross-j admission is the only cross-runtime Account phase that requires two
 * sibling legs in one receiver Runtime candidate. Reliable delivery may carry
 * those legs from adjacent source R-frames, so source runtime identity (not
 * source frame height) is the shared boundary. The exact target receipt, pull,
 * route and both signed Account frames remain the monetary binding. A target
 * proposal remains a normal single input; its ACK is admitted only beside the
 * matching source proposal. Later fill/close Account traffic remains ordinary
 * bilateral consensus traffic.
 */
export const selectMatchedCrossJAccountInputPairs = (
  env: Env,
  inputs: readonly RoutedEntityInput[],
): CrossJAccountInputPairSelection => {
  const candidates = collectCrossJAdmissionCandidates(env, inputs);
  if (candidates.length === 0) return { inputs: [...inputs], pairs: [], droppedInputIndexes: [] };

  // A byte-exact Account frame already present in durable state is transport
  // replay, not a new monetary leg. Let bilateral consensus emit its missing
  // ACK independently; requiring the sibling again would turn packet loss into
  // an alert/retry loop after a successful atomic commit.
  const uncommittedCandidates = candidates.filter(candidate => !candidate.alreadyCommitted);
  const byKey = new Map<string, CrossJAdmissionCandidate[]>();
  for (const candidate of uncommittedCandidates) {
    const group = byKey.get(candidate.pairKey) ?? [];
    group.push(candidate);
    byKey.set(candidate.pairKey, group);
  }
  const candidateCounts = new Map<number, number>();
  for (const candidate of uncommittedCandidates) {
    candidateCounts.set(candidate.inputIndex, (candidateCounts.get(candidate.inputIndex) ?? 0) + 1);
  }
  const invalidIndexes = new Set([...candidateCounts]
    .filter(([, count]) => count !== 1)
    .map(([inputIndex]) => inputIndex));
  const pairs: CrossJAccountInputPair[] = [];
  for (const [pairKey, group] of byKey) {
    const sources = group.filter(candidate => candidate.leg === 'source');
    const targets = group.filter(candidate => candidate.leg === 'target');
    const groupIndexes = new Set(group.map(candidate => candidate.inputIndex));
    if (
      sources.length !== 1 ||
      targets.length !== 1 ||
      groupIndexes.size !== 2 ||
      [...groupIndexes].some(inputIndex => invalidIndexes.has(inputIndex))
    ) {
      groupIndexes.forEach(inputIndex => invalidIndexes.add(inputIndex));
      continue;
    }
    const receipts = sources[0]!.targetReceipts;
    if (!targetFrameMatchesReceipts(targets[0]!, receipts)) {
      groupIndexes.forEach(inputIndex => invalidIndexes.add(inputIndex));
      continue;
    }
    const sourceInput = inputs[sources[0]!.inputIndex]!;
    const targetInput = inputs[targets[0]!.inputIndex]!;
    const sourceProposal = accountInputProposal(sources[0]!.accountInput);
    const targetAck = accountInputAck(targets[0]!.accountInput);
    if (!sourceProposal || !targetAck) {
      groupIndexes.forEach(inputIndex => invalidIndexes.add(inputIndex));
      continue;
    }
    pairs.push({
      pairKey,
      sourceInputIndex: sources[0]!.inputIndex,
      targetInputIndex: targets[0]!.inputIndex,
      sourceAccountFrame: {
        entityId: sourceInput.entityId,
        signerId: sourceInput.signerId,
        counterpartyEntityId: sources[0]!.accountInput.fromEntityId,
        height: sourceProposal.frame.height,
        stateHash: sourceProposal.frame.stateHash,
      },
      targetAccountFrame: {
        entityId: targetInput.entityId,
        signerId: targetInput.signerId,
        counterpartyEntityId: targets[0]!.accountInput.fromEntityId,
        height: targetAck.height,
        stateHash: targetAck.frameHash,
      },
    });
  }
  const allCandidateIndexes = new Set(uncommittedCandidates.map(candidate => candidate.inputIndex));
  const pairedIndexes = new Set(pairs.flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]));
  const droppedInputIndexes = [...allCandidateIndexes]
    .filter(inputIndex => invalidIndexes.has(inputIndex) || !pairedIndexes.has(inputIndex))
    .sort((left, right) => left - right);
  const dropped = new Set(droppedInputIndexes);
  return {
    inputs: inputs.filter((_input, inputIndex) => !dropped.has(inputIndex)),
    pairs: pairs.filter(pair => !dropped.has(pair.sourceInputIndex) && !dropped.has(pair.targetInputIndex)),
    droppedInputIndexes,
  };
};

export const filterMatchedCrossJAccountInputPairs = (
  env: Env,
  inputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => selectMatchedCrossJAccountInputPairs(env, inputs).inputs;

const runtimeRoutingTimestamp = (env: Env): number => {
  const timestamp = Math.floor(Number(env.timestamp ?? 0));
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
};

const resolveRuntimeIdFromProfile = (profile: Profile | undefined): string | null => {
  const runtimeId = normalizeRuntimeId(String(profile?.runtimeId || ''));
  return runtimeId || null;
};

export const resolveRuntimeIdForEntity = (
  env: Env,
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

export const hasLocalEntityReplica = (
  env: Env,
  entityId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'extractEntityId'>,
): boolean => {
  const target = normalizeEntityKey(entityId);
  return Array.from(env.eReplicas.keys()).some(key => {
    try {
      return normalizeEntityKey(deps.extractEntityId(key)) === target;
    } catch {
      return false;
    }
  });
};

export const resolveRuntimeIdForCrossJurisdictionEntity = (
  env: Env,
  entityId: string,
  deps: Pick<RuntimeEntityRoutingDeps, 'ensureRuntimeState' | 'extractEntityId' | 'hasLocalSignerForEntity'>,
): string | null => {
  const localRuntimeId = normalizeRuntimeId(String(env.runtimeId || ''));
  if (localRuntimeId && deps.hasLocalSignerForEntity(env, entityId)) return localRuntimeId;
  return resolveRuntimeIdForEntity(env, entityId, deps);
};

export const registerEntityRuntimeHint = (
  env: Env,
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
  env: Env,
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

export const validateInboundP2PEntityInput = (
  env: Env,
  from: string,
  input: RoutedEntityInput,
  deps: RuntimeEntityRoutingDeps,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputValidation => {
  const txTypes = input.entityTxs?.map(tx => tx.type).join(',') || 'none';
  const targetEntityId = String(input.entityId || '').toLowerCase();
  const localReplicaExists = Array.from(env.eReplicas.keys()).some(key => {
    const [entityKey] = String(key).split(':');
    return String(entityKey || '').toLowerCase() === targetEntityId;
  });
  if (!localReplicaExists) {
    const payload = {
      fromRuntimeId: from,
      entityId: input.entityId,
      txTypes,
    };
    if ((input.entityTxs?.length ?? 0) > 0) {
      env.error?.('network', 'INBOUND_ENTITY_UNKNOWN_TARGET', payload, input.entityId);
      throw new Error(
        `INBOUND_ENTITY_UNKNOWN_TARGET: entity=${input.entityId} signer=${input.signerId} txTypes=${txTypes}`,
      );
    }
    env.warn('network', 'INBOUND_ENTITY_UNKNOWN_TARGET', payload, input.entityId);
    return { kind: 'ignored' };
  }
  if (!deps.hasLocalSignerForEntitySigner(env, input.entityId, input.signerId)) {
    if ((input.entityTxs?.length ?? 0) > 0) {
      env.error?.(
        'network',
        'INBOUND_ENTITY_SIGNER_MISMATCH',
        {
          fromRuntimeId: from,
          entityId: input.entityId,
          signerId: input.signerId,
          txTypes,
        },
        input.entityId,
      );
      throw new Error(
        `INBOUND_ENTITY_SIGNER_MISMATCH: entity=${input.entityId} signer=${input.signerId} txTypes=${txTypes}`,
      );
    }
    env.warn(
      'network',
      'INBOUND_ENTITY_SIGNER_MISMATCH',
      {
        fromRuntimeId: from,
        entityId: input.entityId,
        signerId: input.signerId,
        txTypes,
      },
      input.entityId,
    );
    return { kind: 'ignored' };
  }

  const runtimeState = deps.ensureRuntimeState(env);
  if (runtimeState.halted && !env.scenarioMode) {
    const payload = { fromRuntimeId: from, entityId: input.entityId, txTypes };
    if ((input.entityTxs?.length ?? 0) > 0) {
      env.error?.('network', 'INBOUND_ENTITY_RUNTIME_HALTED', payload, input.entityId);
      throw new Error(
        `INBOUND_ENTITY_RUNTIME_HALTED: entity=${input.entityId} signer=${input.signerId} txTypes=${txTypes}`,
      );
    }
    env.warn?.('network', 'INBOUND_ENTITY_RUNTIME_HALTED', payload, input.entityId);
    return { kind: 'ignored' };
  }

  if (
    runtimeState.persistenceQuiescing &&
    !env.scenarioMode &&
    options.acceptedBeforeQuiesce !== true
  ) {
    const payload = { fromRuntimeId: from, entityId: input.entityId, txTypes };
    if ((input.entityTxs?.length ?? 0) > 0) {
      // Persistence quiesce is bounded transport backpressure, not state
      // corruption. The sender receives the explicit failure and its durable
      // lane retries the same input after publication completes.
      env.info?.('network', 'INBOUND_ENTITY_RUNTIME_QUIESCING', payload, input.entityId);
      throw new Error(
        `INBOUND_ENTITY_RUNTIME_QUIESCING: entity=${input.entityId} signer=${input.signerId} txTypes=${txTypes}`,
      );
    }
    env.warn?.('network', 'INBOUND_ENTITY_RUNTIME_QUIESCING', payload, input.entityId);
    return { kind: 'ignored' };
  }

  const targetReplica = Array.from(env.eReplicas.values()).find(replica =>
    String(replica.entityId || '').toLowerCase() === targetEntityId &&
    String(replica.signerId || '').toLowerCase() === String(input.signerId || '').toLowerCase());
  let commandState = targetReplica?.state;
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
    if (!commandState) throw new Error(`INBOUND_ENTITY_COMMAND_STATE_MISSING:${input.entityId}:${input.signerId}`);
    const command = assertSignedEntityCommand(env, commandState, tx.data);
    commandState = advanceEntityCommandNonce(commandState, command);
  }

  // Never learn sender routes from raw payload fields. The authenticated
  // account/entity transition registers them only after successful apply.

  return { kind: 'accepted' };
};

export const handleInboundP2PEntityInput = (
  env: Env,
  from: string,
  input: RoutedEntityInput,
  deps: RuntimeEntityRoutingDeps,
  ingressTimestamp?: number,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputResult => {
  const validation = validateInboundP2PEntityInput(env, from, input, deps, options);
  if (validation.kind === 'ignored') return validation;

  const reliableIngress = registerReliableIngress(env, from, input);
  if (reliableIngress.kind === 'pending') return { kind: 'pending' };
  if (reliableIngress.kind === 'receipt') {
    return { kind: 'receipt', receipt: reliableIngress.receipt };
  }
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

export const validateInboundP2PEntityInputsEnvelope = (
  env: Env,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeEntityRoutingDeps,
  options: RuntimeInboundEntityInputOptions = {},
): RoutedEntityInput[] => {
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
  if (!Array.isArray(envelope.entityInputs) || envelope.entityInputs.length === 0) {
    throw new Error('INBOUND_ENTITY_INPUTS_EMPTY');
  }
  const localRuntimeId = normalizeRuntimeId(env.runtimeId);
  const validatedInputs = envelope.entityInputs.flatMap(rawInput => {
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
        }]
      : [];
  });
  const sourceIndexes = validatedInputs.flatMap((input, inputIndex) =>
    effectiveAccountInputs(input).some(accountInput =>
      sourceAdmissionCandidate(input, inputIndex, accountInput) !== null)
      ? [inputIndex]
      : []);
  if (sourceIndexes.length > 0) {
    const pairs = selectPotentialCrossJAccountInputPairs(validatedInputs);
    const exactPair = sourceIndexes.length === 1 && validatedInputs.length === 2 && pairs.length === 1 &&
      pairs[0]!.sourceInputIndex === sourceIndexes[0] &&
      new Set([pairs[0]!.sourceInputIndex, pairs[0]!.targetInputIndex]).size === 2;
    if (!exactPair) throw new Error('INBOUND_CROSS_J_ATOMIC_ENVELOPE_INVALID');
  }
  // Pairing is state-dependent: an older Account ACK from the same ordered
  // transport may still be queued immediately before this envelope. Filtering
  // here would inspect stale Account pendingFrame state and destroy one leg of
  // an otherwise valid atomic admission. Runtime apply performs the two-phase
  // preflight after earlier inputs have advanced state, then commits both legs
  // or ignores both with a security incident.
  return validatedInputs;
};

export const handleInboundP2PEntityInputs = (
  env: Env,
  from: string,
  envelope: RuntimeEntityInputsEnvelope,
  deps: RuntimeEntityRoutingDeps,
  ingressTimestamp?: number,
  options: RuntimeInboundEntityInputOptions = {},
): RuntimeInboundEntityInputsResult => {
  // Validate the complete envelope before mutating reliable ledgers or queues.
  const inputs = validateInboundP2PEntityInputsEnvelope(env, from, envelope, deps, options);
  const atomicCrossJInputIndexes = new Set(
    selectPotentialCrossJAccountInputPairs(inputs)
      .flatMap(pair => [pair.sourceInputIndex, pair.targetInputIndex]),
  );
  const queued: RoutedEntityInput[] = [];
  const receipts: ReliableDeliveryReceipt[] = [];
  const registrationTrace: Array<{ inputIndex: number; entityId: string; kind: string }> = [];
  let pending = false;
  for (const [inputIndex, input] of inputs.entries()) {
    const registration = registerReliableIngress(env, from, input, {
      allowContiguousPendingAccountAck: atomicCrossJInputIndexes.has(inputIndex),
    });
    if (atomicCrossJInputIndexes.size > 0) {
      registrationTrace.push({ inputIndex, entityId: input.entityId, kind: registration.kind });
    }
    if (registration.kind === 'pending') {
      pending = true;
      continue;
    }
    if (registration.kind === 'receipt') {
      receipts.push(registration.receipt);
      continue;
    }
    queued.push(input);
  }
  if (atomicCrossJInputIndexes.size > 0) {
    routingLog.info('crossj.atomic_envelope_ingress', {
      sourceRuntimeId: envelope.sourceRuntimeId,
      sourceRuntimeHeight: envelope.sourceRuntimeHeight,
      inputCount: inputs.length,
      registrationTrace,
    });
  }
  if (queued.length > 0) {
    deps.enqueueRuntimeInputs(env, queued, undefined, undefined, ingressTimestamp, options);
    env.info('network', 'INBOUND_ENTITY_INPUTS', {
      fromRuntimeId: from,
      sourceRuntimeHeight: envelope.sourceRuntimeHeight,
      inputCount: queued.length,
    });
  }
  return {
    kind: queued.length > 0 ? 'queued' : pending ? 'pending' : 'ignored',
    receipts,
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
