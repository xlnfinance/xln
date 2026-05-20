<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { locale, translations$, initI18n, loadTranslations } from '$lib/i18n';
  // Removed WalletView - Entity = Wallet, no separate signer wallet view
  import HierarchicalNav from '$lib/components/Navigation/HierarchicalNav.svelte';
  import { appStateOperations } from '$lib/stores/appStateStore';
  import { vaultOperations, activeRuntime, activeSigner, allRuntimes } from '$lib/stores/vaultStore';
  import { deriveRequestSignal, showVaultPanel, vaultUiOperations } from '$lib/stores/vaultUiStore';
  import { xlnFunctions } from '$lib/stores/xlnStore';
  import type { Tab } from '$lib/types/ui';
  import ContextSwitcher from '$lib/components/Entity/ContextSwitcher.svelte';
  import { resetEverything } from '$lib/utils/resetEverything';
  import {
    BRAINVAULT_V1,
    bytesToHex,
    combineShards,
    deriveEthereumAddress,
    deriveEthereumAddressMatrix,
    deriveKey,
    entropyToMnemonic,
    estimatePasswordStrength,
    formatDuration,
    getShardCount,
    hexToBytes,
  } from '@xln/brainvault/core';
  import { generateLazyEntityId } from '@xln/runtime/entity-factory';
  import { DEMO_ACCOUNTS } from '$lib/config/demo-accounts';
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

  // Initialize i18n
  let i18nReady = false;
  $: t = $translations$;

  // ============================================================================
  // CONSTANTS
  // ============================================================================

  $: avatarFns = $xlnFunctions;
  $: avatar = ethereumAddress ? avatarFns.hashToAvatar(ethereumAddress, 80) : '';

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

  type Phase = 'input' | 'deriving' | 'complete';
  type InputMode = 'brainvault' | 'mnemonic';

  let inputMode: InputMode = 'brainvault';
  let phase: Phase = 'input';

  $: hasAnyPersistedState = typeof localStorage !== 'undefined' && (localStorage.length > 0 || typeof indexedDB !== 'undefined');

  async function handleResetEverything() {
    if (confirm('This will clear all wallets, accounts, and runtime state. Continue?')) {
      await resetEverything('manual-reset');
    }
  }
  let createLoginType: 'manual' | 'demo' = 'manual';
  let showSuccessHeader = true;
  let successHeaderTimeout: ReturnType<typeof setTimeout> | null = null;

  // Auto-hide success header after 2.5 seconds
  $: if (phase === 'complete' && showSuccessHeader) {
    successHeaderTimeout = setTimeout(() => {
      showSuccessHeader = false;
    }, 2500);
  }

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

  let deviceMemoryMB = deviceMemoryGB * 1024;

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
  $: memoryPercent = Math.min(100, (allocatedMemoryMB / deviceMemoryMB) * 100);
  let shardCount = 0;
  let shardsCompleted = 0;
  let shardResults: Map<number, Uint8Array> = new Map();
  let shardStatus: ('pending' | 'computing' | 'complete')[] = [];
  let estimatedShardTimeMs = 3000;
  let startTime = 0;
  let elapsedMs = 0;
  let elapsedInterval: ReturnType<typeof setInterval> | null = null;


  // Result state
  type DerivedEoaAddress = { index: number; path: string; address: string };
  let mnemonic24 = '';
  let mnemonic12 = '';
  let recoveryMnemonic24 = '';
  let recoveryMnemonic12 = '';
  let devicePassphrase = '';
  let ethereumAddress = '';
  let entityId = ''; // bytes32 entity ID derived from address
  let derivedEoaAddresses: DerivedEoaAddress[] = [];
  let eoaDerivationSeq = 0;
  let copiedField: string | null = null;
  let creatingRuntime = false;
  let runtimeCreateError = '';

  // ============================================================================
  // LIFECYCLE - Load vault on mount
  // ============================================================================

  onMount(() => {
    // Initialize vault store from localStorage
    vaultOperations.initialize();

    // Check if there's an active vault
    const vault = $activeRuntime;
    if (vault && !$showVaultPanel) {
      // Restore state from saved vault
      name = vault.id;
      mnemonic24 = vault.seed;
      mnemonic12 = vault.mnemonic12 || '';
      devicePassphrase = vault.devicePassphrase || '';

      // Get active signer's address
      const signer = $activeSigner;
      if (signer) {
        ethereumAddress = signer.address;
        entityId = signer.entityId || '';
      }
      void refreshDerivedEoaAddresses(mnemonic24);

      // Skip to complete phase
      phase = 'complete';
      showSuccessHeader = false; // Don't show success animation on reload
      console.log('🔐 Vault restored from storage:', vault.id);
    }
  });

  // Vault management state
  let vaultDropdownOpen = false;
  let signerDropdownOpen = false;
  let showSaveVaultModal = false;
  let vaultNameInput = '';
  let addressCopied = false;

  function copyAddress() {
    if (!currentSignerAddress) return;
    navigator.clipboard.writeText(currentSignerAddress);
    addressCopied = true;
    setTimeout(() => addressCopied = false, 2000);
  }

  function deriveNewVault() {
    vaultDropdownOpen = false;
    reset(); // Go back to input phase
  }

  // Click-outside handler to close dropdowns
  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.context-dropdown')) {
      vaultDropdownOpen = false;
      signerDropdownOpen = false;
    }
  }

  let lastDeriveRequest = 0;
  $: if ($deriveRequestSignal !== lastDeriveRequest) {
    lastDeriveRequest = $deriveRequestSignal;
    deriveNewVault();
  }

  // Reactive: Get current vault/signer for display
  $: currentVault = $activeRuntime;
  $: savedVaults = $allRuntimes;
  $: derivedRuntime = ethereumAddress
    ? savedVaults.find((vault) => vault.id.toLowerCase() === ethereumAddress.toLowerCase()) ?? null
    : null;
  $: activeRuntimeMatchesDerived = Boolean(
    currentVault && ethereumAddress && currentVault.id.toLowerCase() === ethereumAddress.toLowerCase()
  );
  $: matchingRuntime = activeRuntimeMatchesDerived ? currentVault : derivedRuntime;
  $: currentSigner = activeRuntimeMatchesDerived
    ? $activeSigner
    : matchingRuntime?.signers?.[0] ?? null;

  // Current signer's address
  $: currentSignerAddress = currentSigner?.address || ethereumAddress;
  $: displayEntityId = currentSigner?.entityId || entityId;
  $: creationContextTab = ({
    id: 'runtime-creation',
    title: 'Runtime Creation',
    jurisdiction: 'browservm',
    signerId: activeRuntimeMatchesDerived ? (currentSigner?.address || '') : '',
    entityId: activeRuntimeMatchesDerived ? (currentSigner?.entityId || '') : '',
    isActive: true,
  }) satisfies Tab;

  // Identicon for current signer
  $: currentSignerAvatar = currentSignerAddress ? avatarFns.hashToAvatar(currentSignerAddress, 80) : avatar;
  $: recoveryMnemonic24 = (mnemonic24 || matchingRuntime?.seed || '').trim().split(/\s+/).join(' ');
  $: recoveryMnemonic12 = (mnemonic12 || matchingRuntime?.mnemonic12 || '').trim().split(/\s+/).join(' ');

  // Helper to add a new signer
  function handleAddSigner() {
    const newSigner = vaultOperations.addSigner();
    if (newSigner) {
      vaultOperations.selectSigner(newSigner.index);
    }
  }

  async function refreshDerivedEoaAddresses(seed: string): Promise<void> {
    const normalizedSeed = seed.trim().split(/\s+/).join(' ');
    const seq = ++eoaDerivationSeq;
    if (!normalizedSeed) {
      derivedEoaAddresses = [];
      return;
    }

    try {
      const matrix = await deriveEthereumAddressMatrix(normalizedSeed, '', 3);
      if (seq !== eoaDerivationSeq) return;
      derivedEoaAddresses = matrix.standard.map((address, index) => ({
        index,
        path: `m/44'/60'/0'/0/${index}`,
        address,
      }));
    } catch (err) {
      if (seq !== eoaDerivationSeq) return;
      console.warn('[BrainVault] Failed to derive EOA preview addresses:', err);
      derivedEoaAddresses = [];
    }
  }

  async function createXlnWalletFromCurrentVault(labelOverride?: string) {
    if (!mnemonic24 || !ethereumAddress || creatingRuntime) return;

    creatingRuntime = true;
    runtimeCreateError = '';
    try {
      const runtimeId = ethereumAddress;
      const label = (labelOverride || vaultNameInput || name || '').trim() || `Runtime ${ethereumAddress.slice(0, 6)}`;

      if (!vaultOperations.runtimeExists(runtimeId)) {
        const runtime = await vaultOperations.createRuntime(label, mnemonic24, {
          loginType: createLoginType,
          requiresOnboarding: createLoginType !== 'demo',
          mnemonic12: recoveryMnemonic12 || undefined,
          devicePassphrase: devicePassphrase || undefined,
        });
        entityId = runtime.signers[0]?.entityId || entityId;
        console.log('🔐 XLN runtime created from BrainVault:', runtimeId.slice(0, 10) + '...', `(${label})`);
      } else {
        await vaultOperations.selectRuntime(runtimeId);
        console.log('🔐 Existing XLN runtime selected:', runtimeId.slice(0, 10) + '...');
      }
      createLoginType = 'manual';
      showSaveVaultModal = false;
      vaultNameInput = '';
      vaultUiOperations.hideVault();
      if (!embedded) {
        appStateOperations.setMode('user');
        appStateOperations.setViewMode('home');
      }
    } catch (err) {
      runtimeCreateError = err instanceof Error ? err.message : 'Failed to create XLN wallet';
    } finally {
      creatingRuntime = false;
    }
  }

  // Helper to save current derivation as runtime (uses mnemonic24 for valid BIP39)
  async function saveCurrentAsVault() {
    await createXlnWalletFromCurrentVault(vaultNameInput.trim());
  }

  // Switch to a saved vault
  function switchToVault(vaultId: string) {
    vaultOperations.selectRuntime(vaultId);
    vaultDropdownOpen = false;
  }

  // Switch signer
  function switchSigner(index: number) {
    vaultOperations.selectSigner(index);
    signerDropdownOpen = false;
  }

  function handleCreationContextSelect() {
    if (embedded && savedVaults.length > 0) {
      vaultUiOperations.hideVault();
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
  // Remaining time based on ACTUAL active worker count.
  $: remainingMs = shardCount > 0
    ? Math.max(0, ((shardCount - shardsCompleted) / Math.max(activeWorkerCount, 1)) * estimatedShardTimeMs)
    : 0;
  // Projected ETA based on the current requested worker target.
  $: projectedRemainingMs = shardCount > 0
    ? Math.max(0, ((shardCount - shardsCompleted) / Math.max(effectiveTargetWorkerCount, 1)) * estimatedShardTimeMs)
    : 0;

  // Shard grid dimensions (for visualization)
  // Exact grid dimensions per factor (1:1 shard-to-cube mapping up to factor 5)
  // Factor 1 = 1×1, Factor 2 = 2×2, Factor 3 = 4×4, Factor 4 = 8×8, Factor 5 = 16×16
  // Factor 6+ uses aggregation to keep grid manageable
  $: gridSize = Math.min(Math.ceil(Math.sqrt(shardCount)), 64); // Max 64×64 visual grid
  $: visualShardCount = factor <= 5 ? shardCount : Math.min(shardCount, 64 * 64);
  $: gridCols = gridSize;
  $: gridRows = Math.ceil(visualShardCount / gridCols);
  $: shardsPerCell = Math.ceil(shardCount / visualShardCount);

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  async function copyToClipboard(text: string, field: string) {
    await navigator.clipboard.writeText(text);
    copiedField = field;
    setTimeout(() => copiedField = null, 2000);
  }

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
    if (elapsedInterval) {
      clearInterval(elapsedInterval);
      elapsedInterval = null;
    }
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
    // === MNEMONIC MODE: Skip argon2, use mnemonic directly ===
    if (inputMode === 'mnemonic') {
      phase = 'deriving'; // Brief transition
      const cleanMnemonic = mnemonicInput.trim().split(/\s+/).join(' ');
      mnemonic24 = cleanMnemonic;
      // mnemonic12 left empty - only 24-word is canonical for imported mnemonics
      mnemonic12 = '';

      // Derive Ethereum address (for display)
      ethereumAddress = await deriveEthereumAddress(mnemonic24);
      await refreshDerivedEoaAddresses(mnemonic24);

      // Auto-save runtime - createRuntime handles entity creation + funding
      const runtimeId = ethereumAddress;
      const label = `Mnemonic ${ethereumAddress.slice(0, 6)}`;

      if (!vaultOperations.runtimeExists(runtimeId)) {
        await vaultOperations.createRuntime(label, mnemonic24, {
          loginType: 'manual',
          requiresOnboarding: true,
          mnemonic12: undefined,
        });
        // entityId is set by createRuntime internally
        console.log('🔐 Mnemonic runtime created:', runtimeId.slice(0, 10));
      } else {
        await vaultOperations.selectRuntime(runtimeId);
        console.log('🔐 Mnemonic runtime selected:', runtimeId.slice(0, 10));
      }

      phase = 'complete';
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
    startTime = Date.now();
    elapsedMs = 0;

    // Start elapsed timer
    elapsedInterval = setInterval(() => {
      elapsedMs = Date.now() - startTime;
    }, 100);

    // Start with the exact worker count the UI is allowed to request.
    const cpuCores = navigator.hardwareConcurrency || 4;
    console.log(`[BrainVault] Using ${initialWorkers} workers (${cpuCores} cores, cap ${usableWorkerCap}, requested ${effectiveTargetWorkerCount}, memory ${deviceMemoryGB}GB)`);

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
    if (elapsedInterval) {
      clearInterval(elapsedInterval);
      elapsedInterval = null;
    }
    elapsedMs = Date.now() - startTime;

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
    await refreshDerivedEoaAddresses(mnemonic24);
    // Entity ID is a lazy entity ID for a single-signer quorum (matches runtime algorithm)
    entityId = generateLazyEntityId([ethereumAddress], 1n);

    phase = 'complete';
    await createXlnWalletFromCurrentVault(name.trim() || `Wallet ${ethereumAddress.slice(0, 6)}`);
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
    workerLimitNotice = '';
    createLoginType = 'manual';
    if (elapsedInterval) {
      clearInterval(elapsedInterval);
      elapsedInterval = null;
    }
    if (successHeaderTimeout) {
      clearTimeout(successHeaderTimeout);
      successHeaderTimeout = null;
    }
    showSuccessHeader = true; // Reset for next open
    // Keep name and passphrase for convenience
    mnemonic24 = '';
    mnemonic12 = '';
    devicePassphrase = '';
    ethereumAddress = '';
    entityId = '';
    derivedEoaAddresses = [];
    runtimeCreateError = '';
    creatingRuntime = false;
    shardsCompleted = 0;
    shardResults = new Map();
    shardStatus = [];
  }

  onDestroy(() => {
    terminateWorkers();
    if (elapsedInterval) {
      clearInterval(elapsedInterval);
    }
    if (successHeaderTimeout) {
      clearTimeout(successHeaderTimeout);
    }
  });

  // Check for saved resume on mount + init i18n
  onMount(() => {
    let unsubscribe: (() => void) | undefined;

    // Run async init
    (async () => {
      // Init i18n
      await initI18n();
      i18nReady = true;

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

<svelte:window on:click={handleClickOutside} />

<div class="brainvault-wrapper" class:embedded>
  <!-- Hierarchical Navigation (only in standalone mode) -->
  {#if !embedded}
    <HierarchicalNav />
  {/if}

	    <!-- Main Wallet Content -->
  <div class="brainvault-container" class:deriving={phase === 'deriving'} class:complete={phase === 'complete'}>
    <!-- Ambient particles disabled for minimalist mode -->

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
            <div class="creation-context-copy">Back to Existing Runtimes</div>
            <ContextSwitcher
              tab={creationContextTab}
              on:entitySelect={handleCreationContextSelect}
            />
          </div>
        {/if}

        <div class="wallet-create-title">
          <div>
            <h2>{inputMode === 'mnemonic' ? 'Import XLN wallet' : 'Create XLN wallet'}</h2>
            <p>{inputMode === 'mnemonic'
              ? 'Recover from an existing mnemonic. New wallets start from the main creation form.'
              : 'Enter a display name and secret. The wallet opens automatically when derivation finishes.'}</p>
          </div>
        </div>

        <div class="quick-login-section">
          <div class="quick-login-header">Quick Login (Testnet)</div>
          <div class="quick-login-grid">
            {#each DEMO_ACCOUNTS as account}
              <button
                class="quick-login-btn"
                type="button"
                on:click={() => {
                  name = account.name;
                  passphrase = account.password;
                  shardInput = account.factor;
                  inputMode = 'brainvault';
                  createLoginType = 'demo';
                  setTimeout(() => startDerivation(), 100);
                }}
              >
                {account.name}
              </button>
            {/each}
          </div>
        </div>

        {#if inputMode === 'brainvault'}
        <!-- Name Input -->
        <div class="input-group">
          <label for="name">Display name</label>
	          <span class="input-hint">This becomes the wallet and public entity name.</span>
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

        <!-- Security Factor -->
        <div class="input-group factor-group">
	          <label for="shards">Security work factor</label>

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

          <div class="factor-summary">
            <span class="factor-detail">{factorInfo.shards.toLocaleString()} shards</span>
            <span class="factor-separator">·</span>
            <span class="factor-detail">{factorInfo.time}</span>
          </div>
        </div>

        <!-- Warning (subtle) -->
	        <p class="warning-text">Your inputs generate a unique wallet. No recovery if forgotten.</p>
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
	            Create XLN wallet
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

    <!-- COMPLETE PHASE -->
    {#if phase === 'complete'}
      <div class="glass-card complete tabbed">
        {#if showSuccessHeader}
          <div class="success-header" style="animation: fadeOut 0.5s ease-out 2s forwards;">
            <div class="success-icon-container">
              <div class="success-glow"></div>
              <div class="success-ring">
                <svg viewBox="0 0 24 24" fill="none" class="success-check">
                  <path d="M5 13l4 4L19 7" stroke="url(#checkGradient)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <defs>
                    <linearGradient id="checkGradient" x1="5" y1="7" x2="19" y2="17">
                      <stop offset="0%" stop-color="#fbbf24"/>
                      <stop offset="100%" stop-color="#d97706"/>
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            </div>
	            <h2>{activeRuntimeMatchesDerived ? 'XLN Wallet Ready' : 'Wallet Seed Ready'}</h2>
            <p class="success-stats">{formatRuntimeDurationRounded(elapsedMs)} <span class="stat-divider">·</span> {shardCount} shards</p>
          </div>
        {/if}


        <!-- Tab Content -->
        <div class="complete-tab-content">
          <!-- Unified Context Bar: Vault+Signer (always visible) -->
          {#if !embedded && activeRuntimeMatchesDerived}
          <div class="context-bar">
                <!-- Combined Vault + Signer Dropdown -->
                <div class="context-dropdown vault-signer-combo" class:open={vaultDropdownOpen}>
                  <button
                    class="context-trigger pill"
                    on:click|stopPropagation={() => { vaultDropdownOpen = !vaultDropdownOpen; }}
                  >
                    <img src={currentSignerAvatar} alt="" class="context-avatar" />
                    <div class="context-info">
                      <span class="context-vault-name">{currentVault?.id || 'Vault'}</span>
                      <span class="context-signer-name">{currentSigner?.name || 'Signer 1'}</span>
                    </div>
                    <span class="dropdown-arrow">▼</span>
                  </button>
                  {#if vaultDropdownOpen}
                    <div class="context-menu cascading">
                      <!-- Current Vault Section -->
                      {#if currentVault}
                        <div class="menu-section-label">
                          <span class="section-icon">🔐</span>
                          {currentVault.id}
                        </div>
                        <div class="signers-list">
                          {#each currentVault.signers as signer}
                            <div class="signer-row">
                              <button
                                class="menu-item signer-item"
                                class:active={signer.index === currentSigner?.index}
                                on:click={() => switchSigner(signer.index)}
                              >
                                <img src={avatarFns.hashToAvatar(signer.address, 80)} alt="" class="menu-item-avatar" />
                                <div class="menu-item-info">
                                  <span class="menu-item-label">{signer.name}</span>
                                  <code class="menu-item-addr">{signer.address.slice(0, 6)}...{signer.address.slice(-4)}</code>
                                </div>
                              </button>
                            </div>
                          {/each}
                          <button class="menu-item add-action indent" on:click={handleAddSigner}>
                            <span class="menu-item-icon">➕</span>
                            <span class="menu-item-label">Add Signer</span>
                          </button>
                        </div>
                      {/if}

                      <!-- Other Vaults -->
                      {#if savedVaults.length > 0}
                        <div class="menu-divider"></div>
                        <div class="menu-section-label">Other Vaults</div>
                        {#each savedVaults.filter(v => v.id !== currentVault?.id) as vault}
                          <button
                            class="menu-item vault-item"
                            on:click={() => switchToVault(vault.id)}
                          >
                            <span class="menu-item-icon">🔐</span>
                            <span class="menu-item-label">{vault.id}</span>
                            <span class="menu-item-meta">{vault.signers.length} signers</span>
                          </button>
                        {/each}
                      {/if}

                      <div class="menu-divider"></div>
                      {#if !currentVault}
                        <button class="menu-item" on:click={() => { showSaveVaultModal = true; vaultDropdownOpen = false; }}>
                          <span class="menu-item-icon">💾</span>
                          <span class="menu-item-label">Save Current Vault</span>
                        </button>
                      {/if}
                      <button class="menu-item derive-new" on:click={deriveNewVault}>
                        <span class="menu-item-icon">➕</span>
                        <span class="menu-item-label">Derive New Vault</span>
                      </button>
                    </div>
                  {/if}
                </div>

              </div>
          {/if}

          <section class="recovery-card wallet-primary-card">
            <div class="wallet-ready-head">
              <div class="recovery-identity">
                <img src={currentSignerAvatar} alt="" class="context-avatar" />
                <div>
	                  <h3>{derivedRuntime ? 'XLN wallet available' : 'Create XLN wallet'}</h3>
	                  <p class="muted-tight">
	                    {derivedRuntime ? 'Open the existing XLN wallet for this signer.' : 'Use this seed as your XLN account.'}
                  </p>
                  <p class="muted-tight">Entity {displayEntityId}</p>
                  <p class="muted-tight">Signer {currentSignerAddress || ethereumAddress}</p>
                </div>
              </div>
              <button
                class="derive-btn network-btn"
                on:click={() => createXlnWalletFromCurrentVault()}
                disabled={creatingRuntime || !mnemonic24 || !ethereumAddress || activeRuntimeMatchesDerived}
              >
                {creatingRuntime ? 'Creating...' : activeRuntimeMatchesDerived ? 'XLN wallet active' : derivedRuntime ? 'Open XLN wallet' : 'Create XLN wallet'}
              </button>
            </div>
            {#if runtimeCreateError}
              <div class="matrix-status error">{runtimeCreateError}</div>
            {/if}

            <details class="brainvault-export-details" data-testid="brainvault-export-details">
              <summary data-testid="brainvault-export-toggle">
                <span>
	                  <strong>Recovery export</strong>
                  <small>Show EOA addresses and recovery phrases</small>
                </span>
                <span class="export-chevron">⌄</span>
              </summary>

              <div class="brainvault-export-panel">
                <div class="export-address-row">
                  <div>
                    <span class="export-address-label">Signer address</span>
                    <code>{currentSignerAddress || ethereumAddress}</code>
                  </div>
                  <button class="copy-btn" on:click={copyAddress}>
                    {addressCopied ? '✓' : 'Copy address'}
                  </button>
                </div>

                {#if derivedEoaAddresses.length > 0}
                  <div class="result-section">
                    <div class="result-label">
                      EOA Addresses
                      <span class="label-hint">(standard derivation)</span>
                    </div>
                    <div class="eoa-grid">
                      {#each derivedEoaAddresses as item}
                        <div class="eoa-row" data-testid={`brainvault-eoa-address-${item.index}`}>
                          <div class="eoa-meta">
                            <span>EOA {item.index + 1}</span>
                            <code>{item.path}</code>
                          </div>
                          <code class="eoa-address">{item.address}</code>
                          <button class="copy-btn" on:click={() => copyToClipboard(item.address, `eoa-${item.index}`)}>
                            {copiedField === `eoa-${item.index}` ? '✓' : 'Copy'}
                          </button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}

                {#if recoveryMnemonic12}
                  <div class="result-section">
                    <div class="result-label">
                      Recovery Phrase
                      <span class="label-hint">(12 words)</span>
                    </div>
                    <div class="result-box mnemonic" data-testid="brainvault-mnemonic-12">
                      <div class="mnemonic-words compact">
                        {#each recoveryMnemonic12.split(' ') as word, i}
                          {#if word}
                            <span class="word"><span class="word-num">{i + 1}.</span> {word}</span>
                          {/if}
                        {/each}
                      </div>
                      <button class="copy-btn full" on:click={() => copyToClipboard(recoveryMnemonic12, 'mnemonic12')}>
                        {copiedField === 'mnemonic12' ? '✓ Copied!' : 'Copy 12 words'}
                      </button>
                    </div>
                  </div>
                {/if}

                <div class="result-section">
                  <div class="result-label">
                    Recovery Phrase
                    <span class="label-hint">(24 words)</span>
                  </div>
                  <div class="result-box mnemonic" data-testid="brainvault-mnemonic-24">
                    <div class="mnemonic-words">
                      {#each recoveryMnemonic24.split(' ') as word, i}
                        {#if word}
                          <span class="word"><span class="word-num">{i + 1}.</span> {word}</span>
                        {/if}
                      {/each}
                    </div>
                    <button class="copy-btn full" on:click={() => copyToClipboard(recoveryMnemonic24, 'mnemonic24')}>
                      {copiedField === 'mnemonic24' ? '✓ Copied!' : 'Copy 24 words'}
                    </button>
                  </div>
                </div>
              </div>
            </details>

            <button class="derive-btn secondary" on:click={reset}>
              Derive Another Vault
            </button>
          </section>

          {#if showSaveVaultModal}
            <div class="modal-overlay">
              <div class="modal-content">
                <h3>Create XLN Wallet</h3>
	                <p class="modal-desc">Name the XLN wallet created from this seed.</p>
                <input
                  type="text"
                  class="vault-name-input"
                  placeholder="Enter vault name..."
                  bind:value={vaultNameInput}
                  on:keydown={(e) => e.key === 'Enter' && saveCurrentAsVault()}
                />
                <div class="modal-actions">
                  <button class="modal-btn cancel" on:click={() => showSaveVaultModal = false}>Cancel</button>
                  <button class="modal-btn save" on:click={saveCurrentAsVault} disabled={!vaultNameInput.trim() || creatingRuntime}>
                    {creatingRuntime ? 'Creating...' : 'Create Wallet'}
                  </button>
                </div>
              </div>
            </div>
          {/if}
        </div>
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

  .quick-login-section {
    margin-bottom: 12px;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.018);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    width: 100%;
    box-sizing: border-box;
  }
  .quick-login-header {
    font-size: 10px;
    font-weight: 600;
    color: rgba(156, 163, 175, 0.78);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 8px;
  }
  .quick-login-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
    width: 100%;
  }
  .quick-login-btn {
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.92);
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    text-transform: capitalize;
    min-height: 34px;
  }
  .quick-login-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 200, 100, 0.24);
    color: rgba(255, 200, 100, 0.95);
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

  /* Complete phase - no visible box, seamless with vault background */
  .glass-card.complete {
    background: transparent;
    border: none;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    padding: 0;
  }

  .glass-card.complete::before {
    display: none;
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

  .derive-btn.secondary {
    background: transparent;
    border: 1px solid rgba(180, 140, 80, 0.2);
    color: rgba(180, 140, 80, 0.6);
    margin-top: 24px;
  }

  .derive-btn.secondary:hover:not(:disabled) {
    background: rgba(180, 140, 80, 0.05);
    border-color: rgba(180, 140, 80, 0.4);
    color: rgba(180, 140, 80, 0.9);
  }

  .glass-card.complete.tabbed {
    padding: 0;
  }

  .glass-card.complete.tabbed .success-header {
    padding: 24px 32px 16px;
  }

  .complete-tab-content {
    padding: 24px 32px;
    min-height: 400px;
  }

  .context-bar {
    display: flex;
    gap: 8px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(180, 140, 80, 0.15);
    border-radius: 16px;
    align-items: center;
  }

  .context-dropdown {
    position: relative;
  }

  .context-dropdown.vault-signer-combo {
    flex: 1;
  }

  .context-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: white;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .context-trigger.pill {
    border-radius: 24px;
  }

  .context-trigger:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(180, 140, 80, 0.3);
  }

  .context-dropdown.open .context-trigger {
    background: rgba(180, 140, 80, 0.1);
    border-color: rgba(180, 140, 80, 0.4);
  }

  .context-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid rgba(180, 140, 80, 0.3);
  }

  .context-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    text-align: left;
    min-width: 0;
  }

  .context-vault-name {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(180, 140, 80, 0.7);
  }

  .context-signer-name {
    font-size: 13px;
    font-weight: 500;
    color: white;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recovery-card {
    margin-top: 24px;
    padding: 20px;
    border: 1px solid rgba(180, 140, 80, 0.12);
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.02);
  }

  .wallet-primary-card {
    max-width: 900px;
    margin-left: auto;
    margin-right: auto;
  }

  .wallet-ready-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
  }

  .wallet-ready-head .derive-btn.network-btn {
    width: auto;
    min-width: 190px;
    margin: 0;
    padding: 14px 20px;
    font-size: 14px;
  }

  .recovery-identity {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .recovery-identity h3 {
    margin: 0 0 6px;
    font-size: 18px;
    color: rgba(255, 255, 255, 0.95);
  }

  .brainvault-export-details {
    margin-top: 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }

  .brainvault-export-details summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  .brainvault-export-details summary::-webkit-details-marker {
    display: none;
  }

  .brainvault-export-details summary strong {
    display: block;
    margin-bottom: 3px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.9);
  }

  .brainvault-export-details summary small {
    display: block;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }

  .export-chevron {
    flex: 0 0 auto;
    font-size: 18px;
    color: rgba(255, 255, 255, 0.5);
    transition: transform 0.15s ease;
  }

  .brainvault-export-details[open] .export-chevron {
    transform: rotate(180deg);
  }

  .brainvault-export-panel {
    padding: 0 16px 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .export-address-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 0;
  }

  .export-address-row code {
    display: block;
    margin-top: 4px;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.72);
    word-break: break-all;
  }

  .export-address-label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(180, 140, 80, 0.8);
  }

  .eoa-grid {
    display: grid;
    gap: 10px;
  }

  .eoa-row {
    display: grid;
    grid-template-columns: minmax(90px, 120px) minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.22);
  }

  .eoa-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .eoa-meta span {
    font-size: 12px;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.86);
  }

  .eoa-meta code {
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.45);
    word-break: break-word;
  }

  .eoa-address {
    min-width: 0;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    font-size: 13px;
    color: #fbbf24;
    word-break: break-all;
  }

  .muted-tight {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.55);
    word-break: break-word;
  }

  .dropdown-arrow {
    font-size: 8px;
    opacity: 0.5;
    transition: transform 0.2s ease;
  }

  .context-dropdown.open .dropdown-arrow {
    transform: rotate(180deg);
  }

  .context-menu {
    position: absolute;
    top: 100%;
    left: 0;
    min-width: min(420px, calc(100vw - 24px));
    width: max-content;
    max-width: calc(100vw - 24px);
    margin-top: 4px;
    background: rgba(20, 20, 30, 0.98);
    border: 1px solid rgba(180, 140, 80, 0.2);
    border-radius: 16px;
    padding: 6px;
    z-index: 100;
    max-height: 340px;
    overflow-y: auto;
    overflow-x: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .context-menu.cascading {
    min-width: min(420px, calc(100vw - 24px));
  }

  .menu-section-label {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(180, 140, 80, 0.8);
  }

  .section-icon {
    font-size: 12px;
  }

  .signers-list {
    padding-left: 8px;
    border-left: 2px solid rgba(180, 140, 80, 0.2);
    margin-left: 12px;
  }

  .menu-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.08);
    margin: 6px 8px;
  }

  .menu-item {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    background: transparent;
    border: none;
    border-radius: 10px;
    color: rgba(255, 255, 255, 0.8);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
  }

  .menu-item.indent {
    margin-left: 4px;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .menu-item.active {
    background: rgba(180, 140, 80, 0.15);
    color: rgba(180, 140, 80, 0.95);
  }

  .menu-item.signer-item {
    padding: 8px 10px;
    flex: 1;
  }

  .signer-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .menu-item.add-action,
  .menu-item.derive-new {
    color: rgba(180, 140, 80, 0.8);
  }

  .menu-item.add-action:hover,
  .menu-item.derive-new:hover {
    background: rgba(180, 140, 80, 0.1);
  }

  .menu-item-icon {
    font-size: 14px;
    width: 20px;
    text-align: center;
  }

  .menu-item-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }

  .menu-item-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .menu-item-label {
    font-size: 13px;
    color: inherit;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  .menu-item-addr {
    font-family: 'SF Mono', 'Monaco', monospace;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.25;
    word-break: break-all;
  }

  .menu-item-meta {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  .derive-btn.network-btn {
    display: inline-flex;
    background: linear-gradient(135deg, rgba(220, 180, 100, 0.95), rgba(180, 140, 80, 0.9));
    border: 2px solid rgba(255, 220, 120, 0.6);
    box-shadow: 0 4px 24px rgba(180, 140, 80, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.15);
    text-decoration: none;
    color: #000;
    font-weight: 700;
    text-shadow: none;
    padding: 20px 32px;
    font-size: 16px;
  }

  .derive-btn.network-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(255, 220, 120, 1), rgba(220, 180, 100, 0.95));
    border-color: rgba(255, 240, 160, 0.8);
    box-shadow: 0 6px 32px rgba(180, 140, 80, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.2);
    transform: translateY(-2px);
    color: #000;
  }

  .derive-btn.network-btn:active:not(:disabled) {
    transform: translateY(0);
    box-shadow: 0 2px 12px rgba(180, 140, 80, 0.3);
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

  .success-header {
    text-align: center;
    margin-bottom: 36px;
  }

  .success-icon-container {
    position: relative;
    width: 80px;
    height: 80px;
    margin: 0 auto 20px;
  }

  .success-glow {
    position: absolute;
    inset: -20px;
    background: radial-gradient(circle, rgba(251, 191, 36, 0.4) 0%, rgba(180, 140, 80, 0.2) 50%, transparent 70%);
    filter: blur(20px);
    animation: pulse-glow 2s ease-in-out infinite;
  }

  @keyframes pulse-glow {
    0%, 100% { opacity: 0.6; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.1); }
  }

  @keyframes fadeOut {
    from { opacity: 1; transform: translateY(0); }
    to { opacity: 0; transform: translateY(-20px); }
  }

  .success-ring {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: linear-gradient(135deg,
      rgba(180, 140, 80, 0.2) 0%,
      rgba(120, 90, 50, 0.1) 50%,
      rgba(180, 140, 80, 0.15) 100%);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(180, 140, 80, 0.3);
    box-shadow:
      0 8px 32px rgba(180, 140, 80, 0.3),
      inset 0 1px 1px rgba(255, 200, 100, 0.3),
      inset 0 -1px 1px rgba(0, 0, 0, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .success-check {
    width: 40px;
    height: 40px;
    animation: draw-check 0.6s ease-out forwards;
  }

  .success-check path {
    stroke-dasharray: 30;
    stroke-dashoffset: 30;
    animation: draw-check-path 0.6s ease-out 0.2s forwards;
  }

  @keyframes draw-check-path {
    to { stroke-dashoffset: 0; }
  }

  .success-header h2 {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin: 0 0 8px 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
    text-shadow: 0 0 40px rgba(251, 191, 36, 0.3);
  }

  .success-stats {
    color: rgba(180, 140, 80, 0.7);
    margin: 0;
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .stat-divider {
    opacity: 0.4;
    margin: 0 4px;
  }

  .result-section {
    margin-bottom: 28px;
  }

  .result-label {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 13px;
    font-weight: 600;
    color: rgba(220, 180, 100, 1);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .label-hint {
    font-size: 11px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.45);
    text-transform: none;
    letter-spacing: normal;
  }

  .result-box {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(180, 140, 80, 0.2);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .copy-btn {
    background: rgba(180, 140, 80, 0.15);
    border: 1px solid rgba(180, 140, 80, 0.2);
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 16px;
    transition: all 0.2s ease;
    flex-shrink: 0;
    color: rgba(180, 140, 80, 0.8);
  }

  .copy-btn:hover {
    background: rgba(180, 140, 80, 0.3);
    border-color: rgba(220, 180, 100, 0.5);
    color: rgba(255, 220, 120, 1);
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(180, 140, 80, 0.2);
  }

  .copy-btn:active {
    transform: translateY(0);
    box-shadow: none;
  }

  .copy-btn.full {
    width: 100%;
    margin-top: 12px;
    padding: 12px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
  }

  /* Mnemonic Display - Sensitive field styling */
  .result-box.mnemonic {
    flex-direction: column;
    align-items: stretch;
    border-left: 3px solid rgba(220, 100, 60, 0.6);
    background: rgba(220, 100, 60, 0.03);
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

  .mnemonic-words {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-top: 12px;
    padding: 14px;
    background: rgba(0, 0, 0, 0.5);
    border-radius: 16px;
    border: 1px solid rgba(180, 140, 80, 0.15);
  }

  .mnemonic-words.compact {
    grid-template-columns: repeat(3, 1fr);
  }

  .word {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    background: linear-gradient(135deg, rgba(180, 140, 80, 0.12) 0%, rgba(180, 140, 80, 0.06) 100%);
    padding: 8px;
    border-radius: 10px;
    font-size: 16px;
    color: #f5d78e;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    font-weight: 600;
    letter-spacing: 0.04em;
    border: 1px solid rgba(180, 140, 80, 0.2);
    text-shadow: 0 0 12px rgba(251, 191, 36, 0.25);
    /* min-height: 52px; */
    box-sizing: border-box;
    transition: all 0.15s ease;
  }

  .word:hover {
    background: linear-gradient(135deg, rgba(180, 140, 80, 0.18) 0%, rgba(180, 140, 80, 0.1) 100%);
    border-color: rgba(180, 140, 80, 0.35);
    transform: translateY(-1px);
  }

  .word-num {
    color: rgba(180, 140, 80, 0.4);
    margin-right: 12px;
    font-size: 11px;
    font-weight: 500;
    min-width: 22px;
    flex-shrink: 0;
    opacity: 0.7;
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(4px);
  }

  .modal-content {
    background: rgba(20, 16, 12, 0.98);
    border: 1px solid rgba(180, 140, 80, 0.3);
    border-radius: 16px;
    padding: 28px;
    width: 90%;
    max-width: 400px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  }

  .modal-content h3 {
    margin: 0 0 8px 0;
    font-size: 18px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
  }

  .modal-content p {
    margin: 0 0 20px 0;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
  }

  .vault-name-input {
    width: 100%;
    padding: 14px 16px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(180, 140, 80, 0.3);
    border-radius: 10px;
    font-size: 14px;
    color: #fff;
    outline: none;
    transition: all 0.2s ease;
    box-sizing: border-box;
  }

  .vault-name-input:focus {
    border-color: rgba(180, 140, 80, 0.6);
    background: rgba(0, 0, 0, 0.5);
  }

  .vault-name-input::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  .modal-actions {
    display: flex;
    gap: 12px;
    margin-top: 20px;
  }

  .modal-btn {
    flex: 1;
    padding: 12px 20px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    border: none;
  }

  .modal-btn.cancel {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.7);
  }

  .modal-btn.cancel:hover {
    background: rgba(255, 255, 255, 0.12);
    color: rgba(255, 255, 255, 0.9);
  }

  .modal-btn.save {
    background: linear-gradient(135deg, rgba(180, 140, 80, 0.9), rgba(140, 100, 50, 0.9));
    color: #fff;
  }

  .modal-btn.save:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(200, 160, 100, 0.95), rgba(160, 120, 60, 0.95));
    box-shadow: 0 4px 20px rgba(180, 140, 80, 0.3);
  }

  .modal-btn.save:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Desktop - wider layout */
  @media (min-width: 900px) {
    .glass-card {
      padding: 48px 64px;
      max-width: 900px;
    }

    .mnemonic-words {
      grid-template-columns: repeat(2, 1fr);
      gap: 14px;
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
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 6px;
    }

    .quick-login-btn {
      padding: 9px 6px;
      font-size: 12px;
      min-height: 38px;
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

    .mnemonic-words {
      grid-template-columns: repeat(3, 1fr);
    }

    .eoa-row {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .eoa-row .copy-btn {
      width: 100%;
    }

    .wallet-ready-head {
      flex-direction: column;
      align-items: stretch;
    }

    .wallet-ready-head .derive-btn.network-btn {
      width: 100%;
    }

    .export-address-row {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
