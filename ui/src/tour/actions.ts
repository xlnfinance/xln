/**
 * What the tour itself may do: nothing on the user's behalf. The only action
 * here is the counterparty's, the shop paying a bill the user wrote, and it
 * goes through the same planner and submit path as any payment.
 */
import { getTokenMeta } from '../runtime/format';
import { demoMerchantPays } from '../runtime/sandbox';
import { counterpartyFeePolicy } from '../runtime/financial/manage';
import type { WalletView } from '../runtime/views';

const USDC = 1;

/** Whole USDC in the token's own decimals (6 on every xln jurisdiction so far). */
const usd = (amount: number): bigint => BigInt(Math.round(amount)) * 10n ** BigInt(getTokenMeta(USDC).decimals);

export const TOUR_FAUCET_USD = 100;
export const TOUR_PAY_USD = 25;
export const TOUR_MOVE_USD = 100;
export const TOUR_COLLATERAL_USD = 500;
export const TOUR_INVOICE_USD = 40;

export function demoHub(wallet: WalletView) {
	return wallet.accounts.find(account => account.isHub) ?? null;
}

/** The shop settles the bill the user just wrote: a real inbound payment through the hub. */
export async function tourInvoicePaid(wallet: WalletView): Promise<void> {
	await demoMerchantPays(wallet.entityId, usd(TOUR_INVOICE_USD), 'Meridian Desk paid your bill');
}

/** The hub's committed fee policy for USDC on our account, or null when it has not published one. */
export function tourCollateralPolicy(wallet: WalletView) {
	const hub = demoHub(wallet);
	return hub ? counterpartyFeePolicy(hub.doc, hub.isLeft, USDC) : null;
}
