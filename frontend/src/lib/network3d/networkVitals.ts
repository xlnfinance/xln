/**
 * What the network as a whole is doing, in the numbers someone deciding about it asks for.
 *
 * A caption says what just happened; these say what it added up to. They come from the same
 * frames the scene draws, so the headline and the picture can never disagree.
 */

export type VitalsAccount = {
  /** Collateral posted on the jurisdiction for this account. */
  collateral: bigint;
  /** Signed position: how far from balanced the account currently sits. */
  delta: bigint;
  /** Credit each side has extended to the other. */
  creditExtended: bigint;
  /** Credit actually drawn — someone owes it. */
  creditDrawn: bigint;
  disputed: boolean;
};

export type NetworkVitals = {
  entities: number;
  accounts: number;
  /** Value sitting on the jurisdiction, idle. */
  onChain: bigint;
  /** Value posted into accounts, where it can move without touching the chain. */
  inAccounts: bigint;
  /** Unsecured capacity granted on top of collateral. */
  creditExtended: bigint;
  creditDrawn: bigint;
  /** Share of all value that is working off-chain, 0..1. */
  offChainShare: number;
  /** How much of the posted collateral is actually displaced from balance, 0..1. */
  deltaUtilisation: number;
  disputes: number;
};

const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const share = (part: bigint, whole: bigint): number => (whole <= 0n ? 0 : Number(part) / Number(whole));

export const summarizeNetwork = (
  reserves: readonly bigint[],
  accounts: readonly VitalsAccount[],
): NetworkVitals => {
  const onChain = reserves.reduce((sum, amount) => sum + (amount > 0n ? amount : 0n), 0n);
  let inAccounts = 0n;
  let creditExtended = 0n;
  let creditDrawn = 0n;
  let displaced = 0n;
  let disputes = 0;
  for (const account of accounts) {
    const collateral = account.collateral > 0n ? account.collateral : 0n;
    inAccounts += collateral;
    creditExtended += account.creditExtended > 0n ? account.creditExtended : 0n;
    creditDrawn += account.creditDrawn > 0n ? account.creditDrawn : 0n;
    // Displacement is capped by the collateral: beyond it the position is credit, which
    // the drawn figure already reports.
    const moved = abs(account.delta);
    displaced += moved > collateral ? collateral : moved;
    if (account.disputed) disputes += 1;
  }
  return {
    entities: reserves.length,
    accounts: accounts.length,
    onChain,
    inAccounts,
    creditExtended,
    creditDrawn,
    offChainShare: share(inAccounts, onChain + inAccounts),
    deltaUtilisation: share(displaced, inAccounts),
    disputes,
  };
};

/** Percent for a headline: whole numbers, because a tenth of a percent is noise here. */
export const percent = (value: number): string =>
  `${Math.round((Number.isFinite(value) ? value : 0) * 100)}%`;
