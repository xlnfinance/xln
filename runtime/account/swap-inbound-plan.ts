import type { AccountMachine, EntityTx } from '../types';
import { isLeftEntity } from '../entity/id';
import { deriveDelta } from './utils';

export type SwapInboundCapacityPlan = Readonly<{
  accountExists: boolean;
  tokenActive: boolean;
  requiredInboundAmount: bigint;
  currentInboundCapacity: bigint;
  currentPeerCreditLimit: bigint;
  requiredPeerCreditLimit: bigint | null;
  creditIncrease: bigint;
  setupTxs: readonly EntityTx[];
}>;

export type SwapInboundCapacityPlanInput = Readonly<{
  account: AccountMachine | null;
  ownerEntityId: string;
  counterpartyEntityId: string;
  tokenId: number;
  requiredInboundAmount: bigint;
  allowOpenAccount: boolean;
}>;

export type SwapAccountCapacityView = Readonly<{
  accountExists: boolean;
  tokenActive: boolean;
  inCapacity: bigint;
  outCapacity: bigint;
  peerCreditLimit: bigint;
}>;

export type SwapAccountCapacityViewInput = Readonly<{
  account: AccountMachine | null;
  ownerEntityId: string;
  counterpartyEntityId: string;
  tokenId: number;
}>;

const normalizeEntityId = (value: string): string => String(value || '').trim().toLowerCase();
const nonNegative = (value: bigint): bigint => value < 0n ? 0n : value;

const readTokenDelta = (account: AccountMachine, tokenId: number) => {
  for (const [candidateTokenId, delta] of account.deltas.entries()) {
    if (candidateTokenId === tokenId) return delta;
  }
  return null;
};

const buildPlan = (
  input: SwapInboundCapacityPlanInput,
  fields: Omit<SwapInboundCapacityPlan, 'requiredInboundAmount'>,
): SwapInboundCapacityPlan => ({
  requiredInboundAmount: input.requiredInboundAmount,
  ...fields,
});

const assertAccountParties = (
  account: AccountMachine,
  ownerEntityId: string,
  counterpartyEntityId: string,
): void => {
  const parties = new Set([
    normalizeEntityId(account.leftEntity),
    normalizeEntityId(account.rightEntity),
  ]);
  if (!parties.has(ownerEntityId) || !parties.has(counterpartyEntityId) || parties.size !== 2) {
    throw new Error(
      `SWAP_INBOUND_ACCOUNT_PARTIES_INVALID:owner=${ownerEntityId}:counterparty=${counterpartyEntityId}`,
    );
  }
};

const validateCapacityViewInput = (
  input: SwapAccountCapacityViewInput,
): Readonly<{ ownerEntityId: string; counterpartyEntityId: string }> => {
  const ownerEntityId = normalizeEntityId(input.ownerEntityId);
  const counterpartyEntityId = normalizeEntityId(input.counterpartyEntityId);
  if (!ownerEntityId || !counterpartyEntityId || ownerEntityId === counterpartyEntityId) {
    throw new Error('SWAP_ACCOUNT_CAPACITY_ENTITIES_INVALID');
  }
  if (!Number.isSafeInteger(input.tokenId) || input.tokenId <= 0) {
    throw new Error(`SWAP_ACCOUNT_CAPACITY_TOKEN_INVALID:${input.tokenId}`);
  }
  return { ownerEntityId, counterpartyEntityId };
};

export const readSwapAccountCapacity = (
  input: SwapAccountCapacityViewInput,
): SwapAccountCapacityView => {
  const ids = validateCapacityViewInput(input);
  if (!input.account) {
    return {
      accountExists: false,
      tokenActive: false,
      inCapacity: 0n,
      outCapacity: 0n,
      peerCreditLimit: 0n,
    };
  }
  assertAccountParties(input.account, ids.ownerEntityId, ids.counterpartyEntityId);
  const delta = readTokenDelta(input.account, input.tokenId);
  if (!delta) {
    return {
      accountExists: true,
      tokenActive: false,
      inCapacity: 0n,
      outCapacity: 0n,
      peerCreditLimit: 0n,
    };
  }
  const derived = deriveDelta(delta, isLeftEntity(ids.ownerEntityId, ids.counterpartyEntityId));
  return {
    accountExists: true,
    tokenActive: true,
    inCapacity: nonNegative(derived.inCapacity),
    outCapacity: nonNegative(derived.outCapacity),
    peerCreditLimit: nonNegative(derived.peerCreditLimit),
  };
};

const planMissingAccount = (
  input: SwapInboundCapacityPlanInput,
  counterpartyEntityId: string,
): SwapInboundCapacityPlan => {
  if (!input.allowOpenAccount) {
    throw new Error(`SWAP_INBOUND_ACCOUNT_MISSING:${input.ownerEntityId}:${counterpartyEntityId}`);
  }
  return buildPlan(input, {
    accountExists: false,
    tokenActive: false,
    currentInboundCapacity: 0n,
    currentPeerCreditLimit: 0n,
    requiredPeerCreditLimit: input.requiredInboundAmount,
    creditIncrease: input.requiredInboundAmount,
    setupTxs: [{
      type: 'openAccount',
      data: {
        targetEntityId: counterpartyEntityId,
        tokenId: input.tokenId,
        creditAmount: input.requiredInboundAmount,
      },
    }],
  });
};

const planMissingToken = (
  input: SwapInboundCapacityPlanInput,
  counterpartyEntityId: string,
): SwapInboundCapacityPlan => buildPlan(input, {
  accountExists: true,
  tokenActive: false,
  currentInboundCapacity: 0n,
  currentPeerCreditLimit: 0n,
  requiredPeerCreditLimit: input.requiredInboundAmount,
  creditIncrease: input.requiredInboundAmount,
  setupTxs: [{
    type: 'extendCredit',
    data: {
      counterpartyEntityId,
      tokenId: input.tokenId,
      amount: input.requiredInboundAmount,
    },
  }],
});

const deriveRequiredPeerCreditLimit = (
  derived: ReturnType<typeof deriveDelta>,
  requiredInboundAmount: bigint,
): bigint => {
  // deriveDelta owns the financial decomposition. The planner only solves its
  // canonical inbound equation for the peer-credit window, including existing
  // holds and allowances; omitting either silently underfunds the next lock.
  const requiredUnusedPeerCredit = nonNegative(
    requiredInboundAmount
      + derived.inAllowance
      + derived.inTotalHold
      - derived.inOwnCredit
      - derived.inCollateral,
  );
  return derived.outPeerCredit + requiredUnusedPeerCredit;
};

const planActiveToken = (
  input: SwapInboundCapacityPlanInput,
  account: AccountMachine,
  counterpartyEntityId: string,
  ownerEntityId: string,
): SwapInboundCapacityPlan => {
  const delta = readTokenDelta(account, input.tokenId);
  if (!delta) return planMissingToken(input, counterpartyEntityId);

  const derived = deriveDelta(delta, isLeftEntity(ownerEntityId, counterpartyEntityId));
  const currentInboundCapacity = nonNegative(derived.inCapacity);
  const currentPeerCreditLimit = nonNegative(derived.peerCreditLimit);
  if (currentInboundCapacity >= input.requiredInboundAmount) {
    return buildPlan(input, {
      accountExists: true,
      tokenActive: true,
      currentInboundCapacity,
      currentPeerCreditLimit,
      requiredPeerCreditLimit: null,
      creditIncrease: 0n,
      setupTxs: [],
    });
  }

  const requiredPeerCreditLimit = deriveRequiredPeerCreditLimit(
    derived,
    input.requiredInboundAmount,
  );
  const creditIncrease = nonNegative(requiredPeerCreditLimit - currentPeerCreditLimit);
  if (creditIncrease === 0n) {
    throw new Error(
      `SWAP_INBOUND_PLAN_INSUFFICIENT:required=${input.requiredInboundAmount}:current=${currentInboundCapacity}`,
    );
  }

  return buildPlan(input, {
    accountExists: true,
    tokenActive: true,
    currentInboundCapacity,
    currentPeerCreditLimit,
    requiredPeerCreditLimit,
    creditIncrease,
    setupTxs: [{
      type: 'extendCredit',
      data: {
        counterpartyEntityId,
        tokenId: input.tokenId,
        amount: requiredPeerCreditLimit,
      },
    }],
  });
};

export const planSwapInboundCapacity = (
  input: SwapInboundCapacityPlanInput,
): SwapInboundCapacityPlan => {
  const ownerEntityId = normalizeEntityId(input.ownerEntityId);
  const counterpartyEntityId = normalizeEntityId(input.counterpartyEntityId);
  if (!ownerEntityId || !counterpartyEntityId || ownerEntityId === counterpartyEntityId) {
    throw new Error('SWAP_INBOUND_ENTITIES_INVALID');
  }
  if (!Number.isSafeInteger(input.tokenId) || input.tokenId <= 0) {
    throw new Error(`SWAP_INBOUND_TOKEN_INVALID:${input.tokenId}`);
  }
  if (input.requiredInboundAmount <= 0n) {
    throw new Error(`SWAP_INBOUND_AMOUNT_INVALID:${input.requiredInboundAmount}`);
  }

  if (!input.account) return planMissingAccount(input, counterpartyEntityId);

  assertAccountParties(input.account, ownerEntityId, counterpartyEntityId);
  return planActiveToken(input, input.account, counterpartyEntityId, ownerEntityId);
};
