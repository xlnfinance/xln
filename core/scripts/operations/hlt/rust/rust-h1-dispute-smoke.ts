/** Black-box dispute freeze over the canonical production xlnrs path. */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../protocol/boundary-validation';
import { safeStringify } from '../../../../protocol/serialization';
import type { RuntimeInput } from '../../../../runtime/types';
import {
  queueLaneRuntimeInputWave,
  readLaneAccountDetails,
  startLaneJurisdictionWatcher,
  type LaneRuntime,
} from '../lanes/lane-runtimes';
import { fetchNativeJson, type RustH1Handle } from './rust-h1';
import { waitForRustH1Metrics } from './rust-h1-settlement';

const ENTITY_ID = /^0x[0-9a-f]{64}$/;
const DISPUTE_COOLDOWN_MS = 0;

export type RustH1DisputeAccountStatus = Readonly<{
  hubEntityId: string;
  counterpartyEntityId: string;
  hasAccount: boolean;
  status: 'active' | 'dispute_preparing' | 'disputed';
  ready: boolean;
  disputeObservedOnChain: boolean;
  disputeObservedBlockNumber: number | null;
  settlementWorkspaceHash: string | null;
  settlementWorkspaceStatus: string | null;
  jNonce: number;
  currentHeight: number;
  pendingFrameHeight: number | null;
  mempool: number;
  runtimeHeight: number;
}>;

export type RustH1DisputeSmokeResult = Readonly<{
  evidence: 'functional-smoke';
  hubEntityId: string;
  counterpartyEntityId: string;
  accountHeightBefore: number;
  accountHeightFrozen: number;
  accountHeightAfterRejectedBusinessInput: number;
  runtimeHeightBefore: number;
  runtimeHeightFrozen: number;
  runtimeHeightObservedOnChain: number;
  runtimeHeightAfterRejectedBusinessInput: number;
  runtimeHeightFinalized: number;
  observedBlockNumber: number;
  observedAccountInputs: number;
  jNonceBefore: number;
  jNonceFinalized: number;
  counterProofRequired: false;
}>;

const exactEntityId = (value: unknown, code: string): string => {
  const text = typeof value === 'string' ? value : '';
  if (!ENTITY_ID.test(text)) throw new Error(`${code}:${String(value)}`);
  return text;
};

const boolean = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${code}:${String(value)}`);
  return value;
};

const optionalHeight = (value: unknown, code: string): number | null =>
  value === null ? null : requireBoundaryInteger(value, code, 1);

export const decodeRustH1DisputeAccountStatus = (
  value: unknown,
): RustH1DisputeAccountStatus => {
  const row = requireBoundaryRecord(value, 'HLT_RUST_DISPUTE_STATUS_OBJECT');
  requireExactBoundaryKeys(
    row,
    [
      'success', 'hubEntityId', 'counterpartyEntityId', 'hasAccount', 'ready',
      'status', 'disputeObservedOnChain', 'disputeObservedBlockNumber',
      'settlementWorkspaceHash', 'settlementWorkspaceStatus', 'jNonce',
      'currentHeight', 'pendingFrameHeight', 'mempool', 'tokens', 'runtime',
    ],
    [],
    'HLT_RUST_DISPUTE_STATUS_FIELDS',
  );
  if (row['success'] !== true || !Array.isArray(row['tokens'])) {
    throw new Error('HLT_RUST_DISPUTE_STATUS_INVALID');
  }
  const runtime = requireBoundaryRecord(row['runtime'], 'HLT_RUST_DISPUTE_RUNTIME_OBJECT');
  requireExactBoundaryKeys(
    runtime,
    ['height', 'timestamp'],
    [],
    'HLT_RUST_DISPUTE_RUNTIME_FIELDS',
  );
  return {
    hubEntityId: exactEntityId(row['hubEntityId'], 'HLT_RUST_DISPUTE_HUB_ID'),
    counterpartyEntityId: exactEntityId(
      row['counterpartyEntityId'],
      'HLT_RUST_DISPUTE_COUNTERPARTY_ID',
    ),
    hasAccount: boolean(row['hasAccount'], 'HLT_RUST_DISPUTE_HAS_ACCOUNT'),
    status: (() => {
      const status = String(row['status'] ?? '');
      if (!['active', 'dispute_preparing', 'disputed'].includes(status)) {
        throw new Error(`HLT_RUST_DISPUTE_LIFECYCLE:${status}`);
      }
      return status as RustH1DisputeAccountStatus['status'];
    })(),
    ready: boolean(row['ready'], 'HLT_RUST_DISPUTE_READY'),
    disputeObservedOnChain: boolean(
      row['disputeObservedOnChain'],
      'HLT_RUST_DISPUTE_OBSERVED_ON_CHAIN',
    ),
    disputeObservedBlockNumber: optionalHeight(
      row['disputeObservedBlockNumber'],
      'HLT_RUST_DISPUTE_OBSERVED_BLOCK',
    ),
    settlementWorkspaceHash: row['settlementWorkspaceHash'] === null
      ? null
      : String(row['settlementWorkspaceHash']),
    settlementWorkspaceStatus: row['settlementWorkspaceStatus'] === null
      ? null
      : String(row['settlementWorkspaceStatus']),
    jNonce: requireBoundaryInteger(row['jNonce'], 'HLT_RUST_DISPUTE_J_NONCE'),
    currentHeight: requireBoundaryInteger(
      row['currentHeight'],
      'HLT_RUST_DISPUTE_ACCOUNT_HEIGHT',
    ),
    pendingFrameHeight: optionalHeight(
      row['pendingFrameHeight'],
      'HLT_RUST_DISPUTE_PENDING_HEIGHT',
    ),
    mempool: requireBoundaryInteger(row['mempool'], 'HLT_RUST_DISPUTE_MEMPOOL'),
    runtimeHeight: requireBoundaryInteger(runtime['height'], 'HLT_RUST_DISPUTE_RUNTIME_HEIGHT'),
  };
};

export const readRustH1AccountStatus = async (
  apiBaseUrl: string,
  hubEntityId: string,
  counterpartyEntityId: string,
  tokenId: number,
): Promise<RustH1DisputeAccountStatus> => {
  const url = new URL('/api/account/status', `${apiBaseUrl.replace(/\/+$/, '')}/`);
  url.searchParams.set('hubEntityId', hubEntityId);
  url.searchParams.set('counterpartyEntityId', counterpartyEntityId);
  url.searchParams.set('tokenIds', String(tokenId));
  return decodeRustH1DisputeAccountStatus(await fetchNativeJson(url.toString()));
};

const assertIdleAccount = (
  status: RustH1DisputeAccountStatus,
  code: string,
): void => {
  if (!status.hasAccount || status.currentHeight < 1) throw new Error(`${code}:ACCOUNT_MISSING`);
  if (status.pendingFrameHeight !== null) throw new Error(`${code}:PENDING_FRAME`);
  if (status.mempool !== 0) throw new Error(`${code}:MEMPOOL:${status.mempool}`);
};

export const assertRustH1DisputeFreeze = (
  before: RustH1DisputeAccountStatus,
  frozen: RustH1DisputeAccountStatus,
  observed: RustH1DisputeAccountStatus,
  afterBusinessInput: RustH1DisputeAccountStatus,
): void => {
  const identity = `${before.hubEntityId}:${before.counterpartyEntityId}`;
  if (
    `${frozen.hubEntityId}:${frozen.counterpartyEntityId}` !== identity ||
    `${observed.hubEntityId}:${observed.counterpartyEntityId}` !== identity ||
    `${afterBusinessInput.hubEntityId}:${afterBusinessInput.counterpartyEntityId}` !== identity
  ) throw new Error('HLT_RUST_DISPUTE_ACCOUNT_IDENTITY_CHANGED');
  assertIdleAccount(before, 'HLT_RUST_DISPUTE_BEFORE');
  assertIdleAccount(frozen, 'HLT_RUST_DISPUTE_FROZEN');
  assertIdleAccount(observed, 'HLT_RUST_DISPUTE_OBSERVED');
  assertIdleAccount(afterBusinessInput, 'HLT_RUST_DISPUTE_AFTER');
  if (!before.ready || before.status !== 'active') {
    throw new Error('HLT_RUST_DISPUTE_BEFORE_NOT_READY');
  }
  // With pending=null and mempool=0, native `ready=false` proves the Account
  // lifecycle itself is no longer active; it is not a transient queue signal.
  if (frozen.ready) throw new Error('HLT_RUST_DISPUTE_PREPARE_NOT_FROZEN');
  if (frozen.status !== 'disputed' || frozen.disputeObservedOnChain) {
    throw new Error('HLT_RUST_DISPUTE_PREPARE_LIFECYCLE');
  }
  if (frozen.runtimeHeight <= before.runtimeHeight) {
    throw new Error('HLT_RUST_DISPUTE_PREPARE_NOT_COMMITTED');
  }
  if (afterBusinessInput.runtimeHeight <= frozen.runtimeHeight) {
    throw new Error('HLT_RUST_DISPUTE_BUSINESS_INPUT_NOT_COMMITTED');
  }
  if (
    observed.status !== 'disputed' || !observed.disputeObservedOnChain ||
    observed.disputeObservedBlockNumber === null || observed.runtimeHeight <= frozen.runtimeHeight
  ) throw new Error('HLT_RUST_DISPUTE_J_EVENT_NOT_APPLIED');
  if (afterBusinessInput.currentHeight !== frozen.currentHeight) {
    throw new Error(
      `HLT_RUST_DISPUTE_BUSINESS_INPUT_MUTATED_ACCOUNT:` +
      `${frozen.currentHeight}:${afterBusinessInput.currentHeight}`,
    );
  }
  if (afterBusinessInput.ready || afterBusinessInput.status !== 'disputed') {
    throw new Error('HLT_RUST_DISPUTE_BUSINESS_INPUT_REOPENED_ACCOUNT');
  }
};

/** Jurisdiction finality mutates the Account epoch through the canonical
 * external-finality input; it must not synthesize a bilateral AccountFrame. */
export const assertRustH1DisputeFinalized = (
  beforeFinality: RustH1DisputeAccountStatus,
  finalized: RustH1DisputeAccountStatus,
): void => {
  assertIdleAccount(finalized, 'HLT_RUST_DISPUTE_FINALIZED');
  if (
    finalized.status !== 'disputed' || finalized.ready ||
    finalized.disputeObservedOnChain
  ) throw new Error('HLT_RUST_DISPUTE_FINALITY_LIFECYCLE');
  if (finalized.jNonce <= beforeFinality.jNonce) {
    throw new Error(
      `HLT_RUST_DISPUTE_FINALITY_J_NONCE:${beforeFinality.jNonce}:${finalized.jNonce}`,
    );
  }
  if (finalized.currentHeight !== beforeFinality.currentHeight) {
    throw new Error(
      `HLT_RUST_DISPUTE_FINALITY_SYNTHESIZED_ACCOUNT_FRAME:` +
      `${beforeFinality.currentHeight}:${finalized.currentHeight}`,
    );
  }
  if (finalized.runtimeHeight <= beforeFinality.runtimeHeight) {
    throw new Error(
      `HLT_RUST_DISPUTE_FINALITY_RUNTIME_HEIGHT:` +
      `${beforeFinality.runtimeHeight}:${finalized.runtimeHeight}`,
    );
  }
};

const waitForObservedDispute = async (
  options: Readonly<{
    apiBaseUrl: string;
    rust: RustH1Handle;
    hubEntityId: string;
    counterpartyEntityId: string;
    tokenId: number;
  }>,
): Promise<RustH1DisputeAccountStatus> => {
  const deadline = Date.now() + 5_000;
  let latest: RustH1DisputeAccountStatus | null = null;
  while (Date.now() <= deadline) {
    latest = await readRustH1AccountStatus(
      options.apiBaseUrl,
      options.hubEntityId,
      options.counterpartyEntityId,
      options.tokenId,
    );
    if (latest.disputeObservedOnChain) return latest;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(
    `HLT_RUST_DISPUTE_J_EVENT_TIMEOUT:${safeStringify(latest)}:${options.rust.errorTail()}`,
  );
};

const waitForCounterpartyDispute = async (
  lane: LaneRuntime,
  hubRuntimeId: string,
  hubEntityId: string,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  let latest: readonly unknown[] = [];
  while (Date.now() <= deadline) {
    latest = await readLaneAccountDetails(lane, hubRuntimeId);
    const observed = latest.some(value => {
      const row = requireBoundaryRecord(value, 'HLT_RUST_DISPUTE_COUNTERPARTY_ACCOUNT');
      return String(row['counterpartyId'] || '').toLowerCase() === hubEntityId.toLowerCase()
        && row['status'] === 'disputed'
        && row['activeDisputeObservedOnChain'] === true;
    });
    if (observed) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`HLT_RUST_DISPUTE_COUNTERPARTY_EVENT_TIMEOUT:${safeStringify(latest)}`);
};

const submitCounterpartyFinalize = async (
  lane: LaneRuntime,
  hubEntityId: string,
): Promise<void> => {
  await queueLaneRuntimeInputWave(0, [{
    lane,
    input: {
      runtimeTxs: [],
      entityInputs: [{
        entityId: lane.identity.entityId,
        signerId: lane.identity.signerId,
        entityTxs: [{
          type: 'disputeFinalize',
          data: {
            counterpartyEntityId: hubEntityId,
            description: 'hlt-counterparty-mutual-consent',
          },
        }],
      }],
    },
  }], { waitForCommit: true });
  await queueLaneRuntimeInputWave(0, [{
    lane,
    input: {
      runtimeTxs: [],
      entityInputs: [{
        entityId: lane.identity.entityId,
        signerId: lane.identity.signerId,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      }],
    },
  }], { waitForCommit: true });
};

const waitForFinalizedDispute = async (
  options: Readonly<{
    apiBaseUrl: string;
    rust: RustH1Handle;
    hubEntityId: string;
    counterpartyEntityId: string;
    tokenId: number;
    jNonceBefore: number;
  }>,
): Promise<RustH1DisputeAccountStatus> => {
  const deadline = Date.now() + 5_000;
  let latest: RustH1DisputeAccountStatus | null = null;
  while (Date.now() <= deadline) {
    latest = await readRustH1AccountStatus(
      options.apiBaseUrl,
      options.hubEntityId,
      options.counterpartyEntityId,
      options.tokenId,
    );
    if (
      latest.status === 'disputed' && !latest.disputeObservedOnChain &&
      latest.jNonce > options.jNonceBefore
    ) return latest;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(
    `HLT_RUST_DISPUTE_FINALITY_TIMEOUT:${safeStringify(latest)}:${options.rust.errorTail()}`,
  );
};

export const runRustH1DisputeSmoke = async (options: Readonly<{
  apiBaseUrl: string;
  rust: RustH1Handle;
  lane: LaneRuntime;
  businessInput: RuntimeInput;
  tokenId: number;
}>): Promise<RustH1DisputeSmokeResult> => {
  const hubEntityId = options.rust.ready.entityId;
  const counterpartyEntityId = options.lane.identity.entityId;
  const before = await readRustH1AccountStatus(
    options.apiBaseUrl,
    hubEntityId,
    counterpartyEntityId,
    options.tokenId,
  );
  const businessEntityInputs = options.businessInput.entityInputs;
  if (
    options.businessInput.runtimeTxs.length !== 0 ||
    businessEntityInputs.length !== 1 ||
    businessEntityInputs[0]?.entityId !== counterpartyEntityId ||
    businessEntityInputs[0]?.signerId !== options.lane.identity.signerId ||
    !businessEntityInputs[0]?.entityTxs?.length
  ) throw new Error('HLT_RUST_DISPUTE_BUSINESS_INPUT_INVALID');

  await startLaneJurisdictionWatcher(options.lane);

  await options.rust.submitLocalEntityInputs(
    `hlt-dispute-prepare-${counterpartyEntityId.slice(-8)}-${before.runtimeHeight}`,
    [{
      entityId: hubEntityId,
      signerId: options.rust.ready.signerId,
      entityTxs: [{
        type: 'prepareDispute',
        data: {
          counterpartyEntityId,
          description: 'hlt-production-dispute-freeze',
          minCooldownMs: DISPUTE_COOLDOWN_MS,
        },
      }],
    }],
  );
  const frozen = await readRustH1AccountStatus(
    options.apiBaseUrl,
    hubEntityId,
    counterpartyEntityId,
    options.tokenId,
  );
  const metricsBeforeBusiness = await waitForRustH1Metrics(
    options.rust,
    metrics => metrics.height >= frozen.runtimeHeight,
    'HLT_RUST_DISPUTE_PREPARE_METRICS_MISSING',
  );
  await options.rust.submitLocalEntityInputs(
    `hlt-dispute-broadcast-${counterpartyEntityId.slice(-8)}-${frozen.runtimeHeight}`,
    [{
      entityId: hubEntityId,
      signerId: options.rust.ready.signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }],
  );
  const observed = await waitForObservedDispute({
    apiBaseUrl: options.apiBaseUrl,
    rust: options.rust,
    hubEntityId,
    counterpartyEntityId,
    tokenId: options.tokenId,
  });
  await queueLaneRuntimeInputWave(0, [{ lane: options.lane, input: options.businessInput }], {
    waitForCommit: true,
  });
  const metricsAfterBusiness = await waitForRustH1Metrics(
    options.rust,
    metrics =>
      metrics.height > metricsBeforeBusiness.height &&
      metrics.totalAccountInputs > metricsBeforeBusiness.totalAccountInputs,
    'HLT_RUST_DISPUTE_BUSINESS_INPUT_NOT_OBSERVED',
  );
  const afterBusinessInput = await readRustH1AccountStatus(
    options.apiBaseUrl,
    hubEntityId,
    counterpartyEntityId,
    options.tokenId,
  );
  assertRustH1DisputeFreeze(before, frozen, observed, afterBusinessInput);
  await waitForCounterpartyDispute(
    options.lane,
    options.rust.ready.runtimeId,
    hubEntityId,
  );
  await submitCounterpartyFinalize(options.lane, hubEntityId);
  const finalized = await waitForFinalizedDispute({
    apiBaseUrl: options.apiBaseUrl,
    rust: options.rust,
    hubEntityId,
    counterpartyEntityId,
    tokenId: options.tokenId,
    jNonceBefore: observed.jNonce,
  });
  assertRustH1DisputeFinalized(afterBusinessInput, finalized);
  return {
    evidence: 'functional-smoke',
    hubEntityId,
    counterpartyEntityId,
    accountHeightBefore: before.currentHeight,
    accountHeightFrozen: frozen.currentHeight,
    accountHeightAfterRejectedBusinessInput: afterBusinessInput.currentHeight,
    runtimeHeightBefore: before.runtimeHeight,
    runtimeHeightFrozen: frozen.runtimeHeight,
    runtimeHeightObservedOnChain: observed.runtimeHeight,
    runtimeHeightAfterRejectedBusinessInput: afterBusinessInput.runtimeHeight,
    runtimeHeightFinalized: finalized.runtimeHeight,
    observedBlockNumber: observed.disputeObservedBlockNumber!,
    observedAccountInputs:
      metricsAfterBusiness.totalAccountInputs - metricsBeforeBusiness.totalAccountInputs,
    jNonceBefore: before.jNonce,
    jNonceFinalized: finalized.jNonce,
    counterProofRequired: false,
  };
};
