<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, type ComponentType } from 'svelte';
  import { ethers } from 'ethers';
  import type { Env, EntityTx } from '@xln/runtime/xln-api';
  import type { BarColorMode, EntityReplica, Tab, ThemeName, UIStyleSettings } from '$lib/types/ui';
  import { activeVault, vaultOperations } from '$lib/stores/vaultStore';
  import {
    jmachineConfigs,
    jmachineOperations,
    parseJMachineConfigJson,
    stringifyJMachineConfig,
    type JMachineConfig,
  } from '$lib/stores/jmachineStore';
  import { settings, settingsOperations } from '$lib/stores/settingsStore';
  import { enqueueEntityInputs, p2pState, xlnEnvironment, xlnFunctions } from '$lib/stores/xlnStore';
  import { toasts } from '$lib/stores/toastStore';
  import { resetEverything } from '$lib/utils/resetEverything';
  import { THEME_DEFINITIONS, getAvailableThemes } from '$lib/utils/themes';
  import { DEFAULT_UI_STYLE } from '$lib/utils/ui-style';
  import { getBarColors } from '$lib/utils/bar-colors';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import { Check, ChevronDown, ChevronUp, Copy, Download, Trash2, Upload, X } from 'lucide-svelte';
  import AddJMachine from '$lib/components/Jurisdiction/AddJMachine.svelte';
  import FormationPanel from '$lib/components/Entity/FormationPanel.svelte';
  import GossipPanel from '$lib/components/Entity/GossipPanel.svelte';
  import ChatMessages from '$lib/components/Entity/ChatMessages.svelte';
  import TabStylePicker from '$lib/components/Settings/TabStylePicker.svelte';
  import { TAB_STYLE_OPTIONS, UI_STYLE_OPTIONS } from '$lib/utils/ui-style-options';

  export let embedded = false;
  export let replica: EntityReplica | null = null;
  export let tab: Tab | null = null;
  export let currentTimeIndex = -1;
  export let activeIsLive = true;
  export let jurisdictionLabel = '';
  export let requestedTab: SettingsTab | null = null;

  const dispatch = createEventDispatcher();

  type SettingsTab = 'wallet' | 'display' | 'network' | 'data' | 'log' | 'entity';

  const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
    { id: 'wallet', label: 'Wallet' },
    { id: 'display', label: 'Display' },
    { id: 'network', label: 'Network' },
    { id: 'data', label: 'Advanced' },
    { id: 'log', label: 'Log' },
    { id: 'entity', label: 'Entity' },
  ];

  const ACCOUNT_BAR_USD_PER_100PX_MIN = 10;
  const ACCOUNT_BAR_USD_PER_100PX_MAX = 10_000;
  const BUILD_UI_OPTIONS = UI_STYLE_OPTIONS.filter((group) => group.key !== 'tabs');
  const BALANCE_REFRESH_OPTIONS = [
    { label: 'Off', value: 0 },
    { label: '1s', value: 1000 },
    { label: '5s', value: 5000 },
    { label: '15s', value: 15000 },
    { label: '30s', value: 30000 },
    { label: '60s', value: 60000 },
  ];

  let activeTab: SettingsTab = requestedTab ?? 'wallet';
  let lastRequestedTab: SettingsTab | null = requestedTab;
  let IndexedDbInspectorComponent: ComponentType | null = null;
  let indexedDbInspectorLoading = false;
  let indexedDbInspectorError = '';

  let seedCopied = false;
  let mnemonic12Copied = false;
  let recoveryPhraseRevealed = false;

  let showAddJMachine = false;
  let editingJMachineName: string | null = null;
  let editMachineDraft: JMachineConfig | null = null;
  let editMachineJson = '';
  let editMachineError = '';
  let rpcTestStatus = new Map<string, string>();

  let selectedTheme: ThemeName = 'dark';
  let entityCreationOpen = false;
  let uiSettingsJsonDraft = '';
  let uiSettingsMessage = '';
  let uiSettingsMessageTone: 'neutral' | 'error' = 'neutral';

  let governanceName = '';
  let governanceBio = '';
  let governanceWebsite = '';
  let governanceSaving = false;
  let governanceLoadedForEntity = '';

  let hubConfigLoadedForEntity = '';
  let hubConfigSaving = false;
  let hubMatchingStrategy: 'amount' | 'time' | 'fee' = 'amount';
  let hubRoutingFeePPM = '1';
  let hubBaseFee = '0';
  let hubMinCollateralThreshold = '0';
  let hubRebalanceBaseFee = '0.1';
  let hubRebalanceLiquidityFeeBps = '1';
  let hubRebalanceGasFee = '0';
  let hubRebalanceTimeoutSeconds = '600';
  let hubPolicyVersion = '';

  let checkpointHeights: number[] = [];
  let checkpointRuntimeKey = '';
  let selectedCheckpointHeight = '';
  let checkpointLoadError = '';
  let verifyLoading = false;
  let verifyResult:
    | null
    | {
        latestHeight: number;
        checkpointHeight: number;
        selectedSnapshotHeight: number;
        restoredHeight: number;
      } = null;
  let verifyError = '';

  let nowMs = Date.now();
  let livenessTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    livenessTimer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  });

  onDestroy(() => {
    if (livenessTimer) clearInterval(livenessTimer);
  });

  $: if (requestedTab && requestedTab !== lastRequestedTab) {
    activeTab = requestedTab;
    lastRequestedTab = requestedTab;
  }

  $: if (activeTab !== 'wallet' && recoveryPhraseRevealed) {
    recoveryPhraseRevealed = false;
  }

  $: selectedTheme = $settings.theme;
  $: if (activeTab === 'display' && !uiSettingsJsonDraft) {
    uiSettingsJsonDraft = settingsOperations.exportUiSettingsJson();
  }
  $: currentEntityId = String(replica?.state?.entityId || tab?.entityId || '').trim();
  $: currentJurisdictionLabel = jurisdictionLabel
    || String(replica?.state?.config?.jurisdiction?.name || tab?.jurisdiction || '').trim()
    || 'None';
  $: processEnteredAt = $xlnEnvironment?.lastProcessEnteredAt || 0;
  $: processLagMs = processEnteredAt > 0 ? Math.max(0, nowMs - processEnteredAt) : null;
  $: processLivenessLabel = processEnteredAt > 0
    ? `${new Date(processEnteredAt).toLocaleTimeString()} (${Math.round((processLagMs || 0) / 1000)}s ago)`
    : 'never';
  $: networkRelayUrls = (() => {
    const p2p = $xlnEnvironment?.runtimeState?.p2p as { relayUrls?: string[] } | null | undefined;
    const relayUrls = p2p?.relayUrls;
    return Array.isArray(relayUrls) ? relayUrls : [];
  })();
  $: networkRelayUrl = String(networkRelayUrls[0] || $settings.relayUrl || '').trim() || 'n/a';
  $: networkReconnectSeconds = $p2pState.reconnect
    ? Math.max(0, Math.ceil(($p2pState.reconnect.nextAt - nowMs) / 1000))
    : 0;
  $: networkStatusTone = $p2pState.connected ? 'connected' : $p2pState.reconnect ? 'reconnecting' : 'disconnected';
  $: networkStatusLabel = $p2pState.connected ? 'Connected' : $p2pState.reconnect ? 'Reconnecting' : 'Disconnected';
  $: preferredIndexedDbNames = Array.from(new Set([
    $xlnEnvironment?.dbNamespace ? `level-js-db-${$xlnEnvironment.dbNamespace}` : '',
    $xlnEnvironment?.dbNamespace ? `level-js-db-${$xlnEnvironment.dbNamespace}-infra` : '',
    'level-js-db-default',
    'level-js-db-default-infra',
  ].filter(Boolean)));
  $: barLegendColors = getBarColors($settings.barColorMode, '#2775ca');
  $: accountBarUsdPer100Px = clampAccountBarUsdPer100Px(($settings.accountBarUsdPerPx ?? 100) * 100);

  $: if (activeTab === 'data' && !IndexedDbInspectorComponent && !indexedDbInspectorLoading) {
    indexedDbInspectorLoading = true;
    indexedDbInspectorError = '';
    void import('$lib/components/Settings/IndexedDbInspector.svelte')
      .then((module) => {
        IndexedDbInspectorComponent = module.default;
      })
      .catch((error) => {
        indexedDbInspectorError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        indexedDbInspectorLoading = false;
      });
  }

  $: if (activeTab === 'data' && $xlnEnvironment?.runtimeId) {
    void loadCheckpointHeights();
  }

  $: if (activeTab === 'entity') {
    loadGovernanceProfileFromGossip();
    loadHubConfigFromState();
  }

  function clampAccountBarUsdPer100Px(raw: unknown): number {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return 10_000;
    return Math.max(
      ACCOUNT_BAR_USD_PER_100PX_MIN,
      Math.min(ACCOUNT_BAR_USD_PER_100PX_MAX, Math.round(numeric)),
    );
  }

  function setAccountBarScale(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    settingsOperations.setAccountBarUsdPer100Px(clampAccountBarUsdPer100Px(target.value));
  }

  function setRuntimeDelay(value: number | string): void {
    const clampedValue = Math.max(0, Math.min(2000, Math.floor(Number(value) || 0)));
    settingsOperations.setRuntimeDelay(clampedValue);
    const env = $xlnEnvironment;
    if (!env) return;
    if (!env.runtimeConfig) {
      env.runtimeConfig = { minFrameDelayMs: clampedValue, loopIntervalMs: 25 };
    } else {
      env.runtimeConfig.minFrameDelayMs = clampedValue;
    }
  }

  function isRuntimeEnv(value: unknown): value is Env {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  function resolveEntitySigner(entityId: string, reason: string): string {
    const env = $xlnEnvironment;
    const functions = $xlnFunctions;
    if (env && functions?.resolveEntityProposerId) {
      return functions.resolveEntityProposerId(env, entityId, reason);
    }
    return requireSignerIdForEntity(env, entityId, reason);
  }

  function copySeed() {
    if ($activeVault?.seed) {
      navigator.clipboard.writeText($activeVault.seed);
      seedCopied = true;
      setTimeout(() => seedCopied = false, 2000);
    }
  }

  function copyMnemonic12() {
    if ($activeVault?.mnemonic12) {
      navigator.clipboard.writeText($activeVault.mnemonic12);
      mnemonic12Copied = true;
      setTimeout(() => mnemonic12Copied = false, 2000);
    }
  }

  function setUiStyleValue<K extends keyof UIStyleSettings>(key: K, value: UIStyleSettings[K]) {
    settingsOperations.setUiStyle({ [key]: value } as Pick<UIStyleSettings, K>);
  }

  function resetUiStyleTokens() {
    settingsOperations.setUiStyle(DEFAULT_UI_STYLE);
  }

  function refreshUiSettingsDraft() {
    uiSettingsJsonDraft = settingsOperations.exportUiSettingsJson();
    uiSettingsMessage = '';
    uiSettingsMessageTone = 'neutral';
  }

  async function copyUiSettingsJson() {
    const json = settingsOperations.exportUiSettingsJson();
    await navigator.clipboard.writeText(json);
    uiSettingsJsonDraft = json;
    uiSettingsMessage = 'UI settings JSON copied.';
    uiSettingsMessageTone = 'neutral';
  }

  function downloadUiSettingsJson() {
    const json = settingsOperations.exportUiSettingsJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `xln-ui-settings-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    uiSettingsJsonDraft = json;
    uiSettingsMessage = 'UI settings JSON downloaded.';
    uiSettingsMessageTone = 'neutral';
  }

  function importUiSettingsDraft() {
    try {
      settingsOperations.importUiSettingsJson(uiSettingsJsonDraft);
      uiSettingsJsonDraft = settingsOperations.exportUiSettingsJson();
      uiSettingsMessage = 'UI settings imported.';
      uiSettingsMessageTone = 'neutral';
    } catch (error) {
      uiSettingsMessage = error instanceof Error ? error.message : String(error);
      uiSettingsMessageTone = 'error';
    }
  }

  async function handleUiSettingsFileImport(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      uiSettingsJsonDraft = await file.text();
      importUiSettingsDraft();
    } finally {
      input.value = '';
    }
  }

  function openEditJMachine(config: JMachineConfig) {
    editingJMachineName = config.name;
    editMachineDraft = structuredClone(config);
    editMachineJson = stringifyJMachineConfig(config);
    editMachineError = '';
  }

  function cancelEditJMachine() {
    editingJMachineName = null;
    editMachineDraft = null;
    editMachineJson = '';
    editMachineError = '';
  }

  function syncJsonFromDraft() {
    if (!editMachineDraft) return;
    editMachineJson = stringifyJMachineConfig(editMachineDraft);
  }

  function applyJsonToDraft() {
    try {
      const parsed = parseJMachineConfigJson(editMachineJson);
      editMachineDraft = parsed;
      editMachineError = '';
    } catch (error) {
      editMachineError = error instanceof Error ? error.message : String(error);
    }
  }

  function saveEditedJMachine() {
    if (!editMachineDraft || !editingJMachineName) return;
    try {
      const normalized = parseJMachineConfigJson(editMachineJson || stringifyJMachineConfig(editMachineDraft));
      if (normalized.name.toLowerCase() !== editingJMachineName.toLowerCase()) {
        jmachineOperations.remove(editingJMachineName);
      }
      jmachineOperations.upsert(normalized);
      cancelEditJMachine();
    } catch (error) {
      editMachineError = error instanceof Error ? error.message : String(error);
    }
  }

  async function testJMachineRpc(config: JMachineConfig) {
    const key = config.name;
    if (config.mode === 'browservm') {
      rpcTestStatus.set(key, 'BrowserVM local jurisdiction');
      rpcTestStatus = new Map(rpcTestStatus);
      return;
    }
    const rpcUrl = config.rpcs[0];
    if (!rpcUrl) {
      rpcTestStatus.set(key, 'No RPC URL configured');
      rpcTestStatus = new Map(rpcTestStatus);
      return;
    }
    rpcTestStatus.set(key, 'Testing...');
    rpcTestStatus = new Map(rpcTestStatus);
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const network = await provider.getNetwork();
      const chainId = Number(network.chainId);
      let message = `Reachable: chain ${chainId}`;
      if (chainId !== config.chainId) {
        message += ` (expected ${config.chainId})`;
      }
      if (config.contracts?.depository && ethers.isAddress(config.contracts.depository)) {
        const code = await provider.getCode(config.contracts.depository);
        message += code && code !== '0x' ? ' • depository ok' : ' • depository missing';
      }
      rpcTestStatus.set(key, message);
    } catch (error) {
      rpcTestStatus.set(key, error instanceof Error ? error.message : String(error));
    }
    rpcTestStatus = new Map(rpcTestStatus);
  }

  async function importConfiguredJMachine(config: JMachineConfig) {
    try {
      const imported = await vaultOperations.importJMachine(config);
      const storedConfig: JMachineConfig = {
        ...imported,
        ...(imported.contracts ? { contracts: imported.contracts } : {}),
        createdAt: config.createdAt,
      };
      jmachineOperations.upsert(storedConfig);
      rpcTestStatus.set(config.name, 'Imported into active runtime');
      rpcTestStatus = new Map(rpcTestStatus);
    } catch (error) {
      rpcTestStatus.set(config.name, error instanceof Error ? error.message : String(error));
      rpcTestStatus = new Map(rpcTestStatus);
    }
  }

  async function handleJMachineCreate(event: CustomEvent<{
    name: string;
    mode: 'browservm' | 'rpc';
    chainId: number;
    rpcs: string[];
    ticker: string;
    contracts?: JMachineConfig['contracts'];
  }>) {
    const config: JMachineConfig = {
      name: event.detail.name,
      mode: event.detail.mode,
      chainId: event.detail.chainId,
      rpcs: event.detail.rpcs,
      ticker: event.detail.ticker,
      ...(event.detail.contracts ? { contracts: event.detail.contracts } : {}),
      createdAt: Date.now(),
    };
    jmachineOperations.upsert(config);
    showAddJMachine = false;
    await importConfiguredJMachine(config);
  }

  async function loadCheckpointHeights() {
    const env = $xlnEnvironment;
    const runtimeId = String(env?.runtimeId || '').toLowerCase();
    if (!env || !runtimeId) {
      checkpointHeights = [];
      checkpointRuntimeKey = '';
      selectedCheckpointHeight = '';
      return;
    }
    if (checkpointRuntimeKey === runtimeId && checkpointHeights.length > 0) return;
    checkpointLoadError = '';
    try {
      const heights = await vaultOperations.listPersistedCheckpointHeights(env);
      checkpointHeights = heights;
      checkpointRuntimeKey = runtimeId;
      if (!selectedCheckpointHeight || !heights.includes(Number(selectedCheckpointHeight))) {
        selectedCheckpointHeight = heights.length > 0 ? String(heights[heights.length - 1]) : '';
      }
    } catch (error) {
      checkpointHeights = [];
      checkpointRuntimeKey = runtimeId;
      checkpointLoadError = error instanceof Error ? error.message : String(error);
    }
  }

  async function verifyRuntimeChainNow() {
    const env = $xlnEnvironment;
    const runtimeId = String(env?.runtimeId || '').trim() || null;
    const runtimeSeed = $activeVault?.seed || null;
    if (!runtimeId || !runtimeSeed) return;
    verifyLoading = true;
    verifyError = '';
    verifyResult = null;
    try {
      const selectedHeight = Number(selectedCheckpointHeight || 0);
      const verifyOptions = Number.isFinite(selectedHeight) && selectedHeight > 0
        ? { fromSnapshotHeight: selectedHeight }
        : {};
      const result = await vaultOperations.verifyRuntimeChain(runtimeId, runtimeSeed, verifyOptions);
      verifyResult = {
        latestHeight: result.latestHeight,
        checkpointHeight: result.checkpointHeight,
        selectedSnapshotHeight: result.selectedSnapshotHeight,
        restoredHeight: result.restoredHeight,
      };
    } catch (error) {
      verifyError = error instanceof Error ? error.message : String(error);
    } finally {
      verifyLoading = false;
    }
  }

  function loadGovernanceProfileFromGossip() {
    const entityId = currentEntityId.toLowerCase();
    if (!entityId || governanceLoadedForEntity === entityId) return;
    governanceLoadedForEntity = entityId;
    const profiles = ($xlnEnvironment?.gossip?.getProfiles?.() || []) as Array<{
      entityId?: string;
      name?: string;
      bio?: string;
      website?: string;
    }>;
    const profile = profiles.find((candidate) => String(candidate?.entityId || '').toLowerCase() === entityId);
    governanceName = String(profile?.name || '');
    governanceBio = String(profile?.bio || '');
    governanceWebsite = String(profile?.website || '');
  }

  async function saveGovernanceProfile() {
    const entityId = currentEntityId;
    const signerId = entityId ? resolveEntitySigner(entityId, 'governance-profile-update') : '';
    const env = $xlnEnvironment;
    if (!entityId || !signerId) {
      toasts.error('Entity/signer is required for profile update');
      return;
    }
    if (!isRuntimeEnv(env) || !activeIsLive) {
      toasts.error('Profile updates require LIVE mode');
      return;
    }

    governanceSaving = true;
    try {
      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'profile-update' as const,
          data: {
            profile: {
              entityId,
              name: governanceName.trim(),
              bio: governanceBio.trim(),
              website: governanceWebsite.trim(),
              hankoSignature: '',
            },
          },
        }],
      }]);
      toasts.success('Entity profile update submitted');
      governanceLoadedForEntity = '';
      loadGovernanceProfileFromGossip();
    } catch (error) {
      toasts.error(`Entity profile update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      governanceSaving = false;
    }
  }

  function formatFixed18(value: bigint): string {
    const base = 10n ** 18n;
    const whole = value / base;
    const frac = value % base;
    if (frac === 0n) return whole.toString();
    const fracRaw = frac.toString().padStart(18, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracRaw}`;
  }

  function parseFixed18(raw: string): bigint | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!/^\d+(\.\d{0,18})?$/.test(trimmed)) return null;
    const [wholePart, fracPartRaw = ''] = trimmed.split('.');
    const whole = BigInt(wholePart || '0');
    const frac = BigInt((fracPartRaw + '0'.repeat(18)).slice(0, 18));
    return whole * (10n ** 18n) + frac;
  }

  function loadHubConfigFromState() {
    const entityId = currentEntityId.toLowerCase();
    if (!entityId || hubConfigLoadedForEntity === entityId) return;
    hubConfigLoadedForEntity = entityId;

    const config = replica?.state?.hubRebalanceConfig;
    hubMatchingStrategy = (config?.matchingStrategy === 'time' || config?.matchingStrategy === 'fee')
      ? config.matchingStrategy
      : 'amount';
    hubRoutingFeePPM = String(config?.routingFeePPM ?? 1);
    hubBaseFee = formatFixed18(config?.baseFee ?? 0n);
    hubMinCollateralThreshold = formatFixed18(config?.minCollateralThreshold ?? 0n);
    hubRebalanceBaseFee = formatFixed18(config?.rebalanceBaseFee ?? (10n ** 17n));
    hubRebalanceLiquidityFeeBps = String(config?.rebalanceLiquidityFeeBps ?? config?.minFeeBps ?? 1n);
    hubRebalanceGasFee = formatFixed18(config?.rebalanceGasFee ?? 0n);
    hubRebalanceTimeoutSeconds = String(Math.floor((config?.rebalanceTimeoutMs ?? (10 * 60 * 1000)) / 1000));
    hubPolicyVersion = config?.policyVersion ? String(config.policyVersion) : '';
  }

  async function saveHubConfig() {
    const entityId = currentEntityId;
    const signerId = entityId ? resolveEntitySigner(entityId, 'hub-config-update') : '';
    const env = $xlnEnvironment;
    if (!entityId || !signerId) {
      toasts.error('Entity/signer is required for hub config update');
      return;
    }
    if (!isRuntimeEnv(env) || !activeIsLive) {
      toasts.error('Hub config updates require LIVE mode');
      return;
    }

    const routingFeePPM = Number(hubRoutingFeePPM);
    if (!Number.isFinite(routingFeePPM) || routingFeePPM < 0) {
      toasts.error('Routing fee PPM must be a non-negative number');
      return;
    }
    const rebalanceTimeoutSeconds = Number(hubRebalanceTimeoutSeconds);
    if (!Number.isFinite(rebalanceTimeoutSeconds) || rebalanceTimeoutSeconds < 1) {
      toasts.error('Timeout must be at least 1 second');
      return;
    }

    const baseFee = parseFixed18(hubBaseFee);
    const minCollateralThreshold = parseFixed18(hubMinCollateralThreshold);
    const rebalanceBaseFee = parseFixed18(hubRebalanceBaseFee);
    const rebalanceGasFee = parseFixed18(hubRebalanceGasFee);
    let rebalanceLiquidityFeeBps: bigint;

    try {
      rebalanceLiquidityFeeBps = BigInt(hubRebalanceLiquidityFeeBps.trim());
    } catch {
      toasts.error('Liquidity fee bps must be an integer');
      return;
    }

    if (
      baseFee === null
      || minCollateralThreshold === null
      || rebalanceBaseFee === null
      || rebalanceGasFee === null
    ) {
      toasts.error('Fee and threshold fields must be valid decimal numbers');
      return;
    }

    let explicitPolicyVersion: number | undefined;
    if (hubPolicyVersion.trim()) {
      const parsed = Number(hubPolicyVersion.trim());
      if (!Number.isFinite(parsed) || parsed < 1) {
        toasts.error('Policy version must be a positive integer');
        return;
      }
      explicitPolicyVersion = Math.floor(parsed);
    }

    hubConfigSaving = true;
    try {
      const txData: Extract<EntityTx, { type: 'setHubConfig' }>['data'] = {
        matchingStrategy: hubMatchingStrategy,
        routingFeePPM: Math.floor(routingFeePPM),
        baseFee,
        minCollateralThreshold,
        rebalanceBaseFee,
        rebalanceLiquidityFeeBps,
        rebalanceGasFee,
        rebalanceTimeoutMs: Math.floor(rebalanceTimeoutSeconds * 1000),
      };
      if (explicitPolicyVersion !== undefined) {
        txData.policyVersion = explicitPolicyVersion;
      }

      await enqueueEntityInputs(env, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'setHubConfig' as const,
          data: txData,
        }],
      }]);

      toasts.success('Hub config update submitted');
      hubConfigLoadedForEntity = '';
      loadHubConfigFromState();
    } catch (error) {
      toasts.error(`Hub config update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      hubConfigSaving = false;
    }
  }

  function confirmResetAllData() {
    const confirmed = confirm('Clear all local XLN data? This resets wallets, runtime state, and caches.');
    if (!confirmed) return;
    void resetEverything();
  }

  function close() {
    dispatch('close');
  }
</script>

<div class="entity-settings" class:embedded>
  {#if !embedded}
    <div class="header">
      <h2>Settings</h2>
      <button class="close-btn" on:click={close}>
        <X size={18} />
      </button>
    </div>
  {/if}

  <nav class="settings-tabs" aria-label="Settings workspace">
    {#each SETTINGS_TABS as item}
      <button
        class="settings-tab"
        class:active={activeTab === item.id}
        on:click={() => activeTab = item.id}
      >
        <span>{item.label}</span>
      </button>
    {/each}
  </nav>

  <div class="settings-content">
    {#if activeTab === 'wallet'}
      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Wallet</h3>
            <p class="section-desc">Wallet label and recovery access.</p>
          </div>
        </div>

        {#if $activeVault}
          <div class="info-card">
            <div class="info-row">
              <span class="label">Label</span>
              <span class="value">{$activeVault.label}</span>
            </div>
            <div class="info-row">
              <span class="label">Created</span>
              <span class="value">{new Date($activeVault.createdAt).toLocaleDateString()}</span>
            </div>
          </div>

          <div class="seed-card">
            <div class="seed-warning">
              Never share your recovery phrase. Anyone with it can access your funds.
            </div>

            <div class="seed-gate">
              <div class="seed-gate-copy">
                <strong>Recovery phrase</strong>
                <span>Hidden by default. Reveal only when you are alone and ready to back it up.</span>
              </div>
              <button
                class="btn-secondary seed-gate-btn"
                type="button"
                on:click={() => recoveryPhraseRevealed = !recoveryPhraseRevealed}
              >
                {recoveryPhraseRevealed ? 'Hide phrase' : 'Reveal phrase'}
              </button>
            </div>

            {#if recoveryPhraseRevealed}
              {#if $activeVault.mnemonic12}
                <div class="seed-row">
                  <div class="seed-row-head">
                    <span>12 words</span>
                    <button class="icon-btn" on:click={copyMnemonic12}>
                      {#if mnemonic12Copied}
                        <Check size={14} />
                      {:else}
                        <Copy size={14} />
                      {/if}
                    </button>
                  </div>
                  <code class="seed-code">{$activeVault.mnemonic12}</code>
                </div>
              {/if}

              <div class="seed-row">
                <div class="seed-row-head">
                  <span>24 words</span>
                  <button class="icon-btn" on:click={copySeed}>
                    {#if seedCopied}
                      <Check size={14} />
                    {:else}
                      <Copy size={14} />
                    {/if}
                  </button>
                </div>
                <code class="seed-code">{$activeVault.seed}</code>
              </div>
            {/if}
          </div>
        {:else}
          <div class="empty-card">No wallet connected. Create or import a wallet first.</div>
        {/if}
      </section>

    {:else if activeTab === 'display'}
      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Theme</h3>
            <p class="section-desc">Applies across the full XLN app.</p>
          </div>
        </div>

        <label class="setting-row stacked">
          <span class="setting-title">Color Theme</span>
          <select bind:value={selectedTheme} on:change={(event) => settingsOperations.setTheme((event.currentTarget as HTMLSelectElement).value as ThemeName)} data-testid="settings-theme-select">
            {#each getAvailableThemes() as theme}
              <option value={theme.id}>{theme.name}</option>
            {/each}
          </select>
        </label>

        <div class="theme-grid">
          {#each getAvailableThemes() as theme}
            {@const colors = THEME_DEFINITIONS[theme.id]}
            <button
              class="theme-swatch"
              class:active={$settings.theme === theme.id}
              title={theme.name}
              data-testid={`theme-swatch-${theme.id}`}
              on:click={() => settingsOperations.setTheme(theme.id)}
            >
              <div class="swatch-preview" style={`background:${colors.background};border-color:${colors.surfaceBorder};`}>
                <div class="swatch-bar" style={`background:${colors.barCollateral};width:64%;`}></div>
                <div class="swatch-bar" style={`background:${colors.barDebt};width:34%;`}></div>
                <div class="swatch-text" style={`color:${colors.textPrimary};`}>Aa</div>
                <div class="swatch-accent" style={`background:${colors.accentColor};`}></div>
              </div>
              <span class="swatch-label" class:active={$settings.theme === theme.id}>{theme.name}</span>
            </button>
          {/each}
        </div>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Display</h3>
            <p class="section-desc">Formatting and UI presentation.</p>
          </div>
        </div>

        <label class="setting-row">
          <span class="setting-title">Compact Numbers</span>
          <button class="toggle" class:on={$settings.compactNumbers} on:click={() => settingsOperations.setCompactNumbers(!$settings.compactNumbers)}>
            {$settings.compactNumbers ? 'On' : 'Off'}
          </button>
        </label>

        <label class="setting-row">
          <div class="setting-copy">
            <span class="setting-title">Lite Mode</span>
            <span class="setting-help">Hide bars, extra telemetry, and dense infrastructure details on wallet surfaces.</span>
          </div>
          <button class="toggle" class:on={$settings.liteMode} on:click={() => settingsOperations.setLiteMode(!$settings.liteMode)}>
            {$settings.liteMode ? 'On' : 'Off'}
          </button>
        </label>

        <label class="setting-row">
          <span class="setting-title">Show Token Icons</span>
          <input type="checkbox" checked={$settings.showTokenIcons} on:change={(event) => settingsOperations.setShowTokenIcons((event.currentTarget as HTMLInputElement).checked)} />
        </label>

        <label class="setting-row">
          <span class="setting-title">Time Machine</span>
          <button class="toggle" class:on={$settings.showTimeMachine} on:click={() => settingsOperations.setShowTimeMachine(!$settings.showTimeMachine)}>
            {$settings.showTimeMachine ? 'On' : 'Off'}
          </button>
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Token Precision</span>
          <div class="slider-row">
            <input type="range" min="2" max="18" step="1" value={$settings.tokenPrecision} on:input={(event) => settingsOperations.setTokenPrecision(Number((event.currentTarget as HTMLInputElement).value))} />
            <span class="slider-value">{$settings.tokenPrecision === 18 ? 'full' : `${$settings.tokenPrecision}d`}</span>
          </div>
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Account Delta View</span>
          <select value={$settings.accountDeltaViewMode} on:change={(event) => settingsOperations.setAccountDeltaViewMode((event.currentTarget as HTMLSelectElement).value as 'per-token' | 'aggregated')}>
            <option value="per-token">Per token</option>
            <option value="aggregated">Aggregated</option>
          </select>
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Portfolio Scale</span>
          <div class="slider-row">
            <input type="range" min="1000" max="10000" step="500" value={$settings.portfolioScale} on:input={(event) => settingsOperations.setPortfolioScale(Number((event.currentTarget as HTMLInputElement).value))} />
            <span class="slider-value">${$settings.portfolioScale.toLocaleString()}</span>
          </div>
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Bar Colors</span>
          <select value={$settings.barColorMode} on:change={(event) => settingsOperations.setBarColorMode((event.currentTarget as HTMLSelectElement).value as BarColorMode)}>
            <option value="rgy">Traffic Light (RGY)</option>
            <option value="theme">Match Theme</option>
            <option value="token">Per-token Color</option>
          </select>
          <div class="bar-legend-mini">
            <span class="legend-swatch" style={`background:${barLegendColors.credit};opacity:0.5;`}></span> Credit
            <span class="legend-swatch" style={`background:${barLegendColors.collateral};`}></span> Collateral
            <span class="legend-swatch" style={`background:${barLegendColors.debt};`}></span> Debt
          </div>
        </label>

        <div class="appearance-block tab-groups-block">
          <div class="style-group-head">
            <span class="setting-title">Tab Groups</span>
            <span class="helper-note">Choose how workspace tabs, segmented controls, and filter rails look across the wallet.</span>
          </div>
          <TabStylePicker
            value={$settings.uiStyle.tabs}
            options={TAB_STYLE_OPTIONS}
            on:change={(event) => setUiStyleValue('tabs', event.detail)}
          />
        </div>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Build Your UI</h3>
            <p class="section-desc">Testnet-only design controls for gathering user feedback without changing the default test path.</p>
          </div>
          <button class="compact-btn" on:click={resetUiStyleTokens}>Reset Style</button>
        </div>

        <div class="style-grid">
          {#each BUILD_UI_OPTIONS as group}
            <div class="style-group">
              <div class="style-group-head">
                <span class="setting-title">{group.label}</span>
                <span class="helper-note">{group.description}</span>
              </div>
              <div class="pill-group" role="tablist" aria-label={group.label}>
                {#each group.options as option}
                  <button
                    type="button"
                    class="pill"
                    class:active={$settings.uiStyle[group.key] === option.value}
                    aria-pressed={$settings.uiStyle[group.key] === option.value}
                    on:click={() => setUiStyleValue(group.key, option.value)}
                  >
                    {option.label}
                  </button>
                {/each}
              </div>
              <span class="style-current">
                Current: {group.options.find((option) => option.value === $settings.uiStyle[group.key])?.label ?? 'Default'}
              </span>
            </div>
          {/each}
        </div>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Account Bars</h3>
            <p class="section-desc">Layout, scale, and animation effects.</p>
          </div>
        </div>

        <div class="appearance-block">
          <span class="setting-title">Layout</span>
          <div class="pill-group" role="tablist" aria-label="Account bar layout">
            <button type="button" class="pill" class:active={$settings.barLayout === 'center'} aria-pressed={$settings.barLayout === 'center'} on:click={() => settingsOperations.setBarLayout('center')}>Center</button>
            <button type="button" class="pill" class:active={$settings.barLayout === 'sides'} aria-pressed={$settings.barLayout === 'sides'} on:click={() => settingsOperations.setBarLayout('sides')}>Sides</button>
          </div>
        </div>

        <div class="appearance-block">
          <div class="scale-head">
            <span class="setting-title">Scale</span>
            <strong class="slider-value">100px = ${accountBarUsdPer100Px.toLocaleString('en-US')}</strong>
          </div>
          <input type="range" min={ACCOUNT_BAR_USD_PER_100PX_MIN} max={ACCOUNT_BAR_USD_PER_100PX_MAX} step="10" value={accountBarUsdPer100Px} on:input={setAccountBarScale} />
        </div>

        <label class="setting-row">
          <span class="setting-title">Credit Gradient</span>
          <input type="checkbox" checked={$settings.barCreditGradient} on:change={(event) => settingsOperations.update({ barCreditGradient: (event.currentTarget as HTMLInputElement).checked })} />
        </label>

        <label class="setting-row">
          <span class="setting-title">Smooth Resize</span>
          <input type="checkbox" checked={$settings.barAnimTransition} on:change={(event) => settingsOperations.update({ barAnimTransition: (event.currentTarget as HTMLInputElement).checked })} />
        </label>

        <label class="setting-row">
          <span class="setting-title">Sweep</span>
          <input type="checkbox" checked={$settings.barAnimSweep} on:change={(event) => settingsOperations.update({ barAnimSweep: (event.currentTarget as HTMLInputElement).checked })} />
        </label>

        <label class="setting-row">
          <span class="setting-title">Glow</span>
          <input type="checkbox" checked={$settings.barAnimGlow} on:change={(event) => settingsOperations.update({ barAnimGlow: (event.currentTarget as HTMLInputElement).checked })} />
        </label>

        <label class="setting-row">
          <span class="setting-title">Delta Flash</span>
          <input type="checkbox" checked={$settings.barAnimDeltaFlash} on:change={(event) => settingsOperations.update({ barAnimDeltaFlash: (event.currentTarget as HTMLInputElement).checked })} />
        </label>

        <label class="setting-row">
          <span class="setting-title">Ripple</span>
          <input type="checkbox" checked={$settings.barAnimRipple} on:change={(event) => settingsOperations.update({ barAnimRipple: (event.currentTarget as HTMLInputElement).checked })} />
        </label>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>UI Settings JSON</h3>
            <p class="section-desc">Copy, share, import, or download the current visual settings.</p>
          </div>
        </div>

        <div class="editor-actions">
          <button class="compact-btn" on:click={refreshUiSettingsDraft}>
            <ChevronDown size={14} />
            <span>Refresh JSON</span>
          </button>
          <button class="compact-btn" on:click={copyUiSettingsJson}>
            <Copy size={14} />
            <span>Copy JSON</span>
          </button>
          <button class="compact-btn" on:click={downloadUiSettingsJson}>
            <Download size={14} />
            <span>Download</span>
          </button>
          <label class="compact-btn file-btn">
            <Upload size={14} />
            <span>Import File</span>
            <input type="file" accept="application/json" on:change={handleUiSettingsFileImport} />
          </label>
        </div>

        <textarea bind:value={uiSettingsJsonDraft} rows="14" class="ui-json-editor" data-testid="settings-ui-json"></textarea>

        <div class="editor-actions">
          <button class="primary-btn" on:click={importUiSettingsDraft}>Apply JSON</button>
        </div>

        {#if uiSettingsMessage}
          <p class:helper-note={uiSettingsMessageTone === 'neutral'} class:error-text={uiSettingsMessageTone === 'error'}>
            {uiSettingsMessage}
          </p>
        {/if}
      </section>

    {:else if activeTab === 'network'}
      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Relay Status</h3>
            <p class="section-desc">Live P2P transport state for the active runtime.</p>
          </div>
        </div>
        <div class="info-card">
          <div class="info-row">
            <span class="label">Status</span>
            <span class="value">
              <span class="network-status-badge {networkStatusTone}">{networkStatusLabel}</span>
            </span>
          </div>
          <div class="info-row">
            <span class="label">Relay</span>
            <span class="value mono">{networkRelayUrl}</span>
          </div>
          {#if $p2pState.reconnect}
            <div class="info-row">
              <span class="label">Reconnect</span>
              <span class="value">Attempt {$p2pState.reconnect.attempt} · retry in {networkReconnectSeconds}s</span>
            </div>
          {/if}
        </div>

        <label class="setting-row stacked">
          <span class="setting-title">Balance Refresh</span>
          <span class="setting-desc">How often wallet balances poll RPC. Hard-capped to once per second.</span>
          <select
            value={$settings.balanceRefreshMs ?? 15000}
            on:change={(event) => settingsOperations.setBalanceRefreshMs(Number((event.currentTarget as HTMLSelectElement).value))}
            data-testid="settings-network-balance-refresh"
          >
            {#each BALANCE_REFRESH_OPTIONS as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Jurisdictions</h3>
            <p class="section-desc">Manage imported jurisdictions for the active runtime.</p>
          </div>
        </div>

        <details class="helper-details">
          <summary>Local Dev: second anvil</summary>
          <div class="helper-note">
            Run <code>bun run dev:anvil2</code> to start a second local jurisdiction with a full XLN stack.
            The script prints an import-ready JSON config you can paste into a custom jurisdiction entry below.
          </div>
        </details>

        <div class="network-list">
          {#each $jmachineConfigs as machine}
            <div class="network-row">
              <div class="network-info">
                <span class="network-icon">{machine.mode === 'browservm' ? '🖥️' : '🌐'}</span>
                <div class="network-details">
                  <span class="network-name">{machine.name}</span>
                  <span class="network-meta">Chain {machine.chainId} · {machine.ticker} · {machine.mode === 'browservm' ? 'BrowserVM' : (machine.rpcs[0] || 'no-rpc')}</span>
                </div>
              </div>
              <div class="network-actions">
                <button class="compact-btn" on:click={() => openEditJMachine(machine)}>Edit</button>
                <button class="compact-btn" on:click={() => void testJMachineRpc(machine)}>Test RPC</button>
                <button class="compact-btn" on:click={() => void importConfiguredJMachine(machine)}>Import</button>
                <button class="danger-icon" on:click={() => jmachineOperations.remove(machine.name)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {#if rpcTestStatus.get(machine.name)}
              <p class="helper-note">{rpcTestStatus.get(machine.name)}</p>
            {/if}

            {#if editingJMachineName === machine.name && editMachineDraft}
              <div class="inline-editor">
                <div class="editor-grid">
                  <label>
                    <span>Name</span>
                    <input type="text" bind:value={editMachineDraft.name} on:input={syncJsonFromDraft} />
                  </label>
                  <label>
                    <span>Chain ID</span>
                    <input type="number" bind:value={editMachineDraft.chainId} on:input={syncJsonFromDraft} />
                  </label>
                  <label>
                    <span>Ticker</span>
                    <input type="text" bind:value={editMachineDraft.ticker} on:input={syncJsonFromDraft} />
                  </label>
                  <label>
                    <span>Mode</span>
                    <select bind:value={editMachineDraft.mode} on:change={syncJsonFromDraft}>
                      <option value="rpc">RPC</option>
                      <option value="browservm">BrowserVM</option>
                    </select>
                  </label>
                </div>

                <label>
                  <span>Primary RPC</span>
                  <input
                    type="text"
                    value={editMachineDraft.rpcs[0] || ''}
                    on:input={(event) => {
                      editMachineDraft = {
                        ...editMachineDraft!,
                        rpcs: (event.currentTarget as HTMLInputElement).value.trim()
                          ? [(event.currentTarget as HTMLInputElement).value.trim()]
                          : [],
                      };
                      syncJsonFromDraft();
                    }}
                    placeholder="https://rpc.example.com"
                  />
                </label>

                <details class="helper-details" open>
                  <summary>Advanced JSON</summary>
                  <textarea bind:value={editMachineJson} rows="12"></textarea>
                  <div class="editor-actions">
                    <button class="compact-btn" on:click={applyJsonToDraft}>Apply JSON</button>
                    <button class="compact-btn" on:click={syncJsonFromDraft}>Format</button>
                  </div>
                </details>

                {#if editMachineError}
                  <p class="error-text">{editMachineError}</p>
                {/if}

                <div class="editor-actions">
                  <button class="compact-btn" on:click={cancelEditJMachine}>Cancel</button>
                  <button class="primary-btn" on:click={saveEditedJMachine}>Save</button>
                </div>
              </div>
            {/if}
          {/each}
        </div>

        {#if $jmachineConfigs.length === 0}
          <p class="helper-note">No jurisdictions configured yet.</p>
        {/if}

        <button
          class="expand-btn"
          on:click={() => showAddJMachine = !showAddJMachine}
          data-testid="settings-network-add-jmachine-toggle"
        >
          {#if showAddJMachine}
            <ChevronUp size={14} />
          {:else}
            <ChevronDown size={14} />
          {/if}
          <span>Add Custom Jurisdiction</span>
        </button>

        {#if showAddJMachine}
          <div class="expand-panel">
            <AddJMachine on:create={handleJMachineCreate} on:cancel={() => showAddJMachine = false} />
          </div>
        {/if}
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Gossip Directory</h3>
            <p class="section-desc">Runtime-discovered entities and hubs.</p>
          </div>
        </div>
        <GossipPanel currentEntityId={currentEntityId} />
      </section>

    {:else if activeTab === 'data'}
      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Runtime</h3>
            <p class="section-desc">Operational runtime controls and diagnostics.</p>
          </div>
        </div>

        <label class="setting-row">
          <span class="setting-title">Verbose Logging</span>
          <button class="toggle" class:on={$settings.verboseLogging} on:click={() => settingsOperations.setVerboseLogging(!$settings.verboseLogging)}>
            {$settings.verboseLogging ? 'On' : 'Off'}
          </button>
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Frame Delay</span>
          <div class="slider-row">
            <input
              type="range"
              min="0"
              max="2000"
              step="10"
              value={$settings.runtimeDelay}
              on:input={(event) => setRuntimeDelay((event.currentTarget as HTMLInputElement).value)}
              data-testid="settings-runtime-delay"
            />
            <span class="slider-value">{$settings.runtimeDelay === 0 ? 'instant' : `${$settings.runtimeDelay}ms`}</span>
          </div>
        </label>

        <div class="setting-row">
          <span class="setting-title">Last process() tick</span>
          <span class="mono-value">{processLivenessLabel}</span>
        </div>
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Storage</h3>
            <p class="section-desc">Inspect IndexedDB blobs for the active runtime.</p>
          </div>
        </div>

        {#if indexedDbInspectorError}
          <p class="error-text">{indexedDbInspectorError}</p>
        {:else if indexedDbInspectorLoading || !IndexedDbInspectorComponent}
          <p class="helper-note">Loading inspector...</p>
        {:else}
          <svelte:component
            this={IndexedDbInspectorComponent}
            databaseNames={preferredIndexedDbNames}
            databaseNamePrefixes={['level-js-db-']}
            pageSize={40}
          />
        {/if}
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Runtime Verify</h3>
            <p class="section-desc">Replay from a snapshot and compare the final state hash.</p>
          </div>
        </div>

        <label class="setting-row stacked">
          <span class="setting-title">Start from snapshot</span>
          <select bind:value={selectedCheckpointHeight} on:focus={() => void loadCheckpointHeights()} data-testid="settings-verify-checkpoint">
            {#if checkpointHeights.length === 0}
              <option value="">No snapshots</option>
            {:else}
              {#each checkpointHeights as height}
                <option value={String(height)}>
                  {height === 1 ? 'Genesis snapshot (frame 1)' : `Snapshot ${height}`}
                </option>
              {/each}
            {/if}
          </select>
        </label>

        <button
          class="primary-btn"
          on:click={verifyRuntimeChainNow}
          disabled={verifyLoading || checkpointHeights.length === 0 || !$xlnEnvironment?.runtimeId || !$activeVault?.seed}
          data-testid="settings-verify-runtime-chain"
        >
          {verifyLoading ? 'Verifying...' : 'Verify Chain'}
        </button>

        {#if checkpointLoadError}
          <p class="error-text">{checkpointLoadError}</p>
        {/if}
        {#if verifyError}
          <p class="error-text">{verifyError}</p>
        {/if}
        {#if verifyResult}
          <p class="helper-note">
            Verified through frame {verifyResult.latestHeight} from {verifyResult.selectedSnapshotHeight === 1 ? 'genesis snapshot' : `snapshot ${verifyResult.selectedSnapshotHeight}`}.
            Restored height {verifyResult.restoredHeight}.
          </p>
        {/if}
      </section>

      <section class="section-card danger-card">
        <div class="section-head">
          <div>
            <h3>Reset</h3>
            <p class="section-desc">Wipes local wallets, runtime state, and caches.</p>
          </div>
        </div>

        <button class="danger-btn" on:click={confirmResetAllData}>
          Clear All Data
        </button>
      </section>

    {:else if activeTab === 'log'}
      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Entity Log</h3>
            <p class="section-desc">Read-only entity message and event stream.</p>
          </div>
        </div>

        {#if replica && tab}
          <ChatMessages {replica} {tab} currentTimeIndex={currentTimeIndex} />
        {:else}
          <div class="empty-card">Select an entity to inspect its message and event log.</div>
        {/if}
      </section>

    {:else if activeTab === 'entity'}
      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Profile</h3>
            <p class="section-desc">Published entity metadata visible through gossip and routing flows.</p>
          </div>
        </div>

        <label class="setting-row stacked">
          <span class="setting-title">Display Name</span>
          <input type="text" bind:value={governanceName} placeholder="Entity name" maxlength="64" />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Bio</span>
          <input type="text" bind:value={governanceBio} placeholder="Short description" maxlength="180" />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Website</span>
          <input type="url" bind:value={governanceWebsite} placeholder="https://" maxlength="160" />
        </label>

        <button class="primary-btn" on:click={saveGovernanceProfile} disabled={governanceSaving || !currentEntityId || !activeIsLive}>
          {governanceSaving ? 'Submitting...' : 'Save Entity Profile'}
        </button>
        {#if !activeIsLive}
          <p class="helper-note">Profile updates require LIVE mode.</p>
        {/if}
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Hub Policy</h3>
            <p class="section-desc">Routing and rebalance policy published for this entity.</p>
          </div>
        </div>

        <label class="setting-row stacked">
          <span class="setting-title">Policy Version (optional override)</span>
          <input type="number" min="1" bind:value={hubPolicyVersion} placeholder="Auto if empty" />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Matching Strategy</span>
          <select bind:value={hubMatchingStrategy}>
            <option value="amount">amount</option>
            <option value="time">time</option>
            <option value="fee">fee</option>
          </select>
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Routing Fee (PPM)</span>
          <input type="number" min="0" bind:value={hubRoutingFeePPM} />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Base Fee (token units)</span>
          <input type="text" bind:value={hubBaseFee} placeholder="e.g. 0.0" />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Min Collateral Threshold (token units)</span>
          <input type="text" bind:value={hubMinCollateralThreshold} placeholder="e.g. 0" />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Rebalance Base Fee (token units)</span>
          <input type="text" bind:value={hubRebalanceBaseFee} placeholder="e.g. 0.1" />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Rebalance Liquidity Fee (bps)</span>
          <input type="number" min="0" bind:value={hubRebalanceLiquidityFeeBps} />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Rebalance Gas Fee (token units)</span>
          <input type="text" bind:value={hubRebalanceGasFee} placeholder="e.g. 0.0" />
        </label>

        <label class="setting-row stacked">
          <span class="setting-title">Rebalance Timeout (seconds)</span>
          <input type="number" min="1" bind:value={hubRebalanceTimeoutSeconds} />
        </label>

        <button class="primary-btn" on:click={saveHubConfig} disabled={hubConfigSaving || !currentEntityId || !activeIsLive}>
          {hubConfigSaving ? 'Submitting...' : 'Save Hub Policy'}
        </button>
        {#if !activeIsLive}
          <p class="helper-note">Hub policy updates require LIVE mode.</p>
        {/if}
      </section>

      <section class="section-card">
        <div class="section-head">
          <div>
            <h3>Identity</h3>
            <p class="section-desc">Current entity context for this panel.</p>
          </div>
        </div>

        <div class="info-card">
          <div class="info-row">
            <span class="label">Jurisdiction</span>
            <span class="value">{currentJurisdictionLabel}</span>
          </div>
        </div>
      </section>

      <section class="section-card">
        <details bind:open={entityCreationOpen}>
          <summary class="expand-summary">
            <span>Create New Entity</span>
            {#if entityCreationOpen}
              <ChevronUp size={16} />
            {:else}
              <ChevronDown size={16} />
            {/if}
          </summary>
          <div class="expand-panel">
            <FormationPanel onCreated={() => { entityCreationOpen = false; }} />
          </div>
        </details>
      </section>
    {/if}
  </div>
</div>

<style>
  .entity-settings {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    color: var(--theme-text-primary, #e4e4e7);
  }

  .entity-settings.embedded {
    max-width: none;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header h2 {
    margin: 0;
    font-size: 18px;
  }

  .close-btn,
  .icon-btn,
  .compact-btn,
  .danger-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.1)) var(--ui-border-mix, 56%), transparent) !important;
    border-radius: var(--ui-radius-base, 12px) !important;
    background: color-mix(in srgb, var(--theme-surface, rgba(255, 255, 255, 0.03)) var(--ui-card-fill-mix, 94%), transparent) !important;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.7)) !important;
    cursor: pointer;
    box-sizing: border-box;
    transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease, transform 0.16s ease;
  }

  .close-btn,
  .danger-icon {
    width: 32px;
    height: 32px;
  }

  .icon-btn {
    width: 28px;
    height: 28px;
  }

  .compact-btn {
    min-height: calc(var(--ui-control-height, 44px) - 8px);
    padding: 0 12px;
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  .danger-icon {
    color: #fca5a5;
  }

  .close-btn:hover,
  .icon-btn:hover,
  .compact-btn:hover,
  .danger-icon:hover {
    color: var(--theme-text-primary, #e4e4e7) !important;
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 20%, transparent) !important;
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 88%, transparent) !important;
  }

  .settings-tabs {
    display: flex;
    gap: 6px;
    margin: 0;
    padding: 4px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 52%), transparent);
    border-radius: var(--ui-radius-large, 16px);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 68%, transparent);
    overflow-x: auto;
  }

  .settings-tabs::-webkit-scrollbar {
    display: none;
  }

  .settings-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: calc(var(--ui-control-height, 44px) - 6px);
    padding: 0 14px;
    border: 1px solid transparent !important;
    border-radius: calc(var(--ui-radius-base, 12px) - 2px) !important;
    background: transparent !important;
    color: var(--theme-text-secondary, #a1a1aa) !important;
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-weight: 650;
    white-space: nowrap;
    cursor: pointer;
    box-shadow: none;
    transition: color 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    touch-action: manipulation;
  }

  .settings-tab:hover {
    color: var(--theme-text-primary, #e4e4e7) !important;
    border-color: color-mix(in srgb, var(--theme-border, #27272a) 56%, transparent) !important;
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 82%, transparent) !important;
  }

  .settings-tab.active {
    color: var(--theme-text-primary, #e4e4e7) !important;
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 14%, transparent) !important;
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 96%, transparent) !important;
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 86%, transparent);
  }

  .settings-content {
    display: grid;
    gap: 16px;
  }

  .section-card {
    padding: 16px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.08)) var(--ui-border-mix, 58%), transparent);
    border-radius: var(--ui-radius-large, 16px);
    background: color-mix(in srgb, var(--theme-surface, #18181b) var(--ui-card-fill-mix, 90%), transparent);
  }

  .danger-card {
    border-color: rgba(248, 113, 113, 0.28);
    background: color-mix(in srgb, rgba(127, 29, 29, 0.18) 70%, var(--theme-surface, #18181b));
  }

  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 14px;
  }

  .section-head h3 {
    margin: 0;
    font-size: calc(14px * var(--ui-font-scale, 1));
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .section-desc,
  .helper-note {
    margin: 4px 0 0;
    color: var(--theme-text-muted, rgba(255, 255, 255, 0.5));
    font-size: calc(12px * var(--ui-font-scale, 1));
    line-height: 1.45;
  }

  .error-text {
    margin: 8px 0 0;
    color: #fca5a5;
    font-size: 12px;
  }

  .empty-card {
    padding: 18px;
    border: 1px dashed var(--theme-border, rgba(255, 255, 255, 0.1));
    border-radius: 12px;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.7));
    text-align: center;
  }

  .info-card,
  .seed-card {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.08)) var(--ui-border-mix, 56%), transparent);
    border-radius: var(--ui-radius-base, 12px);
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) var(--ui-card-fill-mix, 70%), transparent);
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 60%, transparent);
  }

  .info-row:last-child {
    padding-bottom: 0;
    border-bottom: none;
  }

  .label {
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.65));
    font-size: 12px;
  }

  .value {
    color: var(--theme-text-primary, #e4e4e7);
    font-size: 13px;
    text-align: right;
  }

  .network-status-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 108px;
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .network-status-badge.connected {
    color: #86efac;
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.24);
  }

  .network-status-badge.reconnecting {
    color: #fbbf24;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.24);
  }

  .network-status-badge.disconnected {
    color: #cbd5e1;
    background: rgba(71, 85, 105, 0.16);
    border: 1px solid rgba(100, 116, 139, 0.26);
  }

  .mono {
    font-family: 'JetBrains Mono', monospace;
    overflow-wrap: anywhere;
  }

  .seed-warning {
    padding: 10px 12px;
    border-radius: var(--ui-radius-base, 12px);
    background: rgba(127, 29, 29, 0.18);
    border: 1px solid rgba(248, 113, 113, 0.2);
    color: #fecaca;
    font-size: 12px;
  }

  .seed-row {
    display: grid;
    gap: 8px;
  }

  .seed-gate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 4px 0 2px;
  }

  .seed-gate-copy {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .seed-gate-copy strong {
    font-size: calc(13px * var(--ui-font-scale, 1));
    color: var(--theme-text-primary, #e4e4e7);
  }

  .seed-gate-copy span {
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.7));
    font-size: 11px;
    line-height: 1.4;
  }

  .seed-gate-btn {
    flex-shrink: 0;
  }

  .seed-row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.68));
  }

  .seed-code {
    display: block;
    padding: 12px;
    border-radius: var(--ui-radius-base, 12px);
    background: color-mix(in srgb, var(--theme-background, #09090b) 70%, transparent);
    color: var(--theme-accent, #fbbf24);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 12px 0;
    border-top: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 60%, transparent);
  }

  .setting-row.stacked {
    display: grid;
    justify-content: stretch;
  }

  .setting-row:first-of-type {
    border-top: none;
    padding-top: 0;
  }

  .setting-title {
    font-size: calc(13px * var(--ui-font-scale, 1));
    font-weight: 600;
  }

  .setting-copy {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .setting-help {
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.7));
    font-size: 11px;
    line-height: 1.4;
  }

  .toggle {
    min-width: 58px;
    min-height: calc(var(--ui-control-height, 44px) - 12px);
    padding: 0 12px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.12)) var(--ui-border-mix, 56%), transparent);
    border-radius: var(--ui-radius-pill, 999px);
    background: color-mix(in srgb, var(--theme-surface, #18181b) var(--ui-input-fill-mix, 85%), transparent);
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.7));
    cursor: pointer;
  }

  .toggle.on {
    color: var(--theme-accent, #fbbf24);
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 22%), transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-soft-mix, 10%), transparent);
  }

  input:not([type="range"]):not([type="checkbox"]),
  select,
  textarea {
    width: 100%;
    padding: 10px 12px;
    min-height: var(--ui-control-height, 44px);
    border: 1px solid color-mix(in srgb, var(--theme-input-border, rgba(255, 255, 255, 0.12)) var(--ui-border-mix, 56%), transparent) !important;
    border-radius: var(--ui-radius-base, 12px) !important;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) var(--ui-input-fill-mix, 82%), transparent) !important;
    color: var(--theme-text-primary, #e4e4e7) !important;
    font-size: calc(13px * var(--ui-font-scale, 1));
    box-sizing: border-box;
  }

  input:not([type="range"]):not([type="checkbox"]):focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: var(--theme-input-focus, #fbbf24) !important;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent) !important;
  }

  textarea {
    resize: vertical;
  }

  .setting-row > input[type="checkbox"] {
    margin-left: auto;
  }

  .slider-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .slider-value,
  .mono-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.7));
  }

  @media (max-width: 640px) {
    .slider-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }

    .slider-value {
      justify-self: end;
    }
  }

  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
    gap: 10px;
    margin-top: 14px;
  }

  .theme-swatch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 0 !important;
    background: none !important;
    border: 2px solid transparent !important;
    border-radius: var(--ui-radius-base, 12px) !important;
    cursor: pointer;
    transition: transform 0.15s ease, border-color 0.15s ease;
  }

  .theme-swatch:hover {
    transform: translateY(-1px);
  }

  .theme-swatch.active {
    border-color: var(--theme-accent, #fbbf24) !important;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-accent, #fbbf24) 18%, transparent);
  }

  .swatch-preview {
    width: 100%;
    aspect-ratio: 1.35;
    border-radius: var(--ui-radius-base, 12px);
    border: 1px solid;
    padding: 8px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
    position: relative;
  }

  .swatch-bar {
    height: 4px;
    border-radius: 999px;
  }

  .swatch-text {
    font-size: 11px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }

  .swatch-accent {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .swatch-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.7));
  }

  .swatch-label.active {
    color: var(--theme-accent, #fbbf24);
  }

  .bar-legend-mini {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 10px;
    font-size: 11px;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.7));
  }

  .legend-swatch {
    display: inline-block;
    width: 14px;
    height: 6px;
    border-radius: 999px;
    margin-right: 4px;
  }

  .appearance-block {
    display: grid;
    gap: 10px;
    padding-top: 12px;
    border-top: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 60%, transparent);
  }

  .appearance-block:first-of-type {
    border-top: none;
    padding-top: 0;
  }

  .pill-group {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .pill {
    min-height: calc(var(--ui-control-height, 44px) - 8px);
    padding: 0 14px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.12)) var(--ui-border-mix, 56%), transparent) !important;
    border-radius: var(--ui-radius-pill, 999px) !important;
    background: color-mix(in srgb, var(--theme-surface, #18181b) var(--ui-input-fill-mix, 85%), transparent) !important;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.75)) !important;
    cursor: pointer;
    font-size: calc(12px * var(--ui-font-scale, 1));
    box-sizing: border-box;
    transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease, transform 0.16s ease;
  }

  .pill:hover {
    color: var(--theme-text-primary, #e4e4e7) !important;
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 16%, transparent) !important;
    transform: translateY(-1px);
  }

  .pill.active {
    color: var(--theme-accent, #fbbf24) !important;
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 28%, transparent) !important;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 16%, transparent) !important;
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--theme-accent, #fbbf24) 18%, transparent),
      0 8px 18px color-mix(in srgb, var(--theme-accent, #fbbf24) 10%, transparent);
    transform: translateY(-1px);
    font-weight: 700;
  }

  .style-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 16px;
  }

  .style-group {
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  .style-group-head {
    display: grid;
    gap: 4px;
  }

  .style-current {
    font-size: 11px;
    color: var(--theme-accent, #fbbf24);
    letter-spacing: 0.03em;
  }

  .scale-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .helper-details {
    margin-bottom: 12px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 60%), transparent);
    border-radius: var(--ui-radius-base, 12px);
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) var(--ui-card-fill-mix, 55%), transparent);
    padding: 12px;
  }

  .helper-details summary,
  .expand-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    cursor: pointer;
    list-style: none;
    font-weight: 600;
  }

  .helper-details summary::-webkit-details-marker,
  .expand-summary::-webkit-details-marker {
    display: none;
  }

  .network-list {
    display: grid;
    gap: 10px;
  }

  .network-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 60%), transparent);
    border-radius: var(--ui-radius-base, 12px);
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) var(--ui-card-fill-mix, 55%), transparent);
  }

  .network-info {
    display: flex;
    gap: 12px;
    align-items: center;
    min-width: 0;
  }

  .network-icon {
    font-size: 18px;
  }

  .network-details {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .network-name {
    font-weight: 600;
  }

  .network-meta {
    font-size: 12px;
    color: var(--theme-text-secondary, rgba(255, 255, 255, 0.68));
    overflow-wrap: anywhere;
  }

  .network-actions,
  .editor-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .inline-editor,
  .expand-panel {
    margin-top: 12px;
    padding: 14px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 60%), transparent);
    border-radius: var(--ui-radius-base, 12px);
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) var(--ui-card-fill-mix, 55%), transparent);
  }

  .editor-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }

  .editor-grid label,
  .inline-editor label {
    display: grid;
    gap: 6px;
  }

  .expand-btn,
  .primary-btn,
  .danger-btn {
    min-height: var(--ui-control-height, 44px);
    padding: 0 14px;
    border-radius: var(--ui-radius-base, 12px);
    cursor: pointer;
  }

  .expand-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 1px solid color-mix(in srgb, var(--theme-border, rgba(255, 255, 255, 0.12)) var(--ui-border-mix, 56%), transparent);
    background: color-mix(in srgb, var(--theme-surface, #18181b) var(--ui-input-fill-mix, 85%), transparent);
    color: var(--theme-text-primary, #e4e4e7);
  }

  .primary-btn {
    border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 22%), transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-soft-mix, 10%), transparent);
    color: var(--theme-accent, #fbbf24);
  }

  .danger-btn {
    border: 1px solid rgba(248, 113, 113, 0.35);
    background: rgba(127, 29, 29, 0.18);
    color: #fecaca;
  }

  .primary-btn:disabled,
  .danger-btn:disabled,
  .compact-btn:disabled,
  .expand-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  details[open] > .expand-summary {
    margin-bottom: 12px;
  }

  .file-btn {
    position: relative;
    overflow: hidden;
  }

  .file-btn input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }

  .ui-json-editor {
    min-height: 260px;
    resize: vertical;
    font-family: 'JetBrains Mono', monospace;
    line-height: 1.5;
  }

  :global(html[data-ui-tabs='minimal']) .settings-tabs,
  :global(html[data-ui-tabs='underline']) .settings-tabs {
    padding: 0 0 2px;
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 56%), transparent);
    border-radius: 0;
    background: transparent;
    gap: 18px;
  }

  :global(html[data-ui-tabs='minimal']) .settings-tab,
  :global(html[data-ui-tabs='underline']) .settings-tab {
    min-height: 38px;
    padding: 0 2px 12px;
    border: none !important;
    border-radius: 0 !important;
    background: transparent !important;
  }

  :global(html[data-ui-tabs='minimal']) .settings-tab:hover,
  :global(html[data-ui-tabs='underline']) .settings-tab:hover {
    border-color: transparent !important;
    background: transparent !important;
  }

  :global(html[data-ui-tabs='minimal']) .settings-tab.active {
    color: var(--theme-accent, #fbbf24) !important;
    box-shadow: none;
  }

  :global(html[data-ui-tabs='underline']) .settings-tab.active {
    border-color: transparent !important;
    background: transparent !important;
    box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 88%, transparent);
  }

  :global(html[data-ui-tabs='pill']) .settings-tabs,
  :global(html[data-ui-tabs='segmented']) .settings-tabs,
  :global(html[data-ui-tabs='floating']) .settings-tabs {
    padding: 0;
    border-bottom: none;
    gap: 8px;
  }

  :global(html[data-ui-tabs='pill']) .settings-tab {
    border-radius: var(--ui-radius-pill, 999px);
    border-color: color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 56%), transparent);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 70%, transparent);
  }

  :global(html[data-ui-tabs='pill']) .settings-tab.active {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 22%), transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-soft-mix, 10%), transparent);
    box-shadow: none;
  }

  :global(html[data-ui-tabs='segmented']) .settings-tabs {
    padding: 4px;
    border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 56%), transparent);
    border-radius: var(--ui-radius-large, 16px);
    background: color-mix(in srgb, var(--theme-surface, #18181b) 68%, transparent);
  }

  :global(html[data-ui-tabs='segmented']) .settings-tab {
    flex: 1 1 auto;
    border-radius: calc(var(--ui-radius-base, 12px) - 2px);
    border: none;
    min-width: 0;
  }

  :global(html[data-ui-tabs='segmented']) .settings-tab.active {
    background: color-mix(in srgb, var(--theme-surface-hover, #1c1c20) 96%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 22%), transparent);
  }

  :global(html[data-ui-tabs='floating']) .settings-tabs {
    border: none;
    border-radius: 0;
    background: transparent;
  }

  :global(html[data-ui-tabs='floating']) .settings-tab {
    border-color: color-mix(in srgb, var(--theme-border, #27272a) var(--ui-border-mix, 56%), transparent) !important;
    background: color-mix(in srgb, var(--theme-surface, #18181b) 70%, transparent) !important;
    box-shadow: 0 10px 22px color-mix(in srgb, var(--theme-background, #09090b) 8%, transparent);
  }

  :global(html[data-ui-tabs='floating']) .settings-tab.active {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) var(--ui-accent-border-mix, 20%), transparent) !important;
    box-shadow:
      inset 0 -1px 0 color-mix(in srgb, var(--theme-accent, #fbbf24) 82%, transparent),
      0 14px 30px color-mix(in srgb, var(--theme-background, #09090b) 10%, transparent);
  }

  :global(html[data-ui-buttons='minimal']) .compact-btn,
  :global(html[data-ui-buttons='minimal']) .expand-btn {
    background: transparent;
  }

  :global(html[data-ui-buttons='solid']) .primary-btn {
    color: color-mix(in srgb, var(--theme-background, #09090b) 15%, white 85%);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 78%, transparent);
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 86%, transparent);
  }

  :global(html[data-ui-cards='flat']) .section-card,
  :global(html[data-ui-cards='flat']) .info-card,
  :global(html[data-ui-cards='flat']) .seed-card,
  :global(html[data-ui-cards='flat']) .inline-editor,
  :global(html[data-ui-cards='flat']) .expand-panel,
  :global(html[data-ui-cards='flat']) .network-row,
  :global(html[data-ui-cards='flat']) .helper-details {
    background: color-mix(in srgb, var(--theme-surface, #18181b) 56%, transparent);
  }

  :global(html[data-ui-cards='striped']) .section-card {
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--theme-accent, #fbbf24) 4%, transparent), transparent 26%),
      color-mix(in srgb, var(--theme-surface, #18181b) var(--ui-card-fill-mix, 90%), transparent);
  }

  :global(html[data-ui-inputs='minimal']) input:not([type="range"]):not([type="checkbox"]),
  :global(html[data-ui-inputs='minimal']) select,
  :global(html[data-ui-inputs='minimal']) textarea {
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 54%, transparent);
    border-color: color-mix(in srgb, var(--theme-input-border, rgba(255, 255, 255, 0.12)) 40%, transparent);
  }

  :global(html[data-ui-inputs='filled']) input:not([type="range"]):not([type="checkbox"]),
  :global(html[data-ui-inputs='filled']) select,
  :global(html[data-ui-inputs='filled']) textarea {
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 96%, transparent);
  }

  @media (max-width: 900px) {
    .settings-tabs {
      gap: 8px;
      padding: 0;
      border-bottom: none;
      overflow: visible;
      flex-wrap: wrap;
    }

    .settings-tab {
      flex: 1 1 calc(33.333% - 6px);
      min-width: 92px;
      min-height: 40px;
      padding: 9px 12px;
      border: 1px solid color-mix(in srgb, var(--theme-border, #27272a) 50%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, var(--theme-surface, #18181b) 72%, transparent);
    }

    .section-card {
      padding: 14px;
    }

    .style-grid {
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .info-row,
    .setting-row,
    .scale-head,
    .network-row {
      grid-template-columns: 1fr;
      flex-direction: column;
      align-items: flex-start;
    }

    .network-actions {
      width: 100%;
    }

    .editor-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
