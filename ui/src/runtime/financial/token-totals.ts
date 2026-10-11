import type { AccountView, PlaceRow, TokenTotals } from '../views';
import type { RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';

/** Ownership and capacity from one committed wallet projection. */
export function walletTokenTotals({
  onchain,
  reserves,
  accounts,
  jurisdiction,
  debtTotals,
}: {
  onchain: PlaceRow[];
  reserves: PlaceRow[];
  accounts: AccountView[];
  jurisdiction: string;
  debtTotals: NonNullable<RuntimeAdapterViewFrame['activeEntity']>['core']['debtTotals'];
}): TokenTotals[] {
  const tokenIds = new Set<number>([
    ...onchain.map(row => row.tokenId),
    ...reserves.map(row => row.tokenId),
    ...accounts.flatMap(account => account.tokens.map(token => token.tokenId)),
    ...debtTotals.incoming.keys(),
    ...debtTotals.outgoing.keys(),
  ]);
  return Array.from(tokenIds)
    .sort((a, b) => a - b)
    .map(tokenId => {
      const onchainAmount = onchain.filter(row => row.tokenId === tokenId).reduce((sum, row) => sum + row.amount, 0n);
      const reserveAmount = reserves.filter(row => row.tokenId === tokenId).reduce((sum, row) => sum + row.amount, 0n);
      const pending = reserves.filter(row => row.tokenId === tokenId).reduce((sum, row) => sum + row.pending, 0n);
      // J finality retires the Account claim; the remaining debt is still owed,
      // but has no collateral and cannot become payment capacity or cash.
      let receivable = debtTotals.incoming.get(tokenId) ?? 0n;
      let secured = 0n;
      let risk = receivable;
      let owed = -(debtTotals.outgoing.get(tokenId) ?? 0n);
      let sendCapacity = 0n;
      let receiveCapacity = 0n;
      for (const account of accounts) {
        for (const token of account.tokens) {
          if (token.tokenId !== tokenId) continue;
          if (token.signed > 0n) {
            receivable += token.signed;
            // deriveDelta splits a positive position into the slice collateral covers and the rest.
            const unsecured = token.derived.outPeerCredit < token.signed ? token.derived.outPeerCredit : token.signed;
            risk += unsecured;
            secured += token.signed - unsecured;
          } else owed += token.signed;
          if (!account.disputed) {
            sendCapacity += token.derived.outCapacity;
            receiveCapacity += token.derived.inCapacity;
          }
        }
      }
      const active =
        onchainAmount > 0n ||
        reserveAmount > 0n ||
        pending > 0n ||
        receivable > 0n ||
        owed < 0n ||
        sendCapacity > 0n ||
        receiveCapacity > 0n;
      return {
        tokenId,
        onchain: onchainAmount,
        reserve: reserveAmount,
        pending,
        receivable,
        secured,
        risk,
        owed,
        net: onchainAmount + reserveAmount + receivable + owed,
        sendCapacity,
        receiveCapacity,
        active,
        jurisdictions: jurisdiction ? [jurisdiction] : [],
      };
    });
}
