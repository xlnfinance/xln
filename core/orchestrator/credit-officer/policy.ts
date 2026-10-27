import { CATALOG_TOKENS } from '../../jurisdiction/machine/config/default-tokens';
import type { CreditRequest } from './proof';

export const CREDIT_POLICY = Object.freeze({
  baseUsd: 50_000_000n,
  borrowerCapUsd: 500_000_000n,
  dailyCapUsd: 500_000_000n,
  baseBits: 16,
  testnetChains: [31337, 31338, 11155111, 3448148188] as readonly number[],
  tiers: [
    { ageDays: 7, volumeUsd: 100_000_000n, repaid: 1, limitUsd: 100_000_000n },
    { ageDays: 30, volumeUsd: 1_000_000_000n, repaid: 3, limitUsd: 500_000_000n },
  ],
});

export type CreditFacts = {
  chainId: number;
  ageDays: number;
  volumeUsd: bigint;
  repaid: number;
  adverse: boolean;
  epochChanged: boolean;
  exposureUsd: bigint;
};

/** Round exposure UP: splitting requests must never erase a fractional micro-dollar. */
export function creditUsd(tokenId: number, amount: bigint): bigint {
  const token = CATALOG_TOKENS[tokenId - 1];
  if (!Number.isSafeInteger(tokenId) || tokenId < 1 || !token || amount <= 0n) throw new Error('USD_RATE_UNAVAILABLE');
  const scale = 10n ** BigInt(token.decimals);
  return (amount * token.usdMicros + scale - 1n) / scale;
}

export function creditDifficulty(usd: bigint): number {
  let bits = CREDIT_POLICY.baseBits;
  for (let units = (usd + CREDIT_POLICY.baseUsd - 1n) / CREDIT_POLICY.baseUsd; units > 1n; units = (units + 1n) / 2n)
    bits++;
  return Math.min(32, bits);
}

export function scoreCredit(request: CreditRequest, facts: CreditFacts, spentUsd: bigint) {
  const usd = creditUsd(request.tokenId, BigInt(request.amount));
  let limitUsd: bigint = CREDIT_POLICY.baseUsd;
  for (const tier of CREDIT_POLICY.tiers) {
    if (facts.ageDays >= tier.ageDays && facts.volumeUsd >= tier.volumeUsd && facts.repaid >= tier.repaid)
      limitUsd = tier.limitUsd;
  }
  const reason = !CREDIT_POLICY.testnetChains.includes(facts.chainId)
    ? 'TESTNET_ONLY'
    : facts.epochChanged
      ? 'ACCOUNT_EPOCH_REVIEW_REQUIRED'
      : facts.adverse
        ? 'DEFAULT_OR_DISPUTE'
        : usd + facts.exposureUsd > limitUsd || usd + facts.exposureUsd > CREDIT_POLICY.borrowerCapUsd
          ? 'BORROWER_LIMIT'
          : spentUsd + usd > CREDIT_POLICY.dailyCapUsd
            ? 'DAILY_LIMIT'
            : null;
  return { approved: reason === null, reason, usd, limitUsd, bits: creditDifficulty(usd) };
}
