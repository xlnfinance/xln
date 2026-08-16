import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id.ts';
import type {
  RuntimeReplica,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
} from '../types.ts';
import {
  assertReliableLaneCompatible,
  compareReliableIdentityPosition,
  reliableFrontierCovers,
  reliableReceiptCoversIdentity,
  reliableReceiptExactKey,
  sameReliableIdentityPosition,
  senderFrontierKey,
  senderFrontierKeyForIdentity,
} from './reliable-frontier.ts';
import {
  pruneReceiptedReliableOutputs,
} from '../routing/output-routing.ts';
import {
  ensureReliableState,
  getInputReliableIdentity,
  getReliableDeliveryReceiptValidationError,
} from './reliable-receipt.ts';
export type ReliableReceiptSenderCheckpoint = {
  pendingNetworkOutputs: RoutedEntityInput[];
  receivedLedger: Map<string, ReliableDeliveryReceipt> | undefined;
  receivedTerminalWatermarks: Map<string, ReliableDeliveryReceipt> | undefined;
  deferredNetworkMeta: Map<string, { attempts: number; nextRetryAt: number }> | undefined;
};

const senderLedgerForReceipt = (
  env: RuntimeReplica,
  receipt: ReliableDeliveryReceipt,
): Map<string, ReliableDeliveryReceipt> | undefined => receipt.body.coverage === 'terminal'
  ? env.infrastructure?.receivedReliableTerminalWatermarks
  : env.infrastructure?.receivedReliableReceiptLedger;

const receiptCandidates = (
  env: RuntimeReplica,
  receipt: ReliableDeliveryReceipt,
): ReliableDeliveryReceipt[] => {
  const key = senderFrontierKey(receipt);
  return [
    senderLedgerForReceipt(env, receipt)?.get(key),
    ...(env.runtimeMempool?.reliableReceipts ?? []).filter(candidate =>
      candidate.body.coverage === receipt.body.coverage && senderFrontierKey(candidate) === key),
  ].filter((candidate): candidate is ReliableDeliveryReceipt => Boolean(candidate));
};

const receiptAdvancesSameCoverage = (
  existing: ReliableDeliveryReceipt,
  incoming: ReliableDeliveryReceipt,
): boolean => {
  const current = existing.body.identity;
  const next = incoming.body.identity;
  const position = compareReliableIdentityPosition(next, current);
  if (position < 0) return false;
  if (position > 0) return true;
  assertReliableLaneCompatible(current, next, 'RELIABLE_RECEIPT_LANE_ORDER_CONFLICT');
  if (reliableFrontierCovers(current, next)) return false;
  if (!reliableFrontierCovers(next, current)) {
    throw new Error(`RELIABLE_RECEIPT_FRONTIER_NON_CUMULATIVE:${next.kind}:${next.height}`);
  }
  return true;
};

const reliableReceiptMatchesOutput = (
  output: RoutedEntityInput,
  receipt: ReliableDeliveryReceipt,
): boolean => {
  if (normalizeRuntimeId(output.runtimeId) !== receipt.body.receiverRuntimeId) return false;
  const identity = getInputReliableIdentity(output);
  return Boolean(identity && reliableReceiptCoversIdentity(receipt, identity));
};

type IndexedReliableOutput = {
  index: number;
  output: RoutedEntityInput;
  identity: NonNullable<ReturnType<typeof getInputReliableIdentity>>;
};

const indexReliableOutputs = (
  outputs: readonly RoutedEntityInput[],
): Map<string, IndexedReliableOutput[]> => {
  const indexed = new Map<string, IndexedReliableOutput[]>();
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index]!;
    const receiverRuntimeId = normalizeRuntimeId(output.runtimeId);
    if (!receiverRuntimeId) continue;
    const identity = getInputReliableIdentity(output);
    if (!identity) continue;
    const key = senderFrontierKeyForIdentity(receiverRuntimeId, identity);
    const lane = indexed.get(key) ?? [];
    lane.push({ index, output, identity });
    indexed.set(key, lane);
  }
  return indexed;
};

/** Match locally generated receipts without repeatedly hashing every output. */
export const matchReceiptsToOutputs = (
  outputs: readonly RoutedEntityInput[],
  receipts: readonly ReliableDeliveryReceipt[],
): Map<ReliableDeliveryReceipt, RoutedEntityInput> => {
  const indexed = indexReliableOutputs(outputs);
  const matches = new Map<ReliableDeliveryReceipt, RoutedEntityInput>();
  for (const receipt of receipts) {
    const candidate = indexed.get(senderFrontierKey(receipt))?.find(entry =>
      reliableReceiptCoversIdentity(receipt, entry.identity));
    if (candidate) matches.set(receipt, candidate.output);
  }
  return matches;
};

type TerminalCrossCoverage = 'none' | 'covered' | 'lower-exact';

const terminalCrossCoverageFromLedger = (
  terminalLedger: Map<string, ReliableDeliveryReceipt> | undefined,
  receipt: ReliableDeliveryReceipt,
): TerminalCrossCoverage => {
  if (receipt.body.coverage !== 'exact') return 'none';
  const terminal = terminalLedger?.get(senderFrontierKey(receipt));
  if (!terminal) return 'none';
  const terminalIdentity = terminal.body.identity;
  const incoming = receipt.body.identity;
  if (sameReliableIdentityPosition(terminalIdentity, incoming)) {
    assertReliableLaneCompatible(
      terminalIdentity,
      incoming,
      'RELIABLE_RECEIPT_LANE_ORDER_CONFLICT',
    );
  }
  if (reliableReceiptCoversIdentity(terminal, incoming)) return 'covered';
  return compareReliableIdentityPosition(incoming, terminalIdentity) < 0
    ? 'lower-exact'
    : 'none';
};

const terminalCrossCoverage = (
  env: RuntimeReplica,
  receipt: ReliableDeliveryReceipt,
): TerminalCrossCoverage => terminalCrossCoverageFromLedger(
  env.infrastructure?.receivedReliableTerminalWatermarks,
  receipt,
);

/** Suppress signed stale frontiers but reject same-height equivocation. */
export const registerReliableReceiptIngress = (
  env: RuntimeReplica,
  receipt: ReliableDeliveryReceipt,
): 'enqueue' | 'duplicate' => {
  const validationError = getReliableDeliveryReceiptValidationError(env, receipt);
  if (validationError) throw new Error(validationError);
  const crossCoverage = terminalCrossCoverage(env, receipt);
  if (crossCoverage === 'covered') return 'duplicate';
  const matchesPendingOutput = (env.pendingNetworkOutputs ?? []).some(output =>
    reliableReceiptMatchesOutput(output, receipt));
  if (crossCoverage === 'lower-exact' && !matchesPendingOutput) return 'duplicate';
  const candidates = receiptCandidates(env, receipt);
  if (candidates.some(candidate => reliableReceiptExactKey(candidate) === reliableReceiptExactKey(receipt))) {
    return 'duplicate';
  }
  let newest = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (!newest || receiptAdvancesSameCoverage(newest, candidate)) newest = candidate;
  }
  if (newest && !receiptAdvancesSameCoverage(newest, receipt)) return 'duplicate';
  // A receiver can authenticate only its observation, not arbitrary future
  // sender state. Unknown receipts are stale/unsolicited network input; the
  // reducer retains the loud throw to detect corrupted WAL replay.
  return matchesPendingOutput ? 'enqueue' : 'duplicate';
};

const applyReceiptToSenderLedgers = (
  active: Map<string, ReliableDeliveryReceipt>,
  terminal: Map<string, ReliableDeliveryReceipt>,
  receipt: ReliableDeliveryReceipt,
): void => {
  const key = senderFrontierKey(receipt);
  const ledger = receipt.body.coverage === 'terminal' ? terminal : active;
  const previous = ledger.get(key);
  if (previous && !receiptAdvancesSameCoverage(previous, receipt)) return;
  ledger.set(key, receipt);
  if (receipt.body.coverage === 'terminal') {
    const activeReceipt = active.get(key);
    if (
      activeReceipt &&
      (
        reliableReceiptCoversIdentity(receipt, activeReceipt.body.identity) ||
        (
          receipt.body.identity.kind === 'j-finality' &&
          activeReceipt.body.identity.height < receipt.body.identity.height
        )
      )
    ) {
      active.delete(key);
    }
  }
};

/** Apply signed frontier receipts and GC only their explicit exact/terminal coverage. */
export const applyReliableDeliveryReceipts = (
  env: RuntimeReplica,
  receipts: readonly ReliableDeliveryReceipt[],
): { removed: number } => {
  const state = ensureReliableState(env);
  const active = new Map(state.receivedReliableReceiptLedger ?? []);
  const terminal = new Map(state.receivedReliableTerminalWatermarks ?? []);
  const outputs = [...(env.pendingNetworkOutputs ?? [])];
  const indexedOutputs = indexReliableOutputs(outputs);
  for (const receipt of receipts) {
    const validationError = getReliableDeliveryReceiptValidationError(env, receipt);
    if (validationError) throw new Error(validationError);
    const crossCoverage = terminalCrossCoverageFromLedger(terminal, receipt);
    if (crossCoverage === 'covered') continue;
    const ledger = receipt.body.coverage === 'terminal' ? terminal : active;
    const existing = ledger.get(senderFrontierKey(receipt));
    if (existing) receiptAdvancesSameCoverage(existing, receipt);
    let pendingMatches = 0;
    let pendingSupersets = 0;
    for (const candidate of indexedOutputs.get(senderFrontierKey(receipt)) ?? []) {
      if (reliableReceiptCoversIdentity(receipt, candidate.identity)) pendingMatches += 1;
      if (reliableFrontierCovers(candidate.identity, receipt.body.identity)) pendingSupersets += 1;
    }
    if (
      pendingMatches === 0 &&
      pendingSupersets === 0 &&
      !existing &&
      crossCoverage !== 'lower-exact'
    ) {
      throw new Error(
        `RELIABLE_RECEIPT_OUTPUT_NOT_PENDING:${receipt.body.identity.kind}:` +
          `${receipt.body.identity.evidenceKind}:${receipt.body.identity.height}:` +
          `${receipt.body.identity.signerId}:${receipt.body.coverage}`,
      );
    }
    if (crossCoverage !== 'lower-exact') {
      applyReceiptToSenderLedgers(active, terminal, receipt);
    }
  }
  state.receivedReliableReceiptLedger = active;
  state.receivedReliableTerminalWatermarks = terminal;
  // GC only after every receipt is installed in the sender ledger. Atomic
  // cross-j admission contains one reliable target ACK plus an ordinary source
  // proposal. Removing the ACK first destroys the envelope identity and leaves
  // the source proposal to retry alone, violating atomic delivery after a
  // successful commit. The shared pruning rule retires the complete source
  // Runtime-frame group once every reliable member is receipted.
  env.pendingNetworkOutputs = pruneReceiptedReliableOutputs(env, outputs, receipts);
  return { removed: outputs.length - env.pendingNetworkOutputs.length };
};

export const captureReliableReceiptSenderCheckpoint = (
  env: RuntimeReplica,
): ReliableReceiptSenderCheckpoint => ({
  // Receipt application is copy-on-write: it installs new arrays/maps instead
  // of mutating these committed containers. Retaining their identities gives a
  // constant-time rollback checkpoint without copying the Runtime outbox.
  pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
  receivedLedger: env.infrastructure?.receivedReliableReceiptLedger,
  receivedTerminalWatermarks: env.infrastructure?.receivedReliableTerminalWatermarks,
  deferredNetworkMeta: env.infrastructure?.deferredNetworkMeta,
});

export const rollbackReliableDeliveryReceipts = (
  env: RuntimeReplica,
  checkpoint: ReliableReceiptSenderCheckpoint,
): void => {
  env.pendingNetworkOutputs = checkpoint.pendingNetworkOutputs;
  const state = ensureReliableState(env);
  if (checkpoint.receivedLedger) state.receivedReliableReceiptLedger = checkpoint.receivedLedger;
  else delete state.receivedReliableReceiptLedger;
  if (checkpoint.receivedTerminalWatermarks) {
    state.receivedReliableTerminalWatermarks = checkpoint.receivedTerminalWatermarks;
  } else {
    delete state.receivedReliableTerminalWatermarks;
  }
  if (checkpoint.deferredNetworkMeta) state.deferredNetworkMeta = checkpoint.deferredNetworkMeta;
  else delete state.deferredNetworkMeta;
};
