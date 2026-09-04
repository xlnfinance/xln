import type { EntityTx, RuntimeReplica } from '@xln/core/api/public/runtime-module';
import { getXLN, peekXLN } from './xln-loader';
import { connectEmbedded, disconnectAdapter, getEmbeddedEnv, requireAdapter } from './adapter';
import { deriveAddress, derivePrivateKeyBytes } from './keys';
import { DEFAULT_ACCOUNT_DISPUTE_CONFIG, waitFor } from './tx';
import { jurisdictionRef, planSwap, submitSwapPlan } from './financial/swap';
import { quotePaymentRoutes, submitPayment } from './financial/payments';
import type { AccountState, RuntimeAdapterViewFrame } from '@xln/core/api/public/runtime-module';
import { useApp, type VaultKind } from './store';

/** Anvil's well-known dev mnemonic — sandbox only, never a real vault. */
export const SANDBOX_SEED = 'test test test test test test test test test test test junk';
export const SANDBOX_VAULT_ID = 'sandbox';
const DEMO_J = 'sandbox';
const USDC = 1;
const WETH = 2;
const weth = (value: number): bigint => BigInt(Math.round(value * 1_000_000)) * 10n ** 12n;

export type DemoActor = {
	label: string;
	signerId: string;
	entityId: string;
};

export type DemoTopology = {
	self: DemoActor;
	hub: DemoActor;
	merchant: DemoActor;
};

let topology: DemoTopology | null = null;

export function getDemoTopology(): DemoTopology | null {
	return topology;
}

let usdcScale = 10n ** 6n;

function usd(amount: number): bigint {
	return BigInt(amount) * usdcScale;
}

export function findReplicaState(env: RuntimeReplica, entityId: string) {
	for (const [key, replica] of env.state.eReplicas?.entries?.() ?? []) {
		const keyEntityId = String(key).split(':')[0] ?? '';
		if (keyEntityId.toLowerCase() === entityId.toLowerCase()) return replica;
	}
	return undefined;
}

export function accountReady(env: RuntimeReplica, entityId: string, counterpartyId: string): boolean {
	const replica = findReplicaState(env, entityId);
	return Boolean(replica?.state?.accounts?.get?.(counterpartyId));
}

function creditApplied(env: RuntimeReplica, entityId: string, counterpartyId: string, minTotal: bigint, tokenId: number = USDC): boolean {
	const replica = findReplicaState(env, entityId);
	const account = replica?.state?.accounts?.get?.(counterpartyId);
	const delta = account?.state?.deltas?.get?.(tokenId);
	const xln = peekXLN();
	if (!delta || !replica || !xln) return false;
	const isLeft = xln.isLeftEntity(entityId, counterpartyId);
	const derived = xln.deriveDelta(delta, isLeft);
	return derived.ownCreditLimit + derived.peerCreditLimit >= minTotal;
}

export async function sendEntity(entityId: string, signerId: string, entityTxs: EntityTx[]): Promise<void> {
	await requireAdapter().send({ runtimeTxs: [], entityInputs: [{ entityId, signerId, entityTxs }] });
}

/** Resting offers on the hub's accounts for one pair, counted from the hub's own replica. */
function restingOffers(env: RuntimeReplica, hubEntityId: string, tokenA: number, tokenB: number): number {
	const replica = findReplicaState(env, hubEntityId);
	let count = 0;
	for (const account of replica?.state?.accounts?.values?.() ?? []) {
		for (const offer of account?.state?.swapOffers?.values?.() ?? []) {
			const pair = [offer.giveTokenId, offer.wantTokenId];
			if (pair.includes(tokenA) && pair.includes(tokenB)) count += 1;
		}
	}
	return count;
}

type MerchantOrder = { give: number; giveAmount: bigint; want: number; wantAmount: bigint };

/** A small two-sided WETH/USDC market around 2,500, made by the merchant. */
const MERCHANT_ORDERS: MerchantOrder[] = [
	{ give: WETH, giveAmount: weth(0.5), want: USDC, wantAmount: usd(1_255) },
	{ give: WETH, giveAmount: weth(0.5), want: USDC, wantAmount: usd(1_260) },
	{ give: WETH, giveAmount: weth(1), want: USDC, wantAmount: usd(2_540) },
	{ give: USDC, giveAmount: usd(1_245), want: WETH, wantAmount: weth(0.5) },
	{ give: USDC, giveAmount: usd(1_240), want: WETH, wantAmount: weth(0.5) },
	{ give: USDC, giveAmount: usd(2_460), want: WETH, wantAmount: weth(1) },
];

async function placeMerchantOrders(
	adapter: ReturnType<typeof requireAdapter>,
	env: RuntimeReplica,
	merchant: DemoActor,
	hub: DemoActor,
): Promise<void> {
	if (restingOffers(env, hub.entityId, WETH, USDC) >= MERCHANT_ORDERS.length) return;
	const xln = await getXLN();
	for (const order of MERCHANT_ORDERS) {
		const before = restingOffers(env, hub.entityId, WETH, USDC);
		const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: merchant.entityId, accountsLimit: 50, booksLimit: 10 });
		const account =
			(frame.activeEntity?.accounts.items.find(doc => {
				const left = String(doc.state.leftEntity || '').toLowerCase();
				const right = String(doc.state.rightEntity || '').toLowerCase();
				return (left === merchant.entityId ? right : left) === hub.entityId;
			})?.state as AccountState | undefined) ?? null;
		const prepared = xln.prepareSwapOrder(order.give, order.want, order.giveAmount, order.wantAmount);
		if (!prepared) throw new Error('DEMO_SWAP_ORDER_UNPREPARABLE');
		const giveMeta = xln.getTokenInfo(order.give);
		const wantMeta = xln.getTokenInfo(order.want);
		const plan = await planSwap({
			mode: 'same',
			frame,
			source: { entityId: merchant.entityId, signerId: merchant.signerId, hubEntityId: hub.entityId, jurisdiction: jurisdictionRef(frame), account },
			giveTokenId: order.give,
			giveTokenDecimals: giveMeta.decimals,
			wantTokenId: order.want,
			wantTokenDecimals: wantMeta.decimals,
			giveAmount: prepared.effectiveGive,
			priceTicks: prepared.priceTicks,
			expectedWantAmount: prepared.effectiveWant,
			routeValue: `same:${hub.entityId}`,
		});
		await submitSwapPlan(plan);
		await waitFor(() => restingOffers(env, hub.entityId, WETH, USDC) > before, 'demo resting order', 45_000);
	}
}

export type VaultRuntimeOptions = {
	vaultId: string;
	vaultName: string;
	kind: VaultKind;
	selfLabel: string;
	onStep?: (step: string) => void;
};

/**
 * Boot an embedded runtime and prewire a self–hub–merchant demo network.
 *
 * One code path for the instant sandbox and for personal BrainVault runtimes:
 * signer 0 is the user, signers 1–2 back the local demo hub and merchant so
 * routed payments work without any external infrastructure. Idempotent on a
 * restored runtime. All effects go through the same RuntimeAdapter command
 * lane the rest of the UI uses.
 */
const FUNDED_KEY = 'xln-ui-sandbox-funded';
const fundedKey = (runtimeId: string): string => `${FUNDED_KEY}:${String(runtimeId || '').toLowerCase()}`;
const sandboxFunded = (runtimeId: string): boolean => {
	try {
		return localStorage.getItem(fundedKey(runtimeId)) === '1';
	} catch {
		return false;
	}
};
const markSandboxFunded = (runtimeId: string): void => {
	try {
		localStorage.setItem(fundedKey(runtimeId), '1');
	} catch {
		// Without storage the next entry re-checks balances and only tops up what is missing.
	}
};
const forgetSandboxFunded = (runtimeId: string): void => {
	try {
		localStorage.removeItem(fundedKey(runtimeId));
	} catch {
		// Nothing stored, nothing to forget.
	}
};

export async function bootEmbeddedDemo(seed: string, options: VaultRuntimeOptions): Promise<DemoTopology> {
	useApp.getState().setBooting(true);
	try {
		return await bootEmbeddedDemoInner(seed, options);
	} catch (error) {
		// A halted mid-seed sandbox is not worth preserving: wipe it so the
		// next attempt starts deterministic instead of replaying a wedged WAL.
		if (options.kind === 'sandbox') {
			try {
				const xln = await getXLN();
				const env = getEmbeddedEnv();
				// Stop the live loop before wiping its storage, otherwise the next
				// frame append fails against an empty head and halts the runtime.
				disconnectAdapter();
				if (env) {
					forgetSandboxFunded(String(env.runtimeId || ''));
					await xln.clearDB(env);
				}
			} catch {
				// Reset is best-effort; surface the original failure.
			}
		}
		throw error;
	} finally {
		useApp.getState().setBooting(false);
	}
}

async function bootEmbeddedDemoInner(seed: string, options: VaultRuntimeOptions): Promise<DemoTopology> {
	const step = (text: string): void => {
		options.onStep?.(text);
	};

	step('Starting local runtime');
	const xln = await getXLN();
	usdcScale = 10n ** BigInt(xln.getTokenInfo(USDC).decimals);
	await connectEmbedded(seed);
	const env = getEmbeddedEnv();
	if (!env) throw new Error('EMBEDDED_ENV_MISSING');

	const labels = [options.selfLabel, 'Hub One', 'Meridian Desk'] as const;
	const actors = labels.map((label, index) => {
		const signerId = deriveAddress(seed, index);
		xln.registerSignerKey(env, signerId, derivePrivateKeyBytes(seed, index));
		return {
			label,
			signerId,
			entityId: String(xln.generateLazyEntityId([signerId], 1n)).toLowerCase(),
		};
	});
	const [self, hub, merchant] = actors as [DemoActor, DemoActor, DemoActor];
	topology = { self, hub, merchant };

	const adapter = requireAdapter();

	step('Preparing jurisdiction');
	const hasJurisdiction = (): boolean => {
		const jReplica = env.state.jReplicas?.get?.(DEMO_J);
		return Boolean(jReplica?.contracts?.depository);
	};
	if (!hasJurisdiction()) {
		await adapter.send({
			runtimeTxs: [
				{
					type: 'importJ',
					data: {
						name: DEMO_J,
						chainId: 31337,
						ticker: 'USDC',
						rpcs: [],
						blockTimeMs: 10_000,
					},
				},
			],
			entityInputs: [],
		});
		await waitFor(hasJurisdiction, 'demo importJ', 45_000);
	}

	const jReplica = env.state.jReplicas?.get?.(DEMO_J);
	if (!jReplica) throw new Error('DEMO_JREPLICA_MISSING');
	const depositoryAddress = String(jReplica.contracts?.depository || '');
	const entityProviderAddress = String(jReplica.contracts?.entityProvider || '');
	if (!depositoryAddress || !entityProviderAddress) throw new Error('DEMO_J_CONTRACTS_MISSING');

	step('Creating entities');
	for (const actor of actors) {
		if (findReplicaState(env, actor.entityId)) continue;
		await adapter.send({
			runtimeTxs: [
				xln.importEntity({
					entityId: actor.entityId,
					signerId: actor.signerId,
					entitySeed: seed,
					data: {
						isProposer: true,
						profileName: actor.label,
						config: {
							mode: 'proposer-based',
							threshold: 1n,
							validators: [actor.signerId],
							shares: { [actor.signerId]: 1n },
							jurisdiction: {
								address: `jreplica://${DEMO_J}`,
								name: DEMO_J,
								chainId: Number(jReplica.chainId ?? 31337),
								blockTimeMs: Number(jReplica.blockTimeMs ?? 10_000),
								entityProviderAddress,
								depositoryAddress,
							},
						},
					},
				}),
			],
			entityInputs: [],
		});
		await waitFor(() => Boolean(findReplicaState(env, actor.entityId)), `demo importReplica ${actor.label}`);
	}

	step('Publishing profiles');
	for (const actor of actors) {
		const replica = findReplicaState(env, actor.entityId);
		if (String(replica?.state?.profile?.name || '') === actor.label) continue;
		await sendEntity(actor.entityId, actor.signerId, [
			{
				type: 'profile-update',
				data: {
					profile: { entityId: actor.entityId, name: actor.label, bio: '', website: '' },
				},
			},
		]);
	}

	step('Configuring hub');
	// The hub publishes its fee policy through the same setHubConfig every
	// production hub uses; that commits profile.isHub and the swap taker fee the
	// canonical swap planner requires. Idempotent on a restored runtime.
	const hubConfigured = (): boolean => findReplicaState(env, hub.entityId)?.state?.profile?.isHub === true;
	if (!hubConfigured()) {
		await sendEntity(hub.entityId, hub.signerId, [
			{
				type: 'setHubConfig',
				data: { hubName: hub.label, routingFeePPM: 1, swapTakerFeeBps: 1 },
			},
		]);
		await waitFor(hubConfigured, 'demo hub config', 45_000);
	}

	// The hub matches offers only once its orderbook extension exists; the same
	// initOrderbookExt the market scenario sends. All spread to the taker.
	const bookReady = (): boolean => Boolean(findReplicaState(env, hub.entityId)?.state?.orderbookExt);
	if (!bookReady()) {
		await sendEntity(hub.entityId, hub.signerId, [
			{
				type: 'initOrderbookExt',
				data: {
					name: hub.label,
					spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
					referenceTokenId: USDC,
					usdQuoteAuthorityEntityId: hub.entityId,
					minTradeSize: 0n,
					supportedPairs: ['1/2', '1/3', '2/3'],
				},
			},
		]);
		await waitFor(bookReady, 'demo hub orderbook', 45_000);
	}

	step('Opening accounts');
	const spokes: Array<[DemoActor, DemoActor]> = [
		[self, hub],
		[merchant, hub],
	];
	for (const [spoke, target] of spokes) {
		if (accountReady(env, spoke.entityId, target.entityId) && accountReady(env, target.entityId, spoke.entityId)) {
			continue;
		}
		await sendEntity(spoke.entityId, spoke.signerId, [
			{
				type: 'openAccount',
				data: {
					targetEntityId: target.entityId,
					creditAmount: 0n,
					tokenId: USDC,
					disputeConfig: DEFAULT_ACCOUNT_DISPUTE_CONFIG,
				},
			},
		]);
		await waitFor(
			() => accountReady(env, spoke.entityId, target.entityId) && accountReady(env, target.entityId, spoke.entityId),
			`demo account ${spoke.label}↔${target.label}`,
			45_000,
		);
	}

	step('Setting rebalance policy');
	// The demo hub has no reserve to collateralize with, so a spoke's automatic
	// collateral request could never be filled and would only prepay fees. The
	// spokes therefore run the manual policy (soft limit equal to hard limit),
	// the same user-level setRebalancePolicy any wallet can send.
	const manualLimit = usd(1_000_000);
	const rebalanceIsManual = (entityId: string, counterpartyId: string): boolean => {
		const policy = findReplicaState(env, entityId)?.state?.accounts?.get?.(counterpartyId)?.shadow?.rebalance?.policy?.get?.(USDC);
		return Boolean(policy && policy.r2cRequestSoftLimit === policy.hardLimit);
	};
	for (const spoke of [self, merchant]) {
		if (rebalanceIsManual(spoke.entityId, hub.entityId)) continue;
		await sendEntity(spoke.entityId, spoke.signerId, [
			{
				type: 'setRebalancePolicy',
				data: {
					counterpartyEntityId: hub.entityId,
					tokenId: USDC,
					r2cRequestSoftLimit: manualLimit,
					hardLimit: manualLimit,
					maxAcceptableFee: usd(10),
				},
			},
		]);
		await waitFor(() => rebalanceIsManual(spoke.entityId, hub.entityId), `demo rebalance policy ${spoke.label}`, 45_000);
	}

	step('Extending credit lines');
	const creditLine = usd(50_000);
	const creditPairs: Array<[DemoActor, DemoActor]> = [
		[hub, self],
		[self, hub],
		[hub, merchant],
		[merchant, hub],
	];
	for (const [index, [creditor, debtor]] of creditPairs.entries()) {
		// Both directions on one account raise the combined limit; check the
		// running total so an idempotent re-run does not double-extend.
		const minTotal = creditLine * BigInt((index % 2) + 1);
		if (creditApplied(env, creditor.entityId, debtor.entityId, minTotal)) continue;
		await sendEntity(creditor.entityId, creditor.signerId, [
			{ type: 'extendCredit', data: { counterpartyEntityId: debtor.entityId, tokenId: USDC, amount: creditLine } },
		]);
		await waitFor(
			() => creditApplied(env, creditor.entityId, debtor.entityId, minTotal),
			`demo credit ${creditor.label}→${debtor.label}`,
			45_000,
		);
	}
	// A second lane so the book has something to trade: WETH credit both ways.
	const wethLine = weth(10);
	for (const [index, [creditor, debtor]] of creditPairs.entries()) {
		const minTotal = wethLine * BigInt((index % 2) + 1);
		if (creditApplied(env, creditor.entityId, debtor.entityId, minTotal, WETH)) continue;
		await sendEntity(creditor.entityId, creditor.signerId, [
			{ type: 'extendCredit', data: { counterpartyEntityId: debtor.entityId, tokenId: WETH, amount: wethLine } },
		]);
		await waitFor(
			() => creditApplied(env, creditor.entityId, debtor.entityId, minTotal, WETH),
			`demo WETH credit ${creditor.label}→${debtor.label}`,
			45_000,
		);
	}

	// Starting money is placed once per runtime database. Re-entering the sandbox
	// after the user spent some of it must not top the balances back up: the
	// restored runtime is the user's money, and the wallet has to show it as is.
	const runtimeId = String(env.runtimeId || '');
	if (!runtimeId) throw new Error('DEMO_RUNTIME_ID_MISSING');
	if (!sandboxFunded(runtimeId)) {
		step('Placing opening balances');
		// Hub pays the spokes their starting balances over the fresh credit lines.
		const openingBalances: Array<[DemoActor, bigint]> = [
			[self, usd(10_000)],
			[merchant, usd(5_000)],
		];
		for (const [recipient, amount] of openingBalances) {
			const received = (): bigint => {
				const replica = findReplicaState(env, recipient.entityId);
				const delta = replica?.state?.accounts?.get?.(hub.entityId)?.state?.deltas?.get?.(USDC);
				if (!delta) return 0n;
				const total = delta.ondelta + delta.offdelta;
				const isLeft = recipient.entityId.toLowerCase() < hub.entityId.toLowerCase();
				return isLeft ? total : -total;
			};
			if (received() >= amount) continue;
			await sendEntity(hub.entityId, hub.signerId, [
				{
					type: 'directPayment',
					data: {
						targetEntityId: recipient.entityId,
						tokenId: USDC,
						amount: amount - received(),
						route: [hub.entityId, recipient.entityId],
						deliveryMode: 'direct',
						description: 'Opening balance',
					},
				},
			]);
			await waitFor(() => received() >= amount, `demo opening balance ${recipient.label}`, 45_000);
		}

		step('Funding reserves');
		// A small Depository reserve for the user so the wallet shows all three
		// places money lives, and a hub reserve so Hub One can answer collateral
		// requests with a real reserve → collateral batch. Minted through the
		// jurisdiction like any testnet faucet.
		const reserveOf = (entityId: string): bigint => findReplicaState(env, entityId)?.state?.reserves?.get?.(USDC) ?? 0n;
		for (const [actor, target] of [[self, usd(1_500)], [hub, usd(200_000)]] as Array<[DemoActor, bigint]>) {
			if (reserveOf(actor.entityId) >= target) continue;
			await sendEntity(actor.entityId, actor.signerId, [{ type: 'mintReserves', data: { tokenId: USDC, amount: target - reserveOf(actor.entityId) } }]);
			await waitFor(() => reserveOf(actor.entityId) >= target, `demo reserve mint ${actor.label}`, 45_000);
		}
		step('Placing resting orders');
		// The merchant makes a small two-sided WETH/USDC market on the hub's book,
		// through the same planner the wallet uses. Without it the Swap page shows
		// an empty book and nothing to take.
		await placeMerchantOrders(adapter, env, merchant, hub);
		markSandboxFunded(runtimeId);
	}

	step('Shaping the signer wallet');
	// The BrowserVM bootstraps every funded signer with a trillion of each token,
	// which would make the on-chain tier swallow the whole money scale. A wallet
	// demo wants a plausible balance instead: 2,500 USDC and 1 WETH on-chain,
	// nothing else. The surplus goes to the hub's signer through the same ERC20
	// transfer an external send uses. Runs on every boot; a no-op once shaped.
	await shapeSignerWallet(env, seed, self, hub);

	step('Ready');
	const app = useApp.getState();
	app.setActiveEntityId(self.entityId);
	app.setActiveVault(options.vaultId);
	if (!app.vaults.some(v => v.id === options.vaultId)) {
		app.addVault({ id: options.vaultId, name: options.vaultName, kind: options.kind, createdAt: Date.now() });
	}
	app.unlockSeed(options.vaultId, seed);
	return topology;
}

const SIGNER_WALLET_TARGETS: Record<string, bigint> = { USDC: usd(2_500), WETH: weth(1) };

async function shapeSignerWallet(env: RuntimeReplica, seed: string, self: DemoActor, sink: DemoActor): Promise<void> {
	const jadapter = (await getXLN()).getEntityJAdapter(env, self.entityId, self.signerId);
	if (!jadapter?.fundSignerWallet) return;
	const registry = await jadapter.getTokenRegistry();
	if (registry.length === 0) return;
	const snapshot = await jadapter.readWalletSnapshot({ owner: self.signerId, tokenAddresses: registry.map(token => token.address) });
	const index = [0, 1, 2, 3, 4, 5, 6, 7].find(candidate => deriveAddress(seed, candidate).toLowerCase() === self.signerId.toLowerCase());
	if (index === undefined) throw new Error('SANDBOX_SIGNER_NOT_IN_SEED');
	const privateKey = derivePrivateKeyBytes(seed, index);
	for (const [position, token] of registry.entries()) {
		const target = SIGNER_WALLET_TARGETS[token.symbol.toUpperCase()] ?? 0n;
		const balance = snapshot.tokenBalances[position] ?? 0n;
		if (balance > target) await jadapter.transferErc20(privateKey, token.address, sink.signerId, balance - target);
		else if (balance < target) await jadapter.fundSignerWallet(self.signerId, target, token.symbol);
	}
}

/**
 * Off-chain faucet for demo runtimes: Hub One pays the recipient over the
 * bilateral credit line. Available whenever the local demo topology exists.
 */
export async function demoFaucet(recipientEntityId: string, amount: bigint): Promise<void> {
	const demo = topology;
	if (!demo) throw new Error('Faucet is available only on a local demo runtime');
	const recipient = recipientEntityId.trim().toLowerCase();
	if (recipient === demo.hub.entityId) throw new Error('The hub funds others, not itself');
	await sendEntity(demo.hub.entityId, demo.hub.signerId, [
		{
			type: 'directPayment',
			data: {
				targetEntityId: recipient,
				tokenId: USDC,
				amount,
				route: [demo.hub.entityId, recipient],
				deliveryMode: 'direct',
				description: 'Faucet top-up',
			},
		},
	]);
}

export async function connectSandbox(onStep?: (step: string) => void): Promise<DemoTopology> {
	return bootEmbeddedDemo(SANDBOX_SEED, {
		vaultId: SANDBOX_VAULT_ID,
		vaultName: 'Sandbox',
		kind: 'sandbox',
		selfLabel: 'Alice',
		...(onStep ? { onStep } : {}),
	});
}

/**
 * The shop pays an invoice: Meridian Desk sends the user `amount` USDC through
 * Hub One over the same planner and submit path the Pay screen uses. Lets the
 * tour show a real inbound payment without a second human.
 */
export async function demoMerchantPays(recipientEntityId: string, amount: bigint, description: string): Promise<void> {
	const demo = topology;
	if (!demo) throw new Error('The shop exists only on a local demo runtime');
	const recipient = recipientEntityId.trim().toLowerCase();
	const routes = await quotePaymentRoutes({ sourceEntityId: demo.merchant.entityId, targetEntityId: recipient, tokenId: USDC, amount });
	const route = routes[0];
	if (!route) throw new Error('The shop has no route to you right now');
	await submitPayment({ entityId: demo.merchant.entityId, signerId: demo.merchant.signerId, targetEntityId: recipient, tokenId: USDC, deliveryMode: 'instant', description, route });
}
