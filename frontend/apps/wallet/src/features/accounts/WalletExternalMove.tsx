import { useEffect, useState } from 'react';
import type { RuntimeInput } from '@xln/runtime/api/public/runtime-module';
import { ZeroAddress } from 'ethers';

import { useExternalStore } from '../../../../../packages/react-adapters/use-external-store';
import type { CommandReceipt } from '$lib/stores/runtimeCommandBus';
import { parseTokenAmountInput } from '$lib/components/Entity/token-amount-input';
import {
  buildWalletExternalToAccountInputs,
  buildWalletExternalToReserveInput,
} from '../../../../../packages/runtime-client/wallet-financial-input-adapter';
import type { WalletEntityAccountsView } from './account-view-model';
import {
  approveWalletExternalAllowance,
  sendWalletExternalAsset,
} from './wallet-external-actions';
import {
  walletExternalStore,
  walletExternalStoreController,
} from './wallet-external-store';
import { submitWalletFinancialCommandSequence } from './wallet-financial-actions';
import { WalletCommandReceipt } from './WalletCommandReceipt';

type WalletExternalMoveKind = 'external-to-reserve' | 'external-to-account' | 'external-transfer';

type WalletExternalConfirmation = Readonly<{
  kind: WalletExternalMoveKind;
  operation: string;
  tokenAddress: string;
  tokenId: number | null;
  tokenSymbol: string;
  amountInput: string;
  amountRaw: bigint;
  recipient: string;
  inputs: readonly RuntimeInput[];
}>;

const operationLabel = (kind: WalletExternalMoveKind): string => {
  if (kind === 'external-to-reserve') return 'externalToReserve · draft batch';
  if (kind === 'external-to-account') return 'externalToReserve → reserveToCollateral';
  return 'external wallet transfer';
};

export const WalletExternalMove = ({
  entity,
  receipt,
}: Readonly<{ entity: WalletEntityAccountsView; receipt: CommandReceipt | null }>) => {
  const external = useExternalStore(walletExternalStore);
  const [kind, setKind] = useState<WalletExternalMoveKind>('external-to-reserve');
  const [tokenAddress, setTokenAddress] = useState('');
  const [accountId, setAccountId] = useState(entity.accounts[0]?.counterpartyId ?? '');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [confirmation, setConfirmation] = useState<WalletExternalConfirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chainResult, setChainResult] = useState<string | null>(null);

  useEffect(() => {
    void walletExternalStoreController.selectEntity(entity);
  }, [entity.entityId, entity.height]);
  useEffect(() => {
    if (!external.tokens.some(token => token.address === tokenAddress)) {
      setTokenAddress(external.tokens[0]?.address ?? '');
      setConfirmation(null);
    }
  }, [external.tokens, tokenAddress]);

  const token = external.tokens.find(candidate => candidate.address === tokenAddress) ?? null;
  const allowance = token?.allowanceRaw === null || token?.allowanceRaw === undefined
    ? null
    : BigInt(token.allowanceRaw);
  const allowanceSatisfied = Boolean(
    confirmation
      && confirmation.kind !== 'external-transfer'
      && allowance !== null
      && allowance >= confirmation.amountRaw,
  );

  const buildConfirmation = (): WalletExternalConfirmation => {
    if (!token) throw new Error('Select an external asset');
    const amountRaw = parseTokenAmountInput(amount, token.decimals);
    if (amountRaw > BigInt(token.balanceRaw)) throw new Error('WALLET_MOVE_AMOUNT_EXCEEDS_EXTERNAL_BALANCE');
    const owner = { entityId: entity.entityId, signerId: entity.signerId };
    if (kind !== 'external-transfer' && (token.address === ZeroAddress || token.tokenId === null)) {
      throw new Error('External deposit requires a registered ERC20 asset');
    }
    const inputs = kind === 'external-to-reserve'
      ? [buildWalletExternalToReserveInput({
          ...owner,
          contractAddress: token.address,
          internalTokenId: token.tokenId!,
          tokenDecimals: token.decimals,
          amountInput: amount,
          maxAmount: BigInt(token.balanceRaw),
        })]
      : kind === 'external-to-account'
        ? buildWalletExternalToAccountInputs({
            ...owner,
            contractAddress: token.address,
            internalTokenId: token.tokenId!,
            tokenDecimals: token.decimals,
            amountInput: amount,
            maxAmount: BigInt(token.balanceRaw),
            counterpartyEntityId: accountId,
          })
        : [];
    return Object.freeze({
      kind,
      operation: operationLabel(kind),
      tokenAddress: token.address,
      tokenId: token.tokenId,
      tokenSymbol: token.symbol,
      amountInput: amount,
      amountRaw,
      recipient: kind === 'external-transfer' ? recipient : kind === 'external-to-account' ? accountId : entity.entityId,
      inputs: Object.freeze(inputs),
    });
  };

  const review = (): void => {
    try {
      setError(null);
      setChainResult(null);
      setConfirmation(buildConfirmation());
    } catch (reviewError) {
      setConfirmation(null);
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    }
  };

  const approve = async (): Promise<void> => {
    if (!confirmation || confirmation.tokenId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await approveWalletExternalAllowance({
        entityId: entity.entityId,
        signerId: entity.signerId,
        tokenAddress: confirmation.tokenAddress,
        tokenId: confirmation.tokenId,
        amount: confirmation.amountRaw,
      });
      await walletExternalStoreController.refresh();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : String(approvalError));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!confirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      if (confirmation.kind === 'external-transfer') {
        const hash = await sendWalletExternalAsset({
          entityId: entity.entityId,
          signerId: entity.signerId,
          tokenAddress: confirmation.tokenAddress,
          recipientEoa: confirmation.recipient,
          amount: confirmation.amountRaw,
        });
        setChainResult(hash);
      } else {
        if (!allowanceSatisfied) throw new Error('WALLET_EXTERNAL_ALLOWANCE_REQUIRED');
        await submitWalletFinancialCommandSequence(
          ['wallet-external-move', confirmation.kind, entity.entityId, confirmation.tokenAddress, confirmation.amountRaw].join(':'),
          confirmation.inputs,
        );
      }
      setConfirmation(null);
      setAmount('');
      await walletExternalStoreController.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="wallet-operation" data-testid="wallet-external-move-form">
      <header><p className="wallet-eyebrow">chain-observed external wallet</p><h2>External assets</h2></header>
      {external.loading && external.tokens.length === 0 && <p role="status">Reading finalized wallet balances…</p>}
      {external.error && <p className="wallet-inline-error" role="alert">{external.error}</p>}
      {external.owner && <p className="wallet-field-note">Owner <code>{external.owner}</code>{external.sourceHeight !== null ? ` · source block ${external.sourceHeight}` : ''}</p>}
      <label><span>Operation</span><select value={kind} disabled={submitting} onChange={event => { setKind(event.target.value as WalletExternalMoveKind); setConfirmation(null); }}>
        <option value="external-to-reserve">External → reserve</option>
        <option value="external-to-account">External → account</option>
        <option value="external-transfer">External → external</option>
      </select></label>
      {kind === 'external-to-account' && <label><span>Destination account</span><select value={accountId} disabled={submitting} onChange={event => { setAccountId(event.target.value); setConfirmation(null); }}>{entity.accounts.map(account => <option key={account.counterpartyId} value={account.counterpartyId}>{account.counterpartyId}</option>)}</select></label>}
      {kind === 'external-transfer' && <label><span>Recipient EOA</span><input value={recipient} disabled={submitting} onChange={event => { setRecipient(event.target.value); setConfirmation(null); }} placeholder="0x…" /></label>}
      <div className="wallet-form-grid">
        <label><span>Asset</span><select value={token?.address ?? ''} disabled={submitting || external.loading} onChange={event => { setTokenAddress(event.target.value); setConfirmation(null); }}>{external.tokens.map(item => <option key={item.address} value={item.address}>{item.symbol} · {item.balance}</option>)}</select></label>
        <label><span>Amount</span><input value={amount} inputMode="decimal" disabled={submitting} onChange={event => { setAmount(event.target.value); setConfirmation(null); }} placeholder="0.00" /></label>
      </div>
      {error && <p className="wallet-inline-error" role="alert">{error}</p>}
      {chainResult && <p className="wallet-command-receipt" data-status="accepted">External transaction accepted · <code>{chainResult}</code></p>}
      {confirmation ? (
        <div className="wallet-confirm" data-testid="wallet-external-confirmation">
          <h3>Confirm exact operation</h3>
          <dl>
            <div><dt>Operation</dt><dd>{confirmation.operation}</dd></div>
            <div><dt>Destination</dt><dd>{confirmation.recipient}</dd></div>
            <div><dt>Amount</dt><dd>{confirmation.amountInput} {confirmation.tokenSymbol} <small>({confirmation.amountRaw.toString()} raw)</small></dd></div>
            <div><dt>Token contract</dt><dd>{confirmation.tokenAddress}</dd></div>
            {confirmation.kind !== 'external-transfer' && <div><dt>Depository allowance</dt><dd>{allowance?.toString() ?? 'unavailable'} raw</dd></div>}
          </dl>
          <div className="wallet-action-row">
            <button type="button" className="wallet-button-secondary" disabled={submitting} onClick={() => setConfirmation(null)}>Back</button>
            {confirmation.kind !== 'external-transfer' && !allowanceSatisfied
              ? <button type="button" disabled={submitting} onClick={() => void approve()}>{submitting ? 'Approving…' : 'Approve exact amount'}</button>
              : <button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? 'Submitting…' : 'Submit exact operation'}</button>}
          </div>
        </div>
      ) : <button type="button" disabled={submitting || !token || !amount || (kind === 'external-transfer' && !recipient) || (kind === 'external-to-account' && !accountId)} onClick={review}>Review exact operation</button>}
      <WalletCommandReceipt receipt={receipt} />
    </section>
  );
};
