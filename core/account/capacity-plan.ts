import type { AccountState, Delta, DerivedDelta } from '../types/account';
import type { EntityTx } from '../types/entity-tx';
import { UINT256_MAX } from '../protocol/boundary/integer-ranges';
import { isLeftEntity } from '../protocol/identity/entity-id';
import { normalizeEntityRef } from '../support/boundary-guards';
import { deriveDelta, nonNegative } from './utils';
import { createDefaultDelta } from './state/delta';
import { canonicalAccountDisputeConfig, type AccountDisputeConfig } from './config/dispute-config';

export type AccountCapacitySource = Pick<AccountState, 'leftEntity' | 'rightEntity'> &
  Readonly<{
    deltas: ReadonlyMap<number, Delta>;
  }>;

export type AccountCapacityViewInput = Readonly<{
  account: AccountCapacitySource | null;
  ownerEntityId: string;
  counterpartyEntityId: string;
  tokenId: number;
}>;

export type AccountCapacityView = Readonly<{
  accountExists: boolean;
  tokenActive: boolean;
  inCapacity: bigint;
  outCapacity: bigint;
  peerCreditLimit: bigint;
}>;

export type ReceiveCapacityPlanInput = AccountCapacityViewInput &
  Readonly<{
    requiredInboundAmount: bigint;
    collateralPercent: number;
    creditBufferBps: 0 | 1000;
    allowOpenAccount: boolean;
    newAccountDisputeConfig?: AccountDisputeConfig;
  }>;

type ReceiveCapacityAmounts = Readonly<{
  accountExists: boolean;
  tokenActive: boolean;
  requiredInboundAmount: bigint;
  currentInboundCapacity: bigint;
  shortfall: bigint;
  collateralRequired: bigint;
  collateralSupported: false;
  collateralUnsupportedReason: 'FUTURE_INBOUND_COLLATERAL_UNSUPPORTED';
  currentPeerCreditLimit: bigint;
  maximumPeerCreditLimit: bigint;
  creditIncrease: bigint;
  creditBuffer: bigint;
  requestedCreditBuffer: bigint;
}>;

export type ReceiveCapacityPlan = ReceiveCapacityAmounts &
  (
    | Readonly<{ status: 'ready'; requiredPeerCreditLimit: null; setupTxs: readonly [] }>
    | Readonly<{ status: 'credit'; requiredPeerCreditLimit: bigint; setupTxs: readonly EntityTx[] }>
    | Readonly<{
        status: 'credit-unavailable';
        creditUnsupportedReason: 'CREDIT_LIMIT_EXCEEDED';
        requiredPeerCreditLimit: bigint;
        setupTxs: readonly [];
      }>
    | Readonly<{ status: 'collateral-unavailable'; requiredPeerCreditLimit: bigint | null; setupTxs: readonly [] }>
  );

export type AccountFundingPlanInput = AccountCapacityViewInput &
  Readonly<{
    requiredOutboundAmount: bigint;
  }>;

export type AccountFundingPlan = Readonly<{
  accountExists: boolean;
  tokenActive: boolean;
  currentOutboundCapacity: bigint;
  requiredDeposit: bigint;
}>;

const ceilRatio = (value: bigint, numerator: bigint, denominator: bigint): bigint =>
  (value * numerator + denominator - 1n) / denominator;

const readCapacity = (input: AccountCapacityViewInput) => {
  const owner = normalizeEntityRef(input.ownerEntityId);
  const counterparty = normalizeEntityRef(input.counterpartyEntityId);
  if (!owner || !counterparty || owner === counterparty) throw new Error('ACCOUNT_CAPACITY_ENTITIES_INVALID');
  if (!Number.isSafeInteger(input.tokenId) || input.tokenId <= 0) {
    throw new Error(`ACCOUNT_CAPACITY_TOKEN_INVALID:${input.tokenId}`);
  }
  if (input.account) {
    const parties = new Set([
      normalizeEntityRef(input.account.leftEntity),
      normalizeEntityRef(input.account.rightEntity),
    ]);
    if (!parties.has(owner) || !parties.has(counterparty) || parties.size !== 2) {
      throw new Error(`ACCOUNT_CAPACITY_PARTIES_INVALID:owner=${owner}:counterparty=${counterparty}`);
    }
  }
  const delta = input.account?.deltas.get(input.tokenId);
  const derived = deriveDelta(delta ?? createDefaultDelta(input.tokenId), isLeftEntity(owner, counterparty));
  return { accountExists: input.account !== null, tokenActive: delta !== undefined, counterparty, derived };
};

export const readAccountCapacity = (input: AccountCapacityViewInput): AccountCapacityView => {
  const view = readCapacity(input);
  return {
    accountExists: view.accountExists,
    tokenActive: view.tokenActive,
    inCapacity: view.derived.inCapacity,
    outCapacity: view.derived.outCapacity,
    peerCreditLimit: view.derived.peerCreditLimit,
  };
};

const requiredCreditIncrease = (derived: DerivedDelta, amount: bigint): bigint => {
  // The owner grants the counterparty an absolute permanent limit. Solve the
  // canonical inbound decomposition, retaining signed debt, holds and allowances;
  // adding only the visible shortfall would underfund a previously reduced limit.
  const requiredUnusedPeerCredit = nonNegative(
    amount + derived.inAllowance + derived.inTotalHold - derived.inOwnCredit - derived.inCollateral,
  );
  return nonNegative(derived.outPeerCredit + requiredUnusedPeerCredit - derived.peerCreditLimit);
};

const receiveSetupTxs = (
  input: ReceiveCapacityPlanInput,
  counterpartyEntityId: string,
  requiredPeerCreditLimit: bigint,
): readonly EntityTx[] => {
  if (input.account) {
    return [
      { type: 'extendCredit', data: { counterpartyEntityId, tokenId: input.tokenId, amount: requiredPeerCreditLimit } },
    ];
  }
  if (!input.newAccountDisputeConfig) {
    throw new Error(`RECEIVE_CAPACITY_DISPUTE_CONFIG_REQUIRED:${input.ownerEntityId}:${counterpartyEntityId}`);
  }
  return [
    {
      type: 'openAccount',
      data: {
        targetEntityId: counterpartyEntityId,
        disputeConfig: canonicalAccountDisputeConfig(input.newAccountDisputeConfig),
        tokenId: input.tokenId,
        creditAmount: requiredPeerCreditLimit,
      },
    },
  ];
};

const assertReceiveInput = (input: ReceiveCapacityPlanInput): void => {
  if (input.requiredInboundAmount <= 0n)
    throw new Error(`RECEIVE_CAPACITY_AMOUNT_INVALID:${input.requiredInboundAmount}`);
  if (!Number.isInteger(input.collateralPercent) || input.collateralPercent < 0 || input.collateralPercent > 100) {
    throw new Error(`RECEIVE_CAPACITY_PERCENT_INVALID:${input.collateralPercent}`);
  }
  if (input.creditBufferBps !== 0 && input.creditBufferBps !== 1000) {
    throw new Error(`RECEIVE_CAPACITY_BUFFER_INVALID:${input.creditBufferBps}`);
  }
  if (!input.account && !input.allowOpenAccount) {
    throw new Error(`RECEIVE_CAPACITY_ACCOUNT_MISSING:${input.ownerEntityId}:${input.counterpartyEntityId}`);
  }
};

export const planReceiveCapacity = (input: ReceiveCapacityPlanInput): ReceiveCapacityPlan => {
  assertReceiveInput(input);
  const view = readCapacity(input);
  const currentInboundCapacity = view.derived.inCapacity;
  const shortfall = nonNegative(input.requiredInboundAmount - currentInboundCapacity);
  const collateralRequired = ceilRatio(shortfall, BigInt(input.collateralPercent), 100n);
  const creditPart = shortfall - collateralRequired;
  const baseIncrease = creditPart > 0n ? requiredCreditIncrease(view.derived, currentInboundCapacity + creditPart) : 0n;
  // Apply the owner's optional buffer to the entire required permanent limit.
  // A plan that needs no new credit must not compound an already-granted buffer.
  const requestedCreditBuffer =
    baseIncrease > 0n
      ? ceilRatio(view.derived.peerCreditLimit + baseIncrease, BigInt(input.creditBufferBps), 10_000n)
      : 0n;
  // The required grant is never reduced. Only optional headroom is limited by
  // the uint256 representation of a credit grant, with both amounts exposed.
  const bufferHeadroom = nonNegative(UINT256_MAX - view.derived.peerCreditLimit - baseIncrease);
  const creditBuffer = requestedCreditBuffer < bufferHeadroom ? requestedCreditBuffer : bufferHeadroom;
  const creditIncrease = baseIncrease + creditBuffer;
  const requiredPeerCreditLimit = creditIncrease > 0n ? view.derived.peerCreditLimit + creditIncrease : null;
  // Existing request_collateral funds already-drawn exposure; it cannot reserve
  // future inbound capacity. Never convert a collateral choice into hidden credit
  // or submit a partial mixed plan while its collateral leg is unavailable.
  return {
    accountExists: view.accountExists,
    tokenActive: view.tokenActive,
    requiredInboundAmount: input.requiredInboundAmount,
    currentInboundCapacity,
    shortfall,
    collateralRequired,
    collateralSupported: false,
    collateralUnsupportedReason: 'FUTURE_INBOUND_COLLATERAL_UNSUPPORTED',
    currentPeerCreditLimit: view.derived.peerCreditLimit,
    maximumPeerCreditLimit: UINT256_MAX,
    creditIncrease,
    creditBuffer,
    requestedCreditBuffer,
    ...(requiredPeerCreditLimit !== null && requiredPeerCreditLimit > UINT256_MAX
      ? {
          status: 'credit-unavailable',
          creditUnsupportedReason: 'CREDIT_LIMIT_EXCEEDED',
          requiredPeerCreditLimit,
          setupTxs: [],
        }
      : collateralRequired > 0n
        ? { status: 'collateral-unavailable', requiredPeerCreditLimit, setupTxs: [] }
        : requiredPeerCreditLimit !== null
          ? {
              status: 'credit',
              requiredPeerCreditLimit,
              setupTxs: receiveSetupTxs(input, view.counterparty, requiredPeerCreditLimit),
            }
          : { status: 'ready', requiredPeerCreditLimit: null, setupTxs: [] }),
  };
};

export const planAccountFunding = (input: AccountFundingPlanInput): AccountFundingPlan => {
  if (input.requiredOutboundAmount <= 0n)
    throw new Error(`ACCOUNT_FUNDING_AMOUNT_INVALID:${input.requiredOutboundAmount}`);
  const view = readCapacity(input);
  const derived = view.derived;
  // A deposit allocated to the owner first repays debt above the current credit
  // limit, then restores outbound capacity. Inverting deriveDelta's components
  // also covers capacity hidden below zero by existing holds and allowances.
  const uncoveredDebt = nonNegative(derived.inOwnCredit - derived.ownCreditLimit);
  const capacityGap = nonNegative(
    input.requiredOutboundAmount +
      derived.outAllowance +
      derived.outTotalHold -
      derived.outPeerCredit -
      derived.outCollateral -
      derived.outOwnCredit,
  );
  return {
    accountExists: view.accountExists,
    tokenActive: view.tokenActive,
    currentOutboundCapacity: derived.outCapacity,
    requiredDeposit: derived.outCapacity >= input.requiredOutboundAmount ? 0n : uncoveredDebt + capacityGap,
  };
};
