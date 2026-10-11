import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AccountView, WalletView } from '../runtime/views';
import { peekXLN } from '../runtime/xln-loader';
import { amountInputText, formatMoney, parseAmount } from '../runtime/format';
import { getTokenMeta } from '../runtime/token-meta';
import { availableAt } from '../runtime/financial/move';
import { paymentFundingHref, type PaymentDraft } from '../runtime/financial/payment-funding';
import { eligibleRoutes, quotePaymentRoutes, type PaymentRouteQuote } from '../runtime/financial/payments';

export function PaymentTopUp({
	wallet,
	draft,
	requiredAmount,
	routeAccount,
}: {
	wallet: WalletView;
	draft: PaymentDraft;
	requiredAmount: bigint;
	routeAccount: AccountView | null;
}) {
	const navigate = useNavigate();
	const [selectedId, setSelectedId] = useState('');
	const [quote, setQuote] = useState<{ key: string; route: PaymentRouteQuote } | null>(null);
	const [quoteError, setQuoteError] = useState('');
	const accounts = wallet.accounts.filter(account => !account.disputed);
	const account =
		routeAccount ??
		accounts.find(entry => entry.counterpartyId === selectedId) ??
		accounts.find(entry => entry.counterpartyId === draft.to) ??
		accounts.find(entry => entry.isHub) ??
		accounts[0];
	const selectedAccountId = account?.counterpartyId ?? '';
	const hasRoute = Boolean(routeAccount);
	const quoteKey = `${wallet.entityId}:${draft.to}:${draft.tokenId}:${draft.amount}:${draft.deliveryMode}:${selectedAccountId}`;
	useEffect(() => {
		let cancelled = false;
		setQuote(null);
		setQuoteError('');
		if (!selectedAccountId || hasRoute) return;
		void quotePaymentRoutes({
			sourceEntityId: wallet.entityId,
			targetEntityId: draft.to,
			tokenId: draft.tokenId,
			amount: parseAmount(draft.amount, getTokenMeta(draft.tokenId).decimals),
			fundingAccountId: selectedAccountId,
		})
			.then(routes => {
				if (cancelled) return;
				const next = eligibleRoutes(routes, draft.deliveryMode)[0];
				if (!next) throw new Error('No route for this payment through the selected account.');
				setQuote({ key: quoteKey, route: next });
			})
			.catch(error => {
				if (!cancelled) setQuoteError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
		};
	}, [
		selectedAccountId,
		hasRoute,
		wallet.entityId,
		draft.to,
		draft.tokenId,
		draft.amount,
		draft.deliveryMode,
		quoteKey,
	]);
	const quotedAmount = routeAccount ? requiredAmount : quote?.key === quoteKey ? quote.route.senderAmount : null;
	const xln = peekXLN();
	if (!account || !xln) return null;
	const plan = xln.planAccountFunding({
		account: account.doc.state,
		ownerEntityId: wallet.entityId,
		counterpartyEntityId: account.counterpartyId,
		tokenId: draft.tokenId,
		requiredOutboundAmount: quotedAmount ?? requiredAmount,
	});
	if (plan.requiredDeposit === 0n) return null;
	const meta = getTokenMeta(draft.tokenId);
	const reserve = availableAt('reserve', wallet, draft.tokenId, account.counterpartyId, []);
	const source = reserve >= plan.requiredDeposit ? 'reserve' : 'external';
	const openMove = () => {
		if (quotedAmount === null) return;
		navigate(
			paymentFundingHref(
				{ draft, accountId: account.counterpartyId, requiredCapacity: quotedAmount },
				source,
				amountInputText(plan.requiredDeposit, meta.decimals),
			),
		);
	};
	return (
		<div className="card tight" data-testid="pay-topup">
			<b>Top up for this payment</b>
			{!routeAccount && accounts.length > 1 ? (
				<label className="field">
					Into your account with
					<select
						className="input"
						value={account.counterpartyId}
						onChange={event => setSelectedId(event.target.value)}
						data-testid="pay-funding-account"
					>
						{accounts.map(entry => (
							<option key={entry.counterpartyId} value={entry.counterpartyId}>
								{entry.label}
							</option>
						))}
					</select>
				</label>
			) : null}
			<p className="note">
				{quotedAmount === null
					? quoteError || 'Checking the route and its fees…'
					: `Move ${formatMoney(plan.requiredDeposit, meta.decimals, meta.decimals)} ${meta.symbol} from ${source === 'reserve' ? 'your reserve' : 'your on-chain wallet'} into ${account.label}.`}
			</p>
			<p className="note">
				Includes the current routing fee. You will review the live route and fee again before paying.
			</p>
			<button
				type="button"
				className="btn"
				disabled={quotedAmount === null}
				onClick={openMove}
				data-testid="pay-topup-move"
			>
				Top up for payment
			</button>
		</div>
	);
}
