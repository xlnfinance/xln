import { adoptActiveTabLock, initializeActiveTabLock } from '../../../frontend/src/lib/utils/control/activeTabLock';
import { closeRuntimeSession } from '../../../frontend/src/lib/security/runtimeSession';
import type {
	RuntimeAdapter,
	RuntimeAdapterConfig,
	RuntimeAdapterReadQuery,
} from '@xln/core/api/runtime-adapter/types';
import type { RuntimeReplica } from '@xln/core/api/public/runtime-module';
import { getXLN } from './xln-loader';
import { useApp } from './store';
import { restoreFreshRuntime, type RuntimeRecoveryCandidate } from './restore';
import { runtimeIdForSeed } from './keys';

/**
 * Liveness is a host-observed fact the runtime asks its transport for. Every
 * entity this runtime hosts is reachable without a socket, so the embedded host
 * reports them online the same way the hub orchestrator reports its directly
 * connected peers. When a relay connection starts later, the runtime composes
 * relay presence with this direct set; without one, hosted peers are all it knows.
 */
function installHostedLivenessObserver(env: RuntimeReplica): void {
	const infrastructure = env.infrastructure ?? (env.infrastructure = {});
	const hosted = (entityIds: readonly string[]): ReadonlySet<string> => {
		const local = new Set(Array.from(env.state.eReplicas.values(), replica => replica.entityId.toLowerCase()));
		return new Set(entityIds.map(entityId => entityId.toLowerCase()).filter(entityId => local.has(entityId)));
	};
	infrastructure.observeDirectOnlineEntityIds = hosted;
	if (!infrastructure.observeOnlineEntityIds) infrastructure.observeOnlineEntityIds = hosted;
}

let currentAdapter: RuntimeAdapter | null = null;
let currentEnv: RuntimeReplica | null = null;
let detach: (() => void) | null = null;
let closing: Promise<void> | null = null;
let releaseOwnership: (() => void) | null = null;

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

/** Stop accepted work before revoking the in-memory signing authority. */
export function lockEmbeddedRuntime(): Promise<void> {
  // Keep a failed close rejected until reload; adopting this lease again must
  // never bypass a Runtime that failed to quiesce.
  if (!closing) closing = closeAndLockRuntime().then(() => {
    closing = null;
  });
  return closing;
}

async function closeAndLockRuntime(): Promise<void> {
  const env = currentEnv;
  const seed = env?.runtimeSeed;
  disconnectAdapter();
  useApp.getState().lockAll();
  if (env) {
    const xln = await getXLN();
    try {
      await closeRuntimeSession(env, xln);
    } finally {
      if (seed) xln.clearSignerKeys(seed);
      env.runtimeSeed = undefined;
    }
  }
  // A failed drain retains the lease: a second Runtime must not sign against
  // the same namespace until all accepted work and database handles are closed.
  releaseOwnership?.();
  releaseOwnership = null;
}

export async function connectEmbedded(seed: string, recovery?: RuntimeRecoveryCandidate): Promise<RuntimeAdapter> {
	await closing;
	const xln = await getXLN();
	if (recovery && currentEnv) throw new Error('Close this wallet and reload before restoring on a clean device.');
	disconnectAdapter();

	let env: RuntimeReplica | null = null;
	const adapter = new xln.EmbeddedRuntimeAdapter({
		getEnv: () => env,
		main: async (runtimeSeed?: string | null) => {
			// Serialize local bootstrap/import across tabs before either opens storage.
			env = await navigator.locks.request(`xln-wallet-bootstrap:${runtimeIdForSeed(seed)}`, () =>
				recovery ? restoreFreshRuntime(xln, seed, recovery) : xln.main(runtimeSeed ?? seed),
			);
			installHostedLivenessObserver(env);
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
			readFrameReceipts: query =>
				xln.readRuntimeFrameReceipts(
					{
						latestHeight: () => xln.getPersistedLatestHeight(target),
						journals: (from, to) => xln.readPersistedRuntimeActivityJournals(target, from, to),
					},
					query,
				),
			readAccountSwapHistoryPage: (entityId, counterpartyId, options) =>
				xln.readPersistedAccountSwapHistoryPage(target, entityId, counterpartyId, options),
			readAccountFrameHistory: (entityId: string, counterpartyId: string, limit: number) =>
				xln.readPersistedAccountFrameHistory(target, entityId, counterpartyId, limit),
			findPaymentRoutes: (query?: RuntimeAdapterReadQuery) => xln.findPaymentRoutes(target, query),
		}),
	});

  // Password authentication precedes this call. Reuse the observer's canonical
  // origin-wide lease; its takeover callback drains the previous signer before
  // the new Runtime may open storage or connect to the relay.
  const bootstrapFinished = Promise.withResolvers<void>();
  const relinquish = async (): Promise<void> => {
    // main() owns an opening Runtime before currentEnv is available. A takeover
    // during that await must wait for its owner to be able to drain and close it.
    await bootstrapFinished.promise;
    await lockEmbeddedRuntime();
  };
  releaseOwnership = adoptActiveTabLock(relinquish) ?? (await initializeActiveTabLock(relinquish));
  try {
    await adapter.connect({ mode: 'embedded', seed });
  } catch (error) {
    try {
      await lockEmbeddedRuntime();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'WALLET_BOOT_AND_CLEANUP_FAILED');
    }
    xln.clearSignerKeys(seed);
    throw error;
  } finally {
    bootstrapFinished.resolve();
  }
	currentAdapter = adapter;
	attach(adapter);
	return adapter;
}

export async function connectRemote(wsUrl: string, authKey?: string): Promise<RuntimeAdapter> {
	await closing;
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

/** Dev-only: lets the browser console and E2E debugging read the live adapter. */
declare const __XLN_UI_DIAGNOSTICS__: boolean;
if (import.meta.env.DEV || __XLN_UI_DIAGNOSTICS__) {
	(window as typeof window & { __xln?: Record<string, unknown> }).__xln = {
		adapter: () => currentAdapter,
		env: () => currentEnv,
		xln: () => getXLN(),
		store: useApp,
	};
}

export function requireAdapter(): RuntimeAdapter {
	if (!currentAdapter) throw new Error('Runtime is not connected');
	return currentAdapter;
}
