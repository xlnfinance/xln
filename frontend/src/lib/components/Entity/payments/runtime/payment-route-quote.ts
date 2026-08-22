import type { Profile as GossipProfile } from '@xln/core/api/public/runtime-module';
import {
  quoteHop,
  type DeriveDeltaFn,
  type LocalReplicaLike,
} from '../../payment-routing';

export type PaymentRouteQuote = {
  path: string[];
  hops: Array<{ from: string; to: string; fee: bigint; feePPM: number }>;
  totalFee: bigint;
  senderAmount: bigint;
  recipientAmount: bigint;
};

export const quoteRequiredInboundForForward = (
  desiredForward: bigint,
  feePPM: number,
  baseFee: bigint,
): bigint => {
  if (desiredForward <= 0n) {
    throw new Error(`Invalid desired forward amount: ${desiredForward}`);
  }
  let low = desiredForward + baseFee;
  let high = low;
  const forwardOut = (amountIn: bigint): bigint => {
    const ppmFee = (amountIn * BigInt(Math.max(0, Math.floor(feePPM)))) / 1_000_000n;
    const totalFee = baseFee + ppmFee;
    if (totalFee >= amountIn) throw new Error(`Fee too high for amount ${amountIn}`);
    return amountIn - totalFee;
  };
  while (forwardOut(high) < desiredForward) high *= 2n;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (forwardOut(mid) >= desiredForward) high = mid;
    else low = mid + 1n;
  }
  return low;
};

export const quotePaymentCandidateRoutes = (input: Readonly<{
  paths: readonly string[][];
  canonicalIds: ReadonlyMap<string, string>;
  replicaMap: ReadonlyMap<string, LocalReplicaLike>;
  profiles: readonly GossipProfile[];
  deriveDelta: DeriveDeltaFn;
  tokenId: number;
  recipientAmount: bigint;
  defaultUnknownHopFeePPM: number;
}>): PaymentRouteQuote[] => {
  const quotedRoutes: PaymentRouteQuote[] = [];
  for (const normalizedPath of input.paths) {
    const path = normalizedPath.map(id => input.canonicalIds.get(id) || id);
    const intermediaries = path.slice(1, -1);
    let downstreamAmount = input.recipientAmount;
    const intermediaryFeeByEntity = new Map<string, { fee: bigint; feePPM: number }>();
    let hasCapacity = true;
    for (let index = intermediaries.length - 1; index >= 0; index -= 1) {
      const intermediary = intermediaries[index]!;
      const nextHop = path[index + 2]!;
      const quote = quoteHop(
        input.replicaMap,
        input.profiles,
        input.deriveDelta,
        intermediary,
        nextHop,
        input.tokenId,
        downstreamAmount,
        input.defaultUnknownHopFeePPM,
      );
      if (!quote || quote.outCap < downstreamAmount) {
        hasCapacity = false;
        break;
      }
      const requiredInbound = quoteRequiredInboundForForward(
        downstreamAmount,
        quote.feePPM,
        quote.baseFee,
      );
      intermediaryFeeByEntity.set(intermediary, {
        fee: requiredInbound - downstreamAmount,
        feePPM: quote.feePPM,
      });
      downstreamAmount = requiredInbound;
    }
    if (!hasCapacity) continue;

    if (path.length > 1) {
      const senderQuote = quoteHop(
        input.replicaMap,
        input.profiles,
        input.deriveDelta,
        path[0]!,
        path[1]!,
        input.tokenId,
        downstreamAmount,
        input.defaultUnknownHopFeePPM,
      );
      if (!senderQuote || senderQuote.outCap < downstreamAmount) continue;
    }

    const senderAmount = downstreamAmount;
    const hops = path.slice(0, -1).map((from, index) => {
      const feeInfo = intermediaryFeeByEntity.get(from) || { fee: 0n, feePPM: 0 };
      return {
        from,
        to: path[index + 1]!,
        fee: feeInfo.fee,
        feePPM: feeInfo.feePPM,
      };
    });
    quotedRoutes.push({
      path,
      hops,
      totalFee: senderAmount - input.recipientAmount,
      senderAmount,
      recipientAmount: input.recipientAmount,
    });
  }
  return quotedRoutes;
};
