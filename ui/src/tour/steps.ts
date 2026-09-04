/**
 * The guided tour. It never acts and never navigates: a ring marks the control
 * to press next, wherever the user is, and a step releases only when the
 * runtime shows the effect of what the user did. Plain language in the body;
 * the mechanism under "Under the hood".
 */
import type { WalletView } from '../runtime/views';
import { getTokenMeta } from '../runtime/format';
import { usdOf } from '../runtime/financial/prices';
import { TOUR_COLLATERAL_USD, TOUR_FAUCET_USD, TOUR_INVOICE_USD, TOUR_MOVE_USD, TOUR_PAY_USD, demoHub, tourCollateralPolicy, tourInvoicePaid } from './actions';

export type TourContext = {
	wallet: WalletView;
	pathname: string;
	/** Numbers recorded when the step started, so "grew by" conditions are exact. */
	baseline: Map<string, number>;
	/** Small DOM probes the guidance needs: is a control present, active, filled. */
	dom: {
		has: (testId: string) => boolean;
		active: (testId: string) => boolean;
		value: (testId: string) => string;
	};
};

export type QuizOption = { label: string; correct?: boolean; why: string };

export type TourStep = {
	id: string;
	chapter: string;
	title: string;
	/** Plain language. No protocol words. */
	body: string;
	/** The same step for people who want the mechanism. Collapsed by default. */
	more?: string;
	/** Control to highlight from wherever the user is; the chain leads them there. */
	target?: (ctx: TourContext) => string | undefined;
	/** One line that changes with the target: "now type 25". */
	hint?: (ctx: TourContext) => string | undefined;
	/** read: Next turns the page once the user stands at the target. do: the runtime releases it. quiz: the right answer. */
	mode: 'read' | 'do' | 'quiz';
	options?: QuizOption[];
	enter?: (ctx: TourContext) => void;
	done?: (ctx: TourContext) => boolean;
	/** Progress for multi-part goals, shown as "2 / 3". */
	progress?: (ctx: TourContext) => { done: number; total: number };
	/** The counterparty reacting to what the user did, once (the shop pays the bill). */
	trigger?: (ctx: TourContext) => boolean;
	react?: (wallet: WalletView) => Promise<void>;
	skipWhen?: (ctx: TourContext) => boolean;
};

const USDC = 1;
const WETH = 2;

const hub = (ctx: TourContext) => demoHub(ctx.wallet);
const hubPath = (ctx: TourContext): string => `/accounts/${hub(ctx)?.counterpartyId ?? ''}`;
const hubUsdc = (ctx: TourContext) => hub(ctx)?.tokens.find(token => token.tokenId === USDC) ?? null;
const hubWeth = (ctx: TourContext) => hub(ctx)?.tokens.find(token => token.tokenId === WETH) ?? null;
const collateralUsd = (ctx: TourContext): number => usdOf(USDC, hubUsdc(ctx)?.derived.collateral ?? 0n);
const wethUnits = (ctx: TourContext): number => Number(hubWeth(ctx)?.signed ?? 0n) / 10 ** getTokenMeta(WETH).decimals;
const money = (value: number): string => `$${value.toLocaleString('en-US')}`;
const at = (ctx: TourContext, path: string): boolean => (path === '/' ? ctx.pathname === '/' : ctx.pathname.startsWith(path));

/** Controls that only lead somewhere; standing on one of them is not "being there" yet. */
export const WAYPOINTS = new Set(['nav-home', 'nav-manage', 'back', 'account-row', 'home-sovereignty', 'manage-assets', 'receipt-done']);

/** The way home from anywhere: the Home tab where it shows, the back control inside a flow. */
const toHome = (ctx: TourContext): string => (ctx.dom.has('nav-home') ? 'nav-home' : 'back');
/** Reach a Home control: press it if on Home, otherwise go home first. */
const viaHome = (ctx: TourContext, control: string): string => (at(ctx, '/') ? control : toHome(ctx));
/** Reach a control on the hub account page: the first account row on Home leads there. */
const viaHub = (ctx: TourContext, control: string): string => (at(ctx, hubPath(ctx)) ? control : viaHome(ctx, 'account-row'));
const homeHint = (ctx: TourContext, then: string): string | undefined => (at(ctx, '/') ? then : 'Go back to Home first.');

/** Count how many times a number changed since the step started; each swap fill moves the ETH position. */
const countChanges = (ctx: TourContext, key: string, value: number): number => {
	const last = ctx.baseline.get(`${key}:last`);
	let count = ctx.baseline.get(`${key}:count`) ?? 0;
	if (last !== undefined && Math.abs(last - value) > 1e-9) {
		count += 1;
		ctx.baseline.set(`${key}:count`, count);
	}
	ctx.baseline.set(`${key}:last`, value);
	return count;
};

export const TRADES_TO_MAKE = 3;

export const TOUR_STEPS: TourStep[] = [
	{
		id: 'welcome',
		chapter: 'Start',
		title: 'Meet your wallet',
		body: "You're Alice. Two others share this playground: Hub One, a service that passes payments along, and Meridian Desk, a shop. Everything you do here is real. The money is play money, and it never leaves this tab. The tour only points; you press every button yourself.",
		more: 'Three separate xln runtimes run inside this page, one per participant, next to a local test chain. The tour drives nothing; it watches the runtime for the effect of what you did.',
		target: ctx => viaHome(ctx, 'home-total'),
		mode: 'read',
	},
	{
		id: 'bars',
		chapter: 'Start',
		title: 'One glance, the whole picture',
		body: 'Every bar is drawn to the same scale, so a dollar is the same width everywhere. Green is money that is yours no matter what anyone does. Violet is money someone owes you and has only promised to pay. Right now Hub One owes you $10,000 on a promise.',
		more: 'Every account obeys one line: −L_left ≤ Δ ≤ C + L_right. Δ is who owes whom, C is collateral on-chain, L are the two credit lines. Green covers the on-chain wallet, the Depository reserve and collateral; violet is the part of Δ beyond C, the promise.',
		target: ctx => viaHome(ctx, 'home-risk'),
		mode: 'read',
	},
	{
		id: 'quiz-colors',
		chapter: 'Start',
		title: 'Quick check',
		body: 'Hub One vanishes tonight, servers off, phone dead. Which part of your money is gone?',
		mode: 'quiz',
		options: [
			{ label: 'The violet part', correct: true, why: 'Right. Violet is a promise from Hub One. Everything green is yours by contract or on-chain, whatever the hub does.' },
			{ label: 'The green part', why: 'No. Green is the part the blockchain guarantees. It does not depend on the hub existing.' },
			{ label: 'All of it', why: 'No. Only the violet part depends on the hub. The green part is enforceable without it.' },
		],
	},
	{
		id: 'keys',
		chapter: 'Keys',
		title: 'Your keys, your money',
		body: 'Tap the shield in the corner of Home. It shows where your key lives. In a real wallet the key is made from a name and a passphrase on your device and is never stored anywhere. In the playground it is a throwaway test key.',
		more: 'BrainVault derives the seed with a memory-hard function from name + passphrase. The entity id is the hash of its board, which here is your single signer. Nothing is uploaded.',
		target: ctx => viaHome(ctx, 'home-sovereignty'),
		hint: ctx => homeHint(ctx, 'Tap the shield.'),
		mode: 'do',
		done: ctx => at(ctx, '/sovereignty'),
	},
	{
		id: 'ledger',
		chapter: 'Keys',
		title: 'Both of you sign every change',
		body: 'Your account with Hub One is a shared ledger. Every update is signed by you and by the hub, so neither side can rewrite it alone. "Co-signed 1 of 1" means the latest page is final. "Can dispute without asking" means you already hold the hub\'s signature to take that page to the blockchain by yourself.',
		more: "Each frame carries both parties' hankos. The counterparty's dispute-proof hanko on the newest state lets you start an on-chain dispute unilaterally.",
		target: ctx => (at(ctx, '/sovereignty') ? 'sovereignty-ledger' : viaHome(ctx, 'home-sovereignty')),
		mode: 'read',
	},
	{
		id: 'faucet',
		chapter: 'Credit',
		title: `Get paid ${money(TOUR_FAUCET_USD)} instantly`,
		body: 'Hub One trusts you with a credit line, so it can pay you without touching the blockchain. Go to Manage → Assets and press "Hub pays me USDC over credit". It lands in about a second.',
		more: 'The hub sends a direct payment over the bilateral account: a new frame is proposed, acknowledged and committed by both runtimes. No chain transaction is involved.',
		target: ctx => (at(ctx, '/assets') ? 'faucet-offchain' : at(ctx, '/manage') ? 'manage-assets' : ctx.dom.has('nav-manage') ? 'nav-manage' : 'back'),
		hint: ctx => (at(ctx, '/assets') ? `The amount is already ${TOUR_FAUCET_USD}. Press the first faucet button.` : at(ctx, '/manage') ? 'Open Assets.' : 'Open Manage.'),
		mode: 'do',
		enter: ctx => ctx.baseline.set('receivable', ctx.wallet.usd.receivable),
		done: ctx => ctx.wallet.usd.receivable >= (ctx.baseline.get('receivable') ?? 0) + TOUR_FAUCET_USD * 0.9,
	},
	{
		id: 'faucet-read',
		chapter: 'Credit',
		title: 'More violet, more promise',
		body: `The hub now owes you ${money(TOUR_FAUCET_USD)} more. It came instantly and for free, but it is still a promise. Soon you will turn promises into something the blockchain enforces. Go back to Home to see it.`,
		target: ctx => viaHome(ctx, 'home-risk'),
		mode: 'read',
	},
	{
		id: 'pay',
		chapter: 'Pay',
		title: `Pay the shop ${money(TOUR_PAY_USD)}`,
		body: `You have no account with Meridian Desk, so Hub One passes the payment along. Either both legs happen or neither does; the hub cannot keep your money on the way. Press Pay, pick Meridian Desk, enter ${TOUR_PAY_USD}, confirm.`,
		more: 'A two-hop payment with a hash lock on each hop; one secret releases both. Route and fee come from the payment planner, and the whole thing settles in bilateral state with no block to wait for.',
		target: ctx => {
			if (!at(ctx, '/pay')) return viaHome(ctx, 'home-pay');
			if (!ctx.dom.value('pay-to').trim()) return 'pay-to';
			if (!ctx.dom.value('pay-amount').trim()) return 'pay-amount';
			return 'pay-submit';
		},
		hint: ctx => {
			if (!at(ctx, '/pay')) return homeHint(ctx, 'Press Pay.');
			if (!ctx.dom.value('pay-to').trim()) return 'Tap the "To" field and pick Meridian Desk.';
			if (!ctx.dom.value('pay-amount').trim()) return `Type ${TOUR_PAY_USD}.`;
			return 'Confirm the payment.';
		},
		mode: 'do',
		enter: ctx => ctx.baseline.set('receivable', ctx.wallet.usd.receivable),
		done: ctx => ctx.wallet.usd.receivable <= (ctx.baseline.get('receivable') ?? 0) - TOUR_PAY_USD * 0.9,
	},
	{
		id: 'receipt',
		chapter: 'Pay',
		title: 'A receipt that holds up',
		body: 'Your receipt is not a screenshot. It is the signed page of the ledger that moved the money, with its fingerprint. Both sides signed it, and either of you could take it to the blockchain. Read it, then close it.',
		more: 'The receipt binds the committed frame height and hash read from your own runtime\'s frame journal; the recipient is bound locally from the payment intent you submitted.',
		target: ctx => (ctx.dom.has('receipt-title') ? 'receipt-title' : viaHome(ctx, 'home-frame')),
		mode: 'read',
	},
	{
		id: 'receive',
		chapter: 'Receive',
		title: `Bill the shop ${money(TOUR_INVOICE_USD)}`,
		body: `Press Receive and type ${TOUR_INVOICE_USD}. That builds a payment link and a QR code with your address and the amount. In the playground the shop pays the moment the bill exists; in life you would show the QR or send the link.`,
		more: 'The invoice is a canonical xln link (entity, token, amount, note). The shop\'s runtime quotes a route through Hub One and pays it with the same planner you used a minute ago.',
		target: ctx => (at(ctx, '/receive') ? 'receive-amount' : viaHome(ctx, 'home-receive')),
		hint: ctx => (at(ctx, '/receive') ? `Type ${TOUR_INVOICE_USD}.` : homeHint(ctx, 'Press Receive.')),
		mode: 'do',
		enter: ctx => ctx.baseline.set('receivable', ctx.wallet.usd.receivable),
		trigger: ctx => at(ctx, '/receive') && Number(ctx.dom.value('receive-amount')) >= TOUR_INVOICE_USD,
		react: tourInvoicePaid,
		done: ctx => ctx.wallet.usd.receivable >= (ctx.baseline.get('receivable') ?? 0) + TOUR_INVOICE_USD * 0.9,
	},
	{
		id: 'move',
		chapter: 'Collateral',
		title: `Lock ${money(TOUR_MOVE_USD)} as collateral`,
		body: `Part of your money sits in a shared vault on the blockchain, your reserve. Move ${money(TOUR_MOVE_USD)} of it into your account with Hub One. It becomes collateral: the blockchain itself now guarantees that part of your balance.`,
		more: 'A reserve → collateral operation inside a signed Depository batch. The chain answers with a ReserveToCollateral event that both runtimes apply to the account. In the playground the chain is an in-page EVM.',
		target: ctx => {
			if (!at(ctx, '/move')) return viaHome(ctx, 'home-move');
			if (!ctx.dom.active('move-from-reserve')) return 'move-from-reserve';
			if (!ctx.dom.active('move-to-account')) return 'move-to-account';
			if (!ctx.dom.value('move-amount').trim()) return 'move-amount';
			return 'move-now';
		},
		hint: ctx => {
			if (!at(ctx, '/move')) return homeHint(ctx, 'Press Move, next to Balances.');
			if (!ctx.dom.active('move-from-reserve')) return 'From: Reserve.';
			if (!ctx.dom.active('move-to-account')) return 'To: Account.';
			if (!ctx.dom.value('move-amount').trim()) return `Type ${TOUR_MOVE_USD}.`;
			return 'Sign & send.';
		},
		mode: 'do',
		enter: ctx => ctx.baseline.set('collateral', collateralUsd(ctx)),
		done: ctx => collateralUsd(ctx) >= (ctx.baseline.get('collateral') ?? 0) + TOUR_MOVE_USD * 0.9,
	},
	{
		id: 'move-read',
		chapter: 'Collateral',
		title: 'A promise became a guarantee',
		body: `"Secured" is the part of what you are owed that collateral covers. ${money(TOUR_MOVE_USD)} of violet turned green: if Hub One disappeared tomorrow, that ${money(TOUR_MOVE_USD)} is yours by contract. Back on Home you can see it.`,
		target: ctx => viaHome(ctx, 'home-risk'),
		mode: 'read',
	},
	{
		id: 'rebalance',
		chapter: 'Collateral',
		title: 'Make the hub put up collateral',
		body: `The hub can also lock its own money as collateral for you, for a small fee it published up front. Open your account with Hub One, then Manage → Collateral, ask for ${TOUR_COLLATERAL_USD}. The hub posts it on-chain within a moment.`,
		more: 'requestCollateral quotes the fee from the hub\'s committed policy (base + gas + liquidity basis points). The hub\'s scheduler answers with a reserve → collateral batch paid from its own Depository reserve.',
		target: ctx => {
			if (!at(ctx, hubPath(ctx))) return viaHub(ctx, '');
			if (!ctx.dom.has('collateral-request')) return 'account-manage';
			if (!ctx.dom.value('collateral-amount').trim()) return 'collateral-amount';
			return 'collateral-request';
		},
		hint: ctx => {
			if (!at(ctx, hubPath(ctx))) return homeHint(ctx, 'Open the Hub One account.');
			if (!ctx.dom.has('collateral-request')) return 'Open Manage; the Collateral tab is first.';
			if (!ctx.dom.value('collateral-amount').trim()) return `Type ${TOUR_COLLATERAL_USD}.`;
			return 'Request collateral.';
		},
		mode: 'do',
		enter: ctx => ctx.baseline.set('collateral', collateralUsd(ctx)),
		done: ctx => collateralUsd(ctx) >= (ctx.baseline.get('collateral') ?? 0) + TOUR_COLLATERAL_USD * 0.5,
		skipWhen: ctx => tourCollateralPolicy(ctx.wallet) === null,
	},
	{
		id: 'trade',
		chapter: 'Trade',
		title: `Make ${TRADES_TO_MAKE} trades`,
		body: 'Hub One runs a marketplace for its members and Meridian Desk has left offers on both sides. Tap a price in the book to fill your ticket, then place the order. Buy some ETH, sell some back, buy again: three fills.',
		more: 'Same-hub swaps: your order hits the hub\'s book and matches the merchant\'s resting offer. Both accounts commit the fill in one frame each; the hub takes the spread it published.',
		target: ctx => (at(ctx, '/swap') ? (ctx.dom.value('swap-give').trim() ? 'swap-submit' : 'orderbook') : viaHome(ctx, 'home-swap')),
		hint: ctx => (at(ctx, '/swap') ? (ctx.dom.value('swap-give').trim() ? 'Place the order.' : 'Tap a price. Red rows sell you ETH, green rows buy it from you.') : homeHint(ctx, 'Press Swap.')),
		mode: 'do',
		enter: ctx => {
			ctx.baseline.set('weth:last', wethUnits(ctx));
			ctx.baseline.set('weth:count', 0);
		},
		progress: ctx => ({ done: Math.min(TRADES_TO_MAKE, countChanges(ctx, 'weth', wethUnits(ctx))), total: TRADES_TO_MAKE }),
		done: ctx => countChanges(ctx, 'weth', wethUnits(ctx)) >= TRADES_TO_MAKE,
	},
	{
		id: 'quiz-hub-dark',
		chapter: 'Dispute',
		title: 'Hub One stops answering',
		body: 'Your payments hang. The hub does not sign anything. It still owes you a lot of violet. What do you do?',
		mode: 'quiz',
		options: [
			{ label: 'Dispute: take the last signed page to the blockchain', correct: true, why: 'Yes. You never needed the hub\'s permission. The chain enforces the newest page both of you signed.' },
			{ label: 'Email support and wait', why: 'You can, but you do not have to. xln gives you a button that works without anyone\'s help.' },
			{ label: 'Nothing can be done', why: 'Wrong, and this is the whole point of xln. Your money is protected by signatures you already hold.' },
		],
	},
	{
		id: 'dispute',
		chapter: 'Dispute',
		title: 'Do it: dispute Hub One',
		body: 'Open your account with Hub One, then Manage → Dispute → "Dispute this account", and confirm. It freezes the account, pulls your open orders and gets your latest signed page ready for the blockchain. This is a playground, so go ahead.',
		more: 'prepareDispute freezes the account, withdraws your orders from the hub\'s book and drafts a disputeStart with the newest co-signed proof into your on-chain batch.',
		target: ctx => {
			if (!at(ctx, hubPath(ctx))) return viaHub(ctx, '');
			if (ctx.dom.has('dispute-prepare-confirm')) return 'dispute-prepare-confirm';
			if (ctx.dom.has('dispute-prepare')) return 'dispute-prepare';
			if (ctx.dom.has('manage-tab-dispute')) return 'manage-tab-dispute';
			return 'account-manage';
		},
		hint: ctx => {
			if (!at(ctx, hubPath(ctx))) return homeHint(ctx, 'Open the Hub One account.');
			if (ctx.dom.has('dispute-prepare-confirm')) return 'Confirm.';
			if (ctx.dom.has('dispute-prepare')) return 'Press "Dispute this account".';
			if (ctx.dom.has('manage-tab-dispute')) return 'Open the Dispute tab.';
			return 'Open Manage.';
		},
		mode: 'do',
		done: ctx => (hub(ctx)?.dispute ?? 'none') !== 'none',
	},
	{
		id: 'dispute-batch',
		chapter: 'Dispute',
		title: 'Send it to the blockchain',
		body: 'Your dispute is packed and waiting for your signature on Home. Sign and send. From here the blockchain runs the clock: the hub gets a window to show a newer signed page, and whoever holds the newest one wins.',
		more: 'j_broadcast signs the batch and submits it to the Depository, which emits DisputeStarted. Response windows come from the signed account config: one hour for a hub, a day for a person.',
		target: ctx => viaHome(ctx, 'batch-broadcast'),
		hint: ctx => homeHint(ctx, 'Sign & send the batch.'),
		mode: 'do',
		done: ctx => ['sent', 'active'].includes(hub(ctx)?.dispute ?? 'none'),
	},
	{
		id: 'watchtower',
		chapter: 'Dispute',
		title: 'What if you are the one offline?',
		body: 'The other side can dispute too, with an old page that favours them, hoping you are asleep. You get a window to answer with the newer page. A tower is a service you pick that keeps an encrypted copy of your latest pages and, as a last resort, answers for you while you are away. It cannot read your balances. You can also run your own.',
		more: 'Two tower services: blind encrypted backup (the tower sees only a lookup key, sizes and hashes) and last-resort dispute protection with remedies that decrypt only after the response window opens. Response windows are part of the signed account config; a watch seed derived from the account identity lets the tower recognise DisputeStarted events without learning anything else.',
		target: ctx => viaHub(ctx, 'account-dispute-state'),
		mode: 'read',
	},
	{
		id: 'dispute-read',
		chapter: 'Dispute',
		title: 'What you would see next',
		body: 'On a live network the account now shows a countdown and, when it ends, a Finalize button that pays out exactly what the last signed page says. This playground\'s chain confirms the dispute, but the wallet here does not yet pick that confirmation up, so the story stops at "sent". We show what we know, never more.',
		more: 'Known gap, logged for the core team as finding #12: the embedded runtime finalizes the block with DisputeStarted but never applies it to the account\'s activeDispute.',
		target: ctx => viaHub(ctx, 'account-dispute-state'),
		mode: 'read',
	},
	{
		id: 'evidence',
		chapter: 'Sovereignty',
		title: 'Take your proof with you',
		body: 'Open the shield and press "Save evidence bundle". This file holds the signed pages for every account. Keep it somewhere that is not this device. With it, any xln wallet can defend your money, even if this one is gone.',
		more: 'Frame hashes, both frame signatures and both dispute-proof signatures with their nonces, per account. Enough to open a dispute from another runtime.',
		target: ctx => (at(ctx, '/sovereignty') ? 'evidence-export' : viaHome(ctx, 'home-sovereignty')),
		mode: 'read',
	},
	{
		id: 'finish',
		chapter: 'Done',
		title: "That's xln",
		body: 'You got paid on credit, paid a shop, billed it back, turned promises into guarantees from both sides, traded three times and used the dispute that protects all of it. Replay any chapter from Settings, reset the playground, or create a real wallet. Cross-network trades, shared boards and lending are the advanced tour.',
		target: ctx => viaHome(ctx, 'home-total'),
		mode: 'read',
	},
];
