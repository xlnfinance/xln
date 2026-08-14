import { FINANCIAL } from '../../../../../config/constants';
import {
  computePriceTicksForBaseQuoteDecimals,
  deriveSide,
  prepareSwapOrderForDimensions,
  quoteAmountAtPriceForDecimals,
  getSwapLotScaleForDecimals,
} from '../../../../../orderbook';
import { deriveCanonicalCrossJurisdictionMarket } from '../../../../../extensions/cross-j';
import { getSwapPairPolicyByBaseQuote } from '../../../../utils';
import type { SwapOfferTx } from './admission';

export type PreparedSwapOfferAmounts = {
  priceTicks: bigint;
  effectiveGiveAmount: bigint;
  effectiveWantAmount: bigint;
};

const resolveSameJurisdictionPrice = (
  tx: SwapOfferTx,
  stepTicks: bigint,
): { ok: true; priceTicks: bigint } | { ok: false; message: string } => {
  const { giveTokenId, wantTokenId, giveAmount, wantAmount, priceTicks: input } = tx.data;
  const prepared = prepareSwapOrderForDimensions(giveTokenId, wantTokenId, giveAmount, wantAmount, {
    giveTokenDecimals: tx.data.giveTokenDecimals,
    wantTokenDecimals: tx.data.wantTokenDecimals,
  });
  if (!prepared) {
    return { ok: false, message: 'Invalid price ratio or order too small after canonical quantization' };
  }
  if (input === undefined) return { ok: true, priceTicks: prepared.priceTicks };
  if (input <= 0n) return { ok: false, message: `Invalid explicit priceTicks: ${input}` };
  const alignedInput = (input / stepTicks) * stepTicks;
  if (alignedInput !== input) {
    return {
      ok: false,
      message: `Explicit priceTicks must align to step ${stepTicks.toString()} (got ${input.toString()})`,
    };
  }
  const tickDrift = input > prepared.priceTicks
    ? input - prepared.priceTicks
    : prepared.priceTicks - input;
  if (tickDrift > stepTicks) {
    return {
      ok: false,
      message: `Price mismatch after deterministic quantization: expected ` +
        `${prepared.priceTicks.toString()}, got ${input.toString()} ` +
        `(drift ${tickDrift} > step ${stepTicks})`,
    };
  }
  // A one-step integer round-trip drift is expected; the explicit tick remains
  // the signed user intent and therefore owns the final book level.
  return { ok: true, priceTicks: input };
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

export type SwapOfferAmountResult =
  | { ok: true; prepared: PreparedSwapOfferAmounts }
  | { ok: false; message: string };

export const prepareSwapOfferAmounts = (
  tx: SwapOfferTx,
): SwapOfferAmountResult => {
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
  const baseTokenDecimals = side === 1 ? tx.data.giveTokenDecimals : tx.data.wantTokenDecimals;
  const quoteTokenDecimals = side === 1 ? tx.data.wantTokenDecimals : tx.data.giveTokenDecimals;
  const lotScale = getSwapLotScaleForDecimals(baseTokenDecimals);
  if (rawBaseAmount < lotScale) {
    return { ok: false, message: `Order too small for lot size (${lotScale.toString()} base units)` };
  }
  if (crossMarket && rawBaseAmount % lotScale !== 0n) {
    return {
      ok: false,
      message: `Cross-j base amount must align to lot size (${lotScale.toString()} base units)`,
    };
  }
  const pairPolicy = crossMarket
    ? null
    : getSwapPairPolicyByBaseQuote(baseTokenId, quoteTokenId);
  const stepTicks = BigInt(Math.max(1, pairPolicy?.priceStepTicks ?? 1));
  const sameJurisdictionPrice = crossMarket
    ? null
    : resolveSameJurisdictionPrice(tx, stepTicks);
  if (sameJurisdictionPrice && !sameJurisdictionPrice.ok) {
    return { ok: false, message: sameJurisdictionPrice.message };
  }
  const priceTicks = sameJurisdictionPrice === null
    ? computePriceTicksForBaseQuoteDecimals(
        side,
        baseTokenId,
        quoteTokenId,
        rawBaseAmount,
        rawQuoteAmount,
        baseTokenDecimals,
        quoteTokenDecimals,
      )
    : sameJurisdictionPrice.priceTicks;
  if (crossMarket && priceTicks <= 0n) {
    return { ok: false, message: 'Invalid cross-j price ratio or order too small after canonical quantization' };
  }
  // Cross-j pull receipts already commit the exact amounts. Only same-j intent
  // is quantized; the cross-j price is an index, never authority to resize it.
  const quantizedBaseAmount = crossMarket
    ? rawBaseAmount
    : (rawBaseAmount / lotScale) * lotScale;
  const recomputedQuote = crossMarket
    ? rawQuoteAmount
    : quoteAmountAtPriceForDecimals(
        baseTokenDecimals,
        quoteTokenDecimals,
        quantizedBaseAmount,
        priceTicks,
      );
  const effectiveGiveAmount = side === 1 ? quantizedBaseAmount : recomputedQuote;
  const effectiveWantAmount = side === 1 ? recomputedQuote : quantizedBaseAmount;
  const amountError = validatePreparedAmounts(
    tx,
    effectiveGiveAmount,
    effectiveWantAmount,
  );
  if (amountError) return { ok: false, message: amountError };
  return {
    ok: true,
    prepared: { priceTicks, effectiveGiveAmount, effectiveWantAmount },
  };
};
