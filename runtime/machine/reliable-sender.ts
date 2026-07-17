import { normalizeRuntimeId } from '../networking/runtime-id';
import type {
  Env,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
} from '../types';
import {
  assertReliableLaneCompatible,
  compareReliableIdentityPosition,
  reliableFrontierCovers,
  reliableReceiptCoversIdentity,
  reliableReceiptExactKey,
  sameReliableIdentityPosition,
  senderFrontierKey,
} from './reliable-frontier';
import {
  buildRouteOutputKey,
} from './output-routing';
import {
  ensureReliableState,
  getInputReliableIdentity,
  getReliableDeliveryReceiptValidationError,
} from './reliable-receipt';
import { cloneIsolatedRoutedEntityInputs } from '../protocol/runtime-input-clone';

export type ReliableReceiptSenderCheckpoint = {
  pendingNetworkOutputs: RoutedEntityInput[];
  receivedLedger: Map<string, ReliableDeliveryReceipt> | undefined;
  receivedTerminalWatermarks: Map<string, ReliableDeliveryReceipt> | undefined;
  deferredNetworkMeta: Map<string, { attempts: number; nextRetryAt: number }> | undefined;
};

const senderLedgerForReceipt = (
  env: Env,
  receipt: ReliableDeliveryReceipt,
): Map<string, ReliableDeliveryReceipt> | undefined => receipt.body.coverage === 'terminal'
  ? env.runtimeState?.receivedReliableTerminalWatermarks
  : env.runtimeState?.receivedReliableReceiptLedger;

const receiptCandidates = (
  env: Env,
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

export const reliableReceiptMatchesOutput = (
  output: RoutedEntityInput,
  receipt: ReliableDeliveryReceipt,
): boolean => {
  if (normalizeRuntimeId(output.runtimeId) !== receipt.body.receiverRuntimeId) return false;
  const identity = getInputReliableIdentity(output);
  return Boolean(identity && reliableReceiptCoversIdentity(receipt, identity));
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
  env: Env,
  receipt: ReliableDeliveryReceipt,
): TerminalCrossCoverage => terminalCrossCoverageFromLedger(
  env.runtimeState?.receivedReliableTerminalWatermarks,
  receipt,
);

/** Suppress signed stale frontiers but reject same-height equivocation. */
export const registerReliableReceiptIngress = (
  env: Env,
  receipt: ReliableDeliveryReceipt,
): 'enqueue' | 'duplicate' => {
  const validationError = getReliableDeliveryReceiptValidationError(env, receipt);
  if (validationError) throw new Error(validationError);
  const crossCoverage = terminalCrossCoverage(env, receipt);
  if (crossCoverage === 'covered') return 'duplicate';
  if (
    crossCoverage === 'lower-exact' &&
    !(env.pendingNetworkOutputs ?? []).some(output => reliableReceiptMatchesOutput(output, receipt))
  ) {
    return 'duplicate';
  }
  const candidates = receiptCandidates(env, receipt);
  if (candidates.some(candidate => reliableReceiptExactKey(candidate) === reliableReceiptExactKey(receipt))) {
    return 'duplicate';
  }
  let newest = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (!newest || receiptAdvancesSameCoverage(newest, candidate)) newest = candidate;
  }
  return newest && !receiptAdvancesSameCoverage(newest, receipt) ? 'duplicate' : 'enqueue';
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
  env: Env,
  receipts: readonly ReliableDeliveryReceipt[],
): { removed: number } => {
  const state = ensureReliableState(env);
  const active = new Map(state.receivedReliableReceiptLedger ?? []);
  const terminal = new Map(state.receivedReliableTerminalWatermarks ?? []);
  let outputs = [...(env.pendingNetworkOutputs ?? [])];
  const removedRouteKeys = new Set<string>();
  let removed = 0;
  for (const receipt of receipts) {
    const validationError = getReliableDeliveryReceiptValidationError(env, receipt);
    if (validationError) throw new Error(validationError);
    const crossCoverage = terminalCrossCoverageFromLedger(terminal, receipt);
    if (crossCoverage === 'covered') continue;
    const ledger = receipt.body.coverage === 'terminal' ? terminal : active;
    const existing = ledger.get(senderFrontierKey(receipt));
    if (existing) receiptAdvancesSameCoverage(existing, receipt);
    const retained: RoutedEntityInput[] = [];
    for (const output of outputs) {
      if (!reliableReceiptMatchesOutput(output, receipt)) retained.push(output);
      else {
        removedRouteKeys.add(buildRouteOutputKey(output));
        removed += 1;
      }
    }
    if (
      retained.length === outputs.length &&
      !existing &&
      crossCoverage !== 'lower-exact'
    ) {
      throw new Error(
        `RELIABLE_RECEIPT_OUTPUT_NOT_PENDING:${receipt.body.identity.kind}:${receipt.body.identity.height}`,
      );
    }
    outputs = retained;
    if (crossCoverage !== 'lower-exact') {
      applyReceiptToSenderLedgers(active, terminal, receipt);
    }
  }
  env.pendingNetworkOutputs = outputs;
  state.receivedReliableReceiptLedger = active;
  state.receivedReliableTerminalWatermarks = terminal;
  for (const routeKey of removedRouteKeys) state.deferredNetworkMeta?.delete(routeKey);
  return { removed };
};

export const captureReliableReceiptSenderCheckpoint = (
  env: Env,
): ReliableReceiptSenderCheckpoint => ({
  pendingNetworkOutputs: cloneIsolatedRoutedEntityInputs(env.pendingNetworkOutputs ?? []),
  receivedLedger: env.runtimeState?.receivedReliableReceiptLedger
    ? structuredClone(env.runtimeState.receivedReliableReceiptLedger)
    : undefined,
  receivedTerminalWatermarks: env.runtimeState?.receivedReliableTerminalWatermarks
    ? structuredClone(env.runtimeState.receivedReliableTerminalWatermarks)
    : undefined,
  deferredNetworkMeta: env.runtimeState?.deferredNetworkMeta
    ? structuredClone(env.runtimeState.deferredNetworkMeta)
    : undefined,
});

export const rollbackReliableDeliveryReceipts = (
  env: Env,
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
