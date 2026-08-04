import { useEffect, useState } from 'react';

import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import { resolveConfiguredApiBase } from '$lib/stores/xlnStore';
import type { WalletEntityAccountsView } from './account-view-model';
import { walletAccountStoreController } from './wallet-account-store';
import { walletExternalStore, walletExternalStoreController } from './wallet-external-store';
import {
  requestWalletTestAsset,
  type WalletTestAssetTarget,
} from './wallet-test-asset-actions';

const defaultAmount = (symbol: string, target: WalletTestAssetTarget): string =>
  symbol === 'ETH' || symbol === 'WETH' ? (target === 'account' ? '0.2' : '0.1') : '100';

export const WalletTestAssetFaucet = ({ entity }: Readonly<{ entity: WalletEntityAccountsView }>) => {
  const external = useExternalStore(walletExternalStore);
  const [target, setTarget] = useState<WalletTestAssetTarget>('external');
  const [tokenAddress, setTokenAddress] = useState('');
  const [accountId, setAccountId] = useState(entity.accounts[0]?.counterpartyId ?? '');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void walletExternalStoreController.selectEntity(entity); }, [entity.entityId, entity.height]);
  useEffect(() => {
    const compatible = external.tokens.filter(token => target === 'external' || token.tokenId !== null);
    if (!compatible.some(token => token.address === tokenAddress)) setTokenAddress(compatible[0]?.address ?? '');
  }, [external.tokens, target, tokenAddress]);
  useEffect(() => {
    if (!entity.accounts.some(account => account.counterpartyId === accountId)) {
      setAccountId(entity.accounts[0]?.counterpartyId ?? '');
    }
  }, [entity.accounts, accountId]);

  const compatibleTokens = external.tokens.filter(token => target === 'external' || token.tokenId !== null);
  const token = compatibleTokens.find(candidate => candidate.address === tokenAddress) ?? null;
  const submit = async (): Promise<void> => {
    if (!token || !external.owner) return;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const amount = defaultAmount(token.symbol, target);
      const result = await requestWalletTestAsset({
        apiBase: resolveConfiguredApiBase(window.location.origin),
        target,
        entityId: entity.entityId,
        runtimeId: entity.runtimeId,
        owner: external.owner,
        counterpartyId: target === 'account' ? accountId : null,
        tokenId: token.tokenId,
        symbol: token.symbol,
        amount,
      });
      setMessage(`${amount} ${token.symbol} accepted · waiting for observed ${target} balance${result.requestId ? ` · ${result.requestId}` : ''}`);
      await Promise.all([walletExternalStoreController.refresh(), walletAccountStoreController.refresh()]);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="wallet-test-assets" data-testid="wallet-test-assets">
      <div><p className="wallet-eyebrow">testnet ingress</p><h2>Request test assets</h2><p>HTTP acceptance is not committed balance evidence.</p></div>
      <div className="wallet-test-assets-controls">
        <label><span>Target</span><select value={target} disabled={pending} onChange={event => { setTarget(event.target.value as WalletTestAssetTarget); setMessage(null); }}><option value="external">External wallet</option><option value="reserve">Entity reserve</option><option value="account">First account</option></select></label>
        {target === 'account' && <label><span>Account</span><select value={accountId} disabled={pending} onChange={event => setAccountId(event.target.value)}>{entity.accounts.map(account => <option key={account.counterpartyId} value={account.counterpartyId}>{account.counterpartyId}</option>)}</select></label>}
        <label><span>Asset</span><select value={tokenAddress} disabled={pending || external.loading} onChange={event => setTokenAddress(event.target.value)}>{compatibleTokens.map(item => <option key={item.address} value={item.address}>{item.symbol}</option>)}</select></label>
        <button type="button" disabled={pending || !token || !external.owner || (target === 'account' && !accountId)} onClick={() => void submit()}>{pending ? 'Requesting…' : `Request ${token ? defaultAmount(token.symbol, target) : ''}`}</button>
      </div>
      {external.error && <p className="wallet-inline-error" role="alert">{external.error}</p>}
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      {message && <p className="wallet-command-receipt" data-status="accepted" role="status">{message}</p>}
    </section>
  );
};
