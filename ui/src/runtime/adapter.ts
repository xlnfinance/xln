import type {
	RuntimeAdapter,
	RuntimeAdapterConfig,
	RuntimeAdapterPaymentRoutesResponse,
	RuntimeAdapterReadQuery,
} from '@xln/runtime/api/runtime-adapter/types';
import type { RuntimeReplica } from '@xln/runtime/api/public/runtime-module';
import { getXLN } from './xln-loader';
import { useApp } from './store';

let currentAdapter: RuntimeAdapter | null = null;
let currentEnv: RuntimeReplica | null = null;
let detach: (() => void) | null = null;

export function getAdapter(): RuntimeAdapter | null {
	return currentAdapter;
}

/** Live env of the embedded runtime; null in remote mode. */
export function getEmbeddedEnv(): RuntimeReplica | null {
	return currentEnv;
}

function attach(adapter: RuntimeAdapter): void {
	const push = (): void => {
		useApp.getState().setAdapterState({
			status: adapter.status,
			height: adapter.currentHeight,
			commandReady: adapter.commandReady,
		});
	};
	const offChange = adapter.onChange(() => push());
	const offStatus = adapter.onStatus(() => push());
	detach = () => {
		offChange();
		offStatus();
	};
	push();
}

export function disconnectAdapter(): void {
	detach?.();
	detach = null;
	currentAdapter?.disconnect();
	currentAdapter = null;
	currentEnv = null;
	useApp.getState().setAdapterState({ status: 'disconnected', height: 0, commandReady: false });
}

export async function connectEmbedded(seed: string): Promise<RuntimeAdapter> {
	const xln = await getXLN();
	disconnectAdapter();

	let env: RuntimeReplica | null = null;
	const adapter = new xln.EmbeddedRuntimeAdapter({
		getEnv: () => env,
		main: async (runtimeSeed?: string | null) => {
			env = await xln.main(runtimeSeed ?? seed);
			currentEnv = env;
			return env;
		},
		enqueueRuntimeInput: (target, input) => xln.enqueueRuntimeInput(target, input),
		validateRuntimeInputAdmission: (target, input) => xln.validateRuntimeInputAdmission(target, input),
		submitCrossJurisdictionIntent: async (target, route) => {
			await xln.submitCrossJurisdictionIntent(target, route);
			return { delivered: true as const };
		},
		controlRuntime: async (target, action) => {
			if (action !== 'verify-chain') throw new Error(`UNSUPPORTED_RUNTIME_CONTROL:${String(action)}`);
			return xln.verifyLiveRuntimeStorage(target);
		},
		registerRuntimePublishedCallback: (target, cb) => xln.registerRuntimePublishedCallback(target, cb),
		buildReadContext: target => ({
			readHead: () => xln.readPersistedStorageHead(target),
			readFrame: (height: number) => xln.readPersistedStorageFrameRecord(target, height),
			listCheckpoints: () => xln.listPersistedCheckpointHeights(target),
			loadEntityState: (entityId: string, height: number) => xln.loadEntityStateFromStorageDb(target, entityId, height),
			loadEntityAccountDoc: (entityId: string, counterpartyId: string, height: number) =>
				xln.loadEntityAccountDocFromStorageDb(target, entityId, counterpartyId, height),
			loadEntityViewPage: (entityId: string, height: number, query: unknown) =>
				xln.loadEntityViewPageFromStorageDb(target, entityId, height, query as never),
			listEntityIdsAtHeight: (height: number) => xln.listPersistedEntityIdsAtHeight(target, height),
			readActivityPage: (opts: unknown) => xln.readPersistedRuntimeActivityPage(target, opts as never),
			findPaymentRoutes: (query?: RuntimeAdapterReadQuery) => findEmbeddedPaymentRoutes(target, query),
		}),
	});

	// Mirrors the server rpc-ws findPaymentRoutes so read('payment-routes')
	// behaves identically in embedded and remote mode.
	const findEmbeddedPaymentRoutes = async (
		target: RuntimeReplica,
		query: RuntimeAdapterReadQuery = {},
	): Promise<RuntimeAdapterPaymentRoutesResponse> => {
		const sourceEntityId = String(query.sourceEntityId || '').trim().toLowerCase();
		const targetEntityId = String(query.targetEntityId || '').trim().toLowerCase();
		if (!/^0x[0-9a-f]{64}$/.test(sourceEntityId) || !/^0x[0-9a-f]{64}$/.test(targetEntityId)) {
			throw new Error('payment route endpoints must be 32-byte entity ids');
		}
		const tokenId = Number(query.tokenId);
		const amount = BigInt(String(query.amount || '0'));
		if (!Number.isSafeInteger(tokenId) || tokenId <= 0 || amount <= 0n) {
			throw new Error('payment route query requires positive tokenId and amount');
		}
		await xln.ensureGossipProfiles(target, [sourceEntityId, targetEntityId]);
		const graph = target.gossip?.getNetworkGraph?.();
		const routes = (await graph?.findPaths?.(sourceEntityId, targetEntityId, amount, tokenId)) ?? [];
		if (routes.length === 0) {
			throw new Error(`no payment route from ${sourceEntityId} to ${targetEntityId}`);
		}
		return {
			routes: routes.map(route => ({
				path: route.path,
				hops: route.hops.map(hop => ({
					from: hop.from,
					to: hop.to,
					fee: hop.fee.toString(),
					feePPM: hop.feePPM,
				})),
				totalFee: route.totalFee.toString(),
				senderAmount: route.totalAmount.toString(),
				recipientAmount: amount.toString(),
				probability: route.probability,
			})),
		};
	};

	await adapter.connect({ mode: 'embedded', seed });
	currentAdapter = adapter;
	attach(adapter);
	return adapter;
}

export async function connectRemote(wsUrl: string, authKey?: string): Promise<RuntimeAdapter> {
	const xln = await getXLN();
	disconnectAdapter();

	const adapter = new xln.RemoteRuntimeAdapter();
	const config: RuntimeAdapterConfig = {
		mode: 'remote',
		wsUrl,
		...(authKey ? { authKey } : {}),
	};
	await adapter.connect(config);
	currentAdapter = adapter;
	attach(adapter);
	return adapter;
}

export function requireAdapter(): RuntimeAdapter {
	if (!currentAdapter) throw new Error('Runtime is not connected');
	return currentAdapter;
}
