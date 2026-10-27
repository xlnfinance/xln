import type { AccountView } from '../views';

/** A payment or faucet transfer the user's own credit limit cannot hold. The wallet never raises it. */
export class CreditLimitFullError extends Error {
  constructor(readonly accountId: string, message: string) {
    super(message);
    this.name = 'CreditLimitFullError';
  }
}

export type FullCreditLimit = { accountId: string; label: string; tokenId: number; limit: bigint };

/**
 * Credit lines the user extends that are fully used: the counterparty already
 * owes the whole limit and has no collateral or own debt to repay, so no further
 * payment can arrive. Accounts frozen by a dispute cannot change limits.
 */
export const fullCreditLimits = (accounts: readonly AccountView[]): FullCreditLimit[] =>
  accounts
    .filter(account => !account.disputed)
    .flatMap(account => account.tokens
      .filter(({ derived }) => derived.peerCreditLimit > 0n && derived.inPeerCredit === 0n
        && derived.inCollateral === 0n && derived.inOwnCredit === 0n)
      .map(token => ({ accountId: account.counterpartyId, label: account.label, tokenId: token.tokenId, limit: token.derived.peerCreditLimit })));
