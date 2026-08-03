import type { EntityTx, RuntimeReplica } from '@xln/runtime/api/public/runtime-module';
import { getXLN } from './xln-loader';
import { connectEmbedded, getEmbeddedEnv, requireAdapter } from './adapter';
import { deriveAddress, derivePrivateKeyBytes } from './keys';
import { waitFor } from './tx';
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

function usd(amount: number): bigint {
	return BigInt(amount) * 10n ** 18n;
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
	const delta = replica?.state?.accounts?.get?.(counterpartyId)?.state?.deltas?.get?.(USDC);
	if (!delta) return false;
	return delta.leftCreditLimit + delta.rightCreditLimit >= minTotal;
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
	const step = (text: string): void => {
		options.onStep?.(text);
	};

	step('Starting local runtime');
	const xln = await getXLN();
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
				{
					type: 'importReplica',
					entityId: actor.entityId,
					signerId: actor.signerId,
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
				},
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

	step('Funding reserves');
	const reserveTargets: Array<[DemoActor, bigint]> = [
		[self, usd(25_000)],
		[hub, usd(250_000)],
		[merchant, usd(10_000)],
	];
	for (const [actor, amount] of reserveTargets) {
		const replica = findReplicaState(env, actor.entityId);
		const current = replica?.state?.reserves?.get?.(USDC) ?? 0n;
		if (current >= amount) continue;
		await sendEntity(actor.entityId, actor.signerId, [
			{ type: 'mintReserves', data: { tokenId: USDC, amount: amount - current } },
		]);
	}
	await waitFor(
		() =>
			reserveTargets.every(([actor, amount]) => {
				const replica = findReplicaState(env, actor.entityId);
				return (replica?.state?.reserves?.get?.(USDC) ?? 0n) >= amount;
			}),
		'demo reserves',
		60_000,
	);

	step('Opening accounts');
	const spokes: Array<[DemoActor, DemoActor]> = [
		[self, hub],
		[merchant, hub],
	];
	for (const [spoke, target] of spokes) {
		if (accountReady(env, spoke.entityId, target.entityId)) continue;
		await sendEntity(spoke.entityId, spoke.signerId, [
			{ type: 'openAccount', data: { targetEntityId: target.entityId, creditAmount: 0n, tokenId: USDC } },
		]);
	}
	await waitFor(
		() =>
			spokes.every(
				([spoke, target]) =>
					accountReady(env, spoke.entityId, target.entityId) && accountReady(env, target.entityId, spoke.entityId),
			),
		'demo accounts',
		45_000,
	);

	step('Extending credit lines');
	const creditLine = usd(50_000);
	const creditPairs: Array<[DemoActor, DemoActor]> = [
		[hub, self],
		[self, hub],
		[hub, merchant],
		[merchant, hub],
	];
	for (const [creditor, debtor] of creditPairs) {
		if (creditApplied(env, creditor.entityId, debtor.entityId, creditLine * 2n)) continue;
		await sendEntity(creditor.entityId, creditor.signerId, [
			{ type: 'extendCredit', data: { counterpartyEntityId: debtor.entityId, tokenId: USDC, amount: creditLine } },
		]);
	}
	await waitFor(
		() =>
			creditApplied(env, self.entityId, hub.entityId, creditLine * 2n) &&
			creditApplied(env, merchant.entityId, hub.entityId, creditLine * 2n),
		'demo credit lines',
		45_000,
	);

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

export async function connectSandbox(onStep?: (step: string) => void): Promise<DemoTopology> {
	return bootEmbeddedDemo(SANDBOX_SEED, {
		vaultId: SANDBOX_VAULT_ID,
		vaultName: 'Sandbox',
		kind: 'sandbox',
		selfLabel: 'Alice',
		...(onStep ? { onStep } : {}),
	});
}
