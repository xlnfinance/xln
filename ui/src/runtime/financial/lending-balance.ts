import { useEffect, useState } from 'react';
import { emptyLendingBalance, watchLendingBalance, type LendingBalanceAccount } from '@xln/frontend/lib/utils/ui/lendingBalance';
import type { WalletView } from '../views';
import { resolveApiBase } from '../http';

export function useLendingBalance(wallet: WalletView) {
  const accounts: LendingBalanceAccount[] = wallet.accounts.map(account => ({
    hubEntityId: account.counterpartyId,
    intents: Array.from(account.doc.state.lendingIntents ?? []),
  }));
  const key = JSON.stringify({ apiBase: resolveApiBase(), userEntityId: wallet.entityId, accounts });
  const [result, setResult] = useState({ key: '', value: emptyLendingBalance() });
  useEffect(() => watchLendingBalance(JSON.parse(key), value => setResult({ key, value })), [key]);
  return result.key === key ? result.value : { ...emptyLendingBalance(), loading: accounts.some(account => account.intents.length > 0) };
}
