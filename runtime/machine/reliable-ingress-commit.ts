import type {
  Env,
  ReliableDeliveryIdentity,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
} from '../types';
import { isLocalEntityLeaderTimeoutVote } from '../entity/consensus/leader';
import { normalizeRuntimeId } from '../networking/runtime-id';
import {
  assertReliableIdentityDurableInPostState,
  isReliableAccountAckAwaitingCommit,
  isAuthenticatedAppliedStaleJPrefixInput,
  isReliableIdentityTerminalInPostState,
} from './reliable-authority';
import {
  advanceReliableFrontier,
  assertReliableLaneCompatible,
  compareReliableIdentityPosition,
  receiverFrontierKey,
  reliableFrontierCovers,
  reliableIdentityExactKey,
  reliableReceiptCoversIdentity,
  sameReliableIdentityPosition,
} from './reliable-frontier';
import {
  assertReceiverSourceLaneCapacity,
  ensureReliableIngressState,
} from './reliable-ingress-state';
import { splitRoutedOutputByDeliveryLane } from './output-routing';
import {
  createReliableDeliveryReceipt,
  ensureReliableState,
  getInputReliableIdentity,
} from './reliable-receipt';

export type ReliableIngressCommit = {
  key: string | null;
  frontierKey: string;
  receipt: ReliableDeliveryReceipt | null;
  targetRuntimeIds: string[];
  previousActive: ReliableDeliveryReceipt | undefined;
  previousTerminal: ReliableDeliveryReceipt | undefined;
};

const snapshotIngressMutation = (
  env: Env,
  key: string | null,
  frontierKey: string,
  receipt: ReliableDeliveryReceipt | null,
  targetRuntimeIds: string[],
): ReliableIngressCommit => ({
  key,
  frontierKey,
  receipt,
  targetRuntimeIds,
  previousActive: env.runtimeState?.reliableIngressReceiptLedger?.get(frontierKey),
  previousTerminal: env.runtimeState?.reliableIngressTerminalWatermarks?.get(frontierKey),
});

const assertTerminalAdvance = (
  previous: ReliableDeliveryReceipt | undefined,
  identity: ReliableDeliveryIdentity,
): ReliableDeliveryIdentity => {
  if (!previous) return identity;
  const prior = previous.body.identity;
  const position = compareReliableIdentityPosition(identity, prior);
  if (position < 0) {
    throw new Error(`RELIABLE_TERMINAL_WATERMARK_REGRESSION:${identity.kind}:${prior.height}:${identity.height}`);
  }
  if (position === 0) {
    assertReliableLaneCompatible(prior, identity, 'RELIABLE_TERMINAL_LANE_ORDER_CONFLICT');
    if (identity.kind === 'hash-precommit') {
      return advanceReliableFrontier(prior, identity).identity;
    }
    if (!reliableFrontierCovers(identity, prior) && !reliableFrontierCovers(prior, identity)) {
      throw new Error(`RELIABLE_TERMINAL_WATERMARK_EQUIVOCATION:${identity.kind}:${identity.height}`);
    }
  }
  return identity;
};

const installTerminalFrontier = (
  env: Env,
  key: string,
  identity: ReliableDeliveryIdentity,
): ReliableDeliveryReceipt => {
  const state = ensureReliableIngressState(env);
  assertReceiverSourceLaneCapacity(state, key);
  const previous = state.reliableIngressTerminalWatermarks!.get(key);
  const nextIdentity = assertTerminalAdvance(previous, identity);
  if (previous && reliableReceiptCoversIdentity(previous, nextIdentity)) return previous;
  const receipt = createReliableDeliveryReceipt(env, nextIdentity, 'terminal');
  state.reliableIngressTerminalWatermarks!.set(key, receipt);
  const active = state.reliableIngressReceiptLedger!.get(key);
  if (
    active &&
    (
      reliableReceiptCoversIdentity(receipt, active.body.identity) ||
      (
        nextIdentity.kind === 'j-finality' &&
        active.body.identity.height < nextIdentity.height
      )
    )
  ) {
    state.reliableIngressReceiptLedger!.delete(key);
  }
  return receipt;
};

const refreshTerminalFrontiers = (
  env: Env,
  shouldRefresh: (frontierKey: string, identity: ReliableDeliveryIdentity) => boolean = () => true,
): ReliableIngressCommit[] => {
  const state = ensureReliableIngressState(env);
  const commits: ReliableIngressCommit[] = [];
  for (const [frontierKey, active] of state.reliableIngressReceiptLedger!) {
    const identity = active.body.identity;
    if (!shouldRefresh(frontierKey, identity)) continue;
    const appliedJPrefixRoundCommitted = identity.kind === 'j-prefix-attestation' &&
      [...env.eReplicas.values()].some(replica =>
        (replica.entityId || replica.state.entityId).trim().toLowerCase() === identity.entityId &&
        replica.signerId.trim().toLowerCase() === identity.signerId &&
        replica.state.height >= identity.height,
      );
    // The active ledger is installed only after this exact signed body was
    // applied. Once its target Entity height commits, the round is over even
    // when quorum selection omitted that valid head from the certificate.
    // Pending ingress stays on the stricter exact signed-identity path.
    if (
      !isReliableIdentityTerminalInPostState(env, identity) &&
      !appliedJPrefixRoundCommitted
    ) continue;
    const commit = snapshotIngressMutation(env, null, frontierKey, null, []);
    installTerminalFrontier(env, frontierKey, identity);
    commits.push(commit);
  }
  return commits;
};

const commitTerminalPendingIngress = (env: Env): ReliableIngressCommit[] => {
  const state = ensureReliableIngressState(env);
  const commits: ReliableIngressCommit[] = [];
  for (const [key, pending] of state.pendingReliableIngress!) {
    if (state.reliableIngressCommitting!.has(key)) continue;
    if (!isReliableIdentityTerminalInPostState(env, pending.identity)) continue;
    // Entity catch-up may deterministically replay a deferred H+1 while the
    // enclosing applied input is H. The consumed pending identity must receive
    // its own durable receipt even though it is absent from appliedInputs.
    const targets = [...pending.targetRuntimeIds].sort();
    for (const sourceRuntimeId of targets) {
      const frontierKey = receiverFrontierKey(sourceRuntimeId, pending.identity);
      const commit = snapshotIngressMutation(env, key, frontierKey, null, [sourceRuntimeId]);
      const receipt = installTerminalFrontier(env, frontierKey, pending.identity);
      commits.push({ ...commit, receipt });
    }
    state.reliableIngressCommitting!.add(key);
  }
  return commits;
};

const installActiveFrontier = (
  env: Env,
  key: string,
  identity: ReliableDeliveryIdentity,
): ReliableDeliveryReceipt => {
  const state = ensureReliableIngressState(env);
  assertReceiverSourceLaneCapacity(state, key);
  const terminal = state.reliableIngressTerminalWatermarks!.get(key);
  if (terminal && reliableReceiptCoversIdentity(terminal, identity)) return terminal;
  const active = state.reliableIngressReceiptLedger!.get(key);
  if (active && !sameReliableIdentityPosition(active.body.identity, identity)) {
    throw new Error(
      `RELIABLE_ACTIVE_FRONTIER_ORDER_GAP:${identity.kind}:` +
      `${active.body.identity.height}:${identity.height}`,
    );
  }
  const advance = advanceReliableFrontier(active?.body.identity, identity);
  if (!advance.changed && active) return active;
  const receipt = createReliableDeliveryReceipt(env, advance.identity, 'exact');
  state.reliableIngressReceiptLedger!.set(key, receipt);
  return receipt;
};

const planAppliedIngressCommit = (
  env: Env,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): ReliableIngressCommit[] => {
  const authenticatedStaleJPrefix = isAuthenticatedAppliedStaleJPrefixInput(env, input, identity);
  if (!authenticatedStaleJPrefix) assertReliableIdentityDurableInPostState(env, input, identity);
  const state = ensureReliableIngressState(env);
  const key = reliableIdentityExactKey(identity);
  const targets = new Set(state.pendingReliableIngress!.get(key)?.targetRuntimeIds ?? []);
  const inputSourceRuntimeId = normalizeRuntimeId(input.from);
  if (inputSourceRuntimeId) targets.add(inputSourceRuntimeId);
  if (targets.size === 0) return [];
  const terminal = authenticatedStaleJPrefix || isReliableIdentityTerminalInPostState(env, identity);
  const commits = [...targets].sort().map((sourceRuntimeId) => {
    const frontierKey = receiverFrontierKey(sourceRuntimeId, identity);
    const commit = snapshotIngressMutation(env, key, frontierKey, null, [sourceRuntimeId]);
    const receipt = terminal
      ? installTerminalFrontier(env, frontierKey, identity)
      : installActiveFrontier(env, frontierKey, identity);
    return { ...commit, receipt };
  });
  state.reliableIngressCommitting!.add(key);
  return commits;
};

/** Install active/terminal frontiers in the same working state as the enclosing WAL. */
export const commitReliableIngress = (
  env: Env,
  appliedInputs: readonly RoutedEntityInput[],
): ReliableIngressCommit[] => {
  const state = ensureReliableIngressState(env);
  const commits: ReliableIngressCommit[] = [];
  try {
    const reliableApplied = appliedInputs.flatMap(input =>
      splitRoutedOutputByDeliveryLane(input).flatMap(split => {
        const identity = getInputReliableIdentity(split);
        return identity ? [{ input: split, identity }] : [];
      }));
    const commitEligible = reliableApplied.filter(({ identity }) =>
      !isReliableAccountAckAwaitingCommit(env, identity));
    const contiguousAccountSuccessors = new Map<string, Set<number>>();
    for (const { input, identity } of commitEligible) {
      if (identity.kind !== 'account-ack') continue;
      const sources = new Set(
        state.pendingReliableIngress!
          .get(reliableIdentityExactKey(identity))
          ?.targetRuntimeIds ?? [],
      );
      const inputSource = normalizeRuntimeId(input.from);
      if (inputSource) sources.add(inputSource);
      for (const source of sources) {
        const frontierKey = receiverFrontierKey(source, identity);
        const heights = contiguousAccountSuccessors.get(frontierKey) ?? new Set<number>();
        heights.add(identity.height);
        contiguousAccountSuccessors.set(frontierKey, heights);
      }
    }
    // Evaluate only the exact Account predecessor against the authenticated
    // post-state before installing its contiguous successor. Other protocol
    // lanes retain their existing plan-then-refresh semantics.
    commits.push(...refreshTerminalFrontiers(env, (frontierKey, identity) =>
      identity.kind === 'account-ack' &&
      contiguousAccountSuccessors.get(frontierKey)?.has(identity.height + 1) === true));
    for (const { input, identity } of commitEligible) {
      commits.push(...planAppliedIngressCommit(env, input, identity));
    }
    commits.push(...refreshTerminalFrontiers(env));
    commits.push(...commitTerminalPendingIngress(env));
    return commits;
  } catch (error) {
    rollbackReliableIngressCommit(env, commits);
    throw error;
  }
};

/** Let a later transport retry enqueue messages consensus did not commit. */
export const releaseUncommittedReliableIngress = (
  env: Env,
  attemptedInputs: readonly RoutedEntityInput[],
  appliedInputs: readonly RoutedEntityInput[],
): void => {
  const state = ensureReliableState(env);
  if (!state.pendingReliableIngress?.size) return;
  const appliedKeys = new Set<string>();
  for (const input of appliedInputs.flatMap(splitRoutedOutputByDeliveryLane)) {
    const identity = getInputReliableIdentity(input);
    // `appliedInputs` also records Entity-level acceptance for WAL replay. An
    // Account ACK can therefore appear here while an unrelated frozen-prefix
    // roll left the bilateral Account at H with only pendingFrame H+1. Release
    // that live ingress reservation so the sender's exact retry is enqueued;
    // retaining it would classify every retry as `pending` and deadlock H+1.
    if (identity && !isReliableAccountAckAwaitingCommit(env, identity)) {
      appliedKeys.add(reliableIdentityExactKey(identity));
    }
  }
  for (const input of attemptedInputs.flatMap(splitRoutedOutputByDeliveryLane)) {
    if (
      input.leaderTimeoutVote?.signature === '' &&
      isLocalEntityLeaderTimeoutVote(input.leaderTimeoutVote)
    ) {
      // Scheduler intents are local pre-signing commands, never transport
      // ingress. The canonical signed vote in appliedInputs is the only value
      // eligible for reliable identity and receipt processing.
      continue;
    }
    const identity = getInputReliableIdentity(input);
    if (!identity) continue;
    const key = reliableIdentityExactKey(identity);
    if (!appliedKeys.has(key)) state.pendingReliableIngress.delete(key);
  }
};

/** Restore both active and terminal maps if the enclosing WAL write fails. */
export const rollbackReliableIngressCommit = (
  env: Env,
  commits: readonly ReliableIngressCommit[],
): void => {
  const state = ensureReliableIngressState(env);
  for (const commit of [...commits].reverse()) {
    if (commit.key) state.reliableIngressCommitting!.delete(commit.key);
    if (commit.previousActive) {
      state.reliableIngressReceiptLedger!.set(commit.frontierKey, commit.previousActive);
    } else {
      state.reliableIngressReceiptLedger!.delete(commit.frontierKey);
    }
    if (commit.previousTerminal) {
      state.reliableIngressTerminalWatermarks!.set(commit.frontierKey, commit.previousTerminal);
    } else {
      state.reliableIngressTerminalWatermarks!.delete(commit.frontierKey);
    }
  }
};

/** Emit only receipts caused by exact ingress; refresh-only mutations need no ACK-of-ACK. */
export const finalizeReliableIngressCommit = (
  env: Env,
  commits: readonly ReliableIngressCommit[],
): Array<{ runtimeId: string; receipt: ReliableDeliveryReceipt }> => {
  const state = ensureReliableIngressState(env);
  const deliveries = new Map<string, { runtimeId: string; receipt: ReliableDeliveryReceipt }>();
  for (const commit of commits) {
    if (!commit.key) continue;
    state.reliableIngressCommitting!.delete(commit.key);
    state.pendingReliableIngress!.delete(commit.key);
    if (!commit.receipt) throw new Error('RELIABLE_INGRESS_COMMIT_RECEIPT_MISSING');
    for (const runtimeId of commit.targetRuntimeIds) {
      deliveries.set(`${runtimeId}:${commit.frontierKey}`, {
        runtimeId,
        receipt: commit.receipt,
      });
    }
  }
  return [...deliveries.values()];
};
