import { useEffect, useMemo, useState } from 'react';

import {
  buildWalletPayHref,
  buildXlnInvoiceDeepLink,
  buildXlnInvoiceUri,
} from '../../../src/lib/utils/xlnInvoice';
import type { WalletPaymentProjection } from './wallet-payment-model';
import type { WalletPaymentSource } from './wallet-payment-source';

export function WalletPaymentReceive({
  projection,
  source,
}: Readonly<{
  projection: WalletPaymentProjection;
  source: WalletPaymentSource;
}>) {
  const [tokenId, setTokenId] = useState(projection.tokens[0]?.tokenId || 0);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrError, setQrError] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'invoice' | 'app'>('idle');
  const selectedTokenId = tokenId || projection.tokens[0]?.tokenId || 0;
  const amountError = source.validateInvoiceAmount(selectedTokenId, amount);
  const invoice = useMemo(() => buildXlnInvoiceUri({
    targetEntityId: projection.activeEntityId,
    tokenId: selectedTokenId,
    amount: amountError ? '' : amount,
    description,
  }), [amount, amountError, description, projection.activeEntityId, selectedTokenId]);
  const walletHref = useMemo(() => buildWalletPayHref({
    targetEntityId: projection.activeEntityId,
    tokenId: selectedTokenId,
    amount: amountError ? '' : amount,
    description,
  }), [amount, amountError, description, projection.activeEntityId, selectedTokenId]);
  const appLink = useMemo(() => buildXlnInvoiceDeepLink({
    targetEntityId: projection.activeEntityId,
    tokenId: selectedTokenId,
    amount: amountError ? '' : amount,
    description,
  }), [amount, amountError, description, projection.activeEntityId, selectedTokenId]);

  useEffect(() => {
    let current = true;
    setQrDataUrl('');
    setQrError('');
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(walletHref, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#f4f7ef', light: '#111413' },
    })).then((url) => {
      if (current) setQrDataUrl(url);
    }).catch((error: unknown) => {
      if (current) setQrError(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [walletHref]);

  const copy = async (value: string, kind: 'invoice' | 'app'): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopyState(kind);
  };

  return (
    <section className="wallet-payments-pane" aria-labelledby="wallet-receive-title">
      <div className="wallet-payments-section-heading">
        <div><p>02</p><h2 id="wallet-receive-title">Receive</h2></div>
        <span>Canonical invoice · no command</span>
      </div>
      <div className="wallet-receive-grid">
        <div className="wallet-receive-builder">
          <label>
            <span>Receiving Entity</span>
            <code>{projection.activeEntityId}</code>
          </label>
          <label>
            <span>Asset</span>
            <select onChange={(event) => setTokenId(Number(event.target.value))} value={selectedTokenId}>
              {projection.tokens.map((token) => <option key={token.tokenId} value={token.tokenId}>{token.symbol}</option>)}
            </select>
          </label>
          <label>
            <span>Requested amount · optional</span>
            <input inputMode="decimal" onChange={(event) => { setAmount(event.target.value); setCopyState('idle'); }} placeholder="Open amount" value={amount} />
          </label>
          <label>
            <span>Description · optional</span>
            <input maxLength={200} onChange={(event) => { setDescription(event.target.value); setCopyState('idle'); }} placeholder="What is this for?" value={description} />
          </label>
          {amountError ? <p className="wallet-payment-error" role="alert">{amountError}</p> : null}
          <div className="wallet-payment-actions">
            <button disabled={Boolean(amountError)} onClick={() => void copy(invoice, 'invoice')} type="button">
              {copyState === 'invoice' ? 'Invoice copied' : 'Copy invoice'}
            </button>
            <button disabled={Boolean(amountError)} onClick={() => void copy(appLink, 'app')} type="button">
              {copyState === 'app' ? 'App link copied' : 'Copy app link'}
            </button>
          </div>
        </div>
        <article className="wallet-receive-preview">
          <header><span>Invoice QR</span><small>Wallet link payload</small></header>
          {qrDataUrl && !amountError
            ? <img alt="xln payment invoice QR" height="240" src={qrDataUrl} width="240" />
            : <div className="wallet-receive-qr-placeholder">{amountError ? 'Fix amount to generate' : qrError || 'Generating…'}</div>}
          <code>{amountError ? projection.activeEntityId : invoice}</code>
        </article>
      </div>
    </section>
  );
}
