import { useRef, useState } from 'react';

import type { PaymentDeliveryMode } from '@xln/runtime/api/public/runtime-module';
import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import { runtimeQueryClient } from '$lib/stores/runtimeQueryClient';
import { parseTokenAmountInput } from '$lib/components/Entity/token-amount-input';
import { parseXlnInvoice } from '$lib/utils/xlnInvoice';
import type { WalletEntityAccountsView } from '../accounts/account-view-model';
import type { WalletDirectoryEntity } from '../accounts/wallet-account-store';
import { submitWalletFinancialCommand } from '../accounts/wallet-financial-actions';
import { WalletCommandReceipt } from '../accounts/WalletCommandReceipt';
import {
  buildWalletPaymentCommand,
  type WalletPaymentCommand,
} from '../../../../../packages/runtime-client/wallet-payment-input-adapter';
import {
  projectWalletPaymentRoutes,
  walletPaymentRouteErrorText,
  type WalletPaymentRouteView,
} from './wallet-payment-routes';

export type WalletPaymentFormProps = Readonly<{
  entity: WalletEntityAccountsView;
  directory: readonly WalletDirectoryEntity[];
  receipt: CommandReceipt | null;
  initialInvoice?: string | null;
}>;

const initialIntent = (raw: string | null | undefined) => {
  if (!raw) return null;
  try { return parseXlnInvoice(raw); } catch { return null; }
};

const routeLabel = (path: readonly string[]): string =>
  path.map(entityId => `${entityId.slice(0, 8)}…${entityId.slice(-6)}`).join(' → ');

export const WalletPaymentForm = ({ entity, directory, receipt, initialInvoice }: WalletPaymentFormProps) => {
  const imported = initialIntent(initialInvoice);
  const recipients = directory.filter(candidate => candidate.entityId !== entity.entityId);
  const [target, setTarget] = useState(imported?.targetEntityId ?? recipients[0]?.entityId ?? '');
  const [tokenId, setTokenId] = useState(imported?.tokenId ?? entity.catalog[0]?.tokenId ?? 0);
  const token = entity.catalog.find(candidate => candidate.tokenId === tokenId) ?? entity.catalog[0] ?? null;
  const [amount, setAmount] = useState(imported?.amount ?? '');
  const [description, setDescription] = useState(imported?.description ?? '');
  const [deliveryMode, setDeliveryMode] = useState<PaymentDeliveryMode>('instant');
  const [routes, setRoutes] = useState<readonly WalletPaymentRouteView[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [routePhase, setRoutePhase] = useState<'idle' | 'loading'>('idle');
  const [confirmation, setConfirmation] = useState<WalletPaymentCommand | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const routeRequest = useRef(0);
  const selectedRoute = routes[selectedRouteIndex] ?? null;

  const invalidate = (): void => {
    routeRequest.current += 1;
    setRoutes([]);
    setSelectedRouteIndex(0);
    setConfirmation(null);
    setError(null);
    setRoutePhase('idle');
  };

  const findRoutes = async (): Promise<void> => {
    const request = ++routeRequest.current;
    setRoutePhase('loading');
    setConfirmation(null);
    setError(null);
    try {
      if (!token) throw new Error('Select an asset');
      const recipientAmount = parseTokenAmountInput(amount, token.decimals);
      const response = await runtimeQueryClient.findPaymentRoutes({
        sourceEntityId: entity.entityId,
        targetEntityId: target,
        tokenId: token.tokenId,
        amount: recipientAmount.toString(),
      });
      if (request !== routeRequest.current) return;
      const projected = projectWalletPaymentRoutes({
        response,
        sourceEntityId: entity.entityId,
        targetEntityId: target,
        recipientAmount,
        deliveryMode,
      });
      if (projected.length === 0) throw new Error('No route has enough real capacity for this amount');
      setRoutes(projected);
      setSelectedRouteIndex(0);
    } catch (routeError) {
      if (request !== routeRequest.current) return;
      setRoutes([]);
      setError(walletPaymentRouteErrorText(routeError));
    } finally {
      if (request === routeRequest.current) setRoutePhase('idle');
    }
  };

  const review = (): void => {
    try {
      if (!token || !selectedRoute) throw new Error('Find and select a route');
      setError(null);
      setConfirmation(buildWalletPaymentCommand({
        entityId: entity.entityId,
        signerId: entity.signerId,
        targetEntityId: selectedRoute.path.at(-1) ?? target,
        tokenId: token.tokenId,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        amountInput: amount,
        route: selectedRoute.path,
        deliveryMode,
        totalFee: selectedRoute.totalFee,
        description,
      }));
    } catch (previewError) {
      setConfirmation(null);
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    }
  };

  const submit = async (): Promise<void> => {
    if (!confirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      const command = confirmation;
      const key = [command.preview.entityId, command.preview.targetEntityId, command.preview.tokenId, command.preview.amountRaw, command.preview.deliveryMode].join(':');
      await submitWalletFinancialCommand(key, command.input);
      setConfirmation(null);
      setRoutes([]);
      setAmount('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="wallet-operation" data-testid="wallet-payment-form">
      <header><p className="wallet-eyebrow">canonical route · one command</p><h2>Pay</h2></header>
      <label><span>Recipient</span><input id="payment-invoice-input" list="wallet-payment-recipients" value={target} disabled={submitting} onChange={event => { setTarget(event.target.value.trim().toLowerCase()); invalidate(); }} /></label>
      <datalist id="wallet-payment-recipients">{recipients.map(candidate => <option key={candidate.entityId} value={candidate.entityId}>{candidate.label}</option>)}</datalist>
      <div className="wallet-form-grid">
        <label><span>Asset</span><select data-testid="wallet-payment-token" value={token?.tokenId ?? 0} disabled={submitting} onChange={event => { setTokenId(Number(event.target.value)); invalidate(); }}>{entity.catalog.map(item => <option key={item.tokenId} value={item.tokenId}>{item.symbol}</option>)}</select></label>
        <fieldset className="wallet-payment-modes"><legend>Delivery</legend>{(['direct', 'instant', 'async', 'trusted'] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={deliveryMode === mode} data-testid={`payment-mode-${mode}`} disabled={submitting} onClick={() => { setDeliveryMode(mode); invalidate(); }}>{mode}</button>)}</fieldset>
      </div>
      <label><span>Amount</span><input id="payment-amount-input" data-testid="payment-amount-input" value={amount} inputMode="decimal" disabled={submitting} onChange={event => { setAmount(event.target.value); invalidate(); }} placeholder="0.00" /></label>
      <label><span>Private note</span><input value={description} disabled={submitting} maxLength={200} onChange={event => { setDescription(event.target.value); setConfirmation(null); }} /></label>
      <button type="button" disabled={submitting || routePhase === 'loading' || !target || !token || !amount} onClick={() => void findRoutes()}>{routePhase === 'loading' ? 'Finding routes…' : routes.length > 0 ? 'Refresh routes' : 'Find routes'}</button>
      {error && <p className="wallet-inline-error form-error" role="alert">{error}</p>}
      {routes.length > 0 && <div className="wallet-payment-routes" role="radiogroup" aria-label="Payment routes">{routes.map((route, index) => <button key={route.path.join(':')} type="button" role="radio" aria-checked={selectedRouteIndex === index} className={`route-option ${selectedRouteIndex === index ? 'selected' : ''}`} data-route-path={route.path.join(',')} onClick={() => { setSelectedRouteIndex(index); setConfirmation(null); }}><span>{routeLabel(route.path)}</span><small>fee {route.totalFee.toString()} raw · {Math.round(route.probability * 100)}%</small></button>)}</div>}
      {confirmation ? <div className="wallet-confirm" data-testid="wallet-payment-confirmation"><h3>Confirm exact command</h3><dl><div><dt>Recipient</dt><dd>{confirmation.preview.targetEntityId}</dd></div><div><dt>Amount</dt><dd>{amount} {confirmation.preview.tokenSymbol} <small>({confirmation.preview.amountRaw} raw)</small></dd></div><div><dt>Fee</dt><dd>{confirmation.preview.totalFeeRaw} raw</dd></div><div><dt>Route</dt><dd>{routeLabel(confirmation.preview.route)}</dd></div><div><dt>Operation</dt><dd>{confirmation.preview.deliveryMode === 'direct' || confirmation.preview.deliveryMode === 'trusted' ? 'directPayment' : 'htlcPayment'}</dd></div></dl><div className="wallet-action-row"><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirmation(null)}>Back</button><button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit payment'}</button></div></div> : <button type="button" disabled={submitting || !selectedRoute} onClick={review}>Review payment</button>}
      <WalletCommandReceipt receipt={receipt} />
    </section>
  );
};
