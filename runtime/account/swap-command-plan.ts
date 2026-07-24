import {
  requantizeRemainingSwapAtPrice,
} from '../orderbook';
import type {
  AccountMachine,
  CrossJurisdictionSwapRoute,
  EntityTx,
  Env,
  RuntimeInput,
} from '../types';
import {
  planSwapInboundCapacity,
  readSwapAccountCapacity,
  type SwapInboundCapacityPlan,
} from './swap-inbound-plan';
import {
  buildCrossJurisdictionSwapIntent,
  buildDeterministicSwapOfferId,
} from './swap-command-route';
export { buildDeterministicSwapOfferId } from './swap-command-route';

type SwapCommandParty = Readonly<{
  entityId: string;
  signerId: string;
  hubEntityId: string;
  hubSignerId: string;
  jurisdiction: string;
  account: AccountMachine | null;
}>;

export type SwapCommandPlanInput = Readonly<{
  mode: 'same' | 'cross';
  logicalTimestamp: number;
  logicalHeight: number;
  routeValue: string;
  giveTokenId: number;
  wantTokenId: number;
  giveAmount: bigint;
  priceTicks: bigint;
  source: SwapCommandParty;
  target?: SwapCommandParty;
  allowOpenTargetAccount?: boolean;
  expiresInMs?: number;
}>;

export type SwapCommandPreparedOrder = Readonly<{
  priceTicks: bigint;
  effectiveGive: bigint;
  effectiveWant: bigint;
  unspentGiveAmount: bigint;
}>;

type SwapCommandPlanBase = Readonly<{
  offerId: string;
  preparedOrder: SwapCommandPreparedOrder;
  sourceOutCapacity: bigint;
}>;

export type SameJurisdictionSwapCommandPlan = SwapCommandPlanBase & Readonly<{
  mode: 'same';
  runtimeInput: RuntimeInput;
  targetSetupInput: null;
  crossJurisdictionIntent: null;
}>;

export type CrossJurisdictionSwapCommandPlan = SwapCommandPlanBase & Readonly<{
  mode: 'cross';
  runtimeInput: null;
  targetSetupInput: RuntimeInput | null;
  crossJurisdictionIntent: CrossJurisdictionSwapRoute;
}>;

export type SwapCommandPlan =
  | SameJurisdictionSwapCommandPlan
  | CrossJurisdictionSwapCommandPlan;

const normalizeId = (value: string): string => String(value || '').trim().toLowerCase();

const requirePositiveInteger = (value: number, code: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${code}:${value}`);
  return value;
};

const requireParty = (party: SwapCommandParty, label: string): SwapCommandParty => {
  const normalized = {
    ...party,
    entityId: normalizeId(party.entityId),
    signerId: normalizeId(party.signerId),
    hubEntityId: normalizeId(party.hubEntityId),
    hubSignerId: normalizeId(party.hubSignerId),
    jurisdiction: String(party.jurisdiction || '').trim().toLowerCase(),
  };
  if (
    !normalized.entityId ||
    !normalized.signerId ||
    !normalized.hubEntityId ||
    !normalized.hubSignerId ||
    !normalized.jurisdiction ||
    normalized.entityId === normalized.hubEntityId
  ) {
    throw new Error(`SWAP_COMMAND_${label}_PARTY_INVALID`);
  }
  return normalized;
};

const prepareOrder = (input: SwapCommandPlanInput): SwapCommandPreparedOrder => {
  requirePositiveInteger(input.giveTokenId, 'SWAP_COMMAND_GIVE_TOKEN_INVALID');
  requirePositiveInteger(input.wantTokenId, 'SWAP_COMMAND_WANT_TOKEN_INVALID');
  if (input.giveAmount <= 0n) throw new Error('SWAP_COMMAND_GIVE_AMOUNT_INVALID');
  if (input.priceTicks <= 0n) throw new Error('SWAP_COMMAND_PRICE_TICKS_INVALID');
  const prepared = requantizeRemainingSwapAtPrice(
    input.giveTokenId,
    input.wantTokenId,
    input.giveAmount,
    input.priceTicks,
  );
  if (!prepared) throw new Error('SWAP_COMMAND_ORDER_TOO_SMALL');
  return {
    priceTicks: input.priceTicks,
    effectiveGive: prepared.effectiveGive,
    effectiveWant: prepared.effectiveWant,
    unspentGiveAmount: prepared.releasedGiveDust,
  };
};

const requireSourceCapacity = (
  source: SwapCommandParty,
  tokenId: number,
  amount: bigint,
): bigint => {
  if (!source.account) throw new Error('SWAP_COMMAND_SOURCE_ACCOUNT_MISSING');
  const capacity = readSwapAccountCapacity({
    account: source.account,
    ownerEntityId: source.entityId,
    counterpartyEntityId: source.hubEntityId,
    tokenId,
  });
  if (!capacity.tokenActive || capacity.outCapacity < amount) {
    throw new Error(
      `SWAP_COMMAND_SOURCE_CAPACITY_INSUFFICIENT:required=${amount}:available=${capacity.outCapacity}`,
    );
  }
  return capacity.outCapacity;
};

const inboundPlan = (
  party: SwapCommandParty,
  tokenId: number,
  amount: bigint,
  allowOpenAccount: boolean,
): SwapInboundCapacityPlan => planSwapInboundCapacity({
  account: party.account,
  ownerEntityId: party.entityId,
  counterpartyEntityId: party.hubEntityId,
  tokenId,
  requiredInboundAmount: amount,
  allowOpenAccount,
});

const runtimeInputFor = (
  party: SwapCommandParty,
  entityTxs: readonly EntityTx[],
): RuntimeInput => ({
  runtimeTxs: [],
  entityInputs: [{
    entityId: party.entityId,
    signerId: party.signerId,
    entityTxs: [...entityTxs],
  }],
});

export const planSwapCommand = (input: SwapCommandPlanInput): SwapCommandPlan => {
  const source = requireParty(input.source, 'SOURCE');
  const preparedOrder = prepareOrder(input);
  const sourceOutCapacity = requireSourceCapacity(
    source,
    input.giveTokenId,
    preparedOrder.effectiveGive,
  );
  const offerId = buildDeterministicSwapOfferId({
    logicalTimestamp: input.logicalTimestamp,
    logicalHeight: input.logicalHeight,
    sourceEntityId: source.entityId,
    counterpartyEntityId: source.hubEntityId,
    sellToken: input.giveTokenId,
    buyToken: input.wantTokenId,
    sellAmount: preparedOrder.effectiveGive,
    buyAmount: preparedOrder.effectiveWant,
    priceTicks: preparedOrder.priceTicks,
    routeValue: input.routeValue,
  });

  if (input.mode === 'same') {
    if (input.giveTokenId === input.wantTokenId) {
      throw new Error('SWAP_COMMAND_SAME_J_TOKEN_PAIR_INVALID');
    }
    const capacityPlan = inboundPlan(
      source,
      input.wantTokenId,
      preparedOrder.effectiveWant,
      false,
    );
    return {
      mode: 'same',
      offerId,
      preparedOrder,
      sourceOutCapacity,
      runtimeInput: runtimeInputFor(source, [
        ...capacityPlan.setupTxs,
        {
          type: 'placeSwapOffer',
          data: {
            offerId,
            counterpartyEntityId: source.hubEntityId,
            giveTokenId: input.giveTokenId,
            giveAmount: preparedOrder.effectiveGive,
            wantTokenId: input.wantTokenId,
            wantAmount: preparedOrder.effectiveWant,
            priceTicks: preparedOrder.priceTicks,
          },
        },
      ]),
      targetSetupInput: null,
      crossJurisdictionIntent: null,
    };
  }

  const target = input.target ? requireParty(input.target, 'TARGET') : null;
  if (!target) throw new Error('SWAP_COMMAND_TARGET_REQUIRED');
  if (source.jurisdiction === target.jurisdiction) {
    throw new Error('SWAP_COMMAND_CROSS_J_REQUIRES_DISTINCT_JURISDICTIONS');
  }
  const targetCapacityPlan = inboundPlan(
    target,
    input.wantTokenId,
    preparedOrder.effectiveWant,
    input.allowOpenTargetAccount === true,
  );
  const crossJurisdictionIntent = buildCrossJurisdictionSwapIntent({
    offerId,
    logicalTimestamp: input.logicalTimestamp,
    expiresInMs: input.expiresInMs ?? 24 * 60 * 60 * 1_000,
    giveTokenId: input.giveTokenId,
    wantTokenId: input.wantTokenId,
    giveAmount: preparedOrder.effectiveGive,
    wantAmount: preparedOrder.effectiveWant,
    priceTicks: preparedOrder.priceTicks,
    source,
    target,
  });
  return {
    mode: 'cross',
    offerId,
    preparedOrder,
    sourceOutCapacity,
    runtimeInput: null,
    targetSetupInput: targetCapacityPlan.setupTxs.length > 0
      ? runtimeInputFor(target, targetCapacityPlan.setupTxs)
      : null,
    crossJurisdictionIntent,
  };
};

export const assertCrossJurisdictionSwapTargetReady = (
  route: CrossJurisdictionSwapRoute,
  targetAccount: AccountMachine | null,
): void => {
  const plan = planSwapInboundCapacity({
    account: targetAccount,
    ownerEntityId: route.target.counterpartyEntityId,
    counterpartyEntityId: route.target.entityId,
    tokenId: route.target.tokenId,
    requiredInboundAmount: route.target.amount,
    allowOpenAccount: false,
  });
  if (plan.setupTxs.length > 0) {
    throw new Error(
      `CROSS_J_TARGET_INBOUND_NOT_READY:${route.orderId}:required=${route.target.amount}:` +
        `current=${plan.currentInboundCapacity}`,
    );
  }
};

export const assertCrossJurisdictionSwapTargetReadyInEnv = (
  env: Env,
  route: CrossJurisdictionSwapRoute,
): void => {
  const targetEntityId = normalizeId(route.target.counterpartyEntityId);
  const targetSignerId = normalizeId(route.targetSignerId || '');
  const hubEntityId = normalizeId(route.target.entityId);
  const replica = [...env.eReplicas.values()].find((candidate) => (
    normalizeId(candidate.entityId || candidate.state?.entityId || '') === targetEntityId
    && (!targetSignerId || normalizeId(candidate.signerId || '') === targetSignerId)
  ));
  assertCrossJurisdictionSwapTargetReady(
    route,
    replica?.state?.accounts?.get(hubEntityId) ?? null,
  );
};
