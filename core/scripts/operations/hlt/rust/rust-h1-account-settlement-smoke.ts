/** Black-box Account settlement over the canonical production xlnrs path. */

import { safeStringify } from '../../../../protocol/serialization';
import { fetchNativeJson, type HltLivePaymentEvidence, type RustH1Handle } from './rust-h1';
import { requireBoundaryRecord } from '../../../../protocol/boundary-validation';
import {
  readLaneAccountDetails,
  startLaneJurisdictionWatcher,
  type LaneRuntime,
} from '../lanes/lane-runtimes';
import {
  readRustH1AccountStatus,
  type RustH1AccountStatus,
} from './rust-h1-dispute-smoke';

export type RustH1AccountSettlementSmokeResult = Readonly<{
  evidence: 'functional-smoke';
  hubEntityId: string;
  counterpartyEntityId: string;
  accountHeightBefore: number;
  accountHeightReady: number | null;
  accountHeightSubmitted: number | null;
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
  evidence: HltLivePaymentEvidence | null;
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
    options.users < 10 || options.offeredPerSecond < options.users ||
    options.durationSeconds < 5 ||
    options.payments !== options.offeredPerSecond * options.durationSeconds
  ) throw new Error('HLT_RUST_ACCOUNT_SETTLEMENT_SMOKE_REQUIRES_SUSTAINED_FUNCTIONAL_RUN');
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

export const runRustH1SettlementRejectionSmoke = async (options: Readonly<{
  apiBaseUrl: string; rust: RustH1Handle; counterpartyLane: LaneRuntime; tokenId: number;
}>) => {
  const { entityId, signerId } = options.rust.ready;
  const counterpartyEntityId = options.counterpartyLane.identity.entityId;
  const profileUrl = `${options.apiBaseUrl}/api/gossip/profile?entityId=${entityId}`;
  const accountUrl = `${options.apiBaseUrl}/api/account/status?hubEntityId=${entityId}&counterpartyEntityId=${counterpartyEntityId}&tokenIds=${options.tokenId}`;
  const readProfile = async () => requireBoundaryRecord(
    requireBoundaryRecord(await fetchNativeJson(profileUrl), 'SETTLEMENT_REJECT_PROFILE')['profile'],
    'SETTLEMENT_REJECT_PROFILE_FIELDS',
  );
  const before = requireBoundaryRecord(await fetchNativeJson(accountUrl), 'SETTLEMENT_REJECT_ACCOUNT');
  const profile = await readProfile();
  if (before['ready'] !== true || before['settlementWorkspaceHash'] !== null || !Array.isArray(before['tokens'])) {
    throw new Error('HLT_SETTLEMENT_REJECT_BEFORE_NOT_READY');
  }
  const runtime = requireBoundaryRecord(before['runtime'], 'SETTLEMENT_REJECT_RUNTIME');
  const marker = `settlement-reject-healthy-${runtime['height']}`;
  const height = await options.rust.submitLocalEntityInputs(marker, [
    { entityId, signerId, entityTxs: [
      { type: 'profile-update', data: { profile: { entityId, name: marker } } },
    ] },
    { entityId, signerId, entityTxs: [
      { type: 'profile-update', data: { profile: { entityId, name: `${marker}-rollback` } } },
      { type: 'settle_propose', data: { counterpartyEntityId, ops: [
        { type: 'r2r', tokenId: options.tokenId, amount: -1n },
      ] } },
    ] },
    { entityId, signerId, entityTxs: [
      { type: 'profile-update', data: { profile: { entityId, bio: marker } } },
    ] },
  ]);
  const deadline = Date.now() + 5_000;
  let observed = await readProfile();
  while (observed['bio'] !== marker && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    observed = await readProfile();
  }
  if (observed['bio'] !== marker || observed['name'] !== marker) {
    throw new Error(`HLT_SETTLEMENT_REJECT_HEALTHY_COMMAND:${safeStringify(observed)}`);
  }
  const after = requireBoundaryRecord(await fetchNativeJson(accountUrl), 'SETTLEMENT_REJECT_AFTER');
  for (const field of ['tokens', 'currentHeight', 'jNonce', 'settlementWorkspaceHash', 'pendingFrameHeight']) {
    if (safeStringify(after[field]) !== safeStringify(before[field])) {
      throw new Error(`HLT_SETTLEMENT_REJECT_STATE_CHANGED:${field}`);
    }
  }
  if (typeof profile['bio'] !== 'string' || typeof profile['name'] !== 'string') throw new Error('HLT_SETTLEMENT_REJECT_BIO_INVALID');
  await options.rust.submitLocalEntityInputs(`${marker}-restore-profile`, [{ entityId, signerId,
    entityTxs: [{ type: 'profile-update', data: { profile: { entityId, name: profile['name'], bio: profile['bio'] } } }],
  }]);
  return { evidence: 'functional-smoke' as const, height, healthyCommandCommitted: true,
    invalidSettlementLeftNoMutation: true, rejectedCommandProfileRolledBack: true, accountMoneyAndNoncePreserved: true, counterpartyEntityId };
};

export const runRustH1AccountSettlementSmoke = async (options: Readonly<{
  apiBaseUrl: string;
  rust: RustH1Handle;
  counterpartyLane: LaneRuntime;
  tokenId: number;
  operation: 'r2r' | 'r2c' | 'c2r';
  amount: bigint;
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
  await runRustH1SettlementRejectionSmoke(options);
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
          ops: [{ type: options.operation, tokenId: options.tokenId, amount: options.amount }],
          memo: 'hlt-production-account-settlement',
        },
      }],
    }],
  );
  stage('propose-submitted');
  if (options.operation === 'c2r') {
    // The production hub scheduler executes and broadcasts C2R. A second
    // manual execute races that owner; observe finalized money instead.
    const finalized = await waitForAccount({
      ...options,
      counterpartyEntityId,
      code: 'HLT_RUST_ACCOUNT_SETTLEMENT_AUTO_C2R_FINALITY_TIMEOUT',
      predicate: status => status.settlementWorkspaceHash === null && status.jNonce > before.jNonce,
    });
    if (finalized.currentHeight <= before.currentHeight) {
      throw new Error('HLT_RUST_ACCOUNT_SETTLEMENT_ACCOUNT_HEIGHT_NOT_MONOTONIC');
    }
    stage('auto-c2r-account-settled-finalized', finalized);
    return {
      evidence: 'functional-smoke', hubEntityId, counterpartyEntityId,
      accountHeightBefore: before.currentHeight,
      accountHeightReady: null,
      accountHeightSubmitted: null,
      accountHeightFinalized: finalized.currentHeight,
      runtimeHeightBefore: before.runtimeHeight,
      runtimeHeightFinalized: finalized.runtimeHeight,
      jNonceBefore: before.jNonce,
      jNonceFinalized: finalized.jNonce,
    };
  }
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
