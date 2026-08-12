import type { AccountReplica, SettlementOp } from '../../types/account';
import type { EntityInput } from '../types';
import type { EntityRuntimeContext } from '../runtime-context';
import type { EntityTx } from '../../types/entity-tx';
import { isLeftEntity } from '../id';
import { getEntityLeaderState } from '../consensus/leader';
import { deriveDelta } from '../../account/utils';
import { normalizeRebalanceMatchingStrategy } from '../../extensions/rebalance/policy';
import {
  assertNoTokenlessHubRawOverrides,
  getDefaultRebalanceBaseFeeForToken,
  getDefaultRebalancePolicyForToken,
} from '../../account/config/defaults';
import { createStructuredLogger, shortId } from '../../infra/logger';
import {
  batchAddReserveToCollateral,
  cloneJBatch,
  initJBatch,
} from '../../jurisdiction/machine/batch';
import { hasPendingSettlementTransition } from '../../account/tx/handlers/settle-transition';
import type {
  CrontabExecutionContext,
  EntityTransitionContext,
  CrontabTaskState,
} from '../scheduler-types';
import { getRebalanceAccountIds } from '../consensus/account-work-index';

const crontabLog = createStructuredLogger('entity.crontab');

export const HUB_PENDING_BROADCAST_STALE_MS = 120_000;
const HUB_SUBMITTED_REQUEST_STALE_MS = 5 * 60 * 1_000;
const HUB_MAX_R2C_PER_TICK = 10;
const HUB_MAX_C2R_PER_TICK = 10;

type RebalanceDebug = (payload: Record<string, unknown>) => void;

type RebalanceRun = {
  env: EntityRuntimeContext;
  replica: EntityTransitionContext;
  execution: CrontabExecutionContext;
  outputs: EntityInput[];
  localEntityTxs: EntityTx[];
  signerId: string;
  now: number;
  submitClockNow: number;
  strategy: ReturnType<typeof normalizeRebalanceMatchingStrategy>;
  liquidityFeeBps: bigint;
  policyVersion: number;
  hubId: string;
  debug: RebalanceDebug;
};

type R2CTarget = {
  counterpartyId: string;
  tokenId: number;
  amount: bigint;
  requestedAt: number;
  feePaidUpfront: bigint;
};

type C2RPlan = {
  counterpartyId: string;
  ops: SettlementOp[];
  totalAmount: bigint;
};

const compareBigDesc = (left: bigint, right: bigint): number =>
  left === right ? 0 : left > right ? -1 : 1;
const compareBigAsc = (left: bigint, right: bigint): number =>
  left === right ? 0 : left < right ? -1 : 1;

const createRebalanceRun = (
  env: EntityRuntimeContext,
  replica: EntityTransitionContext,
  execution: CrontabExecutionContext,
): RebalanceRun => {
  const config = replica.state.hubRebalanceConfig!;
  const hubId = replica.entityId;
  const debug: RebalanceDebug = payload => {
    (execution.candidateEffects ??= []).push({
      kind: 'debug',
      payload: { level: 'info', code: 'REB_STEP', hubId, ...payload },
    });
  };
  return {
    env,
    replica,
    execution,
    outputs: [],
    localEntityTxs: [],
    // A deterministic self-output targets the committed Entity leader. Looking
    // at Runtime replicas or private keys here would make validator replay
    // depend on local topology instead of the signed Entity authority.
    signerId: getEntityLeaderState(replica.state).activeValidatorId,
    now: replica.state.timestamp,
    // `sentBatch.lastSubmittedAt` uses Runtime time. Comparing it with Entity
    // time would freeze age while the pending batch blocks Entity frames.
    submitClockNow: env.state.timestamp,
    strategy: normalizeRebalanceMatchingStrategy(config.matchingStrategy),
    liquidityFeeBps: config.rebalanceLiquidityFeeBps,
    policyVersion:
      Number.isFinite(config.policyVersion) && config.policyVersion > 0
        ? config.policyVersion
        : 1,
    hubId,
    debug,
  };
};

const resolveBatchAvailability = (run: RebalanceRun): {
  canTouchBatch: boolean;
  terminal: boolean;
} => {
  const { replica, submitClockNow, hubId, localEntityTxs, outputs, signerId } = run;
  replica.state.jBatchState ??= initJBatch();
  const sent = replica.state.jBatchState.sentBatch;
  if (!sent) return { canTouchBatch: true, terminal: false };
  const ageMs =
    submitClockNow -
    (sent.lastSubmittedAt || replica.state.jBatchState.lastBroadcast || 0);
  if (ageMs <= HUB_PENDING_BROADCAST_STALE_MS) {
    console.warn(
      `⏳ Hub rebalance blocked: sentBatch pending age=${ageMs}ms ` +
      `nonce=${sent.entityNonce} (entity=${hubId.slice(-4)})`,
    );
    return { canTouchBatch: false, terminal: false };
  }
  console.warn(
    `⚠️ Hub rebalance stale sentBatch (${ageMs}ms) - ` +
    'queueing persisted abort (manual recovery path)',
  );
  localEntityTxs.push({
    type: 'j_abort_sent_batch',
    data: { reason: 'stale-hub-rebalance-latch', requeueToCurrent: true },
  });
  outputs.push({ entityId: replica.entityId, signerId, entityTxs: localEntityTxs });
  return { canTouchBatch: false, terminal: true };
};

const recordStaleR2CRetry = (
  run: RebalanceRun,
  counterpartyId: string,
  tokenId: number,
  submittedAgeMs: number,
): void => {
  console.warn(
    `⚠️ R→C stale submission reset for retry: token=${tokenId} ` +
    `cp=${counterpartyId.slice(-4)} submittedAgeMs=${submittedAgeMs}`,
  );
  run.debug({
    step: 2,
    status: 'retry',
    event: 'request_submitted_stale_retry_reset',
    counterpartyId,
    tokenId,
    submittedAgeMs,
  });
};

const validateR2CRequestPolicy = (
  run: RebalanceRun,
  account: AccountReplica,
  counterpartyId: string,
  tokenId: number,
  requestedAmount: bigint,
): { requestedAt: number; feePaidUpfront: bigint } | null => {
  const feeState = account.state.requestedRebalanceFeeState?.get(tokenId);
  if (!feeState) {
    throw new Error(`REBALANCE_REQUEST_FEE_STATE_MISSING:${counterpartyId}:${tokenId}`);
  }
  if (feeState.refund) {
    run.debug({
      step: 2,
      status: 'blocked',
      event: 'request_refund_in_progress',
      counterpartyId,
      tokenId,
      requestId: feeState.requestId,
      refundedAmount: String(feeState.refund.refundedAmount),
    });
    return null;
  }
  const submittedAt = account.shadow.rebalance.submittedAtByToken.get(tokenId) ?? 0;
  const submittedAgeMs = submittedAt > 0 ? run.now - submittedAt : 0;
  const submittedStale =
    submittedAt > 0 && submittedAgeMs >= HUB_SUBMITTED_REQUEST_STALE_MS;
  if (submittedAt > 0 && !submittedStale) return null;
  if (submittedAt <= 0 && (feeState.policyVersion || 0) !== run.policyVersion) {
    console.warn(
      `⏸️ R→C request pending (policy mismatch, manual action required): ` +
      `token=${tokenId} cp=${counterpartyId.slice(-4)} ` +
      `reqPolicy=${feeState.policyVersion} hubPolicy=${run.policyVersion}`,
    );
    run.debug({
      step: 2,
      status: 'blocked',
      event: 'policy_mismatch_manual',
      counterpartyId,
      tokenId,
      requestPolicyVersion: feeState.policyVersion || 0,
      hubPolicyVersion: run.policyVersion,
    });
    return null;
  }
  if (submittedStale) {
    recordStaleR2CRetry(run, counterpartyId, tokenId, submittedAgeMs);
  }
  const minFee =
    getDefaultRebalanceBaseFeeForToken(tokenId) +
    (requestedAmount * run.liquidityFeeBps) / 10_000n;
  if (feeState.feePaidUpfront >= minFee) {
    return {
      requestedAt: feeState.requestedAt || 0,
      feePaidUpfront: feeState.feePaidUpfront,
    };
  }
  console.warn(
    `⏸️ R→C request pending (prepaid fee too low, manual action required): ` +
    `token=${tokenId} cp=${counterpartyId.slice(-4)} ` +
    `prepaid=${feeState.feePaidUpfront} < requiredFee=${minFee}`,
  );
  run.debug({
    step: 2,
    status: 'blocked',
    event: 'prepaid_fee_too_low_manual',
    counterpartyId,
    tokenId,
    prepaidFee: String(feeState.feePaidUpfront),
    requiredFee: String(minFee),
  });
  return null;
};

const evaluateR2CRequest = (
  run: RebalanceRun,
  account: AccountReplica,
  counterpartyId: string,
  tokenId: number,
  requestedAmountRaw: bigint,
  effectiveReserves: Map<number, bigint>,
): R2CTarget | null => {
  if (requestedAmountRaw <= 0n) return null;
  const request = validateR2CRequestPolicy(
    run,
    account,
    counterpartyId,
    tokenId,
    requestedAmountRaw,
  );
  if (!request) return null;
  const delta = account.state.deltas.get(tokenId);
  if (!delta) {
    console.warn(
      `⚠️ R→C request ignored (missing delta): token=${tokenId} cp=${counterpartyId.slice(-4)}`,
    );
    run.debug({
      step: 2,
      status: 'error',
      event: 'request_missing_delta',
      counterpartyId,
      tokenId,
    });
    return null;
  }
  const uncollateralized =
    deriveDelta(delta, !isLeftEntity(run.hubId, counterpartyId)).outPeerCredit;
  if (uncollateralized <= 0n) {
    // A local crontab tick cannot clear bilateral request state. Only an
    // explicit Account transition may change both peers' committed root.
    run.debug({
      step: 2,
      status: 'blocked',
      event: 'request_waiting_bilateral_resolution',
      counterpartyId,
      tokenId,
    });
    return null;
  }
  const requestedAmount =
    requestedAmountRaw > uncollateralized ? uncollateralized : requestedAmountRaw;
  const reserve = effectiveReserves.get(tokenId) ?? 0n;
  const amount = requestedAmount > reserve ? reserve : requestedAmount;
  if (amount <= 0n) {
    console.warn(
      `⚠️ R→C request pending but skipped (zero reserve): token=${tokenId} ` +
      `cp=${counterpartyId.slice(-4)} requested=${requestedAmount}`,
    );
    run.debug({
      step: 2,
      status: 'blocked',
      event: 'hub_reserve_zero',
      counterpartyId,
      tokenId,
      requestedAmount: String(requestedAmount),
    });
    return null;
  }
  effectiveReserves.set(tokenId, reserve - amount);
  return {
    counterpartyId,
    tokenId,
    amount,
    requestedAt: request.requestedAt,
    feePaidUpfront: request.feePaidUpfront,
  };
};

const collectR2CTargets = (run: RebalanceRun): R2CTarget[] => {
  const effectiveReserves = new Map(run.replica.state.reserves);
  const targets: R2CTarget[] = [];
  for (const counterpartyId of getRebalanceAccountIds(run.replica.state)) {
    const account = run.replica.state.accounts.get(counterpartyId);
    if (!account) throw new Error(`REBALANCE_ACCOUNT_INDEX_STALE:${counterpartyId}`);
    for (const [tokenId, amount] of account.state.requestedRebalance ?? []) {
      const target = evaluateR2CRequest(
        run,
        account,
        counterpartyId,
        tokenId,
        amount,
        effectiveReserves,
      );
      if (target) targets.push(target);
    }
  }
  if (run.strategy === 'amount') {
    targets.sort((left, right) =>
      compareBigDesc(left.amount, right.amount) ||
      compareBigAsc(BigInt(left.requestedAt), BigInt(right.requestedAt)));
  } else if (run.strategy === 'fee') {
    targets.sort((left, right) =>
      compareBigDesc(left.feePaidUpfront, right.feePaidUpfront) ||
      compareBigDesc(left.amount, right.amount));
  } else {
    targets.sort((left, right) =>
      compareBigAsc(BigInt(left.requestedAt), BigInt(right.requestedAt)) ||
      compareBigDesc(left.amount, right.amount));
  }
  if (targets.length > HUB_MAX_R2C_PER_TICK) {
    console.warn(
      `⚠️ Hub rebalance: capped R→C targets this tick ` +
      `${HUB_MAX_R2C_PER_TICK}/${targets.length}`,
    );
  }
  return targets.slice(0, HUB_MAX_R2C_PER_TICK);
};

const queueR2CTargets = (
  run: RebalanceRun,
  targets: readonly R2CTarget[],
  canTouchBatch: boolean,
): number => {
  if (!canTouchBatch) {
    if (targets.length > 0) {
      console.warn(`⏳ R→C skipped this tick: sentBatch pending (targets=${targets.length})`);
    }
    return 0;
  }
  const current = run.replica.state.jBatchState!;
  const submissions = targets.map(target => {
    const account = run.replica.state.accounts.get(target.counterpartyId);
    if (!account?.state.requestedRebalanceFeeState?.has(target.tokenId)) {
      throw new Error(
        `REBALANCE_TARGET_STATE_CHANGED:${target.counterpartyId}:${target.tokenId}`,
      );
    }
    return { account, target };
  });
  const candidate = {
    ...current,
    batch: cloneJBatch(current.batch),
  };

  // Build the complete R→C draft away from live Entity state. A contract
  // limit or malformed target must reject this Entity frame; committing a
  // prefix would spend reserve for only part of the selected request set.
  for (const target of targets) {
    batchAddReserveToCollateral(
      candidate,
      run.hubId,
      target.counterpartyId,
      target.tokenId,
      target.amount,
    );
  }
  current.batch = candidate.batch;
  current.status = candidate.status;

  for (const { account, target } of submissions) {
    account.shadow.rebalance.submittedAtByToken.set(target.tokenId, run.now);
    run.execution.accountChanges.add(target.counterpartyId);
    crontabLog.debug('rebalance.r2c.batch_add', {
      hub: shortId(run.hubId, 8),
      counterparty: shortId(target.counterpartyId),
      tokenId: target.tokenId,
      amount: target.amount.toString(),
      requestedAt: target.requestedAt,
    });
    run.debug({
      step: 2,
      status: 'ok',
      event: 'batch_add',
      counterpartyId: target.counterpartyId,
      tokenId: target.tokenId,
      amount: String(target.amount),
      requestedAt: target.requestedAt,
    });
  }
  return targets.length;
};

const collectC2RAccountWork = (
  run: RebalanceRun,
  counterpartyId: string,
  account: AccountReplica,
  canTouchBatch: boolean,
): { plan?: C2RPlan; executable: boolean } => {
  if (account.pendingFrame || hasPendingSettlementTransition(account)) {
    return { executable: false };
  }
  const hubIsLeft = isLeftEntity(run.hubId, counterpartyId);
  const workspace = account.state.settlementWorkspace;
  if (workspace) {
    const executable =
      canTouchBatch &&
      workspace.lastModifiedByLeft === hubIsLeft &&
      workspace.ops.length > 0 &&
      workspace.ops.every(op => op.type === 'c2r') &&
      workspace.executorIsLeft === hubIsLeft &&
      workspace.status === 'ready_to_submit' &&
      Boolean(hubIsLeft ? workspace.rightHanko : workspace.leftHanko);
    return { executable };
  }

  const ops: SettlementOp[] = [];
  let totalAmount = 0n;
  for (const [tokenId, delta] of account.state.deltas) {
    if ((account.state.requestedRebalance.get(tokenId) ?? 0n) > 0n) continue;
    const derived = deriveDelta(delta, hubIsLeft);
    if (derived.outTotalHold === undefined) {
      throw new Error(
        `deriveDelta missing outTotalHold for token ${String(tokenId)} on ${counterpartyId}`,
      );
    }
    const free =
      derived.outCollateral > derived.outTotalHold
        ? derived.outCollateral - derived.outTotalHold
        : 0n;
    const softLimit =
      getDefaultRebalancePolicyForToken(tokenId).r2cRequestSoftLimit;
    if (free <= softLimit) continue;
    run.debug({
      step: 2,
      status: 'ok',
      event: 'c2r_withdraw_overcollateralized',
      counterpartyId,
      tokenId,
      outCollateral: String(derived.outCollateral),
      outHold: String(derived.outTotalHold),
      freeOutCollateral: String(free),
      c2rWithdrawSoftLimit: String(softLimit),
      withdrawAmount: String(free),
    });
    ops.push({ type: 'c2r', tokenId, amount: free });
    totalAmount += free;
  }
  return {
    executable: false,
    ...(ops.length > 0 && totalAmount > 0n
      ? { plan: { counterpartyId, ops, totalAmount } }
      : {}),
  };
};

const collectC2RWork = (
  run: RebalanceRun,
  canTouchBatch: boolean,
): { plans: C2RPlan[]; executable: string[] } => {
  const plans: C2RPlan[] = [];
  const executable: string[] = [];
  for (const counterpartyId of getRebalanceAccountIds(run.replica.state)) {
    const account = run.replica.state.accounts.get(counterpartyId);
    if (!account) throw new Error(`REBALANCE_ACCOUNT_INDEX_STALE:${counterpartyId}`);
    const work = collectC2RAccountWork(run, counterpartyId, account, canTouchBatch);
    if (work.plan) plans.push(work.plan);
    if (work.executable) executable.push(counterpartyId);
  }
  plans.sort((left, right) => compareBigDesc(left.totalAmount, right.totalAmount));
  if (plans.length > HUB_MAX_C2R_PER_TICK) {
    console.warn(
      `⚠️ Hub rebalance: capped C→R proposals this tick ` +
      `${HUB_MAX_C2R_PER_TICK}/${plans.length}`,
    );
  }
  if (executable.length > HUB_MAX_C2R_PER_TICK) {
    console.warn(
      `⚠️ Hub rebalance: capped C→R executes this tick ` +
      `${HUB_MAX_C2R_PER_TICK}/${executable.length}`,
    );
  }
  return {
    plans: plans.slice(0, HUB_MAX_C2R_PER_TICK),
    executable: executable.slice(0, HUB_MAX_C2R_PER_TICK),
  };
};

const queueC2RWork = (
  run: RebalanceRun,
  plans: readonly C2RPlan[],
  executable: readonly string[],
): void => {
  for (const plan of plans) {
    run.localEntityTxs.push({
      type: 'settle_propose',
      data: {
        counterpartyEntityId: plan.counterpartyId,
        ops: plan.ops,
        executorIsLeft: isLeftEntity(run.hubId, plan.counterpartyId),
        memo: 'auto-c2r-rebalance',
      },
    });
    crontabLog.debug('rebalance.c2r.propose_queued', {
      counterparty: shortId(plan.counterpartyId),
      ops: plan.ops.length,
      amount: plan.totalAmount.toString(),
    });
    run.debug({
      step: 2,
      status: 'ok',
      event: 'c2r_settle_propose_queued',
      counterpartyId: plan.counterpartyId,
      ops: plan.ops.length,
      amount: String(plan.totalAmount),
    });
  }
  for (const counterpartyId of executable) {
    run.localEntityTxs.push({
      type: 'settle_execute',
      data: { counterpartyEntityId: counterpartyId },
    });
    crontabLog.debug('rebalance.c2r.execute_queued', {
      counterparty: shortId(counterpartyId),
    });
    run.debug({
      step: 2,
      status: 'ok',
      event: 'c2r_settle_execute_queued',
      counterpartyId,
    });
  }
};

const queueRebalanceBroadcast = (
  run: RebalanceRun,
  canTouchBatch: boolean,
  queuedR2C: number,
  queuedC2RExec: number,
): void => {
  const hasBatchWork = queuedR2C > 0 || queuedC2RExec > 0;
  if (!hasBatchWork) return;
  const sentPending = Boolean(run.replica.state.jBatchState?.sentBatch);
  const shouldBroadcast =
    canTouchBatch &&
    !sentPending &&
    !run.execution.manualBroadcastInInput;
  if (shouldBroadcast) {
    run.localEntityTxs.push({ type: 'j_broadcast', data: {} });
    crontabLog.debug('rebalance.broadcast_queued', {
      hub: shortId(run.hubId, 8),
      sentPending,
      queuedR2C,
      queuedC2RExec,
    });
    run.debug({
      step: 3,
      status: 'ok',
      event: 'j_broadcast_queued',
      queuedCount: queuedR2C + queuedC2RExec,
      sentBatchPending: sentPending,
    });
    return;
  }
  console.warn(
    `[REB][3][BROADCAST_ENTITY_TX_SKIPPED] hub=${run.hubId.slice(-8)} ` +
    `reason=${run.execution.manualBroadcastInInput
      ? 'manual-broadcast-in-input'
      : 'sent_batch_pending-or-batch-locked'} ` +
    `sentPending=${sentPending} canTouchBatch=${canTouchBatch} ` +
    `queuedR2C=${queuedR2C} queuedC2RExec=${queuedC2RExec}`,
  );
  run.debug({
    step: 3,
    status: 'blocked',
    event: 'j_broadcast_skipped',
    queuedCount: queuedR2C + queuedC2RExec,
    sentBatchPending: sentPending,
  });
};

export async function hubRebalanceHandler(
  env: EntityRuntimeContext,
  replica: EntityTransitionContext,
  _task: CrontabTaskState,
  execution: CrontabExecutionContext,
): Promise<EntityInput[]> {
  if (!replica.state.hubRebalanceConfig) return [];
  assertNoTokenlessHubRawOverrides(replica.state.hubRebalanceConfig);
  const run = createRebalanceRun(env, replica, execution);
  const batch = resolveBatchAvailability(run);
  if (batch.terminal) return run.outputs;

  const r2cTargets = collectR2CTargets(run);
  const queuedR2C = queueR2CTargets(run, r2cTargets, batch.canTouchBatch);
  const c2r = collectC2RWork(run, batch.canTouchBatch);
  queueC2RWork(run, c2r.plans, c2r.executable);
  queueRebalanceBroadcast(run, batch.canTouchBatch, queuedR2C, c2r.executable.length);
  if (run.localEntityTxs.length > 0) {
    run.outputs.push({
      entityId: replica.entityId,
      signerId: run.signerId,
      entityTxs: run.localEntityTxs,
    });
  }
  return run.outputs;
}
