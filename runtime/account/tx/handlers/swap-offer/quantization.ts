import { FINANCIAL } from '../../../../constants';
import {
  computePriceTicksForBaseQuote,
  deriveSide,
  getSwapLotScale,
  prepareSwapOrder,
  quoteAmountAtPrice,
} from '../../../../orderbook';
import { deriveCanonicalCrossJurisdictionMarket } from '../../../../extensions/cross-j';
import { getSwapPairPolicyByBaseQuote } from '../../../utils';
import type { SwapOfferTx } from './admission';

export type PreparedSwapOfferAmounts = {
  priceTicks: bigint;
  effectiveGiveAmount: bigint;
  effectiveWantAmount: bigint;
};

const resolveSameJurisdictionPrice = (
  tx: SwapOfferTx,
  stepTicks: bigint,
): { priceTicks?: bigint; error?: string } => {
  const { giveTokenId, wantTokenId, giveAmount, wantAmount, priceTicks: input } = tx.data;
  const prepared = prepareSwapOrder(giveTokenId, wantTokenId, giveAmount, wantAmount);
  if (!prepared) {
    return { error: 'Invalid price ratio or order too small after canonical quantization' };
  }
  if (input === undefined) return { priceTicks: prepared.priceTicks };
  if (input <= 0n) return { error: `Invalid explicit priceTicks: ${input}` };
  const alignedInput = (input / stepTicks) * stepTicks;
  if (alignedInput !== input) {
    return {
      error: `Explicit priceTicks must align to step ${stepTicks.toString()} (got ${input.toString()})`,
    };
  }
  const tickDrift = input > prepared.priceTicks
    ? input - prepared.priceTicks
    : prepared.priceTicks - input;
  if (tickDrift > stepTicks) {
    return {
      error: `Price mismatch after deterministic quantization: expected ` +
        `${prepared.priceTicks.toString()}, got ${input.toString()} ` +
        `(drift ${tickDrift} > step ${stepTicks})`,
    };
  }
  // A one-step integer round-trip drift is expected; the explicit tick remains
  // the signed user intent and therefore owns the final book level.
  return { priceTicks: input };
};

const validatePreparedAmounts = (
  tx: SwapOfferTx,
  effectiveGiveAmount: bigint,
  effectiveWantAmount: bigint,
): string | null => {
  if (
    effectiveGiveAmount < FINANCIAL.MIN_PAYMENT_AMOUNT ||
    effectiveGiveAmount > FINANCIAL.MAX_PAYMENT_AMOUNT
  ) {
    return `Quantized giveAmount out of bounds: ${effectiveGiveAmount} ` +
      `(min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`;
  }
  if (
    effectiveWantAmount < FINANCIAL.MIN_PAYMENT_AMOUNT ||
    effectiveWantAmount > FINANCIAL.MAX_PAYMENT_AMOUNT
  ) {
    return `Quantized wantAmount out of bounds: ${effectiveWantAmount} ` +
      `(min ${FINANCIAL.MIN_PAYMENT_AMOUNT}, max ${FINANCIAL.MAX_PAYMENT_AMOUNT})`;
  }
  const route = tx.data.crossJurisdiction;
  if (route && effectiveGiveAmount !== BigInt(route.source.amount)) {
    return `Cross-j source amount changed by quantization: ` +
      `route=${route.source.amount} offer=${effectiveGiveAmount}`;
  }
  if (route && effectiveWantAmount !== BigInt(route.target.amount)) {
    return `Cross-j target amount changed by quantization: ` +
      `route=${route.target.amount} offer=${effectiveWantAmount}`;
  }
  return null;
};

export const prepareSwapOfferAmounts = (
  tx: SwapOfferTx,
): { prepared?: PreparedSwapOfferAmounts; error?: string } => {
  const { giveTokenId, wantTokenId, giveAmount, wantAmount, crossJurisdiction } = tx.data;
  const crossMarket = crossJurisdiction
    ? deriveCanonicalCrossJurisdictionMarket(crossJurisdiction)
    : null;
  const side = crossMarket
    ? crossMarket.sourceIsBase ? 1 : 0
    : deriveSide(giveTokenId, wantTokenId);
  const rawBaseAmount = side === 1 ? giveAmount : wantAmount;
  const rawQuoteAmount = side === 1 ? wantAmount : giveAmount;
  const baseTokenId = side === 1 ? giveTokenId : wantTokenId;
  const quoteTokenId = side === 1 ? wantTokenId : giveTokenId;
  const lotScale = getSwapLotScale(baseTokenId);
  if (rawBaseAmount < lotScale) {
    return { error: `Order too small for lot size (${lotScale.toString()} base units)` };
  }
  if (crossMarket && rawBaseAmount % lotScale !== 0n) {
    return {
      error: `Cross-j base amount must align to lot size (${lotScale.toString()} base units)`,
    };
  }
  const pairPolicy = crossMarket
    ? null
    : getSwapPairPolicyByBaseQuote(baseTokenId, quoteTokenId);
  const stepTicks = BigInt(Math.max(1, pairPolicy?.priceStepTicks ?? 1));
  const sameJurisdictionPrice = crossMarket
    ? null
    : resolveSameJurisdictionPrice(tx, stepTicks);
  if (sameJurisdictionPrice?.error) return { error: sameJurisdictionPrice.error };
  const priceTicks = crossMarket
    ? computePriceTicksForBaseQuote(
        side,
        baseTokenId,
        quoteTokenId,
        rawBaseAmount,
        rawQuoteAmount,
      )
    : sameJurisdictionPrice!.priceTicks!;
  if (crossMarket && priceTicks <= 0n) {
    return { error: 'Invalid cross-j price ratio or order too small after canonical quantization' };
  }
  // Cross-j pull receipts already commit the exact amounts. Only same-j intent
  // is quantized; the cross-j price is an index, never authority to resize it.
  const quantizedBaseAmount = crossMarket
    ? rawBaseAmount
    : (rawBaseAmount / lotScale) * lotScale;
  const recomputedQuote = crossMarket
    ? rawQuoteAmount
    : quoteAmountAtPrice(baseTokenId, quoteTokenId, quantizedBaseAmount, priceTicks);
  const effectiveGiveAmount = side === 1 ? quantizedBaseAmount : recomputedQuote;
  const effectiveWantAmount = side === 1 ? recomputedQuote : quantizedBaseAmount;
  const amountError = validatePreparedAmounts(
    tx,
    effectiveGiveAmount,
    effectiveWantAmount,
  );
  if (amountError) return { error: amountError };
  return {
    prepared: { priceTicks, effectiveGiveAmount, effectiveWantAmount },
  };
};
