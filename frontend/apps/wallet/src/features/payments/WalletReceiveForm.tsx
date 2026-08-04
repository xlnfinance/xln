import { useMemo, useState } from 'react';

import { buildXlnInvoiceDeepLink } from '$lib/utils/xlnInvoice';
import type { WalletEntityAccountsView } from '../accounts/account-view-model';

export const WalletReceiveForm = ({ entity }: Readonly<{ entity: WalletEntityAccountsView }>) => {
  const tokens = entity.catalog;
  const [tokenId, setTokenId] = useState(tokens[0]?.tokenId ?? 0);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invoice = useMemo(() => buildXlnInvoiceDeepLink({
    targetEntityId: entity.entityId,
    tokenId: tokenId || null,
    amount,
    description,
  }), [amount, description, entity.entityId, tokenId]);
  const copy = async (): Promise<void> => {
    setError(null);
    try {
      await navigator.clipboard.writeText(invoice);
      setCopied(true);
    } catch (copyError) {
      setCopied(false);
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };
  return (
    <section className="wallet-operation" data-testid="wallet-receive-form">
      <header><p className="wallet-eyebrow">canonical invoice</p><h2>Receive</h2></header>
      <div className="wallet-form-grid">
        <label><span>Asset</span><select value={tokenId} onChange={event => setTokenId(Number(event.target.value))}>{tokens.map(token => <option key={token.tokenId} value={token.tokenId}>{token.symbol}</option>)}</select></label>
        <label><span>Amount (optional)</span><input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} /></label>
      </div>
      <label><span>Description (optional)</span><input value={description} maxLength={200} onChange={event => setDescription(event.target.value)} /></label>
      <output className="wallet-invoice" data-testid="wallet-receive-invoice">{invoice}</output>
      {error && <p className="wallet-inline-error" role="alert">Invoice copy failed: {error}</p>}
      <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy invoice'}</button>
    </section>
  );
};
