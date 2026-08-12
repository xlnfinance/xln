import type { AccountState, SwapOffer } from '../../../types/account';
import { FINANCIAL } from '../../../config/constants';
import {
  deriveExactSwapFillRatio,
  exactFillRatioToUint16,
  MAX_SWAP_FILL_RATIO,
} from '../../../orderbook/swap-execution';
import { createStructuredLogger, shortOrder } from '../../../infra/logger';
import type {
  SwapResolveFailure,
  SwapResolveTx,
  ValidatedSwapResolve,
} from './swap-resolve-types';
import { assertSwapNetAuthorization } from '../../swap/swap-net-authorization';

const swapResolveLog = createStructuredLogger('account.swap');

type CanonicalOffer = {
  offer: SwapOffer;
  give: bigint;
  want: bigint;
  quantizedGive: bigint;
  quantizedWant: bigint;
  priceTicks: bigint;
};

type ExecutionFill = {
  filledGive: bigint;
  filledWant: bigint;
  canonicalFillRatio: number;
  exactFillRatio: { numerator: bigint; denominator: bigint };
  executionProvided: boolean;
};

const failure = (events: string[], error: string): SwapResolveFailure => ({
  success: false,
  error,
  events,
});

const resolveCanonicalOffer = (
  account: AccountState,
  tx: SwapResolveTx,
  byLeft: boolean,
  events: string[],
): CanonicalOffer | SwapResolveFailure => {
  if (!account.swapOffers) return failure(events, 'No swap offers exist');
  const offer = account.swapOffers.get(tx.data.offerId);
  if (!offer) return failure(events, `Offer ${tx.data.offerId} not found`);
  if (offer.crossJurisdiction) {
    return failure(
      events,
      'Cross-jurisdiction offers must use cross_swap_fill_ack/requestCrossJurisdictionClear',
    );
  }
  // `commitSwapOffer` and every requantization write price and quantized
  // amounts together. Reconstructing a missing one here would let the resolving
  // counterparty pick the price its own claim is checked against.
  if (
    typeof offer.priceTicks !== 'bigint' ||
    typeof offer.quantizedGive !== 'bigint' ||
    typeof offer.quantizedWant !== 'bigint'
  ) {
    return failure(events, `Committed offer ${tx.data.offerId} is missing canonical price or quantized amounts`);
  }
  const canonical: CanonicalOffer = {
    offer,
    give: offer.giveAmount,
    want: offer.wantAmount,
    quantizedGive: offer.quantizedGive,
    quantizedWant: offer.quantizedWant,
    priceTicks: offer.priceTicks,
  };
  const data = tx.data;
  const restingMismatch =
    (data.restingGiveAmount !== undefined && data.restingGiveAmount !== canonical.give) ||
    (data.restingWantAmount !== undefined && data.restingWantAmount !== canonical.want) ||
    (data.restingQuantizedGive !== undefined &&
      data.restingQuantizedGive !== canonical.quantizedGive) ||
    (data.restingQuantizedWant !== undefined &&
      data.restingQuantizedWant !== canonical.quantizedWant) ||
    (data.restingPriceTicks !== undefined && data.restingPriceTicks !== canonical.priceTicks);
  if (restingMismatch) return failure(events, 'Resting swap terms mismatch live offer');
  if (canonical.give <= 0n || canonical.want <= 0n) {
    return failure(events, 'Canonical resting offer amounts must be positive');
  }
  if (canonical.quantizedGive <= 0n || canonical.quantizedWant <= 0n) {
    return failure(events, 'Canonical resting quantized amounts must be positive');
  }
  if (
    canonical.quantizedGive > canonical.give ||
    canonical.quantizedWant > canonical.want
  ) {
    return failure(events, 'Canonical resting quantized amounts exceed offer amounts');
  }
  if (byLeft === offer.makerIsLeft) {
    return failure(events, 'Only counterparty can resolve swap');
  }
  return canonical;
};

const deriveExecutionFill = (
  tx: SwapResolveTx,
  offer: CanonicalOffer,
  events: string[],
): ExecutionFill | SwapResolveFailure => {
  const {
    fillRatio,
    executionGiveAmount,
    executionWantAmount,
    fillNumerator,
    fillDenominator,
  } = tx.data;
  if (fillRatio < 0 || fillRatio > MAX_SWAP_FILL_RATIO) {
    return failure(events, `Invalid fillRatio: ${fillRatio}`);
  }
  const executionProvided =
    executionGiveAmount !== undefined || executionWantAmount !== undefined;
  if (executionProvided && (
    executionGiveAmount === undefined ||
    executionWantAmount === undefined
  )) {
    return failure(
      events,
      'executionGiveAmount and executionWantAmount must both be provided',
    );
  }
  if (fillRatio > 0 && !executionProvided) {
    return failure(
      events,
      'executionGiveAmount and executionWantAmount required for non-zero fills',
    );
  }
  const limitFilledGive =
    (offer.quantizedGive * BigInt(fillRatio)) / BigInt(MAX_SWAP_FILL_RATIO);
  const limitFilledWant =
    (limitFilledGive * offer.quantizedWant + offer.quantizedGive - 1n) /
    offer.quantizedGive;
  const filledGive = executionProvided ? executionGiveAmount! : limitFilledGive;
  const filledWant = executionProvided ? executionWantAmount! : limitFilledWant;
  const exactFillRatio = deriveExactSwapFillRatio(offer.quantizedGive, filledGive);
  const canonicalFillRatio = executionProvided
    ? exactFillRatioToUint16(exactFillRatio)
    : fillRatio;
  const exactRatioProvided = fillNumerator !== undefined || fillDenominator !== undefined;
  if (exactRatioProvided && (
    fillNumerator === undefined ||
    fillDenominator === undefined
  )) {
    return failure(events, 'fillNumerator and fillDenominator must both be provided');
  }
  if (
    exactRatioProvided &&
    (fillDenominator! <= 0n || fillNumerator! < 0n || fillNumerator! > fillDenominator!)
  ) {
    return failure(
      events,
      `Exact fill ratio out of range: ${fillNumerator}/${fillDenominator}`,
    );
  }
  if (
    exactRatioProvided &&
    fillNumerator! * offer.quantizedGive !== filledGive * fillDenominator!
  ) {
    return failure(
      events,
      `Exact fill ratio mismatch: ${fillNumerator}/${fillDenominator} ` +
      `!= ${filledGive}/${offer.quantizedGive}`,
    );
  }
  return {
    filledGive,
    filledWant,
    canonicalFillRatio,
    exactFillRatio,
    executionProvided,
  };
};

const validateExecutionEconomics = (
  tx: SwapResolveTx,
  canonical: CanonicalOffer,
  fill: ExecutionFill,
  byLeft: boolean,
  events: string[],
): SwapResolveFailure | null => {
  const feeFailure = validateSwapFeeAuthorization(tx, canonical, fill, events);
  if (feeFailure) return feeFailure;
  if (fill.executionProvided) {
    const hasFill = fill.filledGive > 0n || fill.filledWant > 0n;
    if (hasFill && (fill.filledGive <= 0n || fill.filledWant <= 0n)) {
      return failure(events, 'Execution amounts must both be positive for a fill');
    }
    if (tx.data.fillRatio !== fill.canonicalFillRatio) {
      return failure(
        events,
        `fillRatio ${tx.data.fillRatio} does not match canonical execution ratio ` +
        `${fill.canonicalFillRatio}`,
      );
    }
  }
  if (fill.executionProvided && (fill.filledGive > 0n || fill.filledWant > 0n)) {
    if (fill.filledGive > canonical.quantizedGive) {
      return failure(
        events,
        `Execution give amount ${fill.filledGive} exceeds offer limit ${canonical.quantizedGive}`,
      );
    }
    if (
      fill.filledWant * canonical.quantizedGive <
      fill.filledGive * canonical.quantizedWant
    ) {
      const lhs = fill.filledWant * canonical.quantizedGive;
      const rhs = fill.filledGive * canonical.quantizedWant;
      swapResolveLog.debug('maker_limit_violation', {
        offer: shortOrder(tx.data.offerId, 8),
        byLeft,
        makerIsLeft: canonical.offer.makerIsLeft,
        giveTokenId: canonical.offer.giveTokenId,
        wantTokenId: canonical.offer.wantTokenId,
        effectiveGive: canonical.quantizedGive.toString(),
        effectiveWant: canonical.quantizedWant.toString(),
        filledGive: fill.filledGive.toString(),
        filledWant: fill.filledWant.toString(),
        fillRatio: tx.data.fillRatio,
        canonicalFillRatio: fill.canonicalFillRatio,
        limitLhs: lhs.toString(),
        limitRhs: rhs.toString(),
      });
      return failure(
        events,
        `Execution violates maker limit price: offer=${tx.data.offerId} ` +
        `makerIsLeft=${canonical.offer.makerIsLeft} ` +
        `effectiveGive=${canonical.quantizedGive} effectiveWant=${canonical.quantizedWant} ` +
        `filledGive=${fill.filledGive} filledWant=${fill.filledWant} lhs=${lhs} rhs=${rhs}`,
      );
    }
  }
  return validateFilledAmountBounds(fill, events);
};

const validateSwapFeeAuthorization = (
  tx: SwapResolveTx,
  canonical: CanonicalOffer,
  fill: ExecutionFill,
  events: string[],
): SwapResolveFailure | null => {
  const feeAmount = tx.data.feeAmount ?? 0n;
  const feeTokenId = tx.data.feeTokenId ?? canonical.offer.wantTokenId;
  if (feeAmount < 0n) return failure(events, 'Swap taker fee must be >= 0');
  if (feeAmount > 0n && fill.filledGive <= 0n) {
    return failure(events, 'Swap taker fee requires a non-zero fill');
  }
  if (feeAmount > 0n && feeTokenId !== canonical.offer.wantTokenId) {
    return failure(
      events,
      `Swap taker fee token mismatch: expected ${canonical.offer.wantTokenId}, got ${feeTokenId}`,
    );
  }
  if (feeAmount >= fill.filledWant && fill.filledWant > 0n) {
    return failure(
      events,
      `Swap taker fee ${feeAmount} exceeds or equals filled receive amount ${fill.filledWant}`,
    );
  }
  try {
    assertSwapNetAuthorization(
      canonical.offer,
      fill.filledGive,
      fill.filledWant,
      feeAmount,
      tx.data.cancelRemainder,
    );
  } catch (error) {
    return failure(events, error instanceof Error ? error.message : String(error));
  }
  return null;
};

const validateFilledAmountBounds = (
  fill: ExecutionFill,
  events: string[],
): SwapResolveFailure | null => {
  if (fill.canonicalFillRatio > 0 && (
    fill.filledGive < FINANCIAL.MIN_PAYMENT_AMOUNT ||
    fill.filledGive > FINANCIAL.MAX_PAYMENT_AMOUNT
  )) {
    return failure(
      events,
      `Filled give amount out of bounds: ${fill.filledGive} ` +
      `(min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
    );
  }
  if (fill.canonicalFillRatio > 0 && (
    fill.filledWant < FINANCIAL.MIN_PAYMENT_AMOUNT ||
    fill.filledWant > FINANCIAL.MAX_PAYMENT_AMOUNT
  )) {
    return failure(
      events,
      `Filled want amount out of bounds: ${fill.filledWant} ` +
      `(min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`,
    );
  }
  return null;
};

export const validateSwapResolve = (
  account: AccountState,
  tx: SwapResolveTx,
  byLeft: boolean,
  events: string[],
): ValidatedSwapResolve | SwapResolveFailure => {
  const canonical = resolveCanonicalOffer(account, tx, byLeft, events);
  if ('success' in canonical) return canonical;
  const fill = deriveExecutionFill(tx, canonical, events);
  if ('success' in fill) return fill;
  const economicsFailure = validateExecutionEconomics(tx, canonical, fill, byLeft, events);
  if (economicsFailure) return economicsFailure;
  return {
    offerId: tx.data.offerId,
    offer: canonical.offer,
    canonicalGiveAmount: canonical.give,
    canonicalWantAmount: canonical.want,
    canonicalQuantizedGive: canonical.quantizedGive,
    canonicalQuantizedWant: canonical.quantizedWant,
    canonicalPriceTicks: canonical.priceTicks,
    effectiveCancelRemainder: tx.data.cancelRemainder || tx.data.fillRatio === 0,
    filledGive: fill.filledGive,
    filledWant: fill.filledWant,
    canonicalFillRatio: fill.canonicalFillRatio,
    exactFillRatio: fill.exactFillRatio,
    effectiveFeeTokenId: tx.data.feeTokenId ?? canonical.offer.wantTokenId,
    feeAmount: tx.data.feeAmount ?? 0n,
  };
};
