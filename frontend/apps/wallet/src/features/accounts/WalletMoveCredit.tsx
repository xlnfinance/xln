import { useState } from 'react';

import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import { parseTokenAmountInput } from '$lib/components/Entity/token-amount-input';
import {
  buildWalletCollateralToReserveInput,
  buildWalletCreditInput,
  buildWalletReserveToCollateralInput,
  buildWalletReserveToExternalInput,
  buildWalletReserveTransferInput,
} from '../../../../../packages/runtime-client/wallet-financial-input-adapter';
import type { WalletEntityAccountsView } from './account-view-model';
import { requestWalletCredit, submitWalletFinancialCommand } from './wallet-financial-actions';
import { WalletCommandReceipt } from './WalletCommandReceipt';

type WalletMoveKind =
  | 'reserve-transfer'
  | 'reserve-to-external'
  | 'fund-account'
  | 'withdraw-collateral'
  | 'withdraw-account-external'
  | 'move-account-account'
  | 'extend-credit'
  | 'request-credit';

type WalletMoveConfirmation = Readonly<{
  input: ReturnType<typeof buildWalletReserveTransferInput> | null;
  kind: WalletMoveKind;
  operation: string;
  targetEntityId: string;
  tokenId: number;
  tokenSymbol: string;
  amountInput: string;
  amountRaw: bigint;
}>;

export const WalletMoveCredit = ({
  entity,
  receipt,
}: Readonly<{ entity: WalletEntityAccountsView; receipt: CommandReceipt | null }>) => {
  const [kind, setKind] = useState<WalletMoveKind>('reserve-transfer');
  const [counterpartyId, setCounterpartyId] = useState(entity.accounts[0]?.counterpartyId ?? '');
  const [destinationAccountId, setDestinationAccountId] = useState(entity.accounts[1]?.counterpartyId ?? entity.accounts[0]?.counterpartyId ?? '');
  const account = entity.accounts.find(candidate => candidate.counterpartyId === counterpartyId) ?? entity.accounts[0] ?? null;
  const accountTokens = account?.tokens ?? [];
  const tokenOptions = kind === 'reserve-transfer' || kind === 'reserve-to-external' ? entity.reserves : accountTokens;
  const [tokenId, setTokenId] = useState(tokenOptions[0]?.tokenId ?? 0);
  const token = tokenOptions.find(candidate => candidate.tokenId === tokenId) ?? tokenOptions[0] ?? null;
  const accountToken = accountTokens.find(candidate => candidate.tokenId === token?.tokenId) ?? accountTokens[0] ?? null;
  const [recipientId, setRecipientId] = useState('');
  const [amount, setAmount] = useState('');
  const [confirmation, setConfirmation] = useState<WalletMoveConfirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildConfirmation = (): WalletMoveConfirmation => {
    if (!token) throw new Error('Select an asset');
    const owner = { entityId: entity.entityId, signerId: entity.signerId };
    const amountRaw = parseTokenAmountInput(amount, token.decimals);
    const input = kind === 'request-credit'
      ? null
      : kind === 'reserve-transfer'
        ? buildWalletReserveTransferInput({
            ...owner,
            recipientEntityId: recipientId,
            tokenId: token.tokenId,
            tokenDecimals: token.decimals,
            amountInput: amount,
            maxAmount: BigInt(token.raw),
            broadcast: false,
          })
        : kind === 'reserve-to-external'
          ? buildWalletReserveToExternalInput({
              ...owner,
              recipientEoa: recipientId,
              tokenId: token.tokenId,
              tokenDecimals: token.decimals,
              amountInput: amount,
              maxAmount: BigInt(token.raw),
              broadcast: false,
            })
          : kind === 'fund-account'
          ? buildWalletReserveToCollateralInput({
              ...owner,
              counterpartyEntityId: counterpartyId,
              tokenId: token.tokenId,
              tokenDecimals: token.decimals,
              amountInput: amount,
            })
          : kind === 'withdraw-collateral' || kind === 'withdraw-account-external' || kind === 'move-account-account'
            ? buildWalletCollateralToReserveInput({
                ...owner,
                counterpartyEntityId: counterpartyId,
                executorIsLeft: account?.isLeftPerspective ?? false,
                tokenId: token.tokenId,
                tokenDecimals: token.decimals,
                amountInput: amount,
                maxAmount: BigInt(accountToken?.withdrawableCollateralRaw ?? '0'),
                postSettleOp: kind === 'withdraw-account-external'
                  ? { type: 'r2e', recipientEoa: recipientId }
                  : kind === 'move-account-account'
                    ? {
                        type: 'reserve_to_collateral',
                        targetEntityId: entity.entityId,
                        counterpartyEntityId: destinationAccountId,
                      }
                    : { type: 'none' },
              })
            : buildWalletCreditInput({
                ...owner,
                counterpartyEntityId: counterpartyId,
                tokenId: token.tokenId,
                tokenDecimals: token.decimals,
                amountInput: amount,
              });
    return {
      input,
      kind,
      operation: kind === 'reserve-transfer'
        ? 'reserveToReserve'
        : kind === 'reserve-to-external'
          ? 'reserveToExternalToken'
        : kind === 'fund-account'
          ? 'reserveToCollateral'
          : kind === 'withdraw-collateral'
            ? 'settle_propose · c2r → broadcast'
            : kind === 'withdraw-account-external'
              ? 'settle_propose · c2r → r2e → broadcast'
              : kind === 'move-account-account'
                ? 'settle_propose · c2r → r2c → broadcast'
            : kind === 'extend-credit'
              ? 'extendCredit'
              : 'credit request · server receipt',
      targetEntityId: kind === 'reserve-transfer' || kind === 'reserve-to-external' || kind === 'withdraw-account-external'
        ? recipientId
        : kind === 'move-account-account'
          ? destinationAccountId
          : counterpartyId,
      tokenId: token.tokenId,
      tokenSymbol: token.symbol,
      amountInput: amount,
      amountRaw,
    };
  };

  const review = (): void => {
    try {
      setError(null);
      setConfirmation(buildConfirmation());
    } catch (reviewError) {
      setConfirmation(null);
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    }
  };

  const submit = async (): Promise<void> => {
    if (!confirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      if (confirmation.kind === 'request-credit') {
        await requestWalletCredit({
          userEntityId: entity.entityId,
          hubEntityId: confirmation.targetEntityId,
          tokenId: confirmation.tokenId,
          amountRaw: confirmation.amountRaw,
        });
      } else {
        if (!confirmation.input) throw new Error('WALLET_MOVE_COMMAND_MISSING');
        await submitWalletFinancialCommand(
          ['wallet-move', confirmation.kind, entity.entityId, confirmation.targetEntityId, confirmation.tokenId, confirmation.amountRaw].join(':'),
          confirmation.input,
        );
      }
      setConfirmation(null);
      setAmount('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="wallet-operation" data-testid="wallet-move-credit-form">
      <header><p className="wallet-eyebrow">canonical account operations</p><h2>Move & credit</h2></header>
      <label><span>Operation</span><select value={kind} disabled={submitting} onChange={event => { setKind(event.target.value as WalletMoveKind); setTokenId(0); setConfirmation(null); }}>
        <option value="reserve-transfer">Reserve → reserve</option>
        <option value="reserve-to-external">Reserve → external wallet</option>
        <option value="fund-account">Reserve → collateral</option>
        <option value="withdraw-collateral">Collateral → reserve</option>
        <option value="withdraw-account-external">Account → external wallet</option>
        <option value="move-account-account">Account → account</option>
        <option value="extend-credit">Extend credit</option>
        <option value="request-credit">Request credit from hub</option>
      </select></label>
      {kind !== 'reserve-transfer' && kind !== 'reserve-to-external' && <label><span>Account</span><select value={account?.counterpartyId ?? ''} disabled={submitting} onChange={event => { setCounterpartyId(event.target.value); setConfirmation(null); }}>{entity.accounts.map(item => <option key={item.counterpartyId} value={item.counterpartyId}>{item.counterpartyId}</option>)}</select></label>}
      {kind === 'reserve-transfer' && <label><span>Recipient entity</span><input value={recipientId} disabled={submitting} onChange={event => { setRecipientId(event.target.value); setConfirmation(null); }} placeholder="0x…" /></label>}
      {(kind === 'reserve-to-external' || kind === 'withdraw-account-external') && <label><span>Recipient EOA</span><input value={recipientId} disabled={submitting} onChange={event => { setRecipientId(event.target.value); setConfirmation(null); }} placeholder="0x…" /></label>}
      {kind === 'move-account-account' && <label><span>Destination account</span><select value={destinationAccountId} disabled={submitting} onChange={event => { setDestinationAccountId(event.target.value); setConfirmation(null); }}>{entity.accounts.map(item => <option key={item.counterpartyId} value={item.counterpartyId}>{item.counterpartyId}</option>)}</select></label>}
      <div className="wallet-form-grid">
        <label><span>Asset</span><select value={token?.tokenId ?? 0} disabled={submitting} onChange={event => { setTokenId(Number(event.target.value)); setConfirmation(null); }}>{tokenOptions.map(item => <option key={item.tokenId} value={item.tokenId}>{item.symbol}</option>)}</select></label>
        <label><span>Amount</span><input value={amount} inputMode="decimal" disabled={submitting} onChange={event => { setAmount(event.target.value); setConfirmation(null); }} placeholder="0.00" /></label>
      </div>
      {kind === 'withdraw-collateral' && accountToken && <p className="wallet-field-note">Canonical withdrawable collateral: {accountToken.withdrawableCollateralRaw} raw</p>}
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      {confirmation ? (
        <div className="wallet-confirm" data-testid="wallet-move-confirmation">
          <h3>Confirm exact operation</h3>
          <dl>
            <div><dt>Operation</dt><dd>{confirmation.operation}</dd></div>
            <div><dt>Counterparty</dt><dd>{confirmation.targetEntityId}</dd></div>
            <div><dt>Amount</dt><dd>{confirmation.amountInput} {confirmation.tokenSymbol} <small>({confirmation.amountRaw.toString()} raw)</small></dd></div>
            <div><dt>Token ID</dt><dd>{confirmation.tokenId}</dd></div>
          </dl>
          <div className="wallet-action-row"><button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirmation(null)}>Back</button><button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit exact operation'}</button></div>
        </div>
      ) : (
        <button type="button" disabled={submitting || !token || !amount || ((kind === 'reserve-transfer' || kind === 'reserve-to-external' || kind === 'withdraw-account-external') && !recipientId) || (kind === 'move-account-account' && (!destinationAccountId || destinationAccountId === counterpartyId))} onClick={review}>Review exact operation</button>
      )}
      <WalletCommandReceipt receipt={receipt} />
    </section>
  );
};
