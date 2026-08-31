/** Black-box Account settlement over the canonical production xlnrs path. */

import { safeStringify } from '../../../../protocol/serialization';
import type { RustLivePaymentEvidence, RustH1Handle } from './rust-h1';
import {
  readLaneAccountDetails,
  startLaneJurisdictionWatcher,
  type LaneRuntime,
} from '../lanes/lane-runtimes';
import {
  readRustH1AccountStatus,
  type RustH1DisputeAccountStatus as RustH1AccountStatus,
} from './rust-h1-dispute-smoke';

export type RustH1AccountSettlementSmokeResult = Readonly<{
  evidence: 'functional-smoke';
  hubEntityId: string;
  counterpartyEntityId: string;
  accountHeightBefore: number;
  accountHeightReady: number;
  accountHeightSubmitted: number;
  accountHeightFinalized: number;
  runtimeHeightBefore: number;
  runtimeHeightFinalized: number;
  jNonceBefore: number;
  jNonceFinalized: number;
}>;

const readCounterpartyPendingDetails = async (
  lane: LaneRuntime,
  hubRuntimeId: string,
): Promise<unknown> => readLaneAccountDetails(lane, hubRuntimeId);

export const shouldRunRustH1AccountSettlementSmoke = (options: Readonly<{
  requested: string | undefined;
  engine: 'ts' | 'rust';
  evidence: RustLivePaymentEvidence | null;
  users: number;
  payments: number;
  offeredPerSecond: number;
  durationSeconds: number;
}>): boolean => {
  if (options.requested === undefined || options.requested === '0') return false;
  if (options.requested !== '1') {
    throw new Error(`HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_FLAG_INVALID:${options.requested}`);
  }
  if (
    options.engine !== 'rust' || options.evidence !== 'functional-smoke' ||
    options.users !== 1_000 || options.payments !== 5_000 ||
    options.offeredPerSecond !== 1_000 || options.durationSeconds !== 5
  ) throw new Error('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_REQUIRES_EXACT_FUNCTIONAL_SMOKE');
  return true;
};

const waitForAccount = async (
  options: Readonly<{
    apiBaseUrl: string;
    rust: RustH1Handle;
    counterpartyEntityId: string;
    tokenId: number;
    code: string;
    predicate: (status: RustH1AccountStatus) => boolean;
  }>,
): Promise<RustH1AccountStatus> => {
  const deadline = Date.now() + 5_000;
  let latest: RustH1AccountStatus | null = null;
  while (Date.now() <= deadline) {
    latest = await readRustH1AccountStatus(
      options.apiBaseUrl,
      options.rust.ready.entityId,
      options.counterpartyEntityId,
      options.tokenId,
    );
    if (options.predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${options.code}:${safeStringify(latest)}:${options.rust.errorTail()}`);
};

export const runRustH1AccountSettlementSmoke = async (options: Readonly<{
  apiBaseUrl: string;
  rust: RustH1Handle;
  counterpartyLane: LaneRuntime;
  tokenId: number;
}>): Promise<RustH1AccountSettlementSmokeResult> => {
  const startedAt = performance.now();
  const stage = (name: string, status?: RustH1AccountStatus): void => {
    console.log('[load] rust-account-settlement', safeStringify({
      stage: name,
      elapsedMs: Math.ceil(performance.now() - startedAt),
      ...(status ? {
        accountHeight: status.currentHeight,
        pendingFrameHeight: status.pendingFrameHeight,
        workspaceStatus: status.settlementWorkspaceStatus,
        jNonce: status.jNonce,
        runtimeHeight: status.runtimeHeight,
      } : {}),
    }));
  };
  const hubEntityId = options.rust.ready.entityId;
  const counterpartyEntityId = options.counterpartyLane.identity.entityId;
  const before = await readRustH1AccountStatus(
    options.apiBaseUrl,
    hubEntityId,
    counterpartyEntityId,
    options.tokenId,
  );
  if (!before.ready || before.settlementWorkspaceHash !== null) {
    throw new Error('HLT_RUST_ACCOUNT_SETTLEMENT_BEFORE_NOT_READY');
  }
  stage('before', before);
  await startLaneJurisdictionWatcher(options.counterpartyLane);
  stage('counterparty-watcher-started');
  await options.rust.submitLocalEntityInputs(
    `hlt-settlement-propose-${counterpartyEntityId.slice(-8)}-${before.runtimeHeight}`,
    [{
      entityId: hubEntityId,
      signerId: options.rust.ready.signerId,
      entityTxs: [{
        type: 'settle_propose',
        data: {
          counterpartyEntityId,
          ops: [{ type: 'r2r', tokenId: options.tokenId, amount: 1n }],
          memo: 'hlt-production-account-settlement',
        },
      }],
    }],
  );
  stage('propose-submitted');
  const awaiting = await waitForAccount({
    ...options,
    counterpartyEntityId,
    code: 'HLT_RUST_ACCOUNT_SETTLEMENT_PROPOSAL_TIMEOUT',
    predicate: status =>
      status.settlementWorkspaceStatus === 'awaiting_counterparty' ||
      status.settlementWorkspaceStatus === 'ready_to_submit',
  });
  stage('proposal-committed', awaiting);
  console.log('[load] rust-account-settlement-counterparty', safeStringify(
    await readCounterpartyPendingDetails(options.counterpartyLane, options.rust.ready.runtimeId),
  ));
  const ready = await waitForAccount({
    ...options,
    counterpartyEntityId,
    code: 'HLT_RUST_ACCOUNT_SETTLEMENT_READY_TIMEOUT',
    predicate: status => status.settlementWorkspaceStatus === 'ready_to_submit',
  });
  stage('bilateral-hankos-ready', ready);
  await options.rust.submitLocalEntityInputs(
    `hlt-settlement-execute-${counterpartyEntityId.slice(-8)}-${ready.runtimeHeight}`,
    [{
      entityId: hubEntityId,
      signerId: options.rust.ready.signerId,
      entityTxs: [{
        type: 'settle_execute',
        data: { counterpartyEntityId },
      }],
    }],
  );
  stage('execute-submitted');
  const submitted = await waitForAccount({
    ...options,
    counterpartyEntityId,
    code: 'HLT_RUST_ACCOUNT_SETTLEMENT_SUBMITTED_TIMEOUT',
    predicate: status => status.settlementWorkspaceStatus === 'submitted',
  });
  stage('settlement-submitted', submitted);
  await options.rust.submitLocalEntityInputs(
    `hlt-settlement-broadcast-${counterpartyEntityId.slice(-8)}-${submitted.runtimeHeight}`,
    [{
      entityId: hubEntityId,
      signerId: options.rust.ready.signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }],
  );
  stage('j-broadcast-submitted');
  const finalized = await waitForAccount({
    ...options,
    counterpartyEntityId,
    code: 'HLT_RUST_ACCOUNT_SETTLEMENT_FINALITY_TIMEOUT',
    predicate: status =>
      status.settlementWorkspaceHash === null && status.jNonce > before.jNonce,
  });
  stage('account-settled-finalized', finalized);
  if (
    ready.currentHeight <= before.currentHeight ||
    submitted.currentHeight <= ready.currentHeight ||
    finalized.currentHeight <= submitted.currentHeight
  ) throw new Error('HLT_RUST_ACCOUNT_SETTLEMENT_ACCOUNT_HEIGHT_NOT_MONOTONIC');
  return {
    evidence: 'functional-smoke',
    hubEntityId,
    counterpartyEntityId,
    accountHeightBefore: before.currentHeight,
    accountHeightReady: ready.currentHeight,
    accountHeightSubmitted: submitted.currentHeight,
    accountHeightFinalized: finalized.currentHeight,
    runtimeHeightBefore: before.runtimeHeight,
    runtimeHeightFinalized: finalized.runtimeHeight,
    jNonceBefore: before.jNonce,
    jNonceFinalized: finalized.jNonce,
  };
};
