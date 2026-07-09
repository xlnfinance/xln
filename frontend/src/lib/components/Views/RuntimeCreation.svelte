<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { locale, translations$, initI18n, loadTranslations } from '$lib/i18n';
  // Runtime creation is entry only; entity capabilities are resolved in EntityWorkspace.
  import HierarchicalNav from '$lib/components/Navigation/HierarchicalNav.svelte';
  import { appStateOperations } from '$lib/stores/appStateStore';
  import {
    discoverRuntimeRecoveryCandidates,
    parseRuntimeRecoveryCandidateFile,
    vaultOperations,
    allRuntimes,
    type RuntimeRecoveryCandidate,
    type RuntimeRecoveryDiscoveryFailure,
  } from '$lib/stores/vaultStore';
  import { deriveRequestSignal, vaultUiOperations } from '$lib/stores/vaultUiStore';
  import { resetEverything } from '$lib/utils/resetEverything';
  import { writeRuntimeRecoveryDiscoveryStatus } from '$lib/utils/recoveryDiscoveryStatus';
  import { buildRemoteRuntimeRecoveryPeerSources } from '$lib/utils/remoteRuntimeValidation';
  import {
    BRAINVAULT_V1,
    bytesToHex,
    combineShards,
    deriveEthereumAddress,
    deriveKey,
    entropyToMnemonic,
    estimatePasswordStrength,
    getShardCount,
    hexToBytes,
  } from '@xln/brainvault/core';
  import { DEMO_ACCOUNTS, type DemoAccount } from '$lib/config/demo-accounts';
  import { resolveConfiguredApiBase } from '$lib/stores/xlnStore';
  import { runtimeOperations } from '$lib/stores/runtimeStore';
  import { generateLazyEntityIdPreview } from '$lib/utils/lazyEntityId';
  import {
    BRAINVAULT_WORKER_CAP_STORAGE_KEY,
    computeBrainVaultWorkerCap,
    isBrainVaultWasmMemoryError,
    nextBrainVaultWorkerCapAfterFailure,
  } from '$lib/brainvault/workers';
  import {
    FACTOR_INFO,
    STRENGTH_COLORS,
    formatMemoryLabel,
    formatRuntimeDurationRounded,
    generateBase58Secret,
  } from './runtime-creation-model';

  // Props
  export let embedded: boolean = false;

  $: t = $translations$;

  function suggestPassphrase(): void {
    // Generate 10 Base58 chars = ~58.5 bits of entropy (log2(58^10))
    const buf = new Uint8Array(10);
    crypto.getRandomValues(buf);
    passphrase = generateBase58Secret(buf);
    showPassphrase = true; // Auto-show since it's random/public anyway
  }

  async function generateRandomMnemonic(): Promise<void> {
    // Generate 256 bits of entropy for 24-word mnemonic
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);
    mnemonicInput = await entropyToMnemonic(entropy);
  }

  // ============================================================================
  // STATE
  // ============================================================================

  type Phase = 'input' | 'deriving' | 'recovery';
  type InputMode = 'brainvault' | 'mnemonic';

  let inputMode: InputMode = 'brainvault';
  let phase: Phase = 'input';

  // Visual scheme for the standalone auth screen: 'dark' (default "vault") or 'light' (minimalist fintech skin)
  type AuthScheme = 'dark' | 'light';
  const AUTH_SCHEME_STORAGE_KEY = 'xln-auth-scheme';
  let scheme: AuthScheme = 'dark';
  function setScheme(next: AuthScheme): void {
    scheme = next;
    if (typeof localStorage !== 'undefined') localStorage.setItem(AUTH_SCHEME_STORAGE_KEY, next);
  }

  // Advanced options (security work factor etc.) are collapsed by default for a minimalist screen
  let showAdvanced = false;

  // Group demo accounts by role (users | hubs | apps) so quick login can show separators
  const DEMO_GROUPS: DemoAccount[][] = DEMO_ACCOUNTS.reduce((groups: DemoAccount[][], acc) => {
    const last = groups[groups.length - 1];
    if (last && last[0]?.role === acc.role) last.push(acc);
    else groups.push([acc]);
    return groups;
  }, []);

  // Live remote runtimes discovered from the server's import manifest (hubs + MM + custody).
  type LiveRuntime = { label: string; access: 'admin' | 'read'; wsUrl: string; token: string };
  let liveRuntimes: LiveRuntime[] = [];
  let liveRuntimesLoading = false;
  let liveRuntimesError = '';
  let liveRuntimesLoaded = false;
  let connectingRuntimeId = '';
  let selectedRuntimeKey = '';

  function connectSelectedRuntime(): void {
    const rt = liveRuntimes.find((r) => r.wsUrl === selectedRuntimeKey);
    if (rt) void connectLiveRuntime(rt);
  }

  function selectedRuntimeAccessLabel(): 'read' | 'admin' {
    return liveRuntimes.find((r) => r.wsUrl === selectedRuntimeKey)?.access ?? 'read';
  }

  // `silent` (used for auto-discovery on mount) swallows errors so a login screen with no
  // reachable runtime server doesn't surface a scary fetch error before the user asks for it.
  async function discoverLiveRuntimes(silent = false): Promise<void> {
    if (typeof window === 'undefined' || liveRuntimesLoading) return;
    liveRuntimesLoading = true;
    liveRuntimesError = '';
    try {
      const apiBase = resolveConfiguredApiBase(window.location.origin);
      const url = new URL('/api/runtime-import', apiBase);
      url.searchParams.set('access', 'read');
      url.searchParams.set('allowPartial', '1');
      url.searchParams.set('ts', String(Date.now()));
      const res = await fetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json() as {
        ready?: boolean;
        reason?: string;
        error?: string;
        manifest?: { entries?: Array<Record<string, unknown>> };
      };
      const next: LiveRuntime[] = [];
      for (const entry of payload.manifest?.entries ?? []) {
        const wsUrl = String(entry['wsUrl'] || '').trim();
        const token = String(entry['token'] || '').trim();
        const label = String(entry['label'] || wsUrl || 'runtime');
        const access = entry['access'] === 'admin' ? 'admin' : 'read';
        if (!wsUrl || !token) continue;
        next.push({ label, access, wsUrl, token });
      }
      liveRuntimes = next;
      liveRuntimesLoaded = true;
      if (!silent && next.length === 0 && payload.ready === false) {
        liveRuntimesError = String(payload.reason || payload.error || 'runtime import not ready');
      }
      void runtimeOperations.hydrateRemoteRuntimeImportSource(url.toString());
    } catch (err) {
      if (!silent) liveRuntimesError = err instanceof Error ? err.message : String(err);
    } finally {
      liveRuntimesLoading = false;
    }
  }

  async function connectLiveRuntime(rt: LiveRuntime): Promise<void> {
    if (connectingRuntimeId) return;
    connectingRuntimeId = rt.wsUrl;
    liveRuntimesError = '';
    try {
      const stored = await runtimeOperations.connectRemote(rt.wsUrl, rt.token, {
        label: rt.label,
        access: rt.access,
      });
      const activated = await runtimeOperations.activateRemoteRuntime(stored.runtimeId, { href: '/app' });
      if (!activated) {
        liveRuntimesError = `${rt.label}: connected but could not activate the runtime`;
        connectingRuntimeId = '';
      }
    } catch (err) {
      liveRuntimesError = `${rt.label}: ${err instanceof Error ? err.message : String(err)}`;
      connectingRuntimeId = '';
    }
  }

  $: hasAnyPersistedState = typeof localStorage !== 'undefined' && (localStorage.length > 0 || typeof indexedDB !== 'undefined');

  async function handleResetEverything() {
    if (confirm('This will clear all wallets, accounts, and runtime state. Continue?')) {
      await resetEverything({ confirmed: true, reason: 'runtime-creation-manual-reset' });
    }
  }
  let createLoginType: 'manual' | 'demo' = 'manual';

  // Input state
  let name = '';
  let passphrase = '';
  let mnemonicInput = ''; // For mnemonic mode
  let showPassphrase = false;
  let shardInput = 3; // Can be 1-5 (factor) or 6+ (custom shards)

  // Compute actual shard count and factor from input (must match cli.ts derive() logic)
  $: isPreset = shardInput >= 1 && shardInput <= 5;
  $: actualShardCount = isPreset ? getShardCount(shardInput) : shardInput;
  $: factor = isPreset ? shardInput : Math.ceil(Math.log10(actualShardCount)) + 1;

  // Dynamic color: red(1) → yellow(3) → green(5+)
  $: factorColor = (() => {
    const effective = isPreset ? shardInput : Math.min(5, Math.ceil(Math.log10(shardInput)) + 1);
    const t = (effective - 1) / 4;
    if (t < 0.5) {
      // red to yellow
      const r = 239;
      const g = Math.round(68 + (179 - 68) * (t * 2));
      const b = 68;
      return `rgb(${r}, ${g}, ${b})`;
    } else {
      // yellow to green
      const r = Math.round(234 - (234 - 34) * ((t - 0.5) * 2));
      const g = Math.round(179 + (197 - 179) * ((t - 0.5) * 2));
      const b = Math.round(8 + (94 - 8) * ((t - 0.5) * 2));
      return `rgb(${r}, ${g}, ${b})`;
    }
  })();

  type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAppleMobile = typeof navigator !== 'undefined' && (
    /iPhone|iPad|iPod/i.test(userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
  const isWebKitEngine = /AppleWebKit/i.test(userAgent);
  const isIOSFamilyWebKit = isAppleMobile && isWebKitEngine;

  // Device memory detection (navigator.deviceMemory gives GB, default 8GB if unavailable)
  // Safari/iOS does not expose deviceMemory reliably and has much tighter WebContent limits.
  let deviceMemoryGB = typeof navigator !== 'undefined'
    ? ((navigator as NavigatorWithDeviceMemory).deviceMemory ?? (isIOSFamilyWebKit ? 2 : 8))
    : 8;

  // POWER USER OVERRIDE: Uncomment to set actual RAM (bypasses browser 8GB cap)
  // For M3 Ultra 512GB or similar high-RAM machines
  // deviceMemoryGB = 512;

  // Allow user to configure beyond hardwareConcurrency (they'll find sweet spot)
  const hardwareCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
  const SHARD_MEMORY_MB = BRAINVAULT_V1.SHARD_MEMORY_KB / 1024;

  function readPersistedWorkerCap(): number | null {
    if (typeof localStorage === 'undefined') return null;
    const value = Number(localStorage.getItem(BRAINVAULT_WORKER_CAP_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }

  function persistWorkerCap(cap: number): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(BRAINVAULT_WORKER_CAP_STORAGE_KEY, String(Math.max(1, Math.floor(cap))));
  }

  const computeMaxWorkers = () => computeBrainVaultWorkerCap({
    hardwareConcurrency: hardwareCores,
    deviceMemoryGB,
    shardMemoryMB: SHARD_MEMORY_MB,
    isWebKit: isIOSFamilyWebKit,
    storedCap: readPersistedWorkerCap(),
  });

  // Derivation state
  let workers: Worker[] = [];
  const drainingWorkers = new Set<Worker>();
  const workerActiveShard = new Map<Worker, number>();
  let retryShardQueue: number[] = [];
  const shardRetryCounts = new Map<number, number>();
  let workerCount = 1;
  let activeWorkerCount = 1;
  let derivationError = '';
  let workerLimitNotice = '';

  let maxWorkers = computeMaxWorkers();
  let usableWorkerCap = Math.max(1, maxWorkers);
  let targetWorkerCount = Math.max(1, Math.min(hardwareCores, usableWorkerCap));
  let effectiveTargetWorkerCount = targetWorkerCount;

  // Use one cap for slider, live scaling, and displayed limits.
  $: usableWorkerCap = Math.max(
    1,
    Math.min(maxWorkers, shardCount > 0 ? shardCount : maxWorkers)
  );
  $: if (targetWorkerCount > usableWorkerCap) targetWorkerCount = usableWorkerCap;
  $: if (targetWorkerCount < 1) targetWorkerCount = 1;
  $: effectiveTargetWorkerCount = Math.min(targetWorkerCount, usableWorkerCap);

  // Reactive: Adjust workers when user changes slider during derivation
  $: if (phase === 'deriving' && effectiveTargetWorkerCount !== activeWorkerCount) {
    adjustWorkers();
  }

  // Show actual active worker memory, not an optimistic target.
  $: allocatedMemoryMB = activeWorkerCount * 256;
  let shardCount = 0;
  let shardsCompleted = 0;
  let shardResults: Map<number, Uint8Array> = new Map();
  let shardStatus: ('pending' | 'computing' | 'complete')[] = [];
  let estimatedShardTimeMs = 3000;


  // Result state
  let mnemonic24 = '';
  let mnemonic12 = '';
  let devicePassphrase = '';
  let ethereumAddress = '';
  let entityId = ''; // bytes32 entity ID derived from address
  let creatingRuntime = false;
  let recoveryChecking = false;
  let recoveryRuntimeId = '';
  let recoveryLabel = '';
  let recoveryCandidates: RuntimeRecoveryCandidate[] = [];
  let recoveryErrors: string[] = [];
  let recoveryFailures: RuntimeRecoveryDiscoveryFailure[] = [];
  let recoveryCheckedTowers = 0;
  let recoveryCheckedPeers = 0;
  let recoveryPeerBackupCount = 0;
  let selectedRecoveryCandidateId = '';
  let localRuntimeAvailable = false;
  let backupFileInput: HTMLInputElement | null = null;

  // ============================================================================
  // LIFECYCLE - Load vault on mount
  // ============================================================================

  onMount(() => {
    // Screen 1 only creates/selects a runtime, then exits immediately to Screen 2.
    // Never show a post-seed "ready" screen here; account configuration owns that step.
    vaultOperations.initialize();
  });

  let lastDeriveRequest = 0;
  $: if ($deriveRequestSignal !== lastDeriveRequest) {
    lastDeriveRequest = $deriveRequestSignal;
    reset();
  }

  $: savedVaults = $allRuntimes;

  $: selectedRecoveryCandidate = recoveryCandidates.find((candidate) => candidate.id === selectedRecoveryCandidateId) || recoveryCandidates[0] || null;

  const shortRuntimeId = (value: string): string => {
    const text = String(value || '').trim();
    if (text.length <= 18) return text || '-';
    return `${text.slice(0, 10)}...${text.slice(-6)}`;
  };

  const formatRecoveryTime = (createdAt: number): string => {
    if (!Number.isFinite(createdAt) || createdAt <= 0) return 'unknown time';
    try {
      return new Date(createdAt).toLocaleString();
    } catch {
      return String(createdAt);
    }
  };

  function resetRecoveryDecision(): void {
    recoveryChecking = false;
    recoveryRuntimeId = '';
    recoveryLabel = '';
    recoveryCandidates = [];
    recoveryErrors = [];
    recoveryFailures = [];
    recoveryCheckedTowers = 0;
    recoveryCheckedPeers = 0;
    recoveryPeerBackupCount = 0;
    selectedRecoveryCandidateId = '';
    localRuntimeAvailable = false;
  }

  async function prepareRecoveryDecisionFromCurrentSeed(labelOverride?: string): Promise<boolean> {
    if (!mnemonic24 || !ethereumAddress) return false;

    derivationError = '';
    recoveryChecking = true;
    recoveryRuntimeId = ethereumAddress.toLowerCase();
    recoveryLabel = (labelOverride || name || '').trim() || `Runtime ${ethereumAddress.slice(0, 6)}`;
    recoveryCandidates = [];
    recoveryErrors = [];
    recoveryFailures = [];
    recoveryCheckedTowers = 0;
    recoveryCheckedPeers = 0;
    recoveryPeerBackupCount = 0;
    selectedRecoveryCandidateId = '';
    localRuntimeAvailable = vaultOperations.runtimeExists(recoveryRuntimeId);

    try {
      const discovery = await discoverRuntimeRecoveryCandidates(mnemonic24, {
        peers: buildRemoteRuntimeRecoveryPeerSources({ runtimeId: recoveryRuntimeId }),
      });
      recoveryCandidates = discovery.candidates;
      recoveryErrors = discovery.errors;
      recoveryFailures = discovery.failures;
      recoveryCheckedTowers = discovery.checkedTowers;
      recoveryCheckedPeers = discovery.checkedPeers;
      recoveryPeerBackupCount = recoveryCandidates.filter((candidate) => candidate.source === 'peer').length;
      selectedRecoveryCandidateId = recoveryCandidates[0]?.id || '';
      if (recoveryCandidates.length > 0) {
        phase = 'recovery';
      }
      return true;
    } catch (err) {
      recoveryErrors = [err instanceof Error ? err.message : String(err)];
      recoveryFailures = [];
      return false;
    } finally {
      recoveryChecking = false;
    }
  }

  function writeCurrentRecoveryDiscoveryStatus(): void {
    writeRuntimeRecoveryDiscoveryStatus({
      runtimeId: recoveryRuntimeId || ethereumAddress,
      checkedTowers: recoveryCheckedTowers,
      checkedPeers: recoveryCheckedPeers,
      peerBackupCount: recoveryPeerBackupCount,
      backupCount: recoveryCandidates.length,
      errors: recoveryErrors,
      failures: recoveryFailures,
      checkedAt: Date.now(),
    });
  }

  async function continueAfterRecoveryDiscovery(): Promise<void> {
    if (recoveryCandidates.length > 0) {
      phase = 'recovery';
      return;
    }
    writeCurrentRecoveryDiscoveryStatus();
    if (localRuntimeAvailable) {
      await openLocalRuntime();
    } else {
      await createFreshRuntime();
    }
  }

  async function createXlnWalletFromCurrentSeed(
    labelOverride?: string,
    options: {
      recoveryCandidate?: RuntimeRecoveryCandidate;
      forceFresh?: boolean;
      openLocal?: boolean;
    } = {},
  ): Promise<boolean> {
    if (!mnemonic24 || !ethereumAddress || creatingRuntime) return false;

    creatingRuntime = true;
    derivationError = '';
    try {
      const runtimeId = ethereumAddress;
      const label = (labelOverride || name || '').trim() || `Runtime ${ethereumAddress.slice(0, 6)}`;

      if (options.openLocal || (!options.forceFresh && !options.recoveryCandidate && vaultOperations.runtimeExists(runtimeId))) {
        await vaultOperations.selectRuntime(runtimeId);
      } else {
        const runtime = await vaultOperations.createRuntime(label, mnemonic24, {
          loginType: createLoginType,
          requiresOnboarding: createLoginType !== 'demo',
          mnemonic12: mnemonic12.trim().split(/\s+/).join(' ') || undefined,
          devicePassphrase: devicePassphrase || undefined,
          recoveryCandidate: options.recoveryCandidate,
          skipRecoveryRestore: !options.recoveryCandidate,
        });
        entityId = runtime.signers[0]?.entityId || entityId;
      }
      createLoginType = 'manual';
      vaultUiOperations.hideVault();
      if (!embedded) {
        appStateOperations.setMode('user');
        appStateOperations.setViewMode('home');
      }
      return true;
    } catch (err) {
      console.error('[RuntimeCreation] Failed to create XLN wallet', err);
      derivationError = err instanceof Error ? err.message : 'Failed to create XLN wallet';
      phase = 'input';
      return false;
    } finally {
      creatingRuntime = false;
    }
  }

  async function restoreSelectedRecoveryCandidate(): Promise<void> {
    const candidate = selectedRecoveryCandidate;
    if (!candidate) return;
    await createXlnWalletFromCurrentSeed(recoveryLabel, { recoveryCandidate: candidate });
  }

  async function openLocalRuntime(): Promise<void> {
    await createXlnWalletFromCurrentSeed(recoveryLabel, { openLocal: true });
  }

  async function createFreshRuntime(): Promise<void> {
    await createXlnWalletFromCurrentSeed(recoveryLabel, { forceFresh: true });
  }

  function triggerBackupFilePicker(): void {
    backupFileInput?.click();
  }

  async function handleBackupFileSelected(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    derivationError = '';
    try {
      const candidate = await parseRuntimeRecoveryCandidateFile(mnemonic24, await file.text(), {
        sourceLabel: file.name || 'Local backup file',
      });
      recoveryCandidates = [
        candidate,
        ...recoveryCandidates.filter((existing) => existing.id !== candidate.id),
      ].sort((left, right) => {
        if (right.runtimeHeight !== left.runtimeHeight) return right.runtimeHeight - left.runtimeHeight;
        return right.createdAt - left.createdAt;
      });
      selectedRecoveryCandidateId = candidate.id;
    } catch (err) {
      derivationError = err instanceof Error ? err.message : String(err);
    } finally {
      input.value = '';
    }
  }

  // ============================================================================
  // ============================================================================
  // COMPUTED
  // ============================================================================

  $: passwordStrength = (() => {
    const strength = estimatePasswordStrength(passphrase);
    return {
      bits: strength.bits,
      rating: strength.rating,
      color: STRENGTH_COLORS[strength.rating] ?? '#666',
    };
  })();
  $: rawWorkFactorBits = actualShardCount > 0 ? Math.log2(actualShardCount) : 0;
  // Display an attack-cost hint, not a literal entropy claim:
  // round to whole bits and give a small premium for the real derivation expense.
  $: workFactorBits = actualShardCount <= 1 ? 0 : Math.round(rawWorkFactorBits + 0.75);
  $: totalSecurityBits = passwordStrength.bits + workFactorBits;
  // Compute factorInfo from shardInput
  $: factorInfo = isPreset
    ? FACTOR_INFO[shardInput - 1]!
    : {
        factor: 0,
        shards: shardInput,
        time: `~${Math.round(shardInput * 3 / 60)}min`,
        tier: 'Custom',
        attackCost: `$${(shardInput * 13000).toLocaleString()}`
      };
  $: canDerive = inputMode === 'brainvault'
    ? (name.length >= BRAINVAULT_V1.MIN_NAME_LENGTH && passphrase.length >= BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH)
    : mnemonicInput.trim().split(/\s+/).filter(w => w).length >= 12;
  $: progress = shardCount > 0 ? (shardsCompleted / shardCount) * 100 : 0;
  // Projected ETA based on the current requested worker target.
  $: projectedRemainingMs = shardCount > 0
    ? Math.max(0, ((shardCount - shardsCompleted) / Math.max(effectiveTargetWorkerCount, 1)) * estimatedShardTimeMs)
    : 0;

  // Shard grid dimensions (for visualization)
  // Exact grid dimensions per factor (1:1 shard-to-cube mapping up to factor 5)
  // Factor 1 = 1×1, Factor 2 = 2×2, Factor 3 = 4×4, Factor 4 = 8×8, Factor 5 = 16×16
  // Factor 6+ uses aggregation to keep grid manageable
  $: visualShardCount = factor <= 5 ? shardCount : Math.min(shardCount, 64 * 64);
  $: shardsPerCell = Math.ceil(shardCount / visualShardCount);

  // ============================================================================
  // DERIVATION LOGIC
  // ============================================================================

  function syncWorkerCounts(): void {
    workerCount = workers.length;
    activeWorkerCount = workers.length - drainingWorkers.size;
  }

  function isWorkerDraining(worker: Worker): boolean {
    return drainingWorkers.has(worker);
  }

  function markWorkerDraining(worker: Worker): void {
    if (!drainingWorkers.has(worker)) {
      drainingWorkers.add(worker);
      syncWorkerCounts();
    }
  }

  function shutdownWorker(worker: Worker): void {
    workerActiveShard.delete(worker);
    drainingWorkers.delete(worker);
    const index = workers.indexOf(worker);
    if (index >= 0) {
      workers.splice(index, 1);
    }
    worker.terminate();
    syncWorkerCounts();
  }

  function workerErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err && typeof err === 'object' && 'message' in err) {
      return String((err as { message?: unknown }).message ?? 'Worker failed');
    }
    return String(err || 'Worker failed');
  }

  function hasPendingShardWork(): boolean {
    return retryShardQueue.length > 0 || nextShardToDispatch < shardCount;
  }

  function requeueShard(shardIndex: number, message: string): boolean {
    if (shardResults.has(shardIndex)) return true;
    const attempts = (shardRetryCounts.get(shardIndex) ?? 0) + 1;
    shardRetryCounts.set(shardIndex, attempts);
    if (attempts > 3) {
      derivationError = `BrainVault shard ${shardIndex + 1} failed repeatedly: ${message}`;
      return false;
    }
    if (!retryShardQueue.includes(shardIndex)) {
      retryShardQueue.unshift(shardIndex);
    }
    shardStatus[shardIndex] = 'pending';
    shardStatus = shardStatus;
    return true;
  }

  function reduceWorkerCapAfterMemoryError(message: string): void {
    const current = Math.max(activeWorkerCount, effectiveTargetWorkerCount, 1);
    const reduced = nextBrainVaultWorkerCapAfterFailure(current);
    maxWorkers = Math.max(1, Math.min(maxWorkers, reduced));
    persistWorkerCap(maxWorkers);
    targetWorkerCount = Math.max(1, Math.min(targetWorkerCount, maxWorkers));
    workerLimitNotice = `Browser memory pressure detected. BrainVault is continuing with ${maxWorkers} worker${maxWorkers === 1 ? '' : 's'}.`;
    console.warn(`[BrainVault] Wasm memory pressure; reduced worker cap to ${maxWorkers} and persisted it. ${message}`);
  }

  function failDerivation(message: string): void {
    derivationError = message;
    terminateWorkers();
    phase = 'input';
  }

  function handleWorkerFailure(worker: Worker, err: unknown): void {
    const message = workerErrorMessage(err);
    const shardIndex = workerActiveShard.get(worker);
    console.error('[BrainVault] Worker failed:', message);

    if (typeof shardIndex === 'number' && !requeueShard(shardIndex, message)) {
      failDerivation(derivationError || message);
      return;
    }

    const memoryError = isBrainVaultWasmMemoryError(message);
    shutdownWorker(worker);

    if (memoryError) {
      reduceWorkerCapAfterMemoryError(message);
      if (maxWorkers <= 1 && activeWorkerCount === 0 && hasPendingShardWork()) {
        console.warn('[BrainVault] Retrying with a single worker after Wasm memory failure');
      }
    }

    if (activeWorkerCount === 0 && hasPendingShardWork()) {
      void adjustWorkers();
    }
  }

  function attachWorkerHandlers(
    worker: Worker,
    opts: { onReady?: () => void; onError?: (err: unknown) => void; handleErrors?: boolean } = {}
  ): void {
    worker.onmessage = (e) => {
      const { type, data } = e.data;

      if (type === 'ready') {
        opts.onReady?.();
      } else if (type === 'probe_result') {
        estimatedShardTimeMs = data.estimatedShardTimeMs;
      } else if (type === 'shard_complete') {
        handleShardComplete(worker, data.shardIndex, data.resultHex, data.elapsedMs);
      } else if (type === 'error') {
        const error = data?.message ?? 'Worker failed';
        opts.onError?.(error);
        if (opts.handleErrors !== false) {
          handleWorkerFailure(worker, error);
        }
      }
    };

    worker.onerror = (e) => {
      console.error('[BrainVault] Worker error:', e);
      opts.onError?.(e);
      if (opts.handleErrors !== false) {
        handleWorkerFailure(worker, e);
      }
    };
  }

  async function startDerivation() {
    derivationError = '';
    // === MNEMONIC MODE: Skip argon2, use mnemonic directly ===
    if (inputMode === 'mnemonic') {
      phase = 'deriving';
      try {
        const cleanMnemonic = mnemonicInput.trim().split(/\s+/).join(' ');
        mnemonic24 = cleanMnemonic;
        // Imported mnemonic is canonical as entered; no extra compatibility phrase.
        mnemonic12 = '';

        ethereumAddress = await deriveEthereumAddress(mnemonic24);
        createLoginType = 'manual';
        await prepareRecoveryDecisionFromCurrentSeed(`Mnemonic ${ethereumAddress.slice(0, 6)}`);
        await continueAfterRecoveryDiscovery();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to import mnemonic';
        console.error('[RuntimeCreation] Mnemonic import failed:', err);
        derivationError = message;
        phase = 'input';
      }
      return;
    }

    // === BRAINVAULT MODE: Full argon2 derivation ===
    shardCount = isPreset ? getShardCount(shardInput) : shardInput;
    const initialUsableCap = Math.max(1, Math.min(maxWorkers, shardCount));
    let initialWorkers = Math.min(effectiveTargetWorkerCount, initialUsableCap);
    workerCount = initialWorkers;
    activeWorkerCount = initialWorkers;
    finalizeInProgress = false;
    phase = 'deriving';
    derivationError = '';
    workerLimitNotice = '';
    retryShardQueue = [];
    shardRetryCounts.clear();
    shardsCompleted = 0;
    shardResults = new Map();
    shardStatus = Array(shardCount).fill('pending');

    // Start with the exact worker count the UI is allowed to request.
    const cpuCores = navigator.hardwareConcurrency || 4;

    try {
      let attempts = 0;
      while (true) {
        // Create workers
        workers = [];
        drainingWorkers.clear();
        const workerPromises: Promise<void>[] = [];

        for (let i = 0; i < initialWorkers; i++) {
          const worker = new Worker('/brainvault-worker.js');
          workers.push(worker);

          const initPromise = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 30000);
            attachWorkerHandlers(worker, {
              onReady: () => {
                clearTimeout(timeout);
                resolve();
              },
              onError: (err) => {
                clearTimeout(timeout);
                reject(new Error(workerErrorMessage(err)));
              },
              handleErrors: false,
            });
          });

          worker.postMessage({ type: 'init', id: i });
          workerPromises.push(initPromise);
        }

        try {
          syncWorkerCounts();
          await Promise.all(workerPromises);
          break;
        } catch (err) {
          terminateWorkers();
          const message = workerErrorMessage(err);
          if (attempts < 4 && isBrainVaultWasmMemoryError(message) && initialWorkers > 1) {
            const reduced = nextBrainVaultWorkerCapAfterFailure(initialWorkers);
            if (reduced === initialWorkers) {
              throw err;
            }
            initialWorkers = reduced;
            maxWorkers = Math.max(1, Math.min(maxWorkers, reduced));
            persistWorkerCap(maxWorkers);
            workerCount = initialWorkers;
            activeWorkerCount = initialWorkers;
            targetWorkerCount = Math.min(targetWorkerCount, initialWorkers);
            attempts += 1;
            workerLimitNotice = `Browser memory pressure detected. BrainVault is retrying with ${initialWorkers} worker${initialWorkers === 1 ? '' : 's'}.`;
            console.warn(`[BrainVault] Reducing workers to ${initialWorkers} after init failure: ${message}`);
            continue;
          }
          throw err;
        }
      }

      // Probe is cheap on desktop, but on iOS/WebKit we avoid extra wasm churn.
      if (!isIOSFamilyWebKit) {
        workers[0]?.postMessage({ type: 'probe', id: 0 });
        await new Promise(r => setTimeout(r, 500));
      }

      // Dispatch initial shards
      dispatchShards(name);
    } catch (err) {
      const message = workerErrorMessage(err);
      console.error('Failed to initialize workers:', message);
      terminateWorkers();
      derivationError = isBrainVaultWasmMemoryError(message)
        ? `BrainVault could not allocate browser Wasm memory. Reduce other tabs or retry with 1 worker. ${message}`
        : `BrainVault worker initialization failed: ${message}`;
      phase = 'input';
    }
  }

  let nextShardToDispatch = 0;
  let finalizeInProgress = false;

  function dispatchShards(name: string) {
    nextShardToDispatch = 0;

    // Dispatch initial shard to each worker
    for (let i = 0; i < workers.length && nextShardToDispatch < shardCount; i++) {
      dispatchNextShard(workers[i]!);
    }
  }

  function dispatchNextShard(worker: Worker) {
    if (isWorkerDraining(worker)) return;
    while (nextShardToDispatch < shardCount && shardResults.has(nextShardToDispatch)) {
      nextShardToDispatch++;
    }
    while (retryShardQueue.length > 0 && shardResults.has(retryShardQueue[0]!)) {
      retryShardQueue.shift();
    }
    if (retryShardQueue.length === 0 && nextShardToDispatch >= shardCount) return;

    const shardIndex = retryShardQueue.length > 0 ? retryShardQueue.shift()! : nextShardToDispatch++;
    shardStatus[shardIndex] = 'computing';
    shardStatus = shardStatus; // Trigger reactivity
    workerActiveShard.set(worker, shardIndex);

    worker.postMessage({
      type: 'derive_shard',
      id: shardIndex,
      data: {
        name: name,
        passphrase,
        shardIndex,
        shardCount,
      }
    });
  }

  async function handleShardComplete(worker: Worker, shardIndex: number, resultHex: string, elapsedMs: number) {
    workerActiveShard.delete(worker);
    if (shardResults.has(shardIndex)) {
      return;
    }

    shardResults.set(shardIndex, hexToBytes(resultHex));
    shardStatus[shardIndex] = 'complete';
    shardStatus = shardStatus;
    shardsCompleted = shardResults.size;

    // Update time estimate (exponential moving average)
    estimatedShardTimeMs = estimatedShardTimeMs * 0.7 + elapsedMs * 0.3;

    if (isWorkerDraining(worker)) {
      shutdownWorker(worker);
    } else {
      dispatchNextShard(worker);
    }

    // Check if all done
    if (!finalizeInProgress && shardResults.size >= shardCount) {
      finalizeInProgress = true;
      try {
        await finalizeDeriv();
      } catch (err) {
        finalizeInProgress = false;
        throw err;
      }
    }
  }

  async function finalizeDeriv() {
    terminateWorkers();

    // Collect results in order
    const orderedResults: Uint8Array[] = [];
    for (let i = 0; i < shardCount; i++) {
      const shard = shardResults.get(i);
      if (!shard) throw new Error(`Missing shard ${i}`);
      orderedResults.push(shard);
    }

    const masterKey = await combineShards(orderedResults, factor);

    // Derive BIP39 mnemonic (24 words)
    const entropy = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
    mnemonic24 = await entropyToMnemonic(entropy);
    const entropy12 = await deriveKey(masterKey, 'bip39/entropy-128/v1.0', 16);
    mnemonic12 = await entropyToMnemonic(entropy12);

    // Derive device passphrase
    const deviceKey = await deriveKey(masterKey, 'bip39/passphrase/v1.0', 32);
    devicePassphrase = bytesToHex(deviceKey);

    // Derive Ethereum address using the standard path (m/44'/60'/0'/0/0)
    ethereumAddress = await deriveEthereumAddress(mnemonic24);
    // Entity ID is a lazy entity ID for a single-signer quorum (matches runtime algorithm)
    entityId = generateLazyEntityIdPreview([ethereumAddress], 1n);

    await prepareRecoveryDecisionFromCurrentSeed(name.trim() || `Wallet ${ethereumAddress.slice(0, 6)}`);
    await continueAfterRecoveryDiscovery();
  }

  function terminateWorkers() {
    for (const worker of workers) {
      worker?.terminate();
    }
    workers = [];
    drainingWorkers.clear();
    workerActiveShard.clear();
    syncWorkerCounts();
  }

  // Dynamic worker scaling based on user slider
  async function adjustWorkers() {
    if (phase !== 'deriving') return;

    const currentCount = activeWorkerCount;
    const target = Math.min(effectiveTargetWorkerCount, usableWorkerCap);

    if (target < currentCount) {
      // Scale down: drain excess workers (no new shards assigned)
      const activeWorkers = workers.filter(worker => !drainingWorkers.has(worker));
      const excess = currentCount - target;
      const toDrain = activeWorkers.slice(-1 * excess);
      for (const worker of toDrain) {
        markWorkerDraining(worker);
      }
    } else if (target > currentCount && hasPendingShardWork()) {
      // Scale up: add more workers
      const workersToAdd = target - currentCount;
      const currentTotal = workers.length;

      for (let i = 0; i < workersToAdd && hasPendingShardWork(); i++) {
        const worker = new Worker('/brainvault-worker.js');
        workers.push(worker);

        attachWorkerHandlers(worker, {
          onReady: () => {
            dispatchNextShard(worker);
          },
        });

        worker.postMessage({ type: 'init', id: currentTotal + i });
      }
    }
    syncWorkerCounts();
  }



  function reset() {
    phase = 'input';
    terminateWorkers();
    resetRecoveryDecision();
    workerLimitNotice = '';
    createLoginType = 'manual';
    // Keep name and passphrase for convenience
    mnemonic24 = '';
    mnemonic12 = '';
    devicePassphrase = '';
    ethereumAddress = '';
    entityId = '';
    creatingRuntime = false;
    shardsCompleted = 0;
    shardResults = new Map();
    shardStatus = [];
  }

  onDestroy(() => {
    terminateWorkers();
  });

  // Check for saved resume on mount + init i18n
  onMount(() => {
    let unsubscribe: (() => void) | undefined;

    // Restore the saved auth scheme (dark default)
    if (typeof localStorage !== 'undefined' && localStorage.getItem(AUTH_SCHEME_STORAGE_KEY) === 'light') {
      scheme = 'light';
    }

    // Auto-discover live runtimes (hubs) for the connect dropdown.
    // Silent: a login screen without a reachable runtime server must not show a fetch error.
    void discoverLiveRuntimes(true);

    // Run async init
    (async () => {
      // Init i18n
      await initI18n();

      // Watch for locale changes
      unsubscribe = locale.subscribe(async (loc) => {
        await loadTranslations(loc);
      });

      // No auto-login — user must create/login manually
    })();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  });

</script>

<div class="brainvault-wrapper" class:embedded class:scheme-light={scheme === 'light'}>
  <!-- Hierarchical Navigation (only in standalone mode) -->
  {#if !embedded}
    <HierarchicalNav />
  {/if}

	    <!-- Main Wallet Content -->
  <div class="brainvault-container" class:deriving={phase === 'deriving'}>
    <!-- Ambient particles disabled for minimalist mode -->

    <!-- Scheme toggle (dark "vault" <-> light "minimalist") -->
    <div class="scheme-toggle" role="group" aria-label="Color scheme">
        <button
          type="button"
          class:active={scheme === 'dark'}
          aria-pressed={scheme === 'dark'}
          aria-label="Dark scheme"
          on:click={() => setScheme('dark')}
          title="Dark"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
          </svg>
        </button>
        <button
          type="button"
          class:active={scheme === 'light'}
          aria-pressed={scheme === 'light'}
          aria-label="Light scheme"
          on:click={() => setScheme('light')}
          title="Light"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4.2"/>
            <path d="M12 2.4v2.4M12 19.2v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.4 12h2.4M19.2 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/>
          </svg>
        </button>
      </div>

  <!-- Header - minimalist (no logo, clean fintech UI) -->
  <div class="header" class:deriving={phase === 'deriving'}>
  </div>

  <!-- Main Content -->
  <div class="main-content">
    <!-- INPUT SECTION - Always visible at top -->
    {#if phase === 'input' || phase === 'deriving'}
      <div class="glass-card input-section" class:deriving={phase === 'deriving'}>
        {#if embedded && savedVaults.length > 0}
          <div class="creation-context-bar">
            <div class="creation-context-copy">Create another wallet</div>
            <button type="button" class="back-to-create" on:click={() => vaultUiOperations.hideVault()}>
              Back to wallet
            </button>
          </div>
        {/if}

        <div class="wallet-create-title">
          <div>
            <h2>{inputMode === 'mnemonic' ? 'Import xln wallet' : 'Create xln wallet'}</h2>
            <p>{inputMode === 'mnemonic'
              ? 'Recover from an existing mnemonic. New wallets start from the main creation form.'
              : 'Enter a display name and secret. The wallet opens automatically when derivation finishes.'}</p>
          </div>
        </div>

        <div class="input-mode-tabs" role="tablist" aria-label="Wallet setup mode">
          <button
            type="button"
            role="tab"
            aria-selected={inputMode === 'brainvault'}
            class:selected={inputMode === 'brainvault'}
            on:click={() => inputMode = 'brainvault'}
          >
            BrainVault
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={inputMode === 'mnemonic'}
            class:selected={inputMode === 'mnemonic'}
            on:click={() => inputMode = 'mnemonic'}
          >
            Mnemonic
          </button>
        </div>

        <div class="quick-login-section">
          <div class="quick-login-header">
            <span class="ql-title">Quick login</span>
            <span class="ql-temp">sandbox · resets on reload</span>
          </div>
          <div class="quick-login-grid">
            {#each DEMO_GROUPS as group, gi}
              {#if gi > 0}
                <span class="ql-divider" aria-hidden="true"></span>
              {/if}
              <div class="ql-group">
                {#each group as account}
                  <button
                    class="quick-login-btn role-{account.role}"
                    class:wide={account.label.length > 2}
                    type="button"
                    title={account.role === 'hub' ? 'Hub' : account.role === 'app' ? 'App entity' : 'User'}
                    on:click={() => {
                      name = account.name;
                      passphrase = account.password;
                      shardInput = account.factor;
                      inputMode = 'brainvault';
                      createLoginType = 'demo';
                      setTimeout(() => startDerivation(), 100);
                    }}
                  >
                    {account.label}
                  </button>
                {/each}
              </div>
            {/each}
          </div>
        </div>

          <!-- Connect to a live remote runtime (radapter, read-only) -->
          <div class="live-runtime-section">
            <div class="live-runtime-header">
              <span class="ql-title">Connect to live runtime</span>
              <button
                type="button"
                class="live-refresh"
                title="Refresh"
                aria-label="Refresh live runtimes"
                disabled={liveRuntimesLoading}
                on:click={() => discoverLiveRuntimes()}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class:spinning={liveRuntimesLoading}>
                  <path d="M21 2v6h-6M3 22v-6h6M3.51 9a9 9 0 0114.13-3.36L21 8M3 16l3.36 2.36A9 9 0 0020.49 15"/>
                </svg>
              </button>
            </div>

            {#if liveRuntimes.length > 0}
              <div class="live-runtime-row">
                <select
                  class="live-runtime-select"
                  bind:value={selectedRuntimeKey}
                  disabled={!!connectingRuntimeId}
                >
                  <option value="" disabled>Select a runtime…</option>
                  {#each liveRuntimes as rt}
                    <option value={rt.wsUrl}>{rt.label} · {new URL(rt.wsUrl).host}</option>
                  {/each}
                </select>
                <button
                  type="button"
                  class="live-connect-btn"
                  disabled={!selectedRuntimeKey || !!connectingRuntimeId}
                  on:click={connectSelectedRuntime}
                >
                  {connectingRuntimeId ? 'Connecting…' : `Connect · ${selectedRuntimeAccessLabel()}`}
                </button>
              </div>
            {:else if liveRuntimesLoading}
              <div class="live-runtime-hint">Discovering live runtimes…</div>
            {:else if liveRuntimesLoaded}
              <div class="live-runtime-hint">No live runtimes online.</div>
            {/if}

            {#if liveRuntimesError}
              <div class="live-runtime-error">{liveRuntimesError}</div>
            {/if}
          </div>

        {#if inputMode === 'brainvault'}
        <!-- Name Input -->
        <div class="input-group">
          <label for="name">Name <span class="label-aside">for seed derivation</span></label>
	          <span class="input-hint">Becomes the wallet and public entity name.</span>
          <div class="input-wrapper">
            <input
              type="text"
              id="name"
              bind:value={name}
              placeholder={t('vault.name.placeholder')}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
        </div>

        <!-- Passphrase Input -->
        <div class="input-group">
          <label for="passphrase">{t('vault.password.label')}</label>
	          <span class="input-hint">Used locally to derive the wallet seed.</span>
          <div class="input-wrapper">
            <input
              type={showPassphrase ? 'text' : 'password'}
              id="passphrase"
              bind:value={passphrase}
              placeholder={t('vault.password.placeholder')}
              autocomplete="off"
              spellcheck="false"
            />
            <button
              class="toggle-visibility"
              on:click={() => showPassphrase = !showPassphrase}
              type="button"
              aria-label="Toggle passphrase visibility"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                {#if showPassphrase}
                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                {:else}
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                {/if}
              </svg>
            </button>
            <button
              class="suggest-btn"
              on:click={suggestPassphrase}
              type="button"
              title="Suggest random passphrase"
              aria-label="Suggest random passphrase"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M20 7h-9m9 10h-9M4 7h.01M4 17h.01M7 4l-3 3 3 3M7 17l-3 3 3 3"/>
              </svg>
            </button>
          </div>
          {#if passphrase}
            <div class="strength-meter">
              <div
                class="strength-bar"
                style="width: {Math.min(100, passwordStrength.bits)}%; background: {passwordStrength.color}"
              ></div>
            </div>
            <span class="strength-text" style="color: {passwordStrength.color}">
              {passwordStrength.bits} bits phrase + {workFactorBits} bits work factor = {totalSecurityBits} bits
            </span>
          {/if}
        </div>

        <!-- Advanced options - collapsed by default to keep the screen minimal -->
        <button
          type="button"
          class="advanced-toggle"
          class:open={showAdvanced}
          aria-expanded={showAdvanced}
          on:click={() => showAdvanced = !showAdvanced}
        >
          <span class="advanced-toggle-main">
            <span class="advanced-toggle-label">Security work factor</span>
            <span class="advanced-toggle-summary">{factorInfo.tier} · {factorInfo.shards.toLocaleString()} shards · {factorInfo.time}</span>
          </span>
          <svg class="advanced-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        {#if showAdvanced}
          <div class="input-group factor-group advanced-panel">
            <div class="factor-buttons">
              {#each FACTOR_INFO as info, i}
                <button
                  type="button"
                  class="factor-btn"
                  class:selected={shardInput === info.factor}
                  on:click={() => shardInput = info.factor}
                >
                  <span class="factor-num">{info.factor}</span>
                  <span class="factor-tier">{info.tier}</span>
                </button>
              {/each}
              <button
                type="button"
                class="factor-btn custom-btn"
                class:selected={!isPreset}
                on:click={() => { if (isPreset) shardInput = 6; }}
              >
                <span class="factor-num">⚙</span>
                <span class="factor-tier">Custom</span>
              </button>
            </div>

            {#if !isPreset}
              <div class="custom-shard-input">
                <input
                  type="number"
                  id="shards"
                  min="6"
                  max="100000"
                  bind:value={shardInput}
                  placeholder="6"
                />
                <span class="custom-label">shards</span>
              </div>
            {/if}

            <p class="warning-text">Your inputs generate a unique wallet. Encrypted backups and last-resort dispute services can be configured after the runtime is created.</p>
          </div>
        {/if}
        {:else}
        <!-- Mnemonic Input Mode -->
        <button type="button" class="back-to-create" on:click={() => inputMode = 'brainvault'}>
          Back to wallet creation
        </button>
        <div class="input-group">
          <label for="mnemonic">Mnemonic (12 or 24 words)</label>
          <span class="input-hint">Enter your BIP39 mnemonic phrase</span>
          <div class="input-wrapper">
            <textarea
              id="mnemonic"
              bind:value={mnemonicInput}
              placeholder="word1 word2 word3..."
              rows="3"
              autocomplete="off"
              spellcheck="false"
            ></textarea>
          </div>
        </div>

        <!-- Generate Random Mnemonic Button -->
        <button
          class="generate-mnemonic-btn"
          on:click={generateRandomMnemonic}
          type="button"
        >
          Generate Random Mnemonic
        </button>

        <div class="warning-box">
          <p><strong>Backup required.</strong> Write down these words on paper and store securely. Anyone with this mnemonic controls your funds.</p>
        </div>
        {/if}

        <!-- Derive Button - only visible in input phase -->
        {#if phase === 'input'}
          <button
            class="derive-btn"
            disabled={!canDerive}
            on:click={startDerivation}
          >
	            Open / restore wallet
          </button>
          {#if derivationError}
            <div class="matrix-status error">{derivationError}</div>
          {/if}
          {#if hasAnyPersistedState}
            <button
              class="reset-link"
              on:click={handleResetEverything}
            >
              Reset everything
            </button>
          {/if}
        {/if}

        {#if phase === 'deriving'}
          <div class="input-progress">
            <div class="clean-progress-container">
              <div class="simple-progress">
                <div class="pyramid-logo" style="--progress: {progress}%">
                </div>
                <div class="pyramid-progress-text">{Math.floor(progress)}%</div>

                <div class="pyramid-stats">
                  <div class="stat-row">
                    <span class="stat-label">STATUS</span>
                    <span class="stat-value">{creatingRuntime ? 'CREATING RUNTIME' : recoveryChecking ? 'CHECKING BACKUPS' : 'DERIVING SEED'}</span>
                  </div>
                  <div class="stat-row">
                    <span class="stat-label">SHARDS</span>
                    <span class="stat-value">{shardsCompleted}/{shardCount}</span>
                  </div>
                  <div class="stat-row">
                    <span class="stat-label">THREADS</span>
                    <span class="stat-value">{activeWorkerCount}/{usableWorkerCap}</span>
                  </div>
                  <div class="stat-row">
                    <span class="stat-label">MEMORY</span>
                    <span class="stat-value">{formatMemoryLabel(allocatedMemoryMB)}</span>
                  </div>
                </div>

                <div class="pyramid-progress-bar">
                  <div class="pyramid-progress-fill" style="width: {progress}%"></div>
                </div>

                <div class="speed-control">
                  <div class="speed-header">
                    <span class="speed-label">SPEED</span>
                    <span class="speed-eta">ETA: {formatRuntimeDurationRounded(projectedRemainingMs)}</span>
                  </div>
                  <div class="speed-slider-wrapper">
                    <input
                      type="range"
                      min="1"
                      max={usableWorkerCap}
                      bind:value={targetWorkerCount}
                      on:input={adjustWorkers}
                      class="speed-slider"
                    />
                  </div>
                  <div class="speed-details">
                    <span class="speed-threads">{activeWorkerCount} active / {usableWorkerCap} cap</span>
                    <span class="speed-memory">{formatMemoryLabel(allocatedMemoryMB)} RAM</span>
                  </div>
                  {#if workerLimitNotice}
                    <div class="speed-warning">{workerLimitNotice}</div>
                  {/if}
                </div>
              </div>

              <div class="mini-shard-grid" style="--cols: {Math.ceil(Math.sqrt(visualShardCount))}">
                {#each Array(visualShardCount) as _, cellIdx}
                  {@const startShard = cellIdx * shardsPerCell}
                  {@const endShard = Math.min(startShard + shardsPerCell, shardCount)}
                  {@const cellShards = shardStatus.slice(startShard, endShard)}
                  {@const completedInCell = cellShards.filter(s => s === 'complete').length}
                  {@const computingInCell = cellShards.filter(s => s === 'computing').length}
                  {@const cellProgress = completedInCell / cellShards.length}
                  <div
                    class="mini-shard"
                    class:pending={cellProgress === 0 && computingInCell === 0}
                    class:computing={computingInCell > 0}
                    class:complete={cellProgress === 1}
                  ></div>
                {/each}
              </div>

              <div class="anim-controls">
                <button class="control-btn cancel" on:click={reset} title="Cancel derivation">Cancel</button>
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if phase === 'recovery'}
      <div class="glass-card input-section recovery-decision-card">
        <div class="wallet-create-title">
          <div>
            <h2>Restore wallet</h2>
            <p>Seed resolved for {shortRuntimeId(recoveryRuntimeId)}. Checking encrypted backups before any new runtime is created.</p>
          </div>
          <button type="button" class="back-to-create compact" on:click={reset}>
            Back
          </button>
        </div>

        <div class="recovery-status-strip">
          <div>
            <span class="recovery-label">Runtime</span>
            <strong>{shortRuntimeId(recoveryRuntimeId)}</strong>
          </div>
          <div>
            <span class="recovery-label">Towers checked</span>
            <strong>{recoveryChecking ? 'checking...' : recoveryCheckedTowers}</strong>
          </div>
          <div>
            <span class="recovery-label">Remote peers checked</span>
            <strong>{recoveryChecking ? 'checking...' : recoveryCheckedPeers}</strong>
          </div>
          <div>
            <span class="recovery-label">Backups found</span>
            <strong>{recoveryCandidates.length}</strong>
          </div>
        </div>

        {#if recoveryChecking}
          <div class="recovery-loading">
            <div class="recovery-spinner"></div>
            <span>Asking configured towers and saved remote runtimes for encrypted backups...</span>
          </div>
        {:else}
          {#if recoveryCandidates.length > 0}
            <div class="recovery-candidate-list" role="radiogroup" aria-label="Recovery backup versions">
              {#each recoveryCandidates as candidate, index (candidate.id)}
                <button
                  type="button"
                  class="recovery-candidate"
                  class:selected={selectedRecoveryCandidateId === candidate.id || (!selectedRecoveryCandidateId && index === 0)}
                  on:click={() => selectedRecoveryCandidateId = candidate.id}
                >
                  <span class="candidate-main">
                    <strong>{index === 0 ? 'Latest backup' : 'Backup version'}</strong>
                    <span>{candidate.source === 'tower' ? candidate.towerUrl : candidate.sourceLabel}</span>
                  </span>
                  <span class="candidate-meta">
                    <span>height {candidate.runtimeHeight.toLocaleString()}</span>
                    <span>{candidate.signerCount} signer{candidate.signerCount === 1 ? '' : 's'}</span>
                    <span>{formatRecoveryTime(candidate.createdAt)}</span>
                  </span>
                </button>
              {/each}
            </div>

            <div class="recovery-actions">
              <button
                type="button"
                class="derive-btn"
                disabled={!selectedRecoveryCandidate || creatingRuntime}
                on:click={restoreSelectedRecoveryCandidate}
              >
                {creatingRuntime ? 'Restoring...' : 'Restore selected backup'}
              </button>
              <button type="button" class="backup-upload-btn" on:click={triggerBackupFilePicker}>
                I have a runtime backup file
              </button>
            </div>
          {/if}

          {#if recoveryErrors.length > 0}
            <div class="matrix-status error">
              Recovery check warnings: {recoveryErrors.slice(0, 3).join(' | ')}
            </div>
          {/if}
          {#if derivationError}
            <div class="matrix-status error">{derivationError}</div>
          {/if}
        {/if}

        <input
          bind:this={backupFileInput}
          class="backup-file-input"
          type="file"
          accept="application/json,.json"
          on:change={handleBackupFileSelected}
        />
      </div>
    {/if}
  </div>
  <!-- Close main-content -->
</div>
<!-- Close brainvault-container -->
</div>
<!-- Close brainvault-wrapper -->

<style>
  /* Quick Login */
  .wallet-create-title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }

  .wallet-create-title h2 {
    margin: 0 0 6px;
    color: rgba(255, 255, 255, 0.94);
    font-size: 24px;
    line-height: 1.12;
    letter-spacing: 0;
  }

  .wallet-create-title p {
    margin: 0;
    max-width: 560px;
    color: rgba(255, 255, 255, 0.54);
    font-size: 13px;
    line-height: 1.45;
  }

  .back-to-create {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    padding: 8px 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.84);
    font-size: 12px;
    font-weight: 650;
    text-decoration: none;
    cursor: pointer;
    box-sizing: border-box;
  }

  .back-to-create:hover {
    border-color: rgba(255, 200, 100, 0.24);
    color: rgba(255, 200, 100, 0.95);
    background: rgba(255, 200, 100, 0.08);
  }

  .back-to-create {
    width: 100%;
    margin-bottom: 14px;
  }

  .back-to-create.compact {
    width: auto;
    min-width: 88px;
    margin-bottom: 0;
  }

  .recovery-decision-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .recovery-status-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }

  .recovery-status-strip > div {
    min-height: 62px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
    box-sizing: border-box;
  }

  .recovery-label {
    display: block;
    margin-bottom: 6px;
    color: rgba(255, 255, 255, 0.48);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .recovery-status-strip strong {
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .recovery-loading {
    min-height: 76px;
    padding: 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
    display: flex;
    align-items: center;
    gap: 12px;
    color: rgba(255, 255, 255, 0.72);
    box-sizing: border-box;
  }

  .recovery-spinner {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: rgba(255, 200, 100, 0.9);
    animation: spin 0.9s linear infinite;
    flex: 0 0 auto;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .recovery-candidate-list {
    display: grid;
    gap: 8px;
  }

  .recovery-candidate {
    width: 100%;
    min-height: 78px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.035);
    color: rgba(255, 255, 255, 0.78);
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    gap: 12px;
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
  }

  .recovery-candidate.selected {
    border-color: rgba(255, 200, 100, 0.42);
    background: rgba(255, 200, 100, 0.08);
  }

  .candidate-main,
  .candidate-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .candidate-main strong {
    color: rgba(255, 255, 255, 0.94);
    font-size: 13px;
  }

  .candidate-main span,
  .candidate-meta span {
    color: rgba(255, 255, 255, 0.56);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .recovery-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(180px, 0.45fr);
    gap: 10px;
    align-items: stretch;
  }

  .backup-upload-btn {
    min-height: 46px;
    padding: 11px 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.045);
    color: rgba(255, 255, 255, 0.84);
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }

  .backup-upload-btn:hover {
    border-color: rgba(255, 200, 100, 0.28);
    color: rgba(255, 200, 100, 0.95);
  }

  .backup-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .input-mode-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 12px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
  }

  .input-mode-tabs button {
    min-height: 34px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: rgba(255, 255, 255, 0.64);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .input-mode-tabs button:hover {
    color: rgba(255, 255, 255, 0.9);
    background: rgba(255, 255, 255, 0.04);
  }

  .input-mode-tabs button.selected {
    border-color: rgba(255, 200, 100, 0.28);
    background: rgba(255, 200, 100, 0.1);
    color: rgba(255, 218, 150, 0.96);
  }

  .quick-login-section {
    margin-bottom: 14px;
    padding: 10px 12px 12px;
    background: rgba(255, 255, 255, 0.012);
    border: 1px dashed rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    width: 100%;
    box-sizing: border-box;
  }
  .quick-login-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 9px;
  }
  .ql-title {
    font-size: 10px;
    font-weight: 700;
    color: rgba(156, 163, 175, 0.85);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .ql-temp {
    font-size: 9.5px;
    font-weight: 600;
    color: rgba(156, 163, 175, 0.5);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .quick-login-grid {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  .ql-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ql-divider {
    flex: 0 0 auto;
    align-self: stretch;
    width: 1px;
    min-height: 24px;
    margin: 0 3px;
    background: rgba(255, 255, 255, 0.12);
  }
  .quick-login-btn {
    flex: 0 0 auto;
    min-width: 38px;
    padding: 7px 9px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 7px;
    color: rgba(255, 255, 255, 0.88);
    font-weight: 650;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    min-height: 32px;
  }
  .quick-login-btn.wide {
    padding-left: 12px;
    padding-right: 12px;
  }
  .quick-login-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.18);
    color: rgba(255, 255, 255, 0.98);
  }
  /* Hubs = amber (routing infrastructure) */
  .quick-login-btn.role-hub {
    background: rgba(251, 191, 36, 0.08);
    border-color: rgba(251, 191, 36, 0.28);
    color: rgba(253, 215, 150, 0.95);
  }
  .quick-login-btn.role-hub:hover {
    background: rgba(251, 191, 36, 0.16);
    border-color: rgba(251, 191, 36, 0.5);
    color: rgba(255, 224, 168, 1);
  }
  /* App entities = teal (custody app / MM user) */
  .quick-login-btn.role-app {
    background: rgba(45, 212, 191, 0.08);
    border-color: rgba(45, 212, 191, 0.28);
    color: rgba(153, 246, 228, 0.95);
  }
  .quick-login-btn.role-app:hover {
    background: rgba(45, 212, 191, 0.16);
    border-color: rgba(45, 212, 191, 0.5);
    color: rgba(178, 248, 233, 1);
  }

  .label-aside {
    font-weight: 400;
    letter-spacing: 0.04em;
    text-transform: none;
    color: rgba(255, 255, 255, 0.32);
  }

  /* Advanced toggle (collapses the security work factor) */
  .advanced-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 16px;
    padding: 11px 14px;
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.85);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
    text-align: left;
  }
  .advanced-toggle:hover {
    background: rgba(255, 255, 255, 0.045);
    border-color: rgba(255, 200, 100, 0.2);
  }
  .advanced-toggle-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .advanced-toggle-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(180, 140, 80, 0.85);
  }
  .advanced-toggle-summary {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    font-family: 'SF Mono', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .advanced-chevron {
    flex: 0 0 auto;
    color: rgba(255, 255, 255, 0.5);
    transition: transform 0.2s ease;
  }
  .advanced-toggle.open .advanced-chevron {
    transform: rotate(180deg);
  }
  .advanced-panel {
    margin-top: -4px;
  }

  /* Connect to live runtime (radapter) */
  .live-runtime-section {
    margin-bottom: 14px;
    padding: 10px 12px 12px;
    background: rgba(255, 255, 255, 0.012);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 8px;
  }
  .live-runtime-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 9px;
  }
  .live-refresh {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  .live-refresh:hover:not(:disabled) {
    color: rgba(255, 200, 100, 0.95);
    border-color: rgba(255, 200, 100, 0.24);
  }
  .live-refresh:disabled { cursor: default; opacity: 0.6; }
  .live-refresh .spinning { animation: spin 0.9s linear infinite; }
  .live-runtime-row {
    display: flex;
    gap: 8px;
  }
  .live-runtime-select {
    flex: 1;
    min-width: 0;
    min-height: 36px;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 7px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    cursor: pointer;
  }
  .live-runtime-select:focus {
    outline: none;
    border-color: rgba(255, 200, 100, 0.4);
  }
  .live-connect-btn {
    flex: 0 0 auto;
    min-height: 36px;
    padding: 8px 14px;
    background: rgba(255, 200, 100, 0.1);
    border: 1px solid rgba(255, 200, 100, 0.3);
    border-radius: 7px;
    color: rgba(255, 218, 150, 0.96);
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
    white-space: nowrap;
  }
  .live-connect-btn:hover:not(:disabled) {
    background: rgba(255, 200, 100, 0.18);
    border-color: rgba(255, 200, 100, 0.5);
  }
  .live-connect-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .live-runtime-hint {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.42);
  }
  .live-runtime-error {
    margin-top: 8px;
    font-size: 11.5px;
    line-height: 1.4;
    color: rgba(255, 145, 120, 0.95);
    overflow-wrap: anywhere;
  }

  .brainvault-wrapper {
    width: 100%;
    height: 100%;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: visible;
  }

  .brainvault-wrapper.embedded {
    height: auto;
    min-height: 0;
    overflow: visible;
  }

  .brainvault-container {
    flex: 1;
    width: 100%;
    padding: 20px;
    background: #000;
    background-image:
      radial-gradient(ellipse at 50% 0%, rgba(180, 140, 80, 0.08) 0%, transparent 50%),
      radial-gradient(ellipse at 50% 20%, rgba(120, 90, 50, 0.05) 0%, transparent 40%),
      linear-gradient(180deg, #0a0806 0%, #000 100%);
    position: relative;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .brainvault-wrapper.embedded .brainvault-container {
    overflow: visible;
    background: linear-gradient(180deg, #0b0f14 0%, #06080b 100%);
    background-image: none;
  }

  .brainvault-wrapper.embedded .glass-card {
    border-radius: 12px;
    border-color: rgba(255, 255, 255, 0.08);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  }

  .brainvault-wrapper.embedded .input-section.deriving {
    padding-bottom: 8px;
  }

  .brainvault-wrapper.embedded .input-progress {
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .brainvault-wrapper.embedded .input-progress .clean-progress-container {
    gap: 8px;
  }

  .brainvault-wrapper.embedded .input-progress .pyramid-logo {
    display: none;
  }

  .brainvault-wrapper.embedded .input-progress .pyramid-progress-text {
    font-size: 36px;
    color: rgba(255, 255, 255, 0.9);
  }

  .brainvault-wrapper.embedded .pyramid-progress-bar {
    background: rgba(255, 255, 255, 0.08);
  }

  .brainvault-wrapper.embedded .pyramid-progress-fill {
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.5));
  }

  .brainvault-wrapper.embedded .mini-shard-grid {
    display: none;
  }

  .brainvault-wrapper.embedded .anim-controls {
    position: static;
    transform: none;
    margin-top: 8px;
  }

  .header {
    text-align: center;
    margin-bottom: 0;
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    transition: all 0.8s ease;
  }

  /* Header shrinks during derivation to give space to the show */
  .header.deriving {
    margin-bottom: 12px;
  }

  .main-content {
    max-width: 520px;
    width: 100%;
    margin: 0 auto;
    position: relative;
    z-index: 1;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    box-sizing: border-box;
    overflow: visible;
  }

  .creation-context-bar {
    width: 100%;
    margin: 0 0 20px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    justify-content: flex-start;
  }

  .creation-context-copy {
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(196, 181, 161, 0.7);
  }

  /* Glass Card - Sacred Chamber */
  .glass-card {
    background: rgba(10, 8, 6, 0.9);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(180, 140, 80, 0.15);
    border-radius: 2px;
    padding: 24px;
    box-shadow:
      0 0 80px rgba(180, 140, 80, 0.05),
      inset 0 1px 0 rgba(180, 140, 80, 0.1);
    position: relative;
  }

  .input-section {
    margin-bottom: 0;
  }

  .input-section.deriving {
    padding-bottom: 18px;
  }

  /* Mnemonic Textarea */
  .input-wrapper textarea {
    width: 100%;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 200, 100, 0.15);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 14px;
    font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
    line-height: 1.6;
    resize: none;
    transition: all 0.2s ease;
    min-height: 120px;
    box-sizing: border-box;
  }

  .input-wrapper textarea:focus {
    outline: none;
    border-color: rgba(255, 200, 100, 0.4);
    background: rgba(255, 255, 255, 0.04);
    box-shadow: 0 0 0 3px rgba(255, 200, 100, 0.08);
  }

  .input-wrapper textarea::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  /* Generate Mnemonic Button */
  .generate-mnemonic-btn {
    width: 100%;
    padding: 14px 24px;
    margin-bottom: 20px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.88);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.5px;
    cursor: pointer;
    transition: all 0.2s ease;
    text-transform: uppercase;
  }

  .generate-mnemonic-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 200, 100, 0.24);
    color: rgba(255, 200, 100, 0.95);
  }

  .input-progress {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 200, 100, 0.12);
  }

  .input-progress .clean-progress-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }

  .input-progress .simple-progress {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .input-progress .pyramid-logo {
    width: 96px;
    height: 96px;
  }

  .input-progress .pyramid-progress-text {
    font-size: 48px;
    letter-spacing: 2px;
  }

  .input-progress .pyramid-stats {
    gap: 20px;
  }

  .input-progress .mini-shard-grid {
    margin: 16px auto 0;
  }

  .input-progress .speed-control {
    width: 100%;
    max-width: 520px;
  }

  .glass-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 60%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(180, 140, 80, 0.4), transparent);
  }

  /* Input Groups - Sacred inscriptions */
  .input-group {
    margin-bottom: 16px;
  }

  .input-group label {
    display: block;
    font-size: 11px;
    font-weight: 400;
    color: rgba(180, 140, 80, 0.8);
    margin-bottom: 6px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }

  .input-hint {
    display: block;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.35);
    margin-bottom: 12px;
    font-style: italic;
  }

  .input-wrapper {
    position: relative;
  }

  .input-wrapper input {
    width: 100%;
    padding: 16px 18px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(180, 140, 80, 0.2);
    border-radius: 2px;
    font-size: 16px;
    color: rgba(255, 255, 255, 0.9);
    transition: all 0.3s;
    box-sizing: border-box;
    letter-spacing: 0.02em;
  }

  .input-wrapper input:focus {
    outline: none;
    border-color: rgba(180, 140, 80, 0.5);
    background: rgba(0, 0, 0, 0.7);
    box-shadow: 0 0 30px rgba(180, 140, 80, 0.1);
  }

  .input-wrapper input::placeholder {
    color: rgba(255, 255, 255, 0.2);
    font-style: italic;
  }

  /* Password toggle */
  .input-wrapper .toggle-visibility {
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: rgba(180, 140, 80, 0.4);
    transition: color 0.3s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .input-wrapper .toggle-visibility:hover {
    color: rgba(180, 140, 80, 0.9);
  }

  .input-wrapper .suggest-btn {
    position: absolute;
    right: 48px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: rgba(180, 140, 80, 0.4);
    transition: color 0.3s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .input-wrapper .suggest-btn:hover {
    color: rgba(180, 140, 80, 0.9);
  }

  .input-wrapper:has(.toggle-visibility) input {
    padding-right: 80px;
  }

  /* Strength Meter */
  .strength-meter {
    height: 2px;
    background: rgba(180, 140, 80, 0.1);
    border-radius: 0;
    margin-top: 10px;
    overflow: hidden;
  }

  .strength-bar {
    height: 100%;
    transition: all 0.3s;
    border-radius: 0;
  }

  .strength-text {
    font-size: 11px;
    margin-top: 6px;
    display: block;
    letter-spacing: 0.05em;
  }

  /* Factor Buttons - Clean Grid */
  .factor-group {
    margin-bottom: 16px;
  }

  .factor-buttons {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    margin-top: 12px;
    width: 100%;
    box-sizing: border-box;
  }

  .factor-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 13px 6px;
    min-height: 60px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
  }

  .factor-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 200, 100, 0.2);
  }

  .factor-btn.selected {
    background: rgba(255, 200, 100, 0.13);
    border-color: rgba(255, 200, 100, 0.52);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 0 0 1px rgba(255, 200, 100, 0.08);
    transform: translateY(-1px);
  }

  .factor-num {
    font-size: 16px;
    font-weight: 600;
    color: rgba(255, 200, 100, 0.9);
    line-height: 1;
  }

  .factor-tier {
    font-size: 9px;
    color: rgba(255, 255, 255, 0.54);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    line-height: 1.1;
    text-align: center;
  }

  .factor-btn.selected .factor-tier {
    color: rgba(255, 200, 100, 0.8);
  }

  .custom-btn .factor-num {
    font-size: 14px;
  }

  .custom-shard-input {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }

  .custom-shard-input input {
    flex: 1;
    padding: 10px 14px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 200, 100, 0.2);
    border-radius: 6px;
    color: white;
    font-size: 16px;
    text-align: center;
  }

  .custom-shard-input input:focus {
    outline: none;
    border-color: rgba(255, 200, 100, 0.4);
  }

  .custom-label {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
  }

  .factor-summary {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    font-family: 'SF Mono', monospace;
  }

  .factor-separator {
    color: rgba(255, 255, 255, 0.2);
  }

  .warning-text {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
    text-align: center;
    margin: 16px 0 24px;
  }

  /* Derive Button - Sacred Gate */
  .derive-btn {
    width: 100%;
    padding: 18px;
    background: transparent;
    border: 1px solid rgba(180, 140, 80, 0.4);
    border-radius: 2px;
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(180, 140, 80, 0.9);
    cursor: pointer;
    transition: all 0.4s ease;
    position: relative;
    overflow: hidden;
  }

  .derive-btn::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(180, 140, 80, 0.1), transparent);
    transition: left 0.5s ease;
  }

  .derive-btn:hover:not(:disabled)::before {
    left: 100%;
  }

  .reset-link {
    display: block;
    margin: 12px auto 0;
    padding: 6px 12px;
    background: none;
    border: none;
    color: #52525b;
    font-size: 11px;
    cursor: pointer;
    transition: color 0.15s ease;
  }
  .reset-link:hover {
    color: #f43f5e;
  }

  .derive-btn:hover:not(:disabled) {
    background: rgba(180, 140, 80, 0.1);
    border-color: rgba(180, 140, 80, 0.6);
    box-shadow: 0 0 40px rgba(180, 140, 80, 0.15);
    color: rgba(180, 140, 80, 1);
  }

  .derive-btn:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }

  /* Deriving Phase */
  .glass-card.deriving h2 {
    text-align: center;
    color: rgba(255, 255, 255, 0.9);
    margin-bottom: 24px;
  }

  .pyramid-logo {
    position: relative;
    width: 120px;
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pyramid-progress-text {
    font-size: 64px;
    font-weight: 200;
    color: rgb(255, 220, 140);
    letter-spacing: 4px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    text-shadow:
      0 0 20px rgba(255, 200, 100, 0.6),
      0 0 40px rgba(255, 180, 80, 0.4);
  }

  .pyramid-stats {
    display: flex;
    gap: 32px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  }

  .stat-row {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .stat-label {
    font-size: 10px;
    letter-spacing: 2px;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
  }

  .stat-value {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
  }

  .pyramid-progress-bar {
    width: 100%;
    height: 3px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .pyramid-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.5) 0%, #fff 100%);
    transition: width 0.2s ease-out;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
  }

  .speed-control {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    padding: 12px 16px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 10px;
    border: 1px solid rgba(255, 200, 100, 0.15);
  }

  .speed-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .speed-label {
    font-size: 11px;
    letter-spacing: 2px;
    color: rgba(255, 200, 100, 0.7);
    text-transform: uppercase;
    font-weight: 600;
  }

  .speed-eta {
    font-size: 14px;
    color: #f5d78e;
    font-weight: 600;
    text-shadow: 0 0 10px rgba(245, 215, 142, 0.3);
  }

  .speed-slider-wrapper {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .speed-slider {
    flex: 1;
    min-width: 0;
    max-width: 100%;
    cursor: pointer;
  }

  .speed-details {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: rgba(255, 200, 100, 0.5);
    letter-spacing: 0.5px;
  }

  .speed-threads, .speed-memory {
    opacity: 0.8;
  }

  .speed-warning {
    font-size: 10px;
    line-height: 1.35;
    color: rgba(255, 184, 112, 0.9);
  }

  .mini-shard-grid {
    display: grid;
    grid-template-columns: repeat(var(--cols, 16), 16px);
    gap: 3px;
    width: fit-content;
    margin: 24px auto 0;
    padding: 12px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 12px;
    border: 1px solid rgba(255, 200, 100, 0.1);
  }

  .mini-shard {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    transform-style: preserve-3d;
  }

  .mini-shard.pending {
    background: linear-gradient(135deg,
      rgba(40, 35, 30, 0.6) 0%,
      rgba(60, 50, 40, 0.4) 100%);
    border: 1px solid rgba(100, 80, 60, 0.2);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.5);
  }

  .mini-shard.computing {
    background: linear-gradient(135deg,
      rgba(168, 85, 247, 0.8) 0%,
      rgba(139, 92, 246, 0.6) 100%);
    border: 1px solid rgba(168, 85, 247, 0.9);
    box-shadow:
      0 0 12px rgba(168, 85, 247, 0.6),
      0 0 20px rgba(168, 85, 247, 0.3),
      inset 0 1px 2px rgba(255, 255, 255, 0.3);
    animation: cube-pulse 1s ease-in-out infinite;
  }

  .mini-shard.complete {
    background: linear-gradient(135deg,
      rgba(52, 211, 153, 0.9) 0%,
      rgba(16, 185, 129, 0.8) 100%);
    border: 1px solid rgba(52, 211, 153, 1);
    box-shadow:
      0 0 8px rgba(52, 211, 153, 0.4),
      inset 0 1px 2px rgba(255, 255, 255, 0.4),
      inset 0 -1px 2px rgba(0, 0, 0, 0.2);
  }

  @keyframes cube-pulse {
    0%, 100% {
      transform: scale(1) translateZ(0);
      box-shadow:
        0 0 12px rgba(168, 85, 247, 0.6),
        0 0 20px rgba(168, 85, 247, 0.3),
        inset 0 1px 2px rgba(255, 255, 255, 0.3);
    }
    50% {
      transform: scale(1.15) translateZ(4px);
      box-shadow:
        0 0 16px rgba(168, 85, 247, 0.8),
        0 0 28px rgba(168, 85, 247, 0.5),
        inset 0 1px 2px rgba(255, 255, 255, 0.5);
    }
  }

  .anim-controls {
    position: absolute;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .control-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 8px 16px;
    color: rgba(255, 255, 255, 0.5);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;
    border-radius: 6px;
  }

  .control-btn:hover {
    border-color: rgba(255, 255, 255, 0.35);
    color: rgba(255, 255, 255, 0.8);
  }

  .control-btn.cancel {
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    font-size: 12px;
    letter-spacing: 1px;
  }

  .matrix-status {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.65);
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.25);
  }

  .matrix-status.error {
    color: rgba(255, 145, 120, 0.95);
    border: 1px solid rgba(220, 100, 60, 0.35);
    background: rgba(220, 100, 60, 0.08);
  }

  /* Desktop - wider layout */
  @media (min-width: 900px) {
    .glass-card {
      padding: 48px 64px;
      max-width: 900px;
    }

    .derive-btn {
      font-size: 18px;
      padding: 20px 48px;
    }
  }

  /* Responsive */
  @media (max-width: 600px) {
    .glass-card {
      padding: 20px;
    }

    .quick-login-grid {
      gap: 5px;
    }

    .quick-login-btn {
      font-size: 12px;
      min-height: 34px;
    }

    .factor-buttons {
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 6px;
    }

    .factor-btn {
      padding: 11px 4px;
      min-height: 56px;
    }

    .factor-num {
      font-size: 14px;
    }

    .factor-tier {
      font-size: 8px;
    }

    .recovery-status-strip,
    .recovery-candidate,
    .recovery-actions {
      grid-template-columns: 1fr;
    }

    .recovery-actions {
      gap: 8px;
    }
  }

  /* ============================================================
     SCHEME TOGGLE (segmented control, top-right of auth screen)
     ============================================================ */
  .scheme-toggle {
    position: absolute;
    top: 18px;
    right: 18px;
    z-index: 5;
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.09);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }

  .scheme-toggle button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: rgba(255, 255, 255, 0.42);
    cursor: pointer;
    transition: background 0.18s ease, color 0.18s ease;
  }

  .scheme-toggle button:hover {
    color: rgba(255, 255, 255, 0.8);
  }

  .scheme-toggle button.active {
    background: rgba(255, 200, 100, 0.16);
    color: rgba(255, 214, 150, 0.96);
  }

  /* ============================================================
     LIGHT SCHEME — minimalist fintech skin (optional, switchable)
     Tokens scoped to the auth root so the dark default is untouched.
     ============================================================ */
  .brainvault-wrapper.scheme-light {
    --l-bg-1: #f7f9fc;
    --l-bg-2: #eef1f7;
    --l-card: #ffffff;
    --l-border: rgba(15, 23, 42, 0.08);
    --l-border-strong: rgba(15, 23, 42, 0.14);
    --l-text: #0f172a;
    --l-text-2: #475569;
    --l-text-3: #94a3b8;
    --l-accent: #4f46e5;
    --l-accent-hover: #4338ca;
    --l-accent-soft: rgba(79, 70, 229, 0.08);
    --l-accent-ring: rgba(79, 70, 229, 0.16);
    --l-field: #f8fafc;
    --l-shadow-card: 0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 32px rgba(15, 23, 42, 0.07);
  }

  /* Page + card surfaces */
  .scheme-light .brainvault-container {
    background: var(--l-bg-2);
    background-image:
      radial-gradient(ellipse at 50% -10%, rgba(79, 70, 229, 0.06) 0%, transparent 55%),
      linear-gradient(180deg, var(--l-bg-1) 0%, var(--l-bg-2) 100%);
  }

  .scheme-light .glass-card {
    background: var(--l-card);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border: 1px solid var(--l-border);
    border-radius: 18px;
    box-shadow: var(--l-shadow-card);
  }

  .scheme-light .glass-card::before {
    background: linear-gradient(90deg, transparent, var(--l-accent-ring), transparent);
    opacity: 0.7;
  }

  /* Embedded mode (UserModePanel login) styles container/card dark at higher specificity;
     re-assert the light surfaces so the light skin works on the primary login too. */
  .brainvault-wrapper.embedded.scheme-light .brainvault-container {
    background: var(--l-bg-2);
    background-image:
      radial-gradient(ellipse at 50% -10%, rgba(79, 70, 229, 0.06) 0%, transparent 55%),
      linear-gradient(180deg, var(--l-bg-1) 0%, var(--l-bg-2) 100%);
  }
  .brainvault-wrapper.embedded.scheme-light .glass-card {
    border-color: var(--l-border);
    box-shadow: var(--l-shadow-card);
  }
  .brainvault-wrapper.embedded.scheme-light .input-progress .pyramid-progress-text {
    color: var(--l-accent);
  }
  .brainvault-wrapper.embedded.scheme-light .pyramid-progress-bar {
    background: rgba(15, 23, 42, 0.08);
  }
  .brainvault-wrapper.embedded.scheme-light .pyramid-progress-fill {
    background: linear-gradient(90deg, var(--l-accent), #818cf8);
  }

  /* Titles + copy */
  .scheme-light .wallet-create-title h2 { color: var(--l-text); }
  .scheme-light .wallet-create-title p { color: var(--l-text-2); }
  .scheme-light .creation-context-copy { color: var(--l-text-3); }

  /* Segmented mode tabs (iOS-style) */
  .scheme-light .input-mode-tabs {
    background: var(--l-bg-2);
    border-color: var(--l-border);
  }
  .scheme-light .input-mode-tabs button { color: var(--l-text-2); }
  .scheme-light .input-mode-tabs button:hover {
    color: var(--l-text);
    background: rgba(15, 23, 42, 0.03);
  }
  .scheme-light .input-mode-tabs button.selected {
    background: var(--l-card);
    border-color: var(--l-border);
    color: var(--l-accent);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
  }

  /* Quick login */
  .scheme-light .quick-login-section {
    background: rgba(15, 23, 42, 0.012);
    border-color: rgba(15, 23, 42, 0.16);
  }
  .scheme-light .ql-title { color: var(--l-text-2); }
  .scheme-light .ql-temp { color: var(--l-text-3); }
  .scheme-light .ql-divider { background: rgba(15, 23, 42, 0.12); }
  .scheme-light .quick-login-btn {
    background: var(--l-card);
    border-color: var(--l-border-strong);
    color: var(--l-text);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }
  .scheme-light .quick-login-btn:hover {
    background: rgba(15, 23, 42, 0.03);
    border-color: var(--l-border-strong);
    color: var(--l-text);
  }
  /* Hubs = amber */
  .scheme-light .quick-login-btn.role-hub {
    background: rgba(217, 119, 6, 0.08);
    border-color: rgba(217, 119, 6, 0.28);
    color: #b45309;
  }
  .scheme-light .quick-login-btn.role-hub:hover {
    background: rgba(217, 119, 6, 0.14);
    border-color: rgba(217, 119, 6, 0.45);
    color: #92400e;
  }
  /* App entities = teal */
  .scheme-light .quick-login-btn.role-app {
    background: rgba(13, 148, 136, 0.08);
    border-color: rgba(13, 148, 136, 0.28);
    color: #0f766e;
  }
  .scheme-light .quick-login-btn.role-app:hover {
    background: rgba(13, 148, 136, 0.14);
    border-color: rgba(13, 148, 136, 0.45);
    color: #115e59;
  }

  /* Advanced toggle */
  .scheme-light .advanced-toggle {
    background: var(--l-card);
    border-color: var(--l-border);
    color: var(--l-text);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
  }
  .scheme-light .advanced-toggle:hover {
    background: rgba(15, 23, 42, 0.02);
    border-color: var(--l-border-strong);
  }
  .scheme-light .advanced-toggle-label { color: var(--l-text-2); }
  .scheme-light .advanced-toggle-summary { color: var(--l-text-3); }
  .scheme-light .advanced-chevron { color: var(--l-text-3); }

  /* Connect to live runtime */
  .scheme-light .live-runtime-section {
    background: rgba(15, 23, 42, 0.012);
    border-color: var(--l-border);
  }
  .scheme-light .live-refresh {
    border-color: var(--l-border-strong);
    color: var(--l-text-3);
  }
  .scheme-light .live-refresh:hover:not(:disabled) {
    color: var(--l-accent);
    border-color: var(--l-accent-ring);
  }
  .scheme-light .live-runtime-select {
    background: var(--l-field);
    border-color: var(--l-border-strong);
    color: var(--l-text);
  }
  .scheme-light .live-runtime-select:focus {
    border-color: var(--l-accent);
    box-shadow: 0 0 0 3px var(--l-accent-ring);
  }
  .scheme-light .live-connect-btn {
    background: var(--l-accent);
    border-color: transparent;
    color: #ffffff;
    box-shadow: 0 2px 6px rgba(79, 70, 229, 0.22);
  }
  .scheme-light .live-connect-btn:hover:not(:disabled) {
    background: var(--l-accent-hover);
    border-color: transparent;
  }
  .scheme-light .live-connect-btn:disabled { background: #e2e6ee; color: var(--l-text-3); box-shadow: none; }
  .scheme-light .live-runtime-hint { color: var(--l-text-3); }
  .scheme-light .live-runtime-error { color: #b91c1c; }

  /* Labels + hints + inputs */
  .scheme-light .input-group label { color: var(--l-text-2); }
  .scheme-light .label-aside { color: var(--l-text-3); }
  .scheme-light .input-hint { color: var(--l-text-3); }

  .scheme-light .input-wrapper input,
  .scheme-light .input-wrapper textarea,
  .scheme-light .custom-shard-input input {
    background: var(--l-field);
    border: 1px solid var(--l-border-strong);
    border-radius: 10px;
    color: var(--l-text);
  }
  .scheme-light .input-wrapper input:focus,
  .scheme-light .input-wrapper textarea:focus,
  .scheme-light .custom-shard-input input:focus {
    background: var(--l-card);
    border-color: var(--l-accent);
    box-shadow: 0 0 0 3px var(--l-accent-ring);
  }
  .scheme-light .input-wrapper input::placeholder,
  .scheme-light .input-wrapper textarea::placeholder { color: var(--l-text-3); }

  .scheme-light .input-wrapper .toggle-visibility,
  .scheme-light .input-wrapper .suggest-btn { color: var(--l-text-3); }
  .scheme-light .input-wrapper .toggle-visibility:hover,
  .scheme-light .input-wrapper .suggest-btn:hover { color: var(--l-accent); }

  .scheme-light .strength-meter { background: rgba(15, 23, 42, 0.08); }

  /* Factor buttons */
  .scheme-light .factor-btn {
    background: var(--l-card);
    border-color: var(--l-border);
  }
  .scheme-light .factor-btn:hover {
    background: var(--l-accent-soft);
    border-color: var(--l-accent-ring);
  }
  .scheme-light .factor-btn.selected {
    background: var(--l-accent-soft);
    border-color: var(--l-accent);
    box-shadow: 0 0 0 1px var(--l-accent-ring);
  }
  .scheme-light .factor-num { color: var(--l-accent); }
  .scheme-light .factor-tier { color: var(--l-text-3); }
  .scheme-light .factor-btn.selected .factor-tier { color: var(--l-accent); }
  .scheme-light .custom-label,
  .scheme-light .factor-summary { color: var(--l-text-3); }
  .scheme-light .factor-separator { color: var(--l-border-strong); }
  .scheme-light .warning-text { color: var(--l-text-3); }

  /* Primary CTA — solid filled indigo (Stripe/Apple pattern) */
  .scheme-light .derive-btn {
    background: var(--l-accent);
    border: 1px solid transparent;
    border-radius: 12px;
    color: #ffffff;
    letter-spacing: 0.08em;
    box-shadow: 0 6px 16px rgba(79, 70, 229, 0.28);
  }
  .scheme-light .derive-btn::before {
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.22), transparent);
  }
  .scheme-light .derive-btn:hover:not(:disabled) {
    background: var(--l-accent-hover);
    border-color: transparent;
    box-shadow: 0 8px 22px rgba(79, 70, 229, 0.36);
    color: #ffffff;
  }
  .scheme-light .derive-btn:disabled {
    opacity: 1;
    background: #e2e6ee;
    color: var(--l-text-3);
    box-shadow: none;
  }

  /* Secondary buttons + links */
  .scheme-light .back-to-create,
  .scheme-light .backup-upload-btn,
  .scheme-light .generate-mnemonic-btn {
    background: var(--l-card);
    border-color: var(--l-border-strong);
    color: var(--l-text);
  }
  .scheme-light .back-to-create:hover,
  .scheme-light .backup-upload-btn:hover,
  .scheme-light .generate-mnemonic-btn:hover {
    background: var(--l-accent-soft);
    border-color: var(--l-accent-ring);
    color: var(--l-accent);
  }
  .scheme-light .reset-link { color: var(--l-text-3); }
  .scheme-light .reset-link:hover { color: #dc2626; }

  .scheme-light .warning-box {
    background: rgba(217, 119, 6, 0.07);
    border: 1px solid rgba(217, 119, 6, 0.22);
    border-radius: 10px;
    padding: 12px 14px;
    color: #92400e;
  }

  /* Recovery cards */
  .scheme-light .recovery-status-strip > div,
  .scheme-light .recovery-loading,
  .scheme-light .recovery-candidate {
    background: var(--l-card);
    border-color: var(--l-border);
    color: var(--l-text-2);
  }
  .scheme-light .recovery-label { color: var(--l-text-3); }
  .scheme-light .recovery-status-strip strong,
  .scheme-light .candidate-main strong { color: var(--l-text); }
  .scheme-light .candidate-main span,
  .scheme-light .candidate-meta span { color: var(--l-text-2); }
  .scheme-light .recovery-candidate.selected {
    border-color: var(--l-accent);
    background: var(--l-accent-soft);
  }
  .scheme-light .recovery-spinner {
    border-color: rgba(15, 23, 42, 0.12);
    border-top-color: var(--l-accent);
  }

  /* Deriving phase */
  .scheme-light .glass-card.deriving h2 { color: var(--l-text); }
  .scheme-light .pyramid-progress-text {
    color: var(--l-accent);
    text-shadow: none;
  }
  .scheme-light .stat-label { color: var(--l-text-3); }
  .scheme-light .stat-value { color: var(--l-text); }
  .scheme-light .pyramid-progress-bar { background: rgba(15, 23, 42, 0.08); }
  .scheme-light .pyramid-progress-fill {
    background: linear-gradient(90deg, var(--l-accent) 0%, #818cf8 100%);
    box-shadow: none;
  }
  .scheme-light .speed-control {
    background: var(--l-field);
    border-color: var(--l-border);
  }
  .scheme-light .speed-label { color: var(--l-accent); }
  .scheme-light .speed-eta { color: var(--l-text); text-shadow: none; }
  .scheme-light .speed-details { color: var(--l-text-3); }
  .scheme-light .mini-shard-grid {
    background: rgba(15, 23, 42, 0.03);
    border-color: var(--l-border);
  }
  .scheme-light .mini-shard.pending {
    background: rgba(15, 23, 42, 0.06);
    border-color: var(--l-border);
    box-shadow: none;
  }
  .scheme-light .control-btn {
    border-color: var(--l-border-strong);
    color: var(--l-text-2);
  }
  .scheme-light .control-btn:hover {
    border-color: var(--l-accent-ring);
    color: var(--l-accent);
  }
  .scheme-light .matrix-status {
    background: rgba(15, 23, 42, 0.03);
    color: var(--l-text-2);
  }
  .scheme-light .matrix-status.error {
    color: #b91c1c;
    border-color: rgba(220, 38, 38, 0.3);
    background: rgba(220, 38, 38, 0.06);
  }

  /* Toggle itself under light scheme */
  .scheme-light .scheme-toggle {
    background: var(--l-card);
    border-color: var(--l-border);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  }
  .scheme-light .scheme-toggle button { color: var(--l-text-3); }
  .scheme-light .scheme-toggle button:hover { color: var(--l-text-2); }
  .scheme-light .scheme-toggle button.active {
    background: var(--l-accent-soft);
    color: var(--l-accent);
  }
</style>
