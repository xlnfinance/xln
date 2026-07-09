import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

const collectFrontendSources = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectFrontendSources(path));
    } else if (/\.(ts|svelte)$/.test(path)) {
      files.push(path);
    }
  }
  return files;
};

test('runtime selector hot-swaps adapters instead of reloading the app', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');
  expect(source).toContain('switchAppRuntimeAdapter');
  expect(source).not.toContain('window.location.reload');
  expect(source).not.toContain('window.location.assign');
});

test('runtime controller is the single adapter lifecycle owner', () => {
  const controllerSource = readFileSync('frontend/src/lib/stores/runtimeControllerStore.ts', 'utf8');
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const runtimeDropdownSource = readFileSync('frontend/src/lib/components/Runtime/RuntimeDropdown.svelte', 'utf8');
  const runtimeStoreSource = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');
  const queryClientSource = readFileSync('frontend/src/lib/stores/runtimeQueryClient.ts', 'utf8');

  expect(controllerSource).toContain('new RemoteRuntimeAdapter');
  expect(controllerSource).toContain('export const connectRuntimeAdapter');
  expect(controllerSource).toContain('export const runtimeControllerHandle');
  expect(controllerSource).toContain('pendingRuntimeId: string');
  expect(controllerSource).toContain('export const setRuntimeControllerPendingRuntimeId');
  expect(controllerSource).toContain('runtimeId: id');
  expect(queryClientSource).toContain('const adapter = getRuntimeControllerAdapter();');
  expect(queryClientSource).toContain('const handle = get(runtimeControllerHandle)');
  expect(queryClientSource).toContain('runtimeId: handle.runtimeId');
  expect(queryClientSource).toContain('mode: handle.mode');
  expect(queryClientSource).toContain('permissions: handle.permissions');
  expect(controllerSource).toContain('activeAdapter = null');
  expect(controllerSource).toContain('runtimeControllerConfig.set(null)');
  expect(existsSync('frontend/src/lib/stores/runtimeAdapterStore.ts')).toBe(false);
  expect(xlnStoreSource).toContain('getRuntimeControllerAdapter');
  expect(xlnStoreSource).toContain('getRuntimeControllerConfig');
  expect(xlnStoreSource).toContain('runtimeAdapterSend(input)');
  expect(xlnStoreSource).not.toContain('remoteAdapter.send(input)');
  expect(xlnStoreSource).not.toContain('adapter.send(input)');
  expect(xlnStoreSource).not.toContain('activeRuntimeAdapterConfig');
  expect(xlnStoreSource).not.toContain('export const appRuntimeAdapterStatus');
  expect(xlnStoreSource).not.toContain('export const appRuntimeAdapterMode');
  expect(xlnStoreSource).not.toContain('export const appRuntimeAdapterEndpoint');
  expect(xlnStoreSource).not.toContain('appRuntimeAdapterStatus.set');
  expect(xlnStoreSource).not.toContain('appRuntimeAdapterMode.set');
  expect(xlnStoreSource).not.toContain('appRuntimeAdapterEndpoint.set');
  expect(controllerSource).not.toContain('runtimeAdapterAuthLevel');
  expect(runtimeDropdownSource).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore'");
  expect(runtimeDropdownSource).toContain('$runtimeControllerHandle.mode');
  expect(runtimeDropdownSource).toContain('$runtimeControllerHandle.status');
  expect(runtimeDropdownSource).toContain('$runtimeControllerHandle.endpoint');
  expect(runtimeDropdownSource).not.toContain('appRuntimeAdapterMode');
  expect(runtimeDropdownSource).not.toContain('appRuntimeAdapterStatus');
  expect(runtimeDropdownSource).not.toContain('appRuntimeAdapterEndpoint');
  expect(runtimeStoreSource).toContain('export const activeRuntimeId = derived');
  expect(runtimeStoreSource).toContain('[runtimeControllerHandle, runtimes]');
  expect(runtimeStoreSource).toContain('$handle.pendingRuntimeId');
  expect(runtimeStoreSource).toContain('if (pendingId && $runtimes.has(pendingId))');
  expect(runtimeStoreSource).toContain('setRuntimeControllerPendingRuntimeId(id)');
  expect(runtimeStoreSource).toContain("controllerId && controllerId !== 'embedded' && $runtimes.has(controllerId)");
  expect(runtimeStoreSource).toContain("controllerId !== 'embedded'");
  expect(runtimeStoreSource).toContain('$runtimes.has(controllerId)');
  expect(runtimeStoreSource).not.toContain('runtimeSelectionFallbackId');
  expect(runtimeStoreSource).not.toContain('export const activeRuntimeId = writable');
});

test('embedded adapter binds to selected runtime env before bootstrap commands', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');

  expect(source).toContain('targetEnv?: Env | null');
  expect(source).toContain("const boundRuntimeId = normalizeRuntimeConfigId(boundEnv?.runtimeId || '')");
  expect(source).toContain('const runtimeEnv = get(runtimes).get(boundRuntimeId)?.env');
  expect(source).toContain('runtimeOperations.setActiveRuntimeId(envRuntimeId)');
  expect(source).toContain('createEmbeddedRuntimeAdapter(xln, normalizedConfig.seed ?? null, env)');
  expect(source).not.toContain('createEmbeddedRuntimeAdapter(xln, normalizedConfig.seed ?? null),');
});

test('selected embedded runtime never falls back to a mismatched bootstrap env', () => {
  const storeSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const embeddedSource = readFileSync('frontend/src/lib/stores/embeddedRuntimeStore.ts', 'utf8');
  const derivedStart = embeddedSource.indexOf('export const xlnEnvironment = derived');
  const setEnvStart = embeddedSource.indexOf('export function setXlnEnvironment');
  const switchStart = storeSource.indexOf('export const switchAppRuntimeAdapter');
  const refreshStart = storeSource.indexOf('export const refreshCurrentRuntimeProjection', switchStart);

  expect(derivedStart).toBeGreaterThan(0);
  expect(setEnvStart).toBeGreaterThan(derivedStart);
  expect(switchStart).toBeGreaterThan(0);
  expect(refreshStart).toBeGreaterThan(switchStart);

  const derivedSource = embeddedSource.slice(derivedStart, setEnvStart);
  const setEnvSource = embeddedSource.slice(setEnvStart);
  const switchSource = storeSource.slice(switchStart, refreshStart);

  expect(storeSource).toContain("import { xlnEnvironment, setXlnEnvironment } from './embeddedRuntimeStore';");
  expect(storeSource).toContain("export { xlnEnvironment, setXlnEnvironment } from './embeddedRuntimeStore';");
  expect(storeSource).not.toContain('const bootstrapEnvironment = writable');
  expect(storeSource).not.toContain('export const xlnEnvironment = derived');
  expect(storeSource).not.toContain('export function setXlnEnvironment');
  expect(embeddedSource).toContain('const bootstrapEnvironment = writable<Env | null>(null);');
  expect(derivedSource).toContain('return runtimeEntry?.env ?? null;');
  expect(derivedSource).not.toContain('if (runtimeEntry) return runtimeEntry.env ?? null;');
  expect(setEnvSource).toContain('const canPublishActiveEnv = !selectedRuntimeId || (envRuntimeId !== \'\' && envRuntimeId === selectedRuntimeId);');
  expect(setEnvSource).toContain('Refusing to publish env ${envRuntimeId || \'<missing>\'} while runtime ${selectedRuntimeId} is selected');
  expect(switchSource).toContain('const currentRuntimeId = normalizeRuntimeConfigId(currentEnv?.runtimeId || \'\');');
  expect(switchSource).toContain('if (!selectedRuntimeId || currentRuntimeId === selectedRuntimeId)');
  expect(switchSource).toContain('env = await xln.main(selectedRuntime.seed);');
  expect(switchSource).toContain('EMBEDDED_RUNTIME_ENV_MISMATCH');
  expect(switchSource).not.toContain('if (!env) env = await xln.main(normalizedConfig.seed ?? null);');
});

test('remote time-machine history requires radapter batch reads', () => {
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const source = readFileSync('frontend/src/lib/stores/runtimeHistoryStore.ts', 'utf8');
  const querySource = readFileSync('frontend/src/lib/stores/runtimeQueryClient.ts', 'utf8');
  const scanStart = source.indexOf('export const scanRuntimeAdapterHistoryAtHeight');
  expect(scanStart).toBeGreaterThan(0);
  const scanSource = source.slice(scanStart);
  expect(source).toContain('runtimeQueryClient.readHistoryFrameBatch');
  expect(querySource).toContain("'history-frame-batch'");
  expect(xlnStoreSource).not.toContain('export const scanRuntimeAdapterHistoryAtHeight');
  expect(source).not.toContain('unsupported adapter path: history-frame-batch');
  expect(source).not.toContain('buildRemoteAdapterEnvSnapshot');
  expect(source).not.toContain('remoteViewFrameToEnv');
  expect(source).toContain('REMOTE_HISTORY_VIEW_PAGE_SIZE');
  expect(scanSource).toContain('runtimeViewHistoryScan.set({');
  expect(scanSource).toContain('error: message');
  expect(scanSource).toContain('snapshot: { height: scannedHeight }');
  expect(scanSource).not.toContain('setXlnEnvironment');
  expect(scanSource).not.toContain('history.set');
});

test('remote adapter resolver restores active auth from the remote runtime registry', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  expect(source).toContain('resolveStoredRemoteRuntimeAuthKey');
  expect(source).toContain("const storedAuthKey = readStoredAdapterValue('xln-runtime-adapter-key').trim()");
  expect(source).toContain("if (storedAccess === 'admin')");
  expect(source).toContain("resolveStoredRemoteRuntimeAuthKey(normalizedWsUrl, { requiredAccess: 'admin' })");
  expect(source).toContain("readRemoteRuntimeTokenAccess(storedAuthKey) !== 'admin'");
  expect(source).toContain('const authKey = restoredAuthKey || storedAuthKey;');
  expect(source).toContain("sessionStorage.setItem('xln-runtime-adapter-key', restoredAuthKey)");
});

test('direct remote runtime URL reuses saved capability before showing paste prompt', () => {
  const source = readFileSync('frontend/src/lib/utils/runtimeConnection.ts', 'utf8');
  const readStart = source.indexOf('export function readRemoteRuntimeRequestFromUrl');
  const payloadStart = source.indexOf('export function runtimeImportPayloadFromParams', readStart);
  expect(readStart).toBeGreaterThan(0);
  expect(payloadStart).toBeGreaterThan(readStart);
  const readSource = source.slice(readStart, payloadStart);

  expect(readSource).toContain('resolveStoredRemoteRuntimeAuthKey(wsUrl).trim()');
  expect(readSource).toContain('const requiresAuthPaste = !authKey');
  expect(readSource.indexOf('resolveStoredRemoteRuntimeAuthKey(wsUrl).trim()'))
    .toBeLessThan(readSource.indexOf('const requiresAuthPaste = !authKey'));
});

test('remote projection never materializes fake Env snapshots', () => {
  const storeSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  expect(existsSync('frontend/src/lib/utils/runtimeViewEnv.ts')).toBe(false);
  expect(storeSource).not.toContain("$lib/utils/runtimeViewEnv");
  expect(storeSource).not.toContain('runtimeViewFrameToEnv');
  expect(storeSource).not.toContain('buildRemoteAdapterEnvSnapshot');
  expect(storeSource).not.toContain('buildRemoteAdapterHistory');
  expect(storeSource).not.toContain('remoteEnvToSnapshot');
});

test('remote runtime bulk import validates with bounded parallelism', () => {
  const source = readFileSync('frontend/src/lib/utils/remoteRuntimeImportFlow.ts', 'utf8');
  const managerSource = readFileSync('frontend/src/lib/components/Runtime/RemoteRuntimeManager.svelte', 'utf8');
  expect(source).toContain('const REMOTE_RUNTIME_IMPORT_CONCURRENCY = 4');
  expect(source).toContain('export const validateRemoteRuntimeImportEntries = async');
  expect(source).toContain('Array.from({ length: workerCount }');
  expect(source).toContain('await Promise.allSettled(workers)');
  expect(source).toContain('const results = await validateRemoteRuntimeImportEntries(entries, {');
  expect(managerSource).toContain('importRemoteRuntimeEntries(entries');
  expect(source).not.toContain('for (const [index, entry] of entries.entries())');
});

test('remote runtime switch resets runtime-scoped view selection without dropping auth', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const runtimeViewSource = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');
  expect(source).toContain('shouldResetRuntimeAdapterViewSelection(previousConfig, normalizedConfig)');
  expect(source).toContain('resetRuntimeAdapterViewSelection');
  expect(source).toContain("import { clearRuntimeQueryCache, runtimeQueryClient, type RuntimeReceiptStatus } from './runtimeQueryClient'");
  expect(source).toContain('resetRuntimeView,');
  expect(source).toContain("const previousRuntimeId = normalizeRuntimeConfigId(previousConfig.runtimeId || '')");
  expect(source).toContain("const nextRuntimeId = normalizeRuntimeConfigId(nextConfig.runtimeId || '')");
  expect(source).toContain('if (previousRuntimeId || nextRuntimeId) return previousRuntimeId !== nextRuntimeId;');
  expect(source).toContain('clearRuntimeQueryCache();');
  expect(source).toContain('resetRuntimeView();');
  expect(source).toContain('resetRuntimeViewSelection();');
  expect(source).toContain('type RemoteProjectionRefreshInFlight =');
  expect(source).toContain('let remoteProjectionRefreshInFlight: RemoteProjectionRefreshInFlight | null = null');
  expect(source).toContain('const remoteProjectionRefreshKey =');
  expect(source).toContain('remoteProjectionRefreshInFlight = null;');
  expect(source).toContain('if (remoteProjectionRefreshInFlight?.key === refreshKey)');
  expect(source).not.toContain('remoteHistoryCache');
  expect(runtimeViewSource).toContain('export const runtimeViewActiveEntityId');
  expect(runtimeViewSource).toContain('export const runtimeViewPageInfo');
  expect(runtimeViewSource).toContain('export const runtimeViewHistoryScan');
  expect(runtimeViewSource).toContain('export const resetRuntimeView = (): void =>');
  expect(runtimeViewSource).toContain('export const resetRuntimeViewSelection');
  expect(runtimeViewSource).toContain('runtimeViewHistoryScan.set(emptyRuntimeViewHistoryScan())');
  expect(source).toContain("!sameWsEndpoint(previousConfig.wsUrl || '', nextConfig.wsUrl || '')");
  expect(source).not.toContain("sessionStorage.removeItem('xln-runtime-adapter-key')");
  expect(source).not.toContain("localStorage.removeItem('xln-runtime-adapter-ws')");
});

test('stale remote entity selection resets only on current view refresh', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  expect(source).toContain('const isStaleRemoteEntitySelectionError =');
  expect(source).toContain('if (!isStaleRemoteEntitySelectionError(error, requestedEntityId)) throw error;');
  expect(source).toContain('Remote active entity ${requestedEntityId} is not available in this runtime view; resetting to default entity.');
  expect(source).toContain('runtimeViewActiveEntityId.set');
  expect(source).toContain('frame = await refreshView(\'\');');
});

test('remote RuntimeInput command waits for observed receipt before projection refresh', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  expect(source).toContain('const waitForRemoteRuntimeProjectionAtHeight = async');
  expect(source).toContain('REMOTE_RUNTIME_PROJECTION_WAIT_TIMEOUT_MS');
  expect(source).toContain('REMOTE_RUNTIME_PROJECTION_TIMEOUT');
  expect(source).toContain('const observed = await waitForRemoteRuntimeReceiptObserved(accepted.receipt?.id ?? null);');
  expect(source).toContain('const projectedHeight = await waitForRemoteRuntimeProjectionAtHeight(observed?.observedHeight ?? accepted.height);');
  expect(source).toContain('progress.observed(Number(observed.observedHeight ?? projectedHeight));');
  expect(source.indexOf('const observed = await waitForRemoteRuntimeReceiptObserved(accepted.receipt?.id ?? null);'))
    .toBeLessThan(source.indexOf('const projectedHeight = await waitForRemoteRuntimeProjectionAtHeight(observed?.observedHeight ?? accepted.height);'));
  expect(source).not.toContain('waitForRemoteRuntimeCommit');
  expect(source).toContain('latestHeight = Math.max(');
  expect(source).toContain('get(runtimeView).height');
  expect(source).toContain("if (!receiptId) throw new Error('REMOTE_RUNTIME_RECEIPT_ID_MISSING');");
});

test('remote runtime refresh ignores unchanged ticks and debounces projection reads', () => {
  const remoteSource = readFileSync('runtime/radapter/remote.ts', 'utf8');
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const noteHeightStart = remoteSource.indexOf('private noteHeight(');
  const noteHeightEnd = remoteSource.indexOf('private async openSocket', noteHeightStart);
  expect(noteHeightStart).toBeGreaterThan(0);
  expect(noteHeightEnd).toBeGreaterThan(noteHeightStart);
  const noteHeightSource = remoteSource.slice(noteHeightStart, noteHeightEnd);
  expect(noteHeightSource).toContain('options.allowDecrease === true ? next === this.height : next <= this.height');
  expect(noteHeightSource).toContain('for (const cb of this.changeCbs) cb(this.height)');
  expect(remoteSource).not.toContain('notifyWhenUnchanged');

  const scheduleStart = xlnStoreSource.indexOf('const scheduleRuntimeProjectionRefresh = (): void => {');
  const scheduleEnd = xlnStoreSource.indexOf('const isCurrentRuntimeAdapterConfig', scheduleStart);
  expect(scheduleStart).toBeGreaterThan(0);
  expect(scheduleEnd).toBeGreaterThan(scheduleStart);
  const scheduleSource = xlnStoreSource.slice(scheduleStart, scheduleEnd);
  expect(scheduleSource).toContain('if (remoteProjectionRefreshTimer)');
  expect(scheduleSource).toContain('remoteProjectionRefreshQueued = true');
  expect(scheduleSource).toContain('}, 200)');
  expect(scheduleSource).toContain('if (shouldRunAgain) scheduleRuntimeProjectionRefresh();');
});

test('frontend remote runtime operations use short fail-fast budgets', () => {
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const runtimeConnectionSource = readFileSync('frontend/src/lib/utils/runtimeConnection.ts', 'utf8');
  const importValidationSource = readFileSync('frontend/src/lib/utils/remoteRuntimeValidation.ts', 'utf8');

  expect(xlnStoreSource).toContain('const FRONTEND_REMOTE_REQUEST_TIMEOUT_MS = 5_000');
  expect(xlnStoreSource).toContain('const FRONTEND_REMOTE_RECONNECT_MAX_MS = 2_000');
  expect(xlnStoreSource).toContain('const OPEN_ACCOUNT_PROFILE_WAIT_TIMEOUT_MS = 1_200');
  expect(xlnStoreSource).toContain('const REMOTE_RUNTIME_PROJECTION_WAIT_TIMEOUT_MS = 5_000');
  expect(xlnStoreSource).toContain('requestTimeoutMs: config.requestTimeoutMs ?? FRONTEND_REMOTE_REQUEST_TIMEOUT_MS');
  expect(xlnStoreSource).toContain('reconnectMaxMs: config.reconnectMaxMs ?? FRONTEND_REMOTE_RECONNECT_MAX_MS');
  expect(xlnStoreSource).toContain('waitForOpenAccountCounterpartyProfiles(runtimeEnv, input.entityInputs, OPEN_ACCOUNT_PROFILE_WAIT_TIMEOUT_MS)');
  expect(xlnStoreSource).not.toContain('waitForOpenAccountCounterpartyProfiles(runtimeEnv, input.entityInputs, 5_000)');

  expect(runtimeConnectionSource).toContain('const PROJECTION_RUNTIME_CONNECT_TIMEOUT_MS = 6_000');
  expect(runtimeConnectionSource).toContain('const PROJECTION_RUNTIME_REQUEST_TIMEOUT_MS = 5_000');
  expect(runtimeConnectionSource).toContain('const PROJECTION_RUNTIME_RECONNECT_MAX_MS = 2_000');
  expect(importValidationSource).toContain('requestTimeoutMs: 5_000');
});

test('remote RuntimeView refresh stays projection-native without fake Env timestamps', () => {
  const storeSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const refreshStart = storeSource.indexOf('const refreshRemoteRuntimeProjection = async');
  const refreshEnd = storeSource.indexOf('const createEmbeddedRuntimeAdapter', refreshStart);
  expect(refreshStart).toBeGreaterThan(0);
  expect(refreshEnd).toBeGreaterThan(refreshStart);
  const refreshSource = storeSource.slice(refreshStart, refreshEnd);

  expect(existsSync('frontend/src/lib/utils/runtimeViewEnv.ts')).toBe(false);
  expect(storeSource).not.toContain('buildRemoteAdapterPlaceholderEnv');
  expect(storeSource).not.toContain('xln.createEmptyEnv(config.seed');
  expect(storeSource).not.toContain("throw new Error('REMOTE_RUNTIME_INITIAL_VIEW_MISSING')");
  expect(storeSource).toContain('const refreshRemoteRuntimeProjection = async');
  expect(refreshSource).toContain('const view = await refreshRuntimeView');
  expect(refreshSource).toContain('runtimeViewPageInfo.set(historyFrame.pageInfo)');
  expect(refreshSource).not.toContain('Date.now()');
  expect(refreshSource).not.toContain('createEmptyEnv');
});

test('localhost debug env surfaces expose RuntimeView with matching live runtime infrastructure', () => {
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const embeddedStoreSource = readFileSync('frontend/src/lib/stores/embeddedRuntimeStore.ts', 'utf8');
  const runtimeLoaderSource = readFileSync('frontend/src/lib/stores/xlnRuntimeLoader.ts', 'utf8');
  const debugSurfaceSource = readFileSync('frontend/src/lib/utils/debugSurface.ts', 'utf8');
  const viewSource = readFileSync('frontend/src/lib/view/View.svelte', 'utf8');
  const appTypes = readFileSync('frontend/src/app.d.ts', 'utf8');

  expect(xlnStoreSource).toContain("import { xlnEnvironment, setXlnEnvironment } from './embeddedRuntimeStore';");
  expect(xlnStoreSource).not.toContain("registerDebugSurface('env', () => localDebugEnv, { legacyName: '__xln_env' });");
  expect(embeddedStoreSource).toContain('const viewEnv = createRuntimeViewEnv(runtimeEnv);');
  expect(embeddedStoreSource).toContain("registerDebugSurface('env', () => localDebugEnv);");
  expect(embeddedStoreSource).toContain('localDebugEnv = createDetachedRuntimeViewEnv(runtimeEnv);');
  expect(xlnStoreSource).not.toContain('window.__xln_env =');
  expect(runtimeLoaderSource).toContain("registerDebugSurface('instance', () => XLN);");
  expect(runtimeLoaderSource).not.toContain('window.__xln_instance =');
  expect(debugSurfaceSource).not.toContain('legacyName');
  expect(appTypes).not.toContain('__xln_env');
  expect(appTypes).not.toContain('__xln_instance');
  expect(appTypes).not.toContain('__xlnRuntimeAdapter');
  expect(viewSource).toContain("import { getEnv, getXLN, history as runtimeHistory, xlnEnvironment, xlnInstance } from '$lib/stores/xlnStore'");
  expect(viewSource).toContain('unsubRuntimeEnv = xlnEnvironment.subscribe');
  expect(viewSource).not.toContain("import { runtimeViewFrameToEnv } from '$lib/utils/runtimeViewEnv';");
  expect(viewSource).not.toContain('runtimeViewFrameToEnv(');

  const publishStart = viewSource.indexOf('const publishLocalEnv =');
  const publishEnd = viewSource.indexOf('const forceLiveCursor =', publishStart);
  expect(publishStart).toBeGreaterThan(0);
  expect(publishEnd).toBeGreaterThan(publishStart);
  const publishSource = viewSource.slice(publishStart, publishEnd);
  expect(publishSource).toContain('const viewEnv = runtimeEnv ? createRuntimeViewEnv(runtimeEnv) : null;');
  expect(publishSource).toContain('localEnvStore.set(viewEnv);');
  expect(publishSource).toContain('buildCommandPaletteView(viewEnv)');
  expect(publishSource).toContain('buildCommandPaletteViewFromRuntimeView(get(runtimeView).frame)');
  expect(publishSource).not.toContain('buildCommandPaletteView(runtimeEnv)');
  expect(publishSource).toContain('const activeEnv = getEnv();');
  expect(publishSource).toContain('const liveRuntimeEnv = activeEnv ? (unwrapLiveRuntimeEnv(activeEnv) ?? activeEnv) : null;');
  expect(publishSource).toContain('const selectedRuntimeId = normalizeRuntimeId(get(activeRuntimeId));');
  expect(publishSource).toContain('const liveRuntimeMatchesSelection = Boolean(!selectedRuntimeId || (liveRuntimeId && liveRuntimeId === selectedRuntimeId));');
  expect(publishSource).toContain('if (runtimeEnv && !runtimeEnvMatchesActiveSelection(runtimeEnv))');
  expect(publishSource).toContain('liveRuntimeEnv?.runtimeState?.p2p');
  expect(publishSource).toContain('liveRuntimeEnv?.runtimeState?.loopActive');
  expect(publishSource).toContain('if (projectedRuntimeEnv && !projectedRuntimeMatchesSelection) return null;');
  expect(publishSource).toContain('projectedRuntimeMatchesSelection ? projectedRuntimeEnv : null');
  expect(viewSource).toContain('liveEnvResolver={resolveLocalDebugEnv}');

  const debugGetterStart = viewSource.indexOf("registerDebugSurface('liveRuntimeSnapshot'");
  const debugGetterEnd = viewSource.indexOf("registerDebugSurface('publishLiveRuntimeSnapshot'", debugGetterStart);
  expect(debugGetterStart).toBeGreaterThan(0);
  expect(debugGetterEnd).toBeGreaterThan(debugGetterStart);
  const debugGetterSource = viewSource.slice(debugGetterStart, debugGetterEnd);
  expect(debugGetterSource).toContain('const runtimeEnv = resolveLocalDebugEnv();');
  expect(debugGetterSource).toContain('return runtimeEnv ? createDetachedRuntimeViewEnv(runtimeEnv) : null;');
  expect(debugGetterSource).not.toContain('return get(localEnvStore);');
  expect(viewSource).toContain("registerDebugSurface('publishLiveRuntimeSnapshot', () => publishLocalEnv");
  expect(viewSource).not.toContain("Object.defineProperty(window, 'runtimeFrameEnv'");
  expect(viewSource).not.toContain("Object.defineProperty(window, 'isolatedEnv'");
  expect(viewSource).toContain("import { refreshRuntimeView, runtimeView } from '$lib/stores/runtimeViewStore'");
  expect(viewSource).toContain("from '$lib/utils/debugSurface'");
  expect(viewSource).toContain("registerDebugSurface('view', () => get(runtimeView)");
  expect(viewSource).not.toContain("legacyName: '__xlnRuntimeView'");
});

test('view runtime frame stores do not expose legacy isolated names', () => {
  const viewFiles = collectFrontendSources('frontend/src/lib/view');
  const legacyPattern = /\bisolated(Env|History|TimeIndex|IsLive|Revision)\b/;
  for (const file of viewFiles) {
    const source = readFileSync(file, 'utf8');
    expect(source.match(legacyPattern)?.[0] ?? '', file).toBe('');
  }
  const viewSource = readFileSync('frontend/src/lib/view/View.svelte', 'utf8');
  expect(viewSource).toContain("registerDebugSurface('liveRuntimeSnapshot'");
  expect(viewSource).toContain("registerDebugSurface('publishLiveRuntimeSnapshot'");
  expect(viewSource).not.toContain('window.isolatedEnv');
  expect(viewSource).not.toContain("Object.defineProperty(window, 'isolatedEnv'");
});

test('local runtime selection persists embedded mode without deleting saved remote registry', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');
  const persistStart = source.indexOf('const persistActiveEmbeddedRuntime =');
  const switchStart = source.indexOf('// Switch active runtime');
  expect(persistStart).toBeGreaterThan(0);
  expect(switchStart).toBeGreaterThan(persistStart);
  const persistSource = source.slice(persistStart, switchStart);
  expect(persistSource).toContain("localStorage.setItem('xln-runtime-adapter-mode', 'embedded')");
  expect(persistSource).toContain("localStorage.removeItem('xln-runtime-adapter-ws')");
  expect(persistSource).toContain("sessionStorage.removeItem('xln-runtime-adapter-key')");
  expect(persistSource).not.toContain('REMOTE_RUNTIME.IMPORT_STORAGE_KEY');
  expect(source.slice(switchStart)).toContain('persistActiveEmbeddedRuntime();');
  expect(source.slice(switchStart)).toContain("await switchToRuntimeAdapter({ mode: 'embedded', runtimeId: id })");
  expect(source.slice(switchStart)).toContain('runtimeId: id');
});

test('selecting the already connected runtime does not reconnect the adapter', () => {
  const source = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');
  const helperStart = source.indexOf('const runtimeControllerAlreadyTargets =');
  const selectStart = source.indexOf('// Switch active runtime');
  expect(helperStart).toBeGreaterThan(0);
  expect(selectStart).toBeGreaterThan(helperStart);
  const helperSource = source.slice(helperStart, selectStart);
  const selectSource = source.slice(selectStart);

  expect(helperSource).toContain("handle.status !== 'connected'");
  expect(helperSource).toContain('handle.authLevel === expectedAuth');
  expect(helperSource).toContain('normalizeRemoteRuntimeWsUrl(config.wsUrl) === normalizeRemoteRuntimeWsUrl(runtime.wsUrl)');
  expect(selectSource).toContain('if (!runtimeControllerAlreadyTargets(runtime, id)) {');
  const reconnectGuardIndex = selectSource.indexOf('if (!runtimeControllerAlreadyTargets(runtime, id)) {');
  const reconnectIndex = selectSource.indexOf('await switchToRuntimeAdapter({', reconnectGuardIndex);
  const guardEndIndex = selectSource.indexOf('return persistActiveRemoteRuntime(runtime);', reconnectIndex);
  expect(reconnectGuardIndex).toBeGreaterThan(0);
  expect(reconnectIndex).toBeGreaterThan(reconnectGuardIndex);
  expect(guardEndIndex).toBeGreaterThan(reconnectIndex);
});

test('runtime selection persists websocket before switch with rollback and reaffirms active endpoint after success', () => {
  const runtimeStoreSource = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const selectStart = runtimeStoreSource.indexOf('// Switch active runtime');
  const activateStart = runtimeStoreSource.indexOf('async activateRemoteRuntime', selectStart);
  expect(selectStart).toBeGreaterThan(0);
  expect(activateStart).toBeGreaterThan(selectStart);
  const selectSource = runtimeStoreSource.slice(selectStart, activateStart);

  expect(runtimeStoreSource).toContain('const readRuntimeAdapterStorageSnapshot =');
  expect(runtimeStoreSource).toContain('const restoreRuntimeAdapterStorageSnapshot =');
  const remoteSwitchIndex = selectSource.indexOf('await switchToRuntimeAdapter({\n            mode: \'remote\'');
  const remotePersistIndex = selectSource.indexOf('const persisted = persistActiveRemoteRuntime(runtime)');
  const remoteRollbackIndex = selectSource.indexOf('restoreRuntimeAdapterStorageSnapshot(previousStorage)');
  const remotePendingIndex = selectSource.indexOf('setRuntimeControllerPendingRuntimeId(id)', remotePersistIndex);
  const remotePendingRollbackIndex = selectSource.indexOf('setRuntimeControllerPendingRuntimeId(previousPendingRuntimeId)', remoteRollbackIndex);
  const remoteTargetAssertIndex = selectSource.indexOf('REMOTE_RUNTIME_SWITCH_TARGET_MISMATCH', remoteSwitchIndex);
  const remoteFinalPersistIndex = selectSource.indexOf('return persistActiveRemoteRuntime(runtime);', remoteSwitchIndex);
  expect(remoteSwitchIndex).toBeGreaterThan(0);
  expect(remotePersistIndex).toBeGreaterThan(0);
  expect(remotePersistIndex).toBeLessThan(remoteSwitchIndex);
  expect(remotePendingIndex).toBeGreaterThan(remotePersistIndex);
  expect(remotePendingIndex).toBeLessThan(remoteSwitchIndex);
  expect(remoteRollbackIndex).toBeGreaterThan(remoteSwitchIndex);
  expect(remotePendingRollbackIndex).toBeGreaterThan(remoteRollbackIndex);
  expect(remoteTargetAssertIndex).toBeGreaterThan(remoteSwitchIndex);
  expect(remoteFinalPersistIndex).toBeGreaterThan(remoteTargetAssertIndex);

  const embeddedSwitchIndex = selectSource.indexOf("await switchToRuntimeAdapter({ mode: 'embedded', runtimeId: id })");
  const embeddedPersistIndex = selectSource.indexOf('persistActiveEmbeddedRuntime();');
  const embeddedPendingIndex = selectSource.lastIndexOf('setRuntimeControllerPendingRuntimeId(id)', embeddedSwitchIndex);
  const embeddedPendingRollbackIndex = selectSource.lastIndexOf('setRuntimeControllerPendingRuntimeId(previousPendingRuntimeId)');
  expect(embeddedPendingIndex).toBeGreaterThan(remotePendingRollbackIndex);
  expect(embeddedPendingIndex).toBeLessThan(embeddedSwitchIndex);
  expect(embeddedSwitchIndex).toBeGreaterThan(remotePendingRollbackIndex);
  expect(embeddedPersistIndex).toBeGreaterThan(embeddedSwitchIndex);
  expect(embeddedPendingRollbackIndex).toBeGreaterThan(embeddedSwitchIndex);

  expect(xlnStoreSource).toContain("const requestedRuntimeId = normalizeRuntimeConfigId(normalizedConfig.runtimeId || '')");
  expect(xlnStoreSource).toContain("const selectedRuntimeId = requestedRuntimeId || String(get(activeRuntimeId) || '').toLowerCase();");
});

test('runtime controller handle carries selected runtime identity', () => {
  const controllerSource = readFileSync('frontend/src/lib/stores/runtimeControllerStore.ts', 'utf8');
  const runtimeStoreSource = readFileSync('frontend/src/lib/stores/runtimeStore.ts', 'utf8');
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const activeStart = runtimeStoreSource.indexOf('export const activeRuntimeId = derived');
  const activeEnd = runtimeStoreSource.indexOf('// Derived: Get active runtime', activeStart);
  expect(activeStart).toBeGreaterThan(0);
  expect(activeEnd).toBeGreaterThan(activeStart);
  const activeSource = runtimeStoreSource.slice(activeStart, activeEnd);

  expect(controllerSource).toContain('runtimeId: string');
  expect(controllerSource).toContain('pendingRuntimeId: string');
  expect(controllerSource).toContain('const adapterRuntimeId =');
  expect(controllerSource).toContain('normalizeRuntimeId(adapter?.runtimeId) || configId(config)');
  expect(controllerSource).toContain('const id = adapterRuntimeId(adapter, config)');
  expect(controllerSource).toContain('currentRuntimeId === nextRuntimeId');
  expect(runtimeStoreSource).toContain("await switchToRuntimeAdapter({ mode: 'embedded', runtimeId: id })");
  expect(runtimeStoreSource).toContain('runtimeId: id');
  expect(activeSource).toContain('if (pendingId && $runtimes.has(pendingId))');
  expect(activeSource).toContain('controllerId && controllerId !== \'embedded\' && $runtimes.has(controllerId)');
  expect(activeSource).not.toContain("$handle.status === 'connected'");
  expect(xlnStoreSource).toContain('normalizeRuntimeConfigId(config.runtimeId)');
  expect(xlnStoreSource).toContain('remoteRuntimeIdFromConfig(normalizedConfig)');
});

test('vault restore rebinds RuntimeController to the restored embedded runtime', () => {
  const source = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');
  const restoreStart = source.indexOf('const resolvedActive = findRuntimeByIdCaseInsensitive');
  const initializedStart = source.indexOf('initialized = true;', restoreStart);
  expect(restoreStart).toBeGreaterThan(0);
  expect(initializedStart).toBeGreaterThan(restoreStart);
  const restoreSource = source.slice(restoreStart, initializedStart);

  const fallbackIndex = restoreSource.indexOf('runtimeOperations.setActiveRuntimeId(activeId)');
  const pipelineIndex = restoreSource.indexOf('await ensureRuntimePipelineAlive(runtimeToSync as Runtime, activeXln)');
  const controllerIndex = restoreSource.indexOf('await runtimeOperations.selectRuntime(activeId)');
  const syncIndex = restoreSource.indexOf('this.syncRuntime(runtimeToSync)');
  expect(fallbackIndex).toBeGreaterThan(0);
  expect(pipelineIndex).toBeGreaterThan(fallbackIndex);
  expect(controllerIndex).toBeGreaterThan(pipelineIndex);
  expect(syncIndex).toBeGreaterThan(controllerIndex);
});

test('embedded env initialization publishes active runtime snapshot before app shell reads it', () => {
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const updateStart = xlnStoreSource.indexOf('const updateLocalEnvironmentStores =');
  const callbackStart = xlnStoreSource.indexOf('const registerLocalEnvironmentCallback =');
  expect(updateStart).toBeGreaterThan(0);
  expect(callbackStart).toBeGreaterThan(updateStart);
  const updateSlice = xlnStoreSource.slice(updateStart, callbackStart);

  expect(xlnStoreSource).toContain("const EMBEDDED_RUNTIME_SEED_STORAGE_KEY = 'xln-embedded-runtime-seed-v1';");
  expect(xlnStoreSource).toContain('const seed = readOrCreateEmbeddedRuntimeSeed();');
  expect(xlnStoreSource).toContain("return seed ? { mode: 'embedded', seed } : { mode: 'embedded' };");
  expect(xlnStoreSource).toContain('env = await xln.main(adapterConfig.seed ?? null);');
  expect(xlnStoreSource).toContain('env = await xln.main(normalizedConfig.seed ?? null);');
  expect(xlnStoreSource).toContain('EMBEDDED_RUNTIME_ENV_MISMATCH');
  expect(xlnStoreSource).toContain('createEmbeddedAdapter: () => createEmbeddedRuntimeAdapter(xln, adapterConfig.seed ?? null, env)');
  expect(xlnStoreSource).toContain('createEmbeddedAdapter: () => createEmbeddedRuntimeAdapter(xln, normalizedConfig.seed ?? null, env)');
  expect(updateSlice).toContain("upsertRuntimeSnapshot(env, { mode: 'embedded', runtimeId: envRuntimeId }, 'connected')");
  expect(updateSlice.indexOf('upsertRuntimeSnapshot')).toBeLessThan(updateSlice.indexOf('runtimeOperations.updateLocalEnv(env)'));
  expect(updateSlice).not.toContain('buildRemoteAdapterPlaceholderEnv');
});

test('app embedded boot restores vault runtimes before default browser runtime initialization', () => {
  const source = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');
  const helperStart = source.indexOf('function shouldBootRemoteRuntime()');
  const bootStart = source.indexOf('async function bootApp()');
  const mountStart = source.indexOf('onMount(() => {', bootStart);
  expect(helperStart).toBeGreaterThan(0);
  expect(bootStart).toBeGreaterThan(helperStart);
  expect(mountStart).toBeGreaterThan(bootStart);

  const bootSource = source.slice(bootStart, mountStart);
  expect(source.slice(helperStart, bootStart)).toContain("localStorage.getItem('xln-runtime-adapter-mode')");
  expect(bootSource).toContain('const bootingRemoteRuntime = shouldBootRemoteRuntime();');
  expect(bootSource).toContain('if (!bootingRemoteRuntime) {');
  expect(bootSource.indexOf('await vaultOperations.initialize();')).toBeLessThan(bootSource.indexOf('await initializeXLN();'));
  expect(bootSource).toContain("if (!bootingRemoteRuntime && $runtimeControllerHandle.mode !== 'remote')");
});

test('vault bootstrap commands submit explicit runtime env through command bus helper', () => {
  const source = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');
  const enqueueStart = source.indexOf('async function enqueueAndAwait(');
  const helperEnd = source.indexOf('async function ensureRuntimePipelineAlive', enqueueStart);
  expect(enqueueStart).toBeGreaterThan(0);
  expect(helperEnd).toBeGreaterThan(enqueueStart);
  const enqueueSource = source.slice(enqueueStart, helperEnd);

  expect(source).toContain('dispatchRuntimeInputToRuntimeEnv');
  expect(enqueueSource).toContain('await dispatchRuntimeInputToRuntimeEnv(runtimeEnv, runtimeInput)');
  expect(enqueueSource).not.toContain('xln.enqueueRuntimeInput(runtimeEnv, runtimeInput)');
  expect(enqueueSource).not.toContain('xln.startRuntimeLoop(runtimeEnv)');
});

test('app remote runtime prompt activates through hot boot instead of reload', () => {
  const source = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');
  const acceptStart = source.indexOf('async function acceptRemoteRuntime');
  const localStart = source.indexOf('async function useLocalBrowserRuntime');
  const pageChangeStart = source.indexOf("async function changeRemotePage");
  expect(acceptStart).toBeGreaterThan(0);
  expect(localStart).toBeGreaterThan(acceptStart);
  expect(pageChangeStart).toBeGreaterThan(localStart);

  const acceptSlice = source.slice(acceptStart, localStart);
  const localSlice = source.slice(localStart, pageChangeStart);
  expect(acceptSlice).toContain('await activateAppAfterRuntimeChoice()');
  expect(localSlice).toContain('await activateAppAfterRuntimeChoice()');
  expect(acceptSlice).not.toContain('window.location.reload');
  expect(localSlice).not.toContain('window.location.reload');
  expect(source).not.toContain('window.location.reload');
  expect(source).not.toContain('inactive-tab-reload');
  expect(source).toContain('async function claimActiveTabLockInPlace');
  expect(source).toContain('data-testid="inactive-tab-acquire"');
  expect(source).toContain('releaseActiveTabLock = await initializeActiveTabLock');
});

test('accepted remote runtime links persist into the shared runtime registry', () => {
  const source = readFileSync('frontend/src/lib/utils/runtimeConnection.ts', 'utf8');
  const persistStart = source.indexOf('export function persistRemoteRuntimeRequest');
  const acceptStart = source.indexOf('export function hasAcceptedRemoteRuntime');
  expect(persistStart).toBeGreaterThan(0);
  expect(acceptStart).toBeGreaterThan(persistStart);
  const persistSource = source.slice(persistStart, acceptStart);

  expect(persistSource).toContain("localStorage.setItem('xln-runtime-adapter-mode', 'remote')");
  expect(persistSource).toContain("sessionStorage.setItem('xln-runtime-adapter-key', request.authKey)");
  expect(persistSource).toContain('persistRemoteRuntimeImports([{');
  expect(persistSource).toContain('runtimeId: readRemoteRuntimeTokenAudience(request.authKey) || remoteRuntimeIdForWsUrl(request.wsUrl)');
  expect(persistSource).toContain("authLevel: access === 'admin' ? 'admin' : 'inspect'");
  expect(persistSource).toContain('], { merge: true })');
  expect(persistSource).not.toContain("localStorage.setItem('xln-runtime-adapter-key'");
});

test('direct remote adapter config carries token audience runtime identity', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const resolveStart = source.indexOf('const resolveAppRuntimeAdapterConfig =');
  const nextHelperStart = source.indexOf('const upsertRuntimeSnapshot =', resolveStart);
  expect(resolveStart).toBeGreaterThan(0);
  expect(nextHelperStart).toBeGreaterThan(resolveStart);
  const resolveSource = source.slice(resolveStart, nextHelperStart);
  expect(resolveSource).toContain('const runtimeId = readRemoteRuntimeTokenAudience(authKey)');
  expect(resolveSource).toContain('...(runtimeId ? { runtimeId } : {})');
});

test('remote app can page through full hub account and book projections', () => {
  const layoutSource = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');
  const xlnStoreSource = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const runtimeViewSource = readFileSync('frontend/src/lib/stores/runtimeViewStore.ts', 'utf8');

  expect(layoutSource).toContain("import {");
  expect(layoutSource).toContain("import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore'");
  expect(layoutSource).toContain("import { runtimeViewPageInfo, setRuntimeViewPage } from '$lib/stores/runtimeViewStore'");
  expect(layoutSource).toContain('$runtimeControllerHandle.mode');
  expect(layoutSource).toContain('setRuntimeViewPage');
  expect(layoutSource).toContain('async function changeRemotePage');
  expect(layoutSource).toContain('setRuntimeViewPage(kind, pageIndex);');
  expect(layoutSource).toContain('await refreshCurrentRuntimeProjection();');
  expect(layoutSource).toContain('data-testid="remote-page-notice"');
  expect(layoutSource).toContain('Accounts {$runtimeViewPageInfo.accountsPageIndex + 1}/{$runtimeViewPageInfo.accountsPageCount || 1}');
  expect(layoutSource).toContain('disabled={!$runtimeViewPageInfo.accountsHasMore}');
  expect(layoutSource).toContain('onclick={() => changeRemotePage(\'accounts\', $runtimeViewPageInfo!.accountsPageIndex + 1)}');
  expect(layoutSource).toContain('onclick={() => changeRemotePage(\'books\', $runtimeViewPageInfo!.booksPageIndex + 1)}');
  expect(layoutSource).not.toContain('appRuntimeAdapterMode');
  expect(layoutSource).not.toContain('appRuntimeAdapterPageInfo');
  expect(layoutSource).not.toContain('setRuntimeAdapterPage');

  expect(runtimeViewSource).toContain('export const setRuntimeViewPage');
  expect(xlnStoreSource).not.toContain('export const setRuntimeViewPage');
  expect(xlnStoreSource).not.toContain('appRuntimeAdapterPageInfo');
  expect(xlnStoreSource).toContain('accountsPage,');
  expect(xlnStoreSource).toContain('booksPage,');
  expect(runtimeViewSource).toContain('accountsPageIndex: number');
  expect(runtimeViewSource).toContain('accountsPageCount: number');
  expect(runtimeViewSource).toContain('accountsHasMore: boolean');
  expect(runtimeViewSource).toContain('export const runtimeViewPageInfo');
});

test('retryable remote adapter refresh errors do not unmount the app shell', () => {
  const source = readFileSync('frontend/src/lib/stores/xlnStore.ts', 'utf8');
  const handlerStart = source.indexOf('const handleRuntimeProjectionRefreshError');
  const scheduleStart = source.indexOf('const scheduleRuntimeProjectionRefresh', handlerStart);
  expect(handlerStart).toBeGreaterThanOrEqual(0);
  expect(scheduleStart).toBeGreaterThan(handlerStart);

  const handlerSource = source.slice(handlerStart, scheduleStart);
  expect(handlerSource).toContain("errorLog.log(message, 'Runtime Projection Refresh'");
  expect(handlerSource).toContain("getRuntimeControllerConfig()?.mode === 'remote'");
  expect(handlerSource).toContain('Remote runtime projection refresh failed; keeping current runtime view mounted');
  expect(handlerSource).toContain('toasts.warning');
  expect(handlerSource.indexOf('return;')).toBeLessThan(handlerSource.lastIndexOf('error.set(message)'));
});

test('local runtime creation marks the target before bootstrap and switches controller after persistence', () => {
  const source = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');
  const createStart = source.indexOf('async createRuntime(');
  const deleteStart = source.indexOf('async deleteRuntime(', createStart);
  expect(createStart).toBeGreaterThan(0);
  expect(deleteStart).toBeGreaterThan(createStart);
  const createSource = source.slice(createStart, deleteStart);
  const earlyPendingSelect = createSource.indexOf('runtimeOperations.setActiveRuntimeId(runtimeId)');
  const firstRuntimeInput = createSource.indexOf('await enqueueAndAwait(');
  const persistedState = createSource.indexOf('runtimesState.update(state => ({');
  const controllerSelect = createSource.indexOf('await runtimeOperations.selectRuntime(runtimeId)');
  expect(earlyPendingSelect).toBeGreaterThan(0);
  expect(firstRuntimeInput).toBeGreaterThan(earlyPendingSelect);
  expect(persistedState).toBeGreaterThan(firstRuntimeInput);
  expect(controllerSelect).toBeGreaterThan(persistedState);
  expect(createSource).not.toContain("activeRuntimeId.set(runtimeId);");
});

test('vault runtime selection delegates adapter lifecycle to RuntimeController path', () => {
  const source = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');
  const selectStart = source.indexOf('async selectRuntime(runtimeId: string)');
  const addSignerStart = source.indexOf('// Add signer to active runtime', selectStart);
  expect(selectStart).toBeGreaterThan(0);
  expect(addSignerStart).toBeGreaterThan(selectStart);
  const selectSource = source.slice(selectStart, addSignerStart);
  expect(selectSource).toContain('runtimeOperations.selectRuntime(resolvedRuntimeId)');
  expect(selectSource).not.toContain('switchAppRuntimeAdapter');
  expect(selectSource).not.toContain('activeRuntimeId.set(resolvedRuntimeId)');
});

test('vault initialization preserves active shared runtime selection', () => {
  const source = readFileSync('frontend/src/lib/stores/vaultStore.ts', 'utf8');
  const initStart = source.indexOf('async initialize()');
  const clearStart = source.indexOf('// Clear all runtimes', initStart);
  expect(initStart).toBeGreaterThan(0);
  expect(clearStart).toBeGreaterThan(initStart);
  const initSource = source.slice(initStart, clearStart);

  expect(initSource).toContain('const sharedRuntimes = get(runtimes);');
  expect(initSource).toContain('const currentSharedRuntime = currentSelected ? sharedRuntimes.get(currentSelected) : null;');
  expect(initSource).toContain('latest.runtimes[currentSelected] ||');
  expect(initSource).toContain("currentSharedRuntime?.type === 'remote'");
  expect(initSource).not.toContain('latest.runtimes[currentSelected] || sharedRuntimes.has(currentSelected)');
  expect(initSource).toContain('const runtimeEntry = activeId ? sharedRuntimes.get(activeId) : null;');
  expect(initSource).toContain('if (runtimeToSync) this.syncRuntime(runtimeToSync);');
  expect(initSource).toContain('else if (!activeId) this.syncRuntime(null);');
  expect(initSource).not.toContain('this.syncRuntime(runtimeToSync ?? null);');
});

test('frontend surfaces do not bypass RuntimeController when switching active runtime', () => {
  const navigationSource = readFileSync('frontend/src/lib/components/Navigation/HierarchicalNav.svelte', 'utf8');
  expect(navigationSource).toContain('runtimeOperations.selectRuntime(id)');
  expect(navigationSource).not.toContain('activeRuntimeId.set');

  const bypasses = collectFrontendSources('frontend/src')
    .filter((file) => file !== 'frontend/src/lib/stores/runtimeStore.ts')
    .filter((file) => /\bactiveRuntimeId\.set\(/.test(readFileSync(file, 'utf8')));

  expect(bypasses).toEqual([]);
});
