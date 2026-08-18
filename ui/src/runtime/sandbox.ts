import type { EntityTx, RuntimeReplica } from '@xln/core/api/public/runtime-module';
import { getXLN, peekXLN } from './xln-loader';
import { connectEmbedded, getEmbeddedEnv, requireAdapter } from './adapter';
import { deriveAddress, derivePrivateKeyBytes } from './keys';
import { DEFAULT_ACCOUNT_DISPUTE_CONFIG, waitFor } from './tx';
import { useApp, type VaultKind } from './store';

/** Anvil's well-known dev mnemonic — sandbox only, never a real vault. */
export const SANDBOX_SEED = 'test test test test test test test test test test test junk';
export const SANDBOX_VAULT_ID = 'sandbox';
const DEMO_J = 'sandbox';
const USDC = 1;

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

function findReplicaState(env: RuntimeReplica, entityId: string) {
	for (const [key, replica] of env.state.eReplicas?.entries?.() ?? []) {
		const keyEntityId = String(key).split(':')[0] ?? '';
		if (keyEntityId.toLowerCase() === entityId.toLowerCase()) return replica;
	}
	return undefined;
}

function accountReady(env: RuntimeReplica, entityId: string, counterpartyId: string): boolean {
	const replica = findReplicaState(env, entityId);
	return Boolean(replica?.state?.accounts?.get?.(counterpartyId));
}

function creditApplied(env: RuntimeReplica, entityId: string, counterpartyId: string, minTotal: bigint): boolean {
	const replica = findReplicaState(env, entityId);
	const account = replica?.state?.accounts?.get?.(counterpartyId);
	const delta = account?.state?.deltas?.get?.(USDC);
	const xln = peekXLN();
	if (!delta || !replica || !xln) return false;
	const isLeft = xln.isLeftEntity(entityId, counterpartyId);
	const derived = xln.deriveDelta(delta, isLeft);
	return derived.ownCreditLimit + derived.peerCreditLimit >= minTotal;
}

async function sendEntity(entityId: string, signerId: string, entityTxs: EntityTx[]): Promise<void> {
	await requireAdapter().send({ runtimeTxs: [], entityInputs: [{ entityId, signerId, entityTxs }] });
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
				if (env) await xln.clearDB(env);
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

	// No mintReserves here: a mint's J event reproducibly halts the live loop
	// with J_PREFIX_LOCAL_PREFIX_MISMATCH on the receiving entity (runtime
	// prefix-consensus issue, reported upstream). The demo runs entirely on
	// bilateral credit lines, which payments do not need reserves for.

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

	step('Placing opening balances');
	// Hub pays the spokes their starting balances over the fresh credit lines —
	// an off-chain money source that works while on-chain minting is blocked
	// by the reported J-prefix runtime bug.
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
