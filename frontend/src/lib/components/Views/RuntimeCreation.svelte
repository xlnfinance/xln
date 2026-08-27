<script lang="ts">
  import './runtime-creation.css';
  import { onMount, onDestroy } from 'svelte';
  import { locale, translations$, initI18n, loadTranslations } from '$lib/i18n';
  // Runtime creation is entry only; entity capabilities are resolved in EntityWorkspace.
  import HierarchicalNav from '$lib/components/Navigation/HierarchicalNav.svelte';
  import { appStateOperations } from '$lib/stores/appStateStore';
  import { errorLog } from '$lib/stores/errorLogStore';
  import {
    discoverRuntimeRecoveryCandidates,
    parseRuntimeRecoveryCandidateFile,
    vaultOperations,
    allRuntimes,
    DEFAULT_VAULT_UNLOCK_DURATION_MS,
    type RuntimeRecoveryCandidate,
    type RuntimeRecoveryDiscoveryFailure,
    type RuntimeRecoveryDiscoveryResult,
  } from '$lib/stores/vault/vaultStore';
  import type { VaultUnlockDurationMs } from '$lib/security/vaultProtection';
  import { deriveRequestSignal, vaultUiOperations } from '$lib/stores/vault/vaultUiStore';
  import { writeRuntimeRecoveryDiscoveryStatus } from '$lib/utils/recovery/recoveryDiscoveryStatus';
  import { buildRemoteRuntimeRecoveryPeerSources } from '$lib/utils/onboarding/remoteRuntimeValidation';
  import {
    BRAINVAULT_V1,
    BRAINVAULT_V1_SPEC_ID,
    bytesToHex,
    combineShards,
    deriveEthereumAddress,
    deriveKey,
    entropyToMnemonic,
    factorForShardCount,
    getShardCount,
    hexToBytes,
  } from '@xln/brainvault/core';
  import { DEMO_ACCOUNTS } from '$lib/config/demo-accounts';
  import {
    getRuntimeControllerAdapter,
    runtimeControllerHandle,
  } from '$lib/stores/runtimeControllerStore';
  import type {
    RuntimeAdapterBrainVaultRecovery,
    RuntimeAdapterBrainVaultResult,
  } from '@xln/core/api/runtime-adapter/types';
  import { generateLazyEntityIdPreview } from '$lib/utils/identity/lazyEntityId';
  import {
    BRAINVAULT_WORKER_CAP_STORAGE_KEY,
    computeBrainVaultWorkerCap,
    isBrainVaultWasmMemoryError,
    nextBrainVaultWorkerCapAfterFailure,
  } from '$lib/brainvault/workers';
  import {
    FACTOR_INFO,
    WALLET_MODE_TRADEOFFS,
    estimateBrainVaultWork,
    formatMemoryLabel,
    formatRuntimeDurationRounded,
    countMnemonicWords,
    generateBase58Secret,
    hasSupportedMnemonicWordCount,
    normalizeMnemonicPhrase,
    normalizeBrainVaultShardTimeSample,
  } from './runtime-creation-model';
  import {
    resolveWalletIdentityModeNavigation,
    selectWalletIdentityMode,
    type WalletIdentityMode,
  } from '../../../../packages/browser/src/wallet-identity-entry';
  import {
    evaluateWalletRecoveryRehearsal,
    resetWalletRecoveryRehearsal,
    type WalletRecoveryRehearsalMode,
    type WalletRecoveryRehearsalState,
  } from '../../../../packages/browser/src/wallet-recovery-rehearsal';
  import {
    mergeWalletRecoveryCandidate,
    resolveWalletRecoveryContinuation,
    summarizeWalletRecoveryCandidates,
  } from '../../../../packages/browser/src/wallet-recovery-choice';
  import {
    WalletRecoveryDiscoveryCoordinator,
    type WalletRecoveryDiscoveryRequest,
  } from '../../../../packages/browser/src/wallet-recovery-discovery';
  import {
    resolveWalletRuntimeOpeningPlan,
    walletRuntimeOpeningNeedsLocalLookup,
  } from '../../../../packages/browser/src/wallet-runtime-opening';
  import { WalletNodeMnemonicRevealCoordinator } from '../../../../packages/browser/src/wallet-node-mnemonic-reveal';
  import {
    assertWalletNodeBrainVaultResult,
    nextWalletNodeShardTimeMs,
    resolveWalletNodeBrainVaultAccess,
    validateWalletNodeBrainVaultProgress,
  } from '../../../../packages/browser/src/wallet-node-brainvault-validation';
  import {
    WALLET_AUTH_SCHEME_STORAGE_KEY,
    parseWalletBrainVaultWorkerCap,
    resolveWalletAuthScheme,
    resolveWalletUnlockDurationMs,
    serializeWalletBrainVaultWorkerCap,
    type WalletAuthScheme,
    type WalletUnlockDurationChoice,
  } from '../../../../packages/browser/src/wallet-runtime-preferences';

  // Props
  export let embedded: boolean = false;

  $: t = $translations$;

  function logRuntimeCreationDiagnostic(message: string, details?: unknown): void {
    errorLog.log(message, 'Runtime Creation', details);
  }

  const BRAINVAULT_WORKER_URL = `/brainvault-worker.js?spec=${encodeURIComponent(BRAINVAULT_V1_SPEC_ID)}`;

  function createBrainVaultWorker(): Worker {
    return new Worker(BRAINVAULT_WORKER_URL);
  }

  function isScenarioPreview(): boolean {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('locktest') === '1' && params.get('scenarioPreview') === '1';
  }

  function suggestPassphrase(): void {
    // Generate 10 Base58 chars = ~58.5 bits of entropy (log2(58^10))
    const buf = new Uint8Array(10);
    crypto.getRandomValues(buf);
    passphrase = generateBase58Secret(buf);
    showPassphrase = true; // Auto-show since it's random/public anyway
  }

  function disableTextareaAutocorrect(node: HTMLTextAreaElement): void {
    node.setAttribute('autocorrect', 'off');
  }

  async function generateRandomMnemonic(): Promise<void> {
    // Generate 256 bits of entropy for 24-word mnemonic
    const entropy = new Uint8Array(32);
    try {
      crypto.getRandomValues(entropy);
      mnemonicInput = await entropyToMnemonic(entropy);
      derivationError = '';
    } finally {
      entropy.fill(0);
    }
  }

  // ============================================================================
  // STATE
  // ============================================================================

  type Phase = 'input' | 'deriving' | 'recovery' | 'node-ready';
  type InputMode = WalletIdentityMode;
  type RecoveryRehearsalMode = WalletRecoveryRehearsalMode;
  type BrainVaultDerivationRun = Readonly<{
    name: string;
    passphrase: string;
    shardCount: number;
    factor: number;
  }>;

  let inputMode: InputMode = 'brainvault';
  let phase: Phase = 'input';
  let unlockDurationChoice: WalletUnlockDurationChoice = '10m';
  $: unlockDurationMs = resolveWalletUnlockDurationMs(
    unlockDurationChoice,
    DEFAULT_VAULT_UNLOCK_DURATION_MS,
  ) satisfies VaultUnlockDurationMs;

  function selectInputMode(next: InputMode): void {
    const nextState = selectWalletIdentityMode({
      state: { mode: inputMode, passphrase, mnemonicInput, showPassphrase },
      phase,
      rehearsalMode,
      nextMode: next,
    });
    inputMode = nextState.mode;
    passphrase = nextState.passphrase;
    mnemonicInput = nextState.mnemonicInput;
    showPassphrase = nextState.showPassphrase;
  }

  function focusWalletModeTab(next: InputMode): void {
    selectInputMode(next);
    document.getElementById(`wallet-mode-${next}`)?.focus();
  }

  function handleWalletModeKeydown(event: KeyboardEvent): void {
    const nextMode = resolveWalletIdentityModeNavigation({
      currentMode: inputMode,
      key: event.key,
      rehearsalMode,
    });
    if (!nextMode) return;
    event.preventDefault();
    focusWalletModeTab(nextMode);
  }

  // Visual scheme for the standalone auth screen: 'dark' (default "vault") or 'light' (minimalist fintech skin)
  let scheme: WalletAuthScheme = 'dark';
  function setScheme(next: WalletAuthScheme): void {
    scheme = next;
    if (typeof localStorage !== 'undefined') localStorage.setItem(WALLET_AUTH_SCHEME_STORAGE_KEY, next);
  }

  // Advanced options (security work factor etc.) are collapsed by default for a minimalist screen
  let showAdvanced = false;

  let createLoginType: 'manual' | 'demo' = 'manual';

  // Input state
  let name = '';
  let passphrase = '';
  let mnemonicInput = ''; // For mnemonic mode
  let showPassphrase = false;
  let shardInput = 3; // Can be 1-5 (factor) or 6+ (custom shards)
  let rehearsalEnabled = false;
  let rehearsalMode: RecoveryRehearsalMode | null = null;
  let rehearsalExpectedAddress = '';
  let derivationRun: BrainVaultDerivationRun | null = null;
  let nodeDerivationAbort: AbortController | null = null;
  let nodeDerivationResult: RuntimeAdapterBrainVaultResult | null = null;
  let revealedNodeMnemonic = '';
  let revealingNodeMnemonic = false;
  const walletNodeMnemonicReveal = new WalletNodeMnemonicRevealCoordinator<RuntimeAdapterBrainVaultRecovery>();

  const isCurrentDerivationRun = (run: BrainVaultDerivationRun): boolean =>
    derivationRun === run && phase === 'deriving';

  $: derivesBrainVaultOnNode = $runtimeControllerHandle.mode === 'remote';
  $: brainVaultExecutionTarget = derivesBrainVaultOnNode
    ? `Native node · ${$runtimeControllerHandle.endpoint}`
    : 'This browser · WebAssembly';

  // Compute actual shard count and factor from input (must match cli.ts derive() logic)
  $: isValidShardInput = Number.isSafeInteger(shardInput) && shardInput >= 1 && shardInput <= 100_000;
  $: isPreset = isValidShardInput && shardInput >= 1 && shardInput <= 5;
  $: actualShardCount = !isValidShardInput ? 0 : isPreset ? getShardCount(shardInput) : shardInput;
  $: factor = actualShardCount > 0 ? (isPreset ? shardInput : factorForShardCount(actualShardCount)) : 0;

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
  const BRAINVAULT_SHARD_TIME_STORAGE_KEY = 'xln-brainvault-ms-per-shard';

  function readPersistedShardTime(): number | null {
    if (typeof localStorage === 'undefined') return null;
    return normalizeBrainVaultShardTimeSample(
      Number(localStorage.getItem(BRAINVAULT_SHARD_TIME_STORAGE_KEY)),
    );
  }

  function recordMeasuredShardTime(elapsedMs: number): void {
    estimatedShardTimeMs = shardTimeMeasured
      ? estimatedShardTimeMs * 0.7 + elapsedMs * 0.3
      : elapsedMs;
    shardTimeMeasured = true;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BRAINVAULT_SHARD_TIME_STORAGE_KEY, String(Math.round(estimatedShardTimeMs)));
    }
  }

  function readPersistedWorkerCap(): number | null {
    if (typeof localStorage === 'undefined') return null;
    return parseWalletBrainVaultWorkerCap(
      localStorage.getItem(BRAINVAULT_WORKER_CAP_STORAGE_KEY),
    );
  }

  function persistWorkerCap(cap: number): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      BRAINVAULT_WORKER_CAP_STORAGE_KEY,
      serializeWalletBrainVaultWorkerCap(cap),
    );
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
  const workerShardWatchdogs = new Map<Worker, ReturnType<typeof setTimeout>>();
  let retryShardQueue: number[] = [];
  const shardRetryCounts = new Map<number, number>();
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
  const persistedShardTimeMs = readPersistedShardTime();
  let estimatedShardTimeMs = persistedShardTimeMs ?? 3000;
  let shardTimeMeasured = persistedShardTimeMs !== null;
  let nodeShardTimeMs = 0;


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
  const walletRecoveryDiscovery = new WalletRecoveryDiscoveryCoordinator<
    WalletRecoveryDiscoveryRequest,
    RuntimeRecoveryDiscoveryResult
  >({
    discover: ({ seed, runtimeId }) => discoverRuntimeRecoveryCandidates(seed, {
      peers: buildRemoteRuntimeRecoveryPeerSources({ runtimeId }),
    }),
  });

  // ============================================================================
  // LIFECYCLE - Load vault on mount
  // ============================================================================

  onMount(() => {
    if (isScenarioPreview()) return;
    // Screen 1 only creates/selects a runtime, then exits immediately to Screen 2.
    // Never show a post-seed "ready" screen here; account configuration owns that step.
    vaultOperations.initialize();

    const demoLabel = new URLSearchParams(window.location.search).get('demo');
    if (demoLabel !== null) {
      const demo = DEMO_ACCOUNTS.find((candidate) => candidate.label === demoLabel);
      if (!demo) throw new Error(`TESTNET_DEMO_ACCOUNT_UNKNOWN:${demoLabel}`);
      inputMode = 'brainvault';
      name = demo.name;
      passphrase = demo.password;
      shardInput = demo.factor;
      createLoginType = 'demo';
      window.history.replaceState(null, '', '/app');
      queueMicrotask(() => void startDerivation());
    }
  });

  let lastDeriveRequest = 0;
  $: if ($deriveRequestSignal !== lastDeriveRequest) {
    lastDeriveRequest = $deriveRequestSignal;
    reset();
  }

  $: savedVaults = $allRuntimes;

  $: selectedRecoveryCandidate = summarizeWalletRecoveryCandidates(
    recoveryCandidates,
    selectedRecoveryCandidateId,
  ).selectedCandidate;

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
    walletRecoveryDiscovery.invalidate();
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

    const outcome = await walletRecoveryDiscovery.run({
      seed: mnemonic24,
      runtimeId: recoveryRuntimeId,
    });
    if (outcome.status === 'cancelled') return false;
    try {
      if (outcome.status === 'failed') {
        recoveryErrors = [outcome.message];
        recoveryFailures = [];
        return true;
      }
      const { discovery } = outcome;
      recoveryCandidates = discovery.candidates;
      recoveryErrors = discovery.errors;
      recoveryFailures = discovery.failures;
      recoveryCheckedTowers = discovery.checkedTowers;
      recoveryCheckedPeers = discovery.checkedPeers;
      const recoverySummary = summarizeWalletRecoveryCandidates(recoveryCandidates, '');
      recoveryPeerBackupCount = recoverySummary.peerBackupCount;
      selectedRecoveryCandidateId = recoverySummary.selectedCandidate?.id || '';
      if (recoveryCandidates.length > 0) {
        phase = 'recovery';
      }
      return true;
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
    const continuation = resolveWalletRecoveryContinuation({
      hasCandidates: recoveryCandidates.length > 0,
      localRuntimeAvailable,
    });
    if (continuation === 'choose-backup') {
      phase = 'recovery';
      return;
    }
    writeCurrentRecoveryDiscoveryStatus();
    if (continuation === 'open-local') {
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
      const openingChoice = {
        openLocal: options.openLocal === true,
        forceFresh: options.forceFresh === true,
        hasRecoveryCandidate: options.recoveryCandidate !== undefined,
      };
      const openingPlan = resolveWalletRuntimeOpeningPlan({
        runtimeId,
        name,
        labelOverride,
        seed: mnemonic24,
        mnemonic12,
        devicePassphrase,
        loginType: createLoginType,
        unlockDurationMs,
        recoveryCandidate: options.recoveryCandidate,
        forceFresh: openingChoice.forceFresh,
        openLocal: openingChoice.openLocal,
        localRuntimeExists: walletRuntimeOpeningNeedsLocalLookup(openingChoice)
          ? vaultOperations.runtimeExists(runtimeId)
          : false,
      });

      if (openingPlan.action === 'unlock-local') {
        await vaultOperations.unlockRuntime(
          openingPlan.runtimeId,
          openingPlan.seed,
          openingPlan.unlockDurationMs,
        );
      } else {
        const runtime = await vaultOperations.createRuntime(
          openingPlan.label,
          openingPlan.seed,
          openingPlan.options,
        );
        entityId = runtime.signers[0]?.entityId || entityId;
      }
      createLoginType = 'manual';
      clearSensitiveWalletMaterial();
      vaultUiOperations.hideVault();
      if (!embedded) {
        appStateOperations.setMode('user');
        appStateOperations.setViewMode('home');
      }
      return true;
    } catch (err) {
      logRuntimeCreationDiagnostic('Failed to create XLN wallet', err);
      clearSensitiveWalletMaterial();
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
      recoveryCandidates = mergeWalletRecoveryCandidate(recoveryCandidates, candidate);
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

  // Compute work from measured device time, never from guessed password entropy.
  $: factorInfo = isPreset
    ? FACTOR_INFO[shardInput - 1]!
    : {
        factor: 0,
        shards: actualShardCount,
        tier: 'Custom',
      };
  $: workEstimate = actualShardCount > 0
    ? estimateBrainVaultWork(
        actualShardCount,
        SHARD_MEMORY_MB,
        estimatedShardTimeMs,
        Math.max(1, Math.min(effectiveTargetWorkerCount, actualShardCount)),
      )
    : { recoveryMs: 0, totalMemoryWorkMb: 0 };
  $: mnemonicWordCount = countMnemonicWords(mnemonicInput);
  $: canDerive = inputMode === 'brainvault'
    ? (
        isValidShardInput
        && name.length >= BRAINVAULT_V1.MIN_NAME_LENGTH
        && passphrase.length >= BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH
      )
    : inputMode === 'mnemonic' && hasSupportedMnemonicWordCount(mnemonicInput);
  $: progress = shardCount > 0 ? (shardsCompleted / shardCount) * 100 : 0;
  // Projected ETA based on the current requested worker target.
  $: projectedRemainingMs = shardCount > 0
    ? Math.max(0, ((shardCount - shardsCompleted) / Math.max(activeWorkerCount, 1))
      * (derivesBrainVaultOnNode && nodeShardTimeMs > 0 ? nodeShardTimeMs : estimatedShardTimeMs))
    : 0;

  // ============================================================================
  // DERIVATION LOGIC
  // ============================================================================

  function syncWorkerCounts(): void {
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
    clearWorkerShardWatchdog(worker);
    workerActiveShard.delete(worker);
    drainingWorkers.delete(worker);
    const index = workers.indexOf(worker);
    if (index >= 0) {
      workers.splice(index, 1);
    }
    detachWorkerHandlers(worker);
    worker.terminate();
    syncWorkerCounts();
  }

  function detachWorkerHandlers(worker: Worker): void {
    worker.onmessage = null;
    worker.onerror = null;
  }

  function clearWorkerShardWatchdog(worker: Worker): void {
    const watchdog = workerShardWatchdogs.get(worker);
    if (watchdog !== undefined) clearTimeout(watchdog);
    workerShardWatchdogs.delete(worker);
  }

  function armWorkerShardWatchdog(worker: Worker, shardIndex: number): void {
    clearWorkerShardWatchdog(worker);
    const timeoutMs = Math.min(600_000, Math.max(300_000, Math.ceil(estimatedShardTimeMs * 10)));
    workerShardWatchdogs.set(worker, setTimeout(() => {
      if (workerActiveShard.get(worker) !== shardIndex) return;
      handleWorkerFailure(worker, new Error(`Shard ${shardIndex + 1} timed out after ${Math.ceil(timeoutMs / 1000)}s`));
    }, timeoutMs));
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
    return true;
  }

  function reduceWorkerCapAfterMemoryError(message: string): void {
    const current = Math.max(activeWorkerCount, effectiveTargetWorkerCount, 1);
    const reduced = nextBrainVaultWorkerCapAfterFailure(current);
    maxWorkers = Math.max(1, Math.min(maxWorkers, reduced));
    persistWorkerCap(maxWorkers);
    targetWorkerCount = Math.max(1, Math.min(targetWorkerCount, maxWorkers));
    workerLimitNotice = `Browser memory pressure detected. BrainVault is continuing with ${maxWorkers} worker${maxWorkers === 1 ? '' : 's'}.`;
    logRuntimeCreationDiagnostic('BrainVault worker cap reduced after Wasm memory pressure', { maxWorkers, message });
  }

  function failDerivation(message: string): void {
    derivationError = message;
    terminateWorkers();
    derivationRun = null;
    phase = 'input';
  }

  function invalidateNodeReveal(): void {
    walletNodeMnemonicReveal.invalidate();
    revealedNodeMnemonic = '';
    revealingNodeMnemonic = false;
  }

  function wipeShardResults(): void {
    for (const shard of shardResults.values()) shard.fill(0);
    shardResults.clear();
    shardResults = new Map();
  }

  function clearDerivedWalletMaterial(): void {
    derivationRun = null;
    mnemonic24 = '';
    mnemonic12 = '';
    devicePassphrase = '';
    ethereumAddress = '';
    entityId = '';
    wipeShardResults();
    shardsCompleted = 0;
    nodeDerivationResult = null;
    invalidateNodeReveal();
  }

  function clearSensitiveWalletMaterial(): void {
    passphrase = '';
    mnemonicInput = '';
    showPassphrase = false;
    clearDerivedWalletMaterial();
  }

  function closeWalletEntry(): void {
    if (creatingRuntime) return;
    reset();
    vaultUiOperations.hideVault();
  }

  function currentRecoveryRehearsalState(): WalletRecoveryRehearsalState {
    return { enabled: rehearsalEnabled, mode: rehearsalMode, expectedAddress: rehearsalExpectedAddress };
  }

  function publishRecoveryRehearsalState(state: WalletRecoveryRehearsalState): void {
    rehearsalEnabled = state.enabled;
    rehearsalMode = state.mode;
    rehearsalExpectedAddress = state.expectedAddress;
  }

  function acceptRecoveryRehearsal(mode: RecoveryRehearsalMode, address: string): boolean {
    const result = evaluateWalletRecoveryRehearsal({
      state: currentRecoveryRehearsalState(),
      mode,
      address,
    });
    if (result.status === 'skipped') return true;
    if (result.status === 'begin') {
      publishRecoveryRehearsalState(result.state);
      derivationRun = null;
      clearDerivedWalletMaterial();
      showAdvanced = false;
      mnemonicInput = '';
      inputMode = mode;
      derivationError = '';
      phase = 'input';
      return false;
    }
    if (result.status === 'mismatch') {
      derivationRun = null;
      clearDerivedWalletMaterial();
      derivationError = result.message;
      phase = 'input';
      return false;
    }
    publishRecoveryRehearsalState(result.state);
    showAdvanced = false;
    return true;
  }

  function cancelRecoveryRehearsal(): void {
    clearSensitiveWalletMaterial();
    publishRecoveryRehearsalState(resetWalletRecoveryRehearsal());
    showAdvanced = false;
    derivationError = '';
  }

  function selectPresetFactor(nextFactor: number): void {
    shardInput = nextFactor;
    showAdvanced = false;
  }

  function selectCustomFactor(): void {
    if (isPreset) shardInput = 6;
  }

  function handleWorkerFailure(worker: Worker, err: unknown): void {
    const message = workerErrorMessage(err);
    const shardIndex = workerActiveShard.get(worker);
    logRuntimeCreationDiagnostic('BrainVault worker failed', { shardIndex, message });

    if (typeof shardIndex === 'number' && !requeueShard(shardIndex, message)) {
      failDerivation(derivationError || message);
      return;
    }

    const memoryError = isBrainVaultWasmMemoryError(message);
    shutdownWorker(worker);

    if (memoryError) {
      reduceWorkerCapAfterMemoryError(message);
      if (maxWorkers <= 1 && activeWorkerCount === 0 && hasPendingShardWork()) {
        logRuntimeCreationDiagnostic('BrainVault retrying with a single worker after Wasm memory failure', { message });
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
      if (!e.data || typeof e.data !== 'object' || typeof e.data.type !== 'string') {
        const error = new Error('BRAINVAULT_WORKER_MESSAGE_INVALID');
        opts.onError?.(error);
        if (opts.handleErrors !== false) handleWorkerFailure(worker, error);
        return;
      }
      const { type, data } = e.data;

      if (type === 'ready') {
        if (data?.specId !== BRAINVAULT_V1_SPEC_ID) {
          const error = new Error(`BRAINVAULT_WORKER_SPEC_MISMATCH:${String(data?.specId)}:${BRAINVAULT_V1_SPEC_ID}`);
          opts.onError?.(error);
          if (opts.handleErrors !== false) handleWorkerFailure(worker, error);
          return;
        }
        opts.onReady?.();
      } else if (type === 'probe_result') {
        const probeTime = normalizeBrainVaultShardTimeSample(data?.estimatedShardTimeMs);
        if (probeTime !== null) {
          estimatedShardTimeMs = probeTime;
        } else {
          logRuntimeCreationDiagnostic('BrainVault worker returned invalid probe timing', data?.estimatedShardTimeMs);
        }
      } else if (type === 'shard_complete') {
        void handleShardComplete(worker, data?.shardIndex, data?.resultHex, data?.elapsedMs)
          .catch((err) => failDerivation(workerErrorMessage(err)));
      } else if (type === 'error') {
        const error = data?.message ?? 'Worker failed';
        opts.onError?.(error);
        if (opts.handleErrors !== false) {
          handleWorkerFailure(worker, error);
        }
      } else {
        const error = new Error(`BRAINVAULT_WORKER_MESSAGE_UNKNOWN:${type}`);
        opts.onError?.(error);
        if (opts.handleErrors !== false) handleWorkerFailure(worker, error);
      }
    };

    worker.onerror = (e) => {
      logRuntimeCreationDiagnostic('BrainVault worker error event', e);
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
        const cleanMnemonic = normalizeMnemonicPhrase(mnemonicInput);
        if (!hasSupportedMnemonicWordCount(cleanMnemonic)) {
          throw new Error('Enter exactly 12 or 24 BIP39 words.');
        }
        mnemonic24 = cleanMnemonic;
        mnemonicInput = '';
        // Imported mnemonic is canonical as entered; no extra derived phrase.
        mnemonic12 = '';

        ethereumAddress = await deriveEthereumAddress(mnemonic24);
        if (!acceptRecoveryRehearsal('mnemonic', ethereumAddress)) return;
        createLoginType = 'manual';
        if (await prepareRecoveryDecisionFromCurrentSeed(`Mnemonic ${ethereumAddress.slice(0, 6)}`)) {
          await continueAfterRecoveryDiscovery();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to import mnemonic';
        logRuntimeCreationDiagnostic('Mnemonic import failed', err);
        clearSensitiveWalletMaterial();
        derivationError = message;
        phase = 'input';
      }
      return;
    }

    // === BRAINVAULT MODE: Full argon2 derivation ===
    if (!isValidShardInput || actualShardCount < 1 || factor < 1) {
      derivationError = 'Choose a whole shard count between 1 and 100,000.';
      return;
    }
    const run = Object.freeze({
      name,
      passphrase,
      shardCount: actualShardCount,
      factor,
    }) satisfies BrainVaultDerivationRun;
    derivationRun = run;
    invalidateNodeReveal();
    nodeDerivationResult = null;
    shardCount = run.shardCount;
    const initialUsableCap = Math.max(1, Math.min(maxWorkers, shardCount));
    let initialWorkers = Math.min(effectiveTargetWorkerCount, initialUsableCap);
    activeWorkerCount = initialWorkers;
    finalizeInProgress = false;
    phase = 'deriving';
    derivationError = '';
    workerLimitNotice = '';
    retryShardQueue = [];
    shardRetryCounts.clear();
    shardsCompleted = 0;
    wipeShardResults();

    if (derivesBrainVaultOnNode) {
      await startNodeDerivation(run);
      return;
    }

    // Start with the exact worker count the UI is allowed to request.
    try {
      let attempts = 0;
      while (true) {
        // Create workers
        workers = [];
        drainingWorkers.clear();
        const workerPromises: Promise<void>[] = [];

        for (let i = 0; i < initialWorkers; i++) {
          const worker = createBrainVaultWorker();
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
          if (!isCurrentDerivationRun(run)) return;
          break;
        } catch (err) {
          if (!isCurrentDerivationRun(run)) return;
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
            activeWorkerCount = initialWorkers;
            targetWorkerCount = Math.min(targetWorkerCount, initialWorkers);
            attempts += 1;
            workerLimitNotice = `Browser memory pressure detected. BrainVault is retrying with ${initialWorkers} worker${initialWorkers === 1 ? '' : 's'}.`;
            logRuntimeCreationDiagnostic('BrainVault reducing workers after init failure', { workerCount: initialWorkers, message });
            continue;
          }
          throw err;
        }
      }

      // Probe is cheap on desktop, but on iOS/WebKit we avoid extra wasm churn.
      if (!isIOSFamilyWebKit) {
        workers[0]?.postMessage({ type: 'probe', id: 0 });
        await new Promise(r => setTimeout(r, 500));
        if (!isCurrentDerivationRun(run)) return;
      }

      // Dispatch initial shards
      dispatchShards();
    } catch (err) {
      if (!isCurrentDerivationRun(run)) return;
      const message = workerErrorMessage(err);
      logRuntimeCreationDiagnostic('BrainVault worker initialization failed', { message });
      terminateWorkers();
      derivationError = isBrainVaultWasmMemoryError(message)
        ? `BrainVault could not allocate browser Wasm memory. Reduce other tabs or retry with 1 worker. ${message}`
        : `BrainVault worker initialization failed: ${message}`;
      derivationRun = null;
      phase = 'input';
    }
  }

  async function startNodeDerivation(run: BrainVaultDerivationRun): Promise<void> {
    invalidateNodeReveal();
    const adapter = getRuntimeControllerAdapter();
    const access = resolveWalletNodeBrainVaultAccess(adapter);
    if (access.status === 'blocked') {
      failDerivation(access.message);
      return;
    }
    const nodeAdapter = access.adapter;
    const abort = new AbortController();
    nodeDerivationAbort = abort;
    const isCurrentNodeRun = (): boolean =>
      nodeDerivationAbort === abort && isCurrentDerivationRun(run);
    nodeShardTimeMs = 0;
    try {
      const result = await nodeAdapter.deriveBrainVault({
        specId: BRAINVAULT_V1_SPEC_ID,
        name: run.name,
        passphrase: run.passphrase,
        shardInput,
        // Ask for the node maximum; the node clamps this against its own CPU
        // and RAM. Browser hardwareConcurrency must not throttle a remote host.
        workers: 256,
      }, {
        signal: abort.signal,
        onProgress: sample => {
          if (!isCurrentNodeRun()) return;
          const progressValidation = validateWalletNodeBrainVaultProgress(sample, run.shardCount);
          if (!progressValidation.valid) {
            abort.abort();
            derivationError = progressValidation.message;
            return;
          }
          shardCount = sample.total;
          shardsCompleted = sample.completed;
          activeWorkerCount = sample.workers;
          nodeShardTimeMs = nextWalletNodeShardTimeMs(nodeShardTimeMs, sample.lastShardMs);
        },
      });
      if (!isCurrentNodeRun()) return;
      if (abort.signal.aborted) throw new Error('BRAINVAULT_DERIVATION_ABORTED');
      assertWalletNodeBrainVaultResult(result, BRAINVAULT_V1_SPEC_ID, run.shardCount);
      nodeDerivationResult = result;
      ethereumAddress = result.ethereumAddress;
      entityId = result.entityId;
      shardsCompleted = result.shardCount;
      passphrase = '';
      derivationRun = null;
      phase = 'node-ready';
    } catch (err) {
      if (!isCurrentNodeRun()) return;
      if (abort.signal.aborted && !derivationError) {
        phase = 'input';
      } else {
        failDerivation(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (nodeDerivationAbort === abort) nodeDerivationAbort = null;
    }
  }

  async function revealNodeMnemonic(): Promise<void> {
    const adapter = getRuntimeControllerAdapter();
    const expectedResult = nodeDerivationResult;
    if (!adapter || adapter.mode !== 'remote' || phase !== 'node-ready' || !expectedResult) {
      derivationError = 'The node is no longer connected.';
      return;
    }
    revealingNodeMnemonic = true;
    derivationError = '';
    const outcome = await walletNodeMnemonicReveal.run({
      reveal: () => adapter.revealBrainVaultMnemonic(),
      isCurrent: () => (
        phase === 'node-ready'
        && nodeDerivationResult === expectedResult
        && getRuntimeControllerAdapter() === adapter
      ),
    });
    if (outcome.status === 'cancelled') {
      if (outcome.latest) revealingNodeMnemonic = false;
      return;
    }
    try {
      if (outcome.status === 'failed') {
        derivationError = outcome.message;
        return;
      }
      revealedNodeMnemonic = outcome.recovery.mnemonic24;
    } finally {
      revealingNodeMnemonic = false;
    }
  }

  function finishNodeWallet(): void {
    clearSensitiveWalletMaterial();
    vaultUiOperations.hideVault();
    if (!embedded) {
      appStateOperations.setMode('user');
      appStateOperations.setViewMode('home');
    }
  }

  let nextShardToDispatch = 0;
  let finalizeInProgress = false;

  function dispatchShards() {
    nextShardToDispatch = 0;

    // Dispatch initial shard to each worker
    for (let i = 0; i < workers.length && nextShardToDispatch < shardCount; i++) {
      dispatchNextShard(workers[i]!);
    }
  }

  function dispatchNextShard(worker: Worker) {
    const run = derivationRun;
    if (!run) throw new Error('BRAINVAULT_DERIVATION_RUN_MISSING');
    if (isWorkerDraining(worker)) return;
    while (nextShardToDispatch < shardCount && shardResults.has(nextShardToDispatch)) {
      nextShardToDispatch++;
    }
    while (retryShardQueue.length > 0 && shardResults.has(retryShardQueue[0]!)) {
      retryShardQueue.shift();
    }
    if (retryShardQueue.length === 0 && nextShardToDispatch >= shardCount) return;

    const shardIndex = retryShardQueue.length > 0 ? retryShardQueue.shift()! : nextShardToDispatch++;
    workerActiveShard.set(worker, shardIndex);
    armWorkerShardWatchdog(worker, shardIndex);

    worker.postMessage({
      type: 'derive_shard',
      id: shardIndex,
      data: {
        name: run.name,
        passphrase: run.passphrase,
        shardIndex,
        shardCount: run.shardCount,
      }
    });
  }

  async function handleShardComplete(worker: Worker, shardIndex: unknown, resultHex: unknown, elapsedMs: unknown) {
    const activeShard = workerActiveShard.get(worker);
    if (!Number.isSafeInteger(shardIndex) || Number(shardIndex) < 0 || Number(shardIndex) >= shardCount) {
      throw new Error(`BRAINVAULT_WORKER_SHARD_INDEX_INVALID:${String(shardIndex)}`);
    }
    if (activeShard !== shardIndex) {
      throw new Error(`BRAINVAULT_WORKER_SHARD_MISMATCH:${String(activeShard)}:${String(shardIndex)}`);
    }
    if (typeof resultHex !== 'string' || resultHex.length !== BRAINVAULT_V1.SHARD_OUTPUT_BYTES * 2) {
      throw new Error(`BRAINVAULT_WORKER_RESULT_INVALID:${typeof resultHex === 'string' ? resultHex.length : typeof resultHex}`);
    }
    const measuredShardTimeMs = normalizeBrainVaultShardTimeSample(elapsedMs);
    const validatedShardIndex = Number(shardIndex);
    clearWorkerShardWatchdog(worker);
    workerActiveShard.delete(worker);
    if (shardResults.has(validatedShardIndex)) {
      throw new Error(`BRAINVAULT_WORKER_DUPLICATE_SHARD:${validatedShardIndex}`);
    }

    shardResults.set(validatedShardIndex, hexToBytes(resultHex));
    shardsCompleted = shardResults.size;

    // Timing is telemetry: invalid or extreme samples must never discard valid Argon2 output.
    if (measuredShardTimeMs === null) {
      logRuntimeCreationDiagnostic('BrainVault worker returned invalid shard timing', { shardIndex, elapsedMs });
    } else {
      if (measuredShardTimeMs !== elapsedMs) {
        logRuntimeCreationDiagnostic('BrainVault worker shard timing was clamped', {
          shardIndex,
          elapsedMs,
          measuredShardTimeMs,
        });
      }
      recordMeasuredShardTime(measuredShardTimeMs);
    }

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
    const run = derivationRun;
    if (!run) throw new Error('BRAINVAULT_DERIVATION_RUN_MISSING');
    const runShardResults = shardResults;
    const isCurrentRun = (): boolean => isCurrentDerivationRun(run);
    const wipeRunShards = (): void => {
      for (const shard of runShardResults.values()) shard.fill(0);
      runShardResults.clear();
      if (shardResults === runShardResults) shardResults = new Map();
    };
    terminateWorkers();

    // Collect results in order
    const orderedResults: Uint8Array[] = [];
    for (let i = 0; i < run.shardCount; i++) {
      const shard = runShardResults.get(i);
      if (!shard) throw new Error(`Missing shard ${i}`);
      orderedResults.push(shard);
    }

    let masterKey: Uint8Array | null = null;
    let entropy: Uint8Array | null = null;
    let entropy12: Uint8Array | null = null;
    let deviceKey: Uint8Array | null = null;
    try {
      masterKey = await combineShards(orderedResults, run.factor);
      if (!isCurrentRun()) return;
      wipeRunShards();

      entropy = await deriveKey(masterKey, 'bip39/entropy/v1.0', 32);
      if (!isCurrentRun()) return;
      const nextMnemonic24 = await entropyToMnemonic(entropy);
      if (!isCurrentRun()) return;
      entropy12 = await deriveKey(masterKey, 'bip39/entropy-128/v1.0', 16);
      if (!isCurrentRun()) return;
      const nextMnemonic12 = await entropyToMnemonic(entropy12);
      if (!isCurrentRun()) return;

      deviceKey = await deriveKey(masterKey, 'bip39/passphrase/v1.0', 32);
      if (!isCurrentRun()) return;
      const nextDevicePassphrase = bytesToHex(deviceKey);

      const nextEthereumAddress = await deriveEthereumAddress(nextMnemonic24);
      if (!isCurrentRun()) return;
      const nextEntityId = generateLazyEntityIdPreview([nextEthereumAddress], 1n);

      // Commit derived strings together only after every async crypto step
      // still belongs to the active run. Cancel/reset may start another run
      // while a WebCrypto promise is pending; partial global writes here would
      // otherwise resurrect the cancelled wallet or erase the new one.
      mnemonic24 = nextMnemonic24;
      mnemonic12 = nextMnemonic12;
      devicePassphrase = nextDevicePassphrase;
      ethereumAddress = nextEthereumAddress;
      entityId = nextEntityId;
      passphrase = '';
      derivationRun = null;

      if (await prepareRecoveryDecisionFromCurrentSeed(run.name.trim() || `Wallet ${ethereumAddress.slice(0, 6)}`)) {
        await continueAfterRecoveryDiscovery();
      }
    } finally {
      masterKey?.fill(0);
      entropy?.fill(0);
      entropy12?.fill(0);
      deviceKey?.fill(0);
      for (const shard of orderedResults) shard.fill(0);
      wipeRunShards();
      if (derivationRun === run) {
        passphrase = '';
        derivationRun = null;
      }
    }
  }

  function terminateWorkers() {
    for (const worker of workers) {
      clearWorkerShardWatchdog(worker);
      detachWorkerHandlers(worker);
      worker?.terminate();
    }
    workers = [];
    drainingWorkers.clear();
    workerActiveShard.clear();
    workerShardWatchdogs.clear();
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
        const worker = createBrainVaultWorker();
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
    // Runtime creation/restore mutates durable vault and Runtime state before
    // its final await returns. Treat that interval as a point of no return:
    // resetting only the UI would lie about cancellation and allow a second
    // seed to race the still-committing first wallet.
    if (creatingRuntime) return;
    nodeDerivationAbort?.abort();
    nodeDerivationAbort = null;
    phase = 'input';
    terminateWorkers();
    resetRecoveryDecision();
    derivationError = '';
    workerLimitNotice = '';
    createLoginType = 'manual';
    publishRecoveryRehearsalState(resetWalletRecoveryRehearsal());
    showAdvanced = false;
    clearSensitiveWalletMaterial();
    nodeShardTimeMs = 0;
    creatingRuntime = false;
    shardsCompleted = 0;
  }

  onDestroy(() => {
    walletRecoveryDiscovery.invalidate();
    nodeDerivationAbort?.abort();
    nodeDerivationAbort = null;
    clearSensitiveWalletMaterial();
    terminateWorkers();
  });

  // Check for saved resume on mount + init i18n
  onMount(() => {
    let unsubscribe: (() => void) | undefined;

    // Restore the saved auth scheme (dark default)
    if (typeof localStorage !== 'undefined') {
      scheme = resolveWalletAuthScheme(localStorage.getItem(WALLET_AUTH_SCHEME_STORAGE_KEY));
    }

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

{#snippet recoverySecurityWarning()}
  <aside class="shared-risk" data-testid="wallet-recovery-warning" aria-label="Recovery security warning">
    <strong>Both recovery methods are vulnerable on an infected device.</strong>
    <p>A keylogger can steal a Brain Vault passphrase; malware can copy a mnemonic or the private key after derivation.</p>
    <p>Support cannot recover either secret.</p>
    <p>Never enter one while sharing your screen, recording video, or allowing remote access.</p>
    <p>For deeper protection, create multisig child entities inside your primary entity so one compromised signer or device cannot act alone.</p>
  </aside>
{/snippet}

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

  <!-- Main Content -->
  <div class="main-content">
    <div class="auth-brand" class:deriving={phase === 'deriving'}>
      <img
        src="/img/logo.png"
        alt="xln"
        width="92"
        height="80"
        decoding="async"
      />
    </div>

    <!-- INPUT SECTION - Always visible at top -->
    {#if phase === 'input' || phase === 'deriving'}
      <div class="glass-card input-section" class:deriving={phase === 'deriving'}>
        {#if phase === 'input'}
        {#if embedded && savedVaults.length > 0}
          <div class="creation-context-bar">
            <div class="creation-context-copy">Create another wallet</div>
            <button type="button" class="back-to-create" on:click={closeWalletEntry}>
              Back to wallet
            </button>
          </div>
        {/if}

        <div class="input-mode-tabs" role="tablist" aria-label="Wallet setup mode">
          <button
            id="wallet-mode-brainvault"
            type="button"
            role="tab"
            aria-selected={inputMode === 'brainvault'}
            aria-controls="wallet-panel-brainvault"
            tabindex={inputMode === 'brainvault' ? 0 : -1}
            class:selected={inputMode === 'brainvault'}
            disabled={phase !== 'input' || rehearsalMode !== null}
            on:click={() => selectInputMode('brainvault')}
            on:keydown={handleWalletModeKeydown}
          >
            Brain Vault
          </button>
          <button
            id="wallet-mode-mnemonic"
            type="button"
            role="tab"
            aria-selected={inputMode === 'mnemonic'}
            aria-controls="wallet-panel-mnemonic"
            tabindex={inputMode === 'mnemonic' ? 0 : -1}
            class:selected={inputMode === 'mnemonic'}
            disabled={phase !== 'input' || (rehearsalMode !== null && rehearsalMode !== 'mnemonic')}
            on:click={() => selectInputMode('mnemonic')}
            on:keydown={handleWalletModeKeydown}
          >
            Mnemonic
          </button>
        </div>

        <div class="wallet-create-title">
          <div>
            <h1>{rehearsalMode !== null
              ? 'Verify recovery'
              : inputMode === 'brainvault'
              ? 'Create xln wallet'
              : 'Create or restore from seed'}</h1>
            <p>{rehearsalMode !== null
              ? 'Re-enter the same recovery inputs. Only the public wallet fingerprint was kept from the first run.'
              : inputMode === 'brainvault'
              ? 'Your name and private secret recreate the same wallet. No backup phrase is required.'
              : 'Generate a new 24-word seed, or continue with a 12- or 24-word seed you already have.'}</p>
          </div>
        </div>

        {#if inputMode === 'brainvault'}
        <div
          id="wallet-panel-brainvault"
          class="mode-panel"
          role="tabpanel"
          aria-labelledby="wallet-mode-brainvault"
        >
        <!-- Name Input -->
        <div class="input-group">
          <label for="name">Vault name <span class="label-aside">public derivation input</span></label>
          <span class="input-hint">Capitalization and spaces matter. Use the exact same name on every device.</span>
          <div class="input-wrapper">
            <input
              type="text"
              id="name"
              bind:value={name}
              placeholder={t('vault.name.placeholder')}
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
            />
          </div>
        </div>

        <!-- Passphrase Input -->
        <div class="input-group">
          <label for="passphrase">Secret passphrase</label>
          <span class="input-hint">Private and exact. {derivesBrainVaultOnNode
            ? 'It is sent only to the selected trusted node.'
            : 'It stays in this browser.'}</span>
          <div class="input-wrapper">
            <input
              type={showPassphrase ? 'text' : 'password'}
              id="passphrase"
              bind:value={passphrase}
              placeholder={t('vault.password.placeholder')}
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
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
              title="Generate a random passphrase"
              aria-label="Generate a random passphrase"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M20 7h-9m9 10h-9M4 7h.01M4 17h.01M7 4l-3 3 3 3M7 17l-3 3 3 3"/>
              </svg>
            </button>
          </div>
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
            <span class="advanced-toggle-label">Advanced</span>
            <span class="advanced-toggle-summary">
              {`${factorInfo.tier} · ${factorInfo.shards.toLocaleString()} ${factorInfo.shards === 1 ? 'shard' : 'shards'} · ${formatRuntimeDurationRounded(workEstimate.recoveryMs)}`}
            </span>
          </span>
          <svg class="advanced-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        {#if showAdvanced}
          <div class="input-group factor-group advanced-panel">
            <div class="factor-buttons">
              {#each FACTOR_INFO as info}
                <button
                  type="button"
                  class="factor-btn"
                  class:selected={shardInput === info.factor}
                  on:click={() => selectPresetFactor(info.factor)}
                >
                  <span class="factor-num">{info.factor}</span>
                  <span class="factor-tier">{info.tier}</span>
                </button>
              {/each}
              <button
                type="button"
                class="factor-btn custom-btn"
                class:selected={!isPreset}
                on:click={selectCustomFactor}
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

              <div class="work-estimate" data-testid="brainvault-work-estimate">
                <div>
                  <span>{derivesBrainVaultOnNode
                    ? shardTimeMeasured ? 'Browser benchmark' : 'Initial browser estimate'
                    : shardTimeMeasured ? 'Measured on this device' : 'Initial device estimate'}</span>
                  <strong>{formatRuntimeDurationRounded(workEstimate.recoveryMs)}</strong>
                  <small>{Math.max(1, Math.min(effectiveTargetWorkerCount, actualShardCount || 1))} {derivesBrainVaultOnNode ? 'browser workers' : 'worker target'}</small>
                </div>
                <div>
                  <span>Every password guess</span>
                  <strong>{actualShardCount.toLocaleString()} × {SHARD_MEMORY_MB} MB</strong>
                  <small>{formatMemoryLabel(workEstimate.totalMemoryWorkMb)} total memory-work</small>
                </div>
              </div>
              <p class="measurement-note">
                {derivesBrainVaultOnNode
                  ? 'Browser comparison only. The native node benchmark appears after derivation.'
                  : shardTimeMeasured
                  ? 'Timing uses completed Argon2 work from this browser.'
                  : 'Timing updates and is saved after the first completed shard.'}
              </p>
              <p class="warning-text">Recovery requires the exact same vault name, passphrase, and work factor.</p>
            <aside class="execution-target" data-testid="brainvault-execution-target">
              <span class="section-eyebrow">Derivation target</span>
              <strong>{brainVaultExecutionTarget}</strong>
            </aside>
            <div class="unlock-duration-row">
              <label for="unlock-duration">Keep unlocked for</label>
              <select id="unlock-duration" bind:value={unlockDurationChoice}>
                <option value="10m">10 minutes</option>
                <option value="1d">1 day</option>
                <option value="forever">Forever on this device</option>
              </select>
            </div>
            {@render recoverySecurityWarning()}
          </div>
        {/if}
        </div>
        {:else if inputMode === 'mnemonic'}
        <div
          id="wallet-panel-mnemonic"
          class="mode-panel mnemonic-panel"
          role="tabpanel"
          aria-labelledby="wallet-mode-mnemonic"
        >
          <div class="tradeoff-card" data-testid="mnemonic-tradeoffs">
            <div class="tradeoff-heading">
              <span class="section-eyebrow">{WALLET_MODE_TRADEOFFS.mnemonic.eyebrow}</span>
              <p>{WALLET_MODE_TRADEOFFS.mnemonic.summary}</p>
            </div>
            <div class="tradeoff-grid">
              <div class="tradeoff-list benefit-list" role="list" aria-label="Benefits">
                {#each WALLET_MODE_TRADEOFFS.mnemonic.benefits as item}
                  <div role="listitem"><span aria-hidden="true">+</span><p>{item}</p></div>
                {/each}
              </div>
              <div class="tradeoff-list cost-list" role="list" aria-label="Costs">
                {#each WALLET_MODE_TRADEOFFS.mnemonic.costs as item}
                  <div role="listitem"><span aria-hidden="true">−</span><p>{item}</p></div>
                {/each}
                {#if WALLET_MODE_TRADEOFFS.mnemonic.linkedCost}
                  <div role="listitem">
                    <span aria-hidden="true">−</span>
                    <p>
                      {WALLET_MODE_TRADEOFFS.mnemonic.linkedCost.text}
                      <a
                        href={WALLET_MODE_TRADEOFFS.mnemonic.linkedCost.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >{WALLET_MODE_TRADEOFFS.mnemonic.linkedCost.linkText}</a>
                    </p>
                  </div>
                {/if}
              </div>
            </div>
            {@render recoverySecurityWarning()}
          </div>

          <div class="mnemonic-generate-row">
            <div>
              <span class="section-eyebrow">New wallet</span>
              <strong>Create a fresh seed</strong>
              <p>Generated locally from cryptographic randomness.</p>
            </div>
            <button
              class="generate-mnemonic-btn"
              on:click={generateRandomMnemonic}
              type="button"
            >
              Generate 24-word seed
            </button>
          </div>

          <div class="mnemonic-divider"><span>or paste an existing seed</span></div>

          <div class="input-group mnemonic-input-group">
            <div class="mnemonic-label-row">
              <label for="mnemonic">Seed phrase</label>
              <span class:ready={hasSupportedMnemonicWordCount(mnemonicInput)}>
                {mnemonicWordCount === 0 ? '12 or 24 words' : `${mnemonicWordCount} words`}
              </span>
            </div>
            <span class="input-hint">Paste exactly 12 or 24 BIP39 words.</span>
            <div class="input-wrapper">
              <textarea
                id="mnemonic"
                bind:value={mnemonicInput}
                use:disableTextareaAutocorrect
                placeholder="Enter your seed words…"
                rows="4"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
              ></textarea>
            </div>
          </div>

          {#if mnemonicInput}
            <div class="warning-box">
              <p><strong>Keep it offline.</strong> Anyone with these words controls this wallet.</p>
            </div>
          {/if}
        </div>
        {/if}

        <!-- Derive Button - always visible in the input phase. -->
        {#if rehearsalMode !== null}
            <div class="rehearsal-active" data-testid="recovery-rehearsal-active">
              <div>
                <span class="section-eyebrow">Optional recovery rehearsal</span>
                <strong>Re-enter to match {shortRuntimeId(rehearsalExpectedAddress)}</strong>
                <p>The first secret was cleared. Matching this public address proves that your recovery inputs work.</p>
              </div>
              <button type="button" on:click={cancelRecoveryRehearsal}>Cancel rehearsal</button>
            </div>
        {:else if inputMode === 'mnemonic'}
          <details class="mnemonic-advanced">
            <summary>Advanced</summary>
            <label class="rehearsal-option" data-testid="recovery-rehearsal-option">
              <input type="checkbox" bind:checked={rehearsalEnabled} />
              <span>
                <strong>Verify recovery before opening</strong>
                <small>Optional: clear the seed after validation and enter it again once.</small>
              </span>
              <em>Optional</em>
            </label>
            <div class="unlock-duration-row">
              <label for="mnemonic-unlock-duration">Keep unlocked for</label>
              <select id="mnemonic-unlock-duration" bind:value={unlockDurationChoice}>
                <option value="10m">10 minutes</option>
                <option value="1d">1 day</option>
                <option value="forever">Forever on this device</option>
              </select>
            </div>
          </details>
        {/if}
        <button
          class="derive-btn"
          disabled={!canDerive}
          on:click={startDerivation}
        >
          {rehearsalMode !== null
            ? 'Verify recovery'
            : inputMode === 'brainvault'
              ? derivesBrainVaultOnNode ? 'Derive on node' : 'Derive wallet'
              : 'Continue with seed'}
        </button>
        {#if derivationError}
          <div class="matrix-status error">{derivationError}</div>
        {/if}
        {/if}

        {#if phase === 'deriving'}
          <div class="input-progress">
            <div class="clean-progress-container">
              <div class="simple-progress">
                <div class="derivation-status">
                  <span class="section-eyebrow">{recoveryChecking
                    ? 'Recovery search'
                    : creatingRuntime
                      ? 'Opening wallet'
                      : inputMode === 'brainvault'
                        ? 'Brain Vault derivation'
                        : 'Seed validation'}</span>
                  <strong>{recoveryChecking
                    ? 'Finding the latest encrypted backup'
                    : creatingRuntime
                      ? 'Preparing your local runtime'
                      : inputMode === 'brainvault'
                        ? 'Turning memory into a wallet'
                        : 'Checking your seed phrase'}</strong>
                  <p>{recoveryChecking
                    ? 'Asking your configured watchtowers and saved remote runtimes.'
                    : inputMode === 'brainvault'
                      ? 'Keep this tab open until every shard is complete.'
                      : 'The same recovery path follows for every seed.'}</p>
                </div>

                {#if inputMode === 'brainvault' && !recoveryChecking && !creatingRuntime}
                  <div class="pyramid-progress-text">{Math.floor(progress)}%</div>

                  <div class="pyramid-progress-bar">
                    <div class="pyramid-progress-fill" style="width: {progress}%"></div>
                  </div>

                  <div class="speed-control">
                    <div class="speed-header">
                      <span class="speed-label">{derivesBrainVaultOnNode ? 'Native node compute' : 'Browser compute'}</span>
                      <span class="speed-eta">{formatRuntimeDurationRounded(projectedRemainingMs)} left</span>
                    </div>
                    <div class="speed-slider-wrapper">
                      <input
                        type="range"
                        min="1"
                        max={usableWorkerCap}
                        bind:value={targetWorkerCount}
                        on:input={adjustWorkers}
                        disabled={derivesBrainVaultOnNode}
                        class="speed-slider"
                        aria-label="Brain Vault worker count"
                      />
                    </div>
                    <div class="speed-details">
                      <span>{shardsCompleted}/{shardCount} shards</span>
                      <span>{activeWorkerCount} worker{activeWorkerCount === 1 ? '' : 's'} · {formatMemoryLabel(allocatedMemoryMB)}</span>
                    </div>
                    {#if workerLimitNotice}
                      <div class="speed-warning">{workerLimitNotice}</div>
                    {/if}
                  </div>
                {:else}
                  <div class="derivation-orbit" aria-hidden="true"></div>
                {/if}
              </div>

              <div class="anim-controls">
                <button
                  class="control-btn cancel"
                  disabled={creatingRuntime}
                  on:click={reset}
                  title={creatingRuntime ? 'Wallet persistence cannot be cancelled safely' : 'Cancel derivation'}
                >{creatingRuntime ? 'Finalizing wallet' : 'Cancel'}</button>
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if phase === 'node-ready' && nodeDerivationResult}
      <div class="glass-card input-section node-ready-card" data-testid="brainvault-node-ready">
        <div class="wallet-create-title">
          <div>
            <span class="section-eyebrow">Installed on trusted node</span>
            <h2>BrainVault signer is ready</h2>
            <p>The node owns the key. This browser currently holds only the public receipt.</p>
          </div>
        </div>

        <div class="node-result-grid">
          <div><span>Address</span><strong>{shortRuntimeId(nodeDerivationResult.ethereumAddress)}</strong></div>
          <div><span>Entity</span><strong>{shortRuntimeId(nodeDerivationResult.entityId)}</strong></div>
          <div><span>Native benchmark</span><strong>{formatRuntimeDurationRounded(nodeDerivationResult.derivationTimeMs)}</strong></div>
          <div><span>Browser estimate</span><strong>{formatRuntimeDurationRounded(workEstimate.recoveryMs)}</strong></div>
        </div>
        <p class="measurement-note">
          {nodeDerivationResult.shardCount.toLocaleString()} shards · {nodeDerivationResult.workers} native workers ·
          {workEstimate.recoveryMs > 0
            ? `${(workEstimate.recoveryMs / Math.max(1, nodeDerivationResult.derivationTimeMs)).toFixed(2)}× versus this browser estimate`
            : 'browser comparison unavailable'}
        </p>

        <div class="node-secret-export">
          {#if revealedNodeMnemonic}
            <label for="node-mnemonic-export">Recovery mnemonic</label>
            <textarea
              id="node-mnemonic-export"
              readonly
              rows="4"
              value={revealedNodeMnemonic}
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
            ></textarea>
            <p class="warning-text">Mnemonic is now present in this tab. Hide it before screen sharing or remote access.</p>
            <button type="button" class="backup-upload-btn" on:click={invalidateNodeReveal}>Hide mnemonic</button>
          {:else}
            <button
              type="button"
              class="backup-upload-btn"
              disabled={revealingNodeMnemonic}
              on:click={revealNodeMnemonic}
            >
              {revealingNodeMnemonic ? 'Loading from node…' : 'Show mnemonic'}
            </button>
          {/if}
        </div>
        {#if derivationError}<div class="matrix-status error">{derivationError}</div>{/if}
        <div class="recovery-actions">
          <button type="button" class="derive-btn" on:click={finishNodeWallet}>Open node wallet</button>
          <button type="button" class="back-to-create compact" on:click={reset}>Back</button>
        </div>
      </div>
    {/if}

    {#if phase === 'recovery'}
      <div class="glass-card input-section recovery-decision-card">
        <div class="wallet-create-title">
          <div>
            <h2>Restore wallet</h2>
            <p>Seed resolved for {shortRuntimeId(recoveryRuntimeId)}. Checking encrypted backups before any new runtime is created.</p>
          </div>
          <button
            type="button"
            class="back-to-create compact"
            disabled={creatingRuntime}
            on:click={reset}
          >
            {creatingRuntime ? 'Restoring…' : 'Back'}
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
                  disabled={creatingRuntime}
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
              <button
                type="button"
                class="backup-upload-btn"
                disabled={creatingRuntime}
                on:click={triggerBackupFilePicker}
              >
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
