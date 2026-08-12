import type { AccountTx } from '../../../types/account';
import type { EntityInput, EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import { normalizeRebalanceMatchingStrategy } from '../../../extensions/rebalance/policy';
import { prepareEntityTxState } from '../../state-clone';
import { addMessage } from '../../frame-events';
import { checkAutoRebalance } from '../../../account/tx/handlers/request-collateral';
import {
  assertNoTokenlessHubRawOverrides,
  getDefaultRebalanceBaseFeeForToken,
} from '../../../account/config/defaults';
import type { AccountTxTarget } from './account';

type EntityTxOf<T extends EntityTx['type']> = Extract<EntityTx, { type: T }>;

type AccountAdminResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
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
    liquidityFeeBps: config.rebalanceLiquidityFeeBps,
    gasFee: 0n,
  },
});

type SetHubConfigTx = EntityTxOf<'setHubConfig'>;
type HubRebalanceConfig = NonNullable<EntityState['hubRebalanceConfig']>;

const resolveHubPolicyVersion = (
  requestedRaw: number | undefined,
  previous: HubRebalanceConfig | undefined,
  feePolicyChanged: boolean,
): number => {
  if (
    requestedRaw !== undefined &&
    (!Number.isSafeInteger(requestedRaw) || Number(requestedRaw) <= 0)
  ) {
    throw new Error(`HUB_REBALANCE_POLICY_VERSION_INVALID:${String(requestedRaw)}`);
  }
  const previousVersion = previous?.policyVersion ?? 0;
  if (requestedRaw !== undefined) {
    const requested = Number(requestedRaw);
    if (requested < previousVersion) {
      throw new Error(`HUB_REBALANCE_POLICY_VERSION_STALE:${requested}<${previousVersion}`);
    }
    if (requested === previousVersion && feePolicyChanged) {
      throw new Error(`HUB_REBALANCE_POLICY_EQUIVOCATION:version=${requested}`);
    }
    return requested;
  }
  if (previousVersion <= 0) return 1;
  return feePolicyChanged ? previousVersion + 1 : previousVersion;
};

const buildHubConfig = (
  previous: HubRebalanceConfig | undefined,
  data: SetHubConfigTx['data'],
): { config: HubRebalanceConfig; feePolicyChanged: boolean } => {
  assertNoTokenlessHubRawOverrides(data);
  const liquidityFeeBps = data.rebalanceLiquidityFeeBps ?? 1n;
  if (liquidityFeeBps < 0n || liquidityFeeBps > 10_000n) {
    throw new Error(`HUB_REBALANCE_LIQUIDITY_FEE_BPS_INVALID:${liquidityFeeBps}`);
  }
  const feePolicyChanged =
    !previous ||
    previous.rebalanceLiquidityFeeBps !== liquidityFeeBps;
  const hubName = typeof data.hubName === 'string' && data.hubName.trim()
    ? data.hubName.trim()
    : previous?.hubName;
  return {
    feePolicyChanged,
    config: {
      ...(hubName ? { hubName } : {}),
      matchingStrategy: normalizeRebalanceMatchingStrategy(data.matchingStrategy ?? 'amount'),
      policyVersion: resolveHubPolicyVersion(data.policyVersion, previous, feePolicyChanged),
      routingFeePPM: data.routingFeePPM ?? 1,
      baseFee: data.baseFee ?? 0n,
      swapTakerFeeBps: Math.max(
        0,
        Math.min(10_000, Math.floor(Number(data.swapTakerFeeBps ?? 0) || 0)),
      ),
      disputeAutoFinalizeMode: data.disputeAutoFinalizeMode ?? 'auto',
      minCollateralThreshold: data.minCollateralThreshold ?? 0n,
      rebalanceLiquidityFeeBps: liquidityFeeBps,
      rebalanceTimeoutMs: data.rebalanceTimeoutMs ?? 10 * 60 * 1000,
    },
  };
};

const buildHubPolicyTargets = (
  state: EntityState,
  config: HubRebalanceConfig,
): AccountTxTarget[] =>
  Array.from(state.accounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([accountId, account]) =>
      Array.from(account.state.deltas.keys())
        .sort((left, right) => left - right)
        .map(tokenId => ({
          accountId,
          tx: buildHubRebalancePolicyTx(config, tokenId),
        })),
    );

export const handleExtendCreditEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'extendCredit'>,
  mutableFrameState = false,
): AccountAdminResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const accountTxs: AccountTxTarget[] = [];
  const { counterpartyEntityId, tokenId, amount } = entityTx.data;

  if (!newState.accounts.has(counterpartyEntityId)) {
    log.warn('extend_credit.missing_account', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });
    return { newState: entityState, outputs: [] };
  }

  const accountTx: AccountTx = {
    type: 'set_credit_limit',
    data: { tokenId, amount },
  };

  accountTxs.push({ accountId: counterpartyEntityId, tx: accountTx });
  addMessage(newState, `💳 Extended credit of ${amount} to ${counterpartyEntityId.slice(-4)}`);
  log.info('extend_credit.queued', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyEntityId),
    tokenId,
    amount,
  });

  return { newState, outputs: processingTrigger(entityState), accountTxs };
};

export const handleSetHubConfigEntityTx = (
  _env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: EntityTxOf<'setHubConfig'>,
  mutableFrameState = false,
): AccountAdminResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const { config, feePolicyChanged } = buildHubConfig(
    entityState.hubRebalanceConfig,
    entityTx.data,
  );
  newState.hubRebalanceConfig = config;
  newState.profile = { ...newState.profile, isHub: true };

  addMessage(
    newState,
    `🏦 Hub config activated: ${config.matchingStrategy} strategy v${config.policyVersion}, ` +
    `${config.routingFeePPM}ppm routing fee, swapTakerFee=${config.swapTakerFeeBps}bps, ` +
    `rebalance(base=token-default, liqBps=${config.rebalanceLiquidityFeeBps}, gas=token-default, ` +
    'c2rWithdrawSoftLimit=token-default)',
  );
  log.info('hub_config.updated', {
    entity: shortId(newState.entityId),
    matchingStrategy: config.matchingStrategy,
    policyVersion: config.policyVersion,
    routingFeePPM: config.routingFeePPM,
    swapTakerFeeBps: config.swapTakerFeeBps,
    feePolicyChanged,
  });

  const accountTxs = buildHubPolicyTargets(newState, config);

  return {
    newState,
    outputs: accountTxs.length > 0 ? processingTrigger(newState) : [],
    ...(accountTxs.length > 0 ? { accountTxs } : {}),
  };
};

export const handleSetRebalancePolicyEntityTx = (
  _env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: EntityTxOf<'setRebalancePolicy'>,
  mutableFrameState = false,
): AccountAdminResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
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
    accountTxs: rebalanceTxs.map((tx) => ({ accountId: counterpartyEntityId, tx })),
  };
};

export const handleRequestCollateralEntityTx = (
  entityState: EntityState,
  entityTx: EntityTxOf<'requestCollateral'>,
  mutableFrameState = false,
): AccountAdminResult => {
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const { counterpartyEntityId, tokenId, amount, feeTokenId, feeAmount, policyVersion } = entityTx.data;

  if (!newState.accounts.has(counterpartyEntityId)) {
    log.warn('collateral_request.missing_account', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });
    return { newState: entityState, outputs: [] };
  }

  return {
    newState,
    outputs: processingTrigger(entityState),
    accountTxs: [{
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
