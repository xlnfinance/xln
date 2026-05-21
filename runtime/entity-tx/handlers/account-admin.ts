import { DEFAULT_SOFT_LIMIT, type AccountTx, type EntityInput, type EntityState, type EntityTx, type Env } from '../../types';
import { createStructuredLogger, shortId } from '../../logger';
import { normalizeRebalanceMatchingStrategy } from '../../rebalance-policy';
import { announceLocalEntityProfile } from '../../networking/gossip-helper';
import { cloneEntityState, addMessage } from '../../state-helpers';
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
  env: Env,
  entityState: EntityState,
  entityTx: EntityTxOf<'setHubConfig'>,
): AccountAdminResult => {
  const newState = cloneEntityState(entityState);
  const {
    matchingStrategy: matchingStrategyRaw = 'amount',
    policyVersion: policyVersionRaw,
    routingFeePPM = 1,
    baseFee = 0n,
    swapTakerFeeBps = 0,
    disputeAutoFinalizeMode = 'auto',
    minCollateralThreshold = 0n,
    c2rWithdrawSoftLimit = DEFAULT_SOFT_LIMIT,
    minFeeBps = 1n,
    rebalanceBaseFee = 10n ** 17n,
    rebalanceLiquidityFeeBps = 1n,
    rebalanceGasFee = 0n,
    rebalanceTimeoutMs = 10 * 60 * 1000,
  } = entityTx.data;

  const matchingStrategy = normalizeRebalanceMatchingStrategy(matchingStrategyRaw);
  const previousConfig = entityState.hubRebalanceConfig;
  const previousVersion = previousConfig?.policyVersion ?? 0;
  const feePolicyChanged = !previousConfig ||
    (previousConfig.rebalanceBaseFee ?? 10n ** 17n) !== rebalanceBaseFee ||
    (previousConfig.rebalanceLiquidityFeeBps ?? previousConfig.minFeeBps ?? 1n) !== rebalanceLiquidityFeeBps ||
    (previousConfig.rebalanceGasFee ?? 0n) !== rebalanceGasFee;
  const requestedPolicyVersion = Number.isFinite(policyVersionRaw as number) && Number(policyVersionRaw) > 0
    ? Number(policyVersionRaw)
    : undefined;

  let policyVersion: number;
  if (requestedPolicyVersion !== undefined) {
    if (requestedPolicyVersion < previousVersion) {
      log.warn('hub_config.policy_downgrade_blocked', {
        entity: shortId(entityState.entityId),
        requested: requestedPolicyVersion,
        current: previousVersion,
      });
      policyVersion = previousVersion;
    } else {
      policyVersion = requestedPolicyVersion;
    }
  } else if (previousVersion <= 0) {
    policyVersion = 1;
  } else {
    policyVersion = feePolicyChanged ? previousVersion + 1 : previousVersion;
  }

  const effectiveC2RWithdrawSoftLimit =
    c2rWithdrawSoftLimit < DEFAULT_SOFT_LIMIT ? DEFAULT_SOFT_LIMIT : c2rWithdrawSoftLimit;
  const normalizedSwapTakerFeeBps = Math.max(0, Math.min(10_000, Math.floor(Number(swapTakerFeeBps) || 0)));

  newState.hubRebalanceConfig = {
    matchingStrategy,
    policyVersion,
    routingFeePPM,
    baseFee,
    swapTakerFeeBps: normalizedSwapTakerFeeBps,
    disputeAutoFinalizeMode,
    minCollateralThreshold,
    c2rWithdrawSoftLimit: effectiveC2RWithdrawSoftLimit,
    minFeeBps,
    rebalanceBaseFee,
    rebalanceLiquidityFeeBps,
    rebalanceGasFee,
    rebalanceTimeoutMs,
  };
  newState.profile = {
    ...newState.profile,
    isHub: true,
  };

  if (env.gossip) {
    announceLocalEntityProfile(env, newState, env.timestamp);
  }

  addMessage(
    newState,
    `🏦 Hub config activated: ${matchingStrategy} strategy v${policyVersion}, ${routingFeePPM}ppm routing fee, ` +
    `swapTakerFee=${normalizedSwapTakerFeeBps}bps, ` +
    `rebalance(base=${rebalanceBaseFee}, liqBps=${rebalanceLiquidityFeeBps}, gas=${rebalanceGasFee}, c2rWithdrawSoftLimit=${effectiveC2RWithdrawSoftLimit})`,
  );
  log.info('hub_config.updated', {
    entity: shortId(newState.entityId),
    matchingStrategy,
    policyVersion,
    routingFeePPM,
    swapTakerFeeBps: normalizedSwapTakerFeeBps,
    feePolicyChanged,
  });

  return { newState, outputs: [] };
};

export const handleSetRebalancePolicyEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'setRebalancePolicy'>,
): AccountAdminResult => {
  const newState = cloneEntityState(entityState);
  const { counterpartyEntityId, tokenId, r2cRequestSoftLimit, hardLimit, maxAcceptableFee } = entityTx.data;

  if (!newState.accounts.has(counterpartyEntityId)) {
    log.warn('rebalance_policy.missing_account', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });
    return { newState: entityState, outputs: [] };
  }

  return {
    newState,
    outputs: processingTrigger(entityState),
    mempoolOps: [{
      accountId: counterpartyEntityId,
      tx: {
        type: 'set_rebalance_policy',
        data: { tokenId, r2cRequestSoftLimit, hardLimit, maxAcceptableFee },
      },
    }],
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

  const onChainNonce = Number(entityTx.data.onChainNonce ?? accountMachine.onChainSettlementNonce ?? 0);
  addMessage(newState, `🔓 Reopen requested with ${counterpartyEntityId.slice(-4)} at nonce=${onChainNonce}`);

  return {
    newState,
    outputs: processingTrigger(entityState),
    mempoolOps: [{
      accountId: counterpartyEntityId,
      tx: {
        type: 'reopen_disputed',
        data: { onChainNonce },
      },
    }],
  };
};
