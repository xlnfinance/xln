import type { AccountTx, EntityInput, EntityState, EntityTx, Env } from '../../../types';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import { normalizeRebalanceMatchingStrategy } from '../../../extensions/rebalance/policy';
import { cloneEntityState, addMessage } from '../../../state-helpers';
import { checkAutoRebalance } from '../../../account/tx/handlers/request-collateral';
import {
  assertNoTokenlessHubRawOverrides,
  getDefaultRebalanceBaseFeeForToken,
} from '../../../account/rebalance-defaults';
import type { MempoolOp } from './account';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type AccountAdminResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const log = createStructuredLogger('entity.tx.account-admin');

const processingTrigger = (state: EntityState): EntityInput[] => {
  const firstValidator = state.config.validators[0];
  return firstValidator
    ? [{ entityId: state.entityId, signerId: firstValidator, entityTxs: [] }]
    : [];
};

export const buildHubRebalancePolicyTx = (
  config: NonNullable<EntityState['hubRebalanceConfig']>,
  tokenId: number,
): Extract<AccountTx, { type: 'rebalance_policy' }> => ({
  type: 'rebalance_policy',
  data: {
    tokenId,
    policyVersion: config.policyVersion,
    baseFee: getDefaultRebalanceBaseFeeForToken(tokenId),
    liquidityFeeBps: config.rebalanceLiquidityFeeBps ?? config.minFeeBps ?? 1n,
    gasFee: 0n,
  },
});

export const handleExtendCreditEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'extendCredit'>,
): AccountAdminResult => {
  const newState = cloneEntityState(entityState);
  const mempoolOps: MempoolOp[] = [];
  const { counterpartyEntityId, tokenId, amount } = entityTx.data;

  if (!newState.accounts.has(counterpartyEntityId)) {
    log.warn('extend_credit.missing_account', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });
    return { newState: entityState, outputs: [] };
  }

  const accountTx: AccountTx = {
    type: 'set_credit_limit',
    data: { tokenId, amount },
  };

  mempoolOps.push({ accountId: counterpartyEntityId, tx: accountTx });
  addMessage(newState, `💳 Extended credit of ${amount} to ${counterpartyEntityId.slice(-4)}`);
  log.info('extend_credit.queued', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyEntityId),
    tokenId,
    amount,
  });

  return { newState, outputs: processingTrigger(entityState), mempoolOps };
};

export const handleSetHubConfigEntityTx = (
  _env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'setHubConfig'>,
): AccountAdminResult => {
  assertNoTokenlessHubRawOverrides(entityTx.data);
  const newState = cloneEntityState(entityState);
  const {
    hubName: hubNameRaw,
    matchingStrategy: matchingStrategyRaw = 'amount',
    policyVersion: policyVersionRaw,
    routingFeePPM = 1,
    baseFee = 0n,
    swapTakerFeeBps = 0,
    disputeAutoFinalizeMode = 'auto',
    minCollateralThreshold = 0n,
    minFeeBps = 1n,
    rebalanceLiquidityFeeBps = 1n,
    rebalanceTimeoutMs = 10 * 60 * 1000,
  } = entityTx.data;

  const matchingStrategy = normalizeRebalanceMatchingStrategy(matchingStrategyRaw);
  const previousConfig = entityState.hubRebalanceConfig;
  const hubName = typeof hubNameRaw === 'string' && hubNameRaw.trim().length > 0
    ? hubNameRaw.trim()
    : previousConfig?.hubName;
  const previousVersion = previousConfig?.policyVersion ?? 0;
  const feePolicyChanged = !previousConfig ||
    (previousConfig.rebalanceLiquidityFeeBps ?? previousConfig.minFeeBps ?? 1n) !== rebalanceLiquidityFeeBps;
  if (
    policyVersionRaw !== undefined &&
    (!Number.isSafeInteger(policyVersionRaw) || Number(policyVersionRaw) <= 0)
  ) {
    throw new Error(`HUB_REBALANCE_POLICY_VERSION_INVALID:${String(policyVersionRaw)}`);
  }
  const requestedPolicyVersion = policyVersionRaw === undefined
    ? undefined
    : Number(policyVersionRaw);

  if (rebalanceLiquidityFeeBps < 0n || rebalanceLiquidityFeeBps > 10_000n) {
    throw new Error(`HUB_REBALANCE_LIQUIDITY_FEE_BPS_INVALID:${rebalanceLiquidityFeeBps}`);
  }

  let policyVersion: number;
  if (requestedPolicyVersion !== undefined) {
    if (requestedPolicyVersion < previousVersion) {
      throw new Error(`HUB_REBALANCE_POLICY_VERSION_STALE:${requestedPolicyVersion}<${previousVersion}`);
    } else if (requestedPolicyVersion === previousVersion && feePolicyChanged) {
      throw new Error(`HUB_REBALANCE_POLICY_EQUIVOCATION:version=${requestedPolicyVersion}`);
    } else {
      policyVersion = requestedPolicyVersion;
    }
  } else if (previousVersion <= 0) {
    policyVersion = 1;
  } else {
    policyVersion = feePolicyChanged ? previousVersion + 1 : previousVersion;
  }

  const normalizedSwapTakerFeeBps = Math.max(0, Math.min(10_000, Math.floor(Number(swapTakerFeeBps) || 0)));

  newState.hubRebalanceConfig = {
    ...(hubName ? { hubName } : {}),
    matchingStrategy,
    policyVersion,
    routingFeePPM,
    baseFee,
    swapTakerFeeBps: normalizedSwapTakerFeeBps,
    disputeAutoFinalizeMode,
    minCollateralThreshold,
    minFeeBps,
    rebalanceLiquidityFeeBps,
    rebalanceTimeoutMs,
  };
  newState.profile = {
    ...newState.profile,
    isHub: true,
  };

  addMessage(
    newState,
    `🏦 Hub config activated: ${matchingStrategy} strategy v${policyVersion}, ${routingFeePPM}ppm routing fee, ` +
    `swapTakerFee=${normalizedSwapTakerFeeBps}bps, ` +
    `rebalance(base=token-default, liqBps=${rebalanceLiquidityFeeBps}, gas=token-default, ` +
    'c2rWithdrawSoftLimit=token-default)',
  );
  log.info('hub_config.updated', {
    entity: shortId(newState.entityId),
    matchingStrategy,
    policyVersion,
    routingFeePPM,
    swapTakerFeeBps: normalizedSwapTakerFeeBps,
    feePolicyChanged,
  });

  const mempoolOps = Array.from(newState.accounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([accountId, account]) => Array.from(account.deltas.keys())
      .sort((left, right) => left - right)
      .map((tokenId) => ({
        accountId,
        tx: buildHubRebalancePolicyTx(newState.hubRebalanceConfig!, tokenId),
      })));

  return {
    newState,
    outputs: mempoolOps.length > 0 ? processingTrigger(newState) : [],
    ...(mempoolOps.length > 0 ? { mempoolOps } : {}),
  };
};

export const handleSetRebalancePolicyEntityTx = (
  _env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'setRebalancePolicy'>,
): AccountAdminResult => {
  const newState = cloneEntityState(entityState);
  const { counterpartyEntityId, tokenId, r2cRequestSoftLimit, hardLimit, maxAcceptableFee } = entityTx.data;

  if (!newState.accounts.has(counterpartyEntityId)) {
    log.warn('rebalance_policy.missing_account', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });
    return { newState: entityState, outputs: [] };
  }

  if (r2cRequestSoftLimit < 0n || hardLimit < r2cRequestSoftLimit || maxAcceptableFee < 0n) {
    throw new Error(`REBALANCE_POLICY_INVALID: token=${tokenId}`);
  }
  const account = newState.accounts.get(counterpartyEntityId)!;
  account.shadow.rebalance.policy.set(tokenId, {
    r2cRequestSoftLimit,
    hardLimit,
    maxAcceptableFee,
  });

  const rebalanceTxs = newState.hubRebalanceConfig
    ? []
    : checkAutoRebalance(
        account,
        newState.entityId,
        counterpartyEntityId,
      );

  return {
    newState,
    outputs: rebalanceTxs.length > 0 ? processingTrigger(newState) : [],
    mempoolOps: rebalanceTxs.map((tx) => ({ accountId: counterpartyEntityId, tx })),
  };
};

export const handleRequestCollateralEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'requestCollateral'>,
): AccountAdminResult => {
  const newState = cloneEntityState(entityState);
  const { counterpartyEntityId, tokenId, amount, feeTokenId, feeAmount, policyVersion } = entityTx.data;

  if (!newState.accounts.has(counterpartyEntityId)) {
    log.warn('collateral_request.missing_account', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });
    return { newState: entityState, outputs: [] };
  }

  return {
    newState,
    outputs: processingTrigger(entityState),
    mempoolOps: [{
      accountId: counterpartyEntityId,
      tx: {
        type: 'request_collateral',
        data: {
          tokenId,
          amount,
          ...(feeTokenId !== undefined ? { feeTokenId } : {}),
          feeAmount,
          policyVersion,
        },
      },
    }],
  };
};

export const handleReopenDisputedAccountEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'reopenDisputedAccount'>,
): AccountAdminResult => {
  const newState = cloneEntityState(entityState);
  const { counterpartyEntityId } = entityTx.data;
  const accountMachine = newState.accounts.get(counterpartyEntityId);

  if (!accountMachine) {
    log.warn('reopen_disputed.missing_account', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });
    return { newState: entityState, outputs: [] };
  }

  const jNonce = Number(entityTx.data.jNonce ?? accountMachine.jNonce ?? 0);
  addMessage(newState, `🔓 Reopen requested with ${counterpartyEntityId.slice(-4)} at nonce=${jNonce}`);

  return {
    newState,
    outputs: processingTrigger(entityState),
    mempoolOps: [{
      accountId: counterpartyEntityId,
      tx: {
        type: 'reopen_disputed',
        data: { jNonce },
      },
    }],
  };
};
