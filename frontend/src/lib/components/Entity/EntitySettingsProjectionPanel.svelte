<script lang="ts">
  import { Network, PlusCircle, Save, ShieldCheck, SlidersHorizontal } from 'lucide-svelte';
  import type { Env, HubRebalanceConfig } from '@xln/runtime/xln-api';
  import { errorLog } from '$lib/stores/errorLogStore';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { settings, settingsOperations } from '$lib/stores/settingsStore';
  import {
    activeRuntime,
    buildRuntimeRecoveryConfigForMode,
    vaultOperations,
    type RecoveryTowerConfig,
    type RecoveryTowerSetupMode,
  } from '$lib/stores/vaultStore';
  import {
    getManualRecoveryTowers,
    isOfficialRecoveryTower,
    normalizeRecoveryDraft,
    normalizeRecoveryUrl,
    normalizeTowerMode,
    resolveOfficialRecoveryTowerUrl,
    type RecoveryServiceMode,
  } from '$lib/utils/recoverySettings';
  import {
    buildRecoveryTowerStatuses,
    buildRuntimeRecoveryCoverage,
  } from '$lib/utils/recoveryCoverage';
  import {
    readRuntimeRecoveryDiscoveryStatus,
    type RuntimeRecoveryDiscoveryStatus,
  } from '$lib/utils/recoveryDiscoveryStatus';
  import { buildRemoteRuntimeRecoveryPeerSources } from '$lib/utils/remoteRuntimeValidation';
  import AddJMachine from '$lib/components/Jurisdiction/AddJMachine.svelte';
  import type { JMachineCreateDetail } from '$lib/components/Jurisdiction/import-jmachine-runtime';
  import PushWakePanel from '$lib/components/Settings/PushWakePanel.svelte';
  import type { SettingsSubview } from './entity-panel-routing';
  import type { ThemeName } from '$lib/types/ui';

  type ProfileView = {
    name?: string;
    avatar?: string;
    bio?: string;
    website?: string;
    isHub?: boolean;
  };

  type ProfileDraft = {
    name: string;
    avatar: string;
    bio: string;
    website: string;
  };

  type HubPolicyView = HubRebalanceConfig;

  export let entityId = '';
  export let signerId = '';
  export let runtimeId: string | null = null;
  export let runtimeHeight = 0;
  export let jurisdictionLabel = '';
  export let profile: ProfileView | null = null;
  export let hubPolicy: HubPolicyView | null = null;
  export let accountCount = 0;
  export let reserveCount = 0;
  export let proposalCount = 0;
  export let isHub = false;
  export let activeIsLive = true;
  export let runtimeEnv: Env | null = null;
  export let settingsSubview: SettingsSubview = 'wallet';
  export let onSaveProfile: (profile: ProfileDraft) => Promise<void> = async () => {};
  export let onImportJMachine: (detail: JMachineCreateDetail) => Promise<void> = async () => {};

  let draftName = '';
  let draftAvatar = '';
  let draftBio = '';
  let draftWebsite = '';
  let loadedProfileKey = '';
  let savingProfile = false;
  let profileError = '';
  let profileSaved = false;
  let networkPanelOpen = false;
  let importingJMachine = false;
  let importError = '';
  let importSaved = false;
  let recoveryMode: RecoveryTowerSetupMode = 'official';
  let recoveryTowerDraft: RecoveryTowerConfig[] = [];
  let recoveryDraftLoadedFor = '';
  let recoveryManualUrl = '';
  let recoveryManualKind: RecoveryServiceMode = 'blind_backup';
  let recoveryMessage = '';
  let recoveryMessageTone: 'neutral' | 'error' | 'ok' = 'neutral';
  let recoverySaving = false;
  let recoveryDiscoveryStatus: RuntimeRecoveryDiscoveryStatus | null = null;
  let recoveryDiscoveryLoadedFor = '';

  const themeOptions: Array<{ value: ThemeName; label: string }> = [
    { value: 'dark', label: 'Dark' },
    { value: 'editor', label: 'Editor' },
    { value: 'light', label: 'Light' },
    { value: 'merchant', label: 'Merchant' },
    { value: 'gold-luxe', label: 'Gold Luxe' },
    { value: 'matrix', label: 'Matrix' },
    { value: 'arctic', label: 'Arctic' },
  ];

  const normalizeText = (value: unknown): string => String(value || '').trim();

  const shortId = (value: unknown, head = 12): string => {
    const text = normalizeText(value);
    if (!text) return '-';
    return text.length <= head + 6 ? text : `${text.slice(0, head)}...${text.slice(-4)}`;
  };

  const formatCount = (value: unknown): string => {
    const count = Math.max(0, Math.floor(Number(value ?? 0)));
    return Number.isFinite(count) ? count.toLocaleString('en-US') : '0';
  };

  const formatPolicyValue = (value: unknown): string => {
    if (typeof value === 'bigint') return value.toString();
    if (value === null || value === undefined || value === '') return '-';
    return String(value);
  };

  $: runtimeCanWrite = $runtimeControllerHandle.mode === 'embedded' || $runtimeControllerHandle.authLevel === 'admin';
  $: normalizedEntityId = normalizeText(entityId).toLowerCase();
  $: normalizedRuntimeId = normalizeText(runtimeId || $runtimeControllerHandle.id);
  $: profileKey = [
    normalizedEntityId,
    profile?.name || '',
    profile?.avatar || '',
    profile?.bio || '',
    profile?.website || '',
  ].join('|');
  $: if (profileKey !== loadedProfileKey && !savingProfile) {
    loadedProfileKey = profileKey;
    draftName = normalizeText(profile?.name);
    draftAvatar = normalizeText(profile?.avatar);
    draftBio = normalizeText(profile?.bio);
    draftWebsite = normalizeText(profile?.website);
    profileError = '';
    profileSaved = false;
  }
  $: canSaveProfile = Boolean(normalizedEntityId) && activeIsLive && runtimeCanWrite && !savingProfile;
  $: canImportJMachine = activeIsLive && runtimeCanWrite && !importingJMachine;
  $: recoveryOfficialUrl = resolveOfficialRecoveryTowerUrl();
  $: recoveryRuntimeSyncKey = `${$activeRuntime?.id || 'none'}:${JSON.stringify($activeRuntime?.recovery?.towers || [])}:${$activeRuntime?.recovery?.useDefaultTowers === true}`;
  $: activeRecoveryRuntimeId = normalizeText($activeRuntime?.id || runtimeId || '').toLowerCase();
  $: {
    if (recoveryDiscoveryLoadedFor !== activeRecoveryRuntimeId) {
      recoveryDiscoveryStatus = readRuntimeRecoveryDiscoveryStatus(activeRecoveryRuntimeId);
      recoveryDiscoveryLoadedFor = activeRecoveryRuntimeId;
    }
  }
  $: saveDisabledReason = !normalizedEntityId
    ? 'Select an entity'
    : !activeIsLive
      ? 'Go live to mutate'
      : !runtimeCanWrite
        ? 'Admin access required'
        : '';
  $: importDisabledReason = !activeIsLive
    ? 'Go live to import jurisdictions'
    : !runtimeCanWrite
      ? 'Admin access required'
      : '';
  $: recoveryDisabledReason = !$activeRuntime?.id
    ? 'Runtime is required'
    : !activeIsLive
      ? 'Go live to update recovery'
      : !runtimeCanWrite
        ? 'Admin access required'
        : '';
  $: canSaveRecovery = !recoveryDisabledReason && !recoverySaving;
  $: recoveryPeerSourceCount = buildRemoteRuntimeRecoveryPeerSources({ runtimeId: activeRecoveryRuntimeId }).length;
  $: recoveryCoverageItems = buildRuntimeRecoveryCoverage({
    runtime: $activeRuntime,
    towers: recoveryTowerDraft,
    runtimeHeight,
    peerSourceCount: recoveryPeerSourceCount,
    discovery: recoveryDiscoveryStatus,
  });
  $: recoveryTowerStatuses = buildRecoveryTowerStatuses($activeRuntime, recoveryTowerDraft);
  $: recoveryTowerStatusByUrl = new Map(recoveryTowerStatuses.map((status) => [status.url, status]));

  function inferRecoveryMode(): RecoveryTowerSetupMode {
    const runtime = $activeRuntime;
    const officialUrl = resolveOfficialRecoveryTowerUrl();
    const towers = normalizeRecoveryDraft(runtime?.recovery?.towers);
    const officialTower = towers.find((tower) => isOfficialRecoveryTower(tower, officialUrl));
    if (officialTower) {
      return normalizeTowerMode(officialTower.towerMode) === 'delayed_last_resort'
        ? 'official'
        : 'backup_only';
    }
    if (!officialUrl && towers.length === 0) return 'local_only';
    if (towers.length === 0) return 'official';
    return 'local_only';
  }

  function syncRecoveryDraftFromRuntime(force = false): void {
    const runtime = $activeRuntime;
    const key = `${runtime?.id || 'none'}:${JSON.stringify(runtime?.recovery?.towers || [])}:${runtime?.recovery?.useDefaultTowers === true}`;
    if (!force && recoveryDraftLoadedFor === key) return;
    recoveryMode = inferRecoveryMode();
    recoveryTowerDraft = normalizeRecoveryDraft(runtime?.recovery?.towers);
    recoveryDraftLoadedFor = key;
    recoveryMessage = '';
    recoveryMessageTone = 'neutral';
  }

  function applyRecoveryModeDraft(mode: RecoveryTowerSetupMode): void {
    if (mode !== 'local_only' && !recoveryOfficialUrl) return;
    recoveryMode = mode;
    const config = buildRuntimeRecoveryConfigForMode(mode, {
      officialTowerUrl: recoveryOfficialUrl,
      manualTowers: getManualRecoveryTowers(recoveryTowerDraft, recoveryOfficialUrl),
      previous: $activeRuntime?.recovery || null,
    });
    recoveryTowerDraft = normalizeRecoveryDraft(config.towers);
    recoveryMessage = '';
    recoveryMessageTone = 'neutral';
  }

  function addManualRecoveryTower(): void {
    recoveryMessage = '';
    recoveryMessageTone = 'neutral';
    try {
      const url = normalizeRecoveryUrl(recoveryManualUrl);
      const nextTower: RecoveryTowerConfig = {
        id: `manual-${recoveryTowerDraft.length + 1}`,
        url,
        towerMode: recoveryManualKind,
        enabled: true,
      };
      recoveryTowerDraft = normalizeRecoveryDraft([
        ...recoveryTowerDraft.filter((tower) => tower.url !== url),
        nextTower,
      ]);
      recoveryManualUrl = '';
    } catch (error) {
      recoveryMessage = error instanceof Error ? error.message : String(error);
      recoveryMessageTone = 'error';
    }
  }

  function updateRecoveryTowerMode(url: string, mode: RecoveryServiceMode): void {
    recoveryTowerDraft = normalizeRecoveryDraft(recoveryTowerDraft.map((tower) =>
      tower.url === url ? { ...tower, towerMode: mode } : tower
    ));
  }

  function removeRecoveryTower(url: string): void {
    recoveryTowerDraft = recoveryTowerDraft.filter((tower) => tower.url !== url);
  }

  async function saveRecoveryConfig(): Promise<void> {
    if (!canSaveRecovery) {
      recoveryMessage = recoveryDisabledReason || 'Recovery update is not available';
      recoveryMessageTone = 'error';
      return;
    }
    const runtime = $activeRuntime;
    if (!runtime?.id) throw new Error('Runtime is required before configuring recovery services');
    recoverySaving = true;
    recoveryMessage = '';
    recoveryMessageTone = 'neutral';
    try {
      const config = buildRuntimeRecoveryConfigForMode(recoveryMode, {
        officialTowerUrl: recoveryOfficialUrl,
        manualTowers: getManualRecoveryTowers(recoveryTowerDraft, recoveryOfficialUrl),
        previous: runtime.recovery || null,
      });
      const updatedRuntime = await vaultOperations.updateRuntimeRecovery(runtime.id, config);
      recoveryTowerDraft = normalizeRecoveryDraft(updatedRuntime.recovery?.towers);
      recoveryDraftLoadedFor = '';
      syncRecoveryDraftFromRuntime(true);
      recoveryMessage = 'Recovery services saved.';
      recoveryMessageTone = 'ok';
    } catch (error) {
      recoveryMessage = error instanceof Error ? error.message : String(error);
      recoveryMessageTone = 'error';
    } finally {
      recoverySaving = false;
    }
  }

  $: {
    recoveryRuntimeSyncKey;
    syncRecoveryDraftFromRuntime();
  }

  async function submitProfile(): Promise<void> {
    if (!canSaveProfile) {
      profileError = saveDisabledReason || 'Profile update is not available';
      return;
    }
    savingProfile = true;
    profileError = '';
    profileSaved = false;
    try {
      await onSaveProfile({
        name: draftName.trim(),
        avatar: draftAvatar.trim(),
        bio: draftBio.trim(),
        website: draftWebsite.trim(),
      });
      profileSaved = true;
    } catch (error) {
      errorLog.log('Entity profile update failed', 'Entity Settings', { entityId: normalizedEntityId, error });
      profileError = error instanceof Error ? error.message : String(error);
    } finally {
      savingProfile = false;
    }
  }

  async function handleJMachineCreate(event: CustomEvent<JMachineCreateDetail>): Promise<void> {
    if (!canImportJMachine) {
      importError = importDisabledReason || 'Jurisdiction import is not available';
      return;
    }
    importingJMachine = true;
    importError = '';
    importSaved = false;
    try {
      await onImportJMachine(event.detail);
      importSaved = true;
      networkPanelOpen = false;
    } catch (error) {
      errorLog.log('Jurisdiction import failed', 'Entity Settings', { entityId: normalizedEntityId, error });
      importError = error instanceof Error ? error.message : String(error);
    } finally {
      importingJMachine = false;
    }
  }

  function updateTheme(event: Event): void {
    settingsOperations.setTheme((event.currentTarget as HTMLSelectElement).value as ThemeName);
  }
</script>

<section class="settings-projection" data-testid="entity-settings-projection-panel">
  <header class="settings-head">
    <div>
      <p class="eyebrow">Settings</p>
      <h2>{profile?.name || shortId(normalizedEntityId, 16)}</h2>
    </div>
    <div class="runtime-pill" title={normalizedRuntimeId}>
      <ShieldCheck size={15} />
      <span>{$runtimeControllerHandle.mode}</span>
      <strong>{$runtimeControllerHandle.authLevel || 'local'}</strong>
    </div>
  </header>

  <nav class="settings-tabs" aria-label="Settings sections">
    <button
      type="button"
      class:active={settingsSubview !== 'recovery' && settingsSubview !== 'display'}
      on:click={() => settingsSubview = 'wallet'}
    >
      Wallet
    </button>
    <button
      type="button"
      class:active={settingsSubview === 'display'}
      on:click={() => settingsSubview = 'display'}
    >
      Display
    </button>
    <button
      type="button"
      class:active={settingsSubview === 'recovery'}
      on:click={() => settingsSubview = 'recovery'}
    >
      Recovery
    </button>
  </nav>

  {#if settingsSubview === 'recovery'}
    <section class="panel recovery-panel" data-testid="settings-recovery-panel">
      <div class="panel-title">
        <ShieldCheck size={15} />
        <span>Recovery Services</span>
      </div>

      <div class="recovery-coverage-grid" data-testid="recovery-coverage-grid">
        {#each recoveryCoverageItems as item (item.id)}
          <div
            class="recovery-coverage-card"
            data-testid={`recovery-coverage-${item.id}`}
            data-status={item.status}
          >
            <div class="coverage-card-head">
              <strong>{item.label}</strong>
              <span class="coverage-status">{item.statusLabel}</span>
            </div>
            <p>{item.detail}</p>
          </div>
        {/each}
      </div>

      <div class="recovery-mode-grid" role="radiogroup" aria-label="Runtime recovery mode">
        <button
          type="button"
          class="recovery-mode-option"
          class:selected={recoveryMode === 'official'}
          disabled={!recoveryOfficialUrl || recoverySaving}
          on:click={() => applyRecoveryModeDraft('official')}
        >
          <span class="recovery-mode-title">Backup + disputer</span>
          <span class="recovery-mode-copy">
            {recoveryOfficialUrl
              ? 'Encrypted backups and delayed last-resort dispute rescue.'
              : 'No official tower for this runtime.'}
          </span>
        </button>
        <button
          type="button"
          class="recovery-mode-option"
          class:selected={recoveryMode === 'backup_only'}
          disabled={!recoveryOfficialUrl || recoverySaving}
          on:click={() => applyRecoveryModeDraft('backup_only')}
        >
          <span class="recovery-mode-title">Backup only</span>
          <span class="recovery-mode-copy">Encrypted runtime backup, no dispute rescue.</span>
        </button>
        <button
          type="button"
          class="recovery-mode-option"
          class:selected={recoveryMode === 'local_only'}
          disabled={recoverySaving}
          on:click={() => applyRecoveryModeDraft('local_only')}
        >
          <span class="recovery-mode-title">Local only</span>
          <span class="recovery-mode-copy">No remote backup unless you add a service URL.</span>
        </button>
      </div>

      <div class="recovery-service-list">
        {#if recoveryTowerDraft.length === 0}
          <div class="empty-recovery-card">No remote recovery service configured.</div>
        {:else}
          {#each recoveryTowerDraft as tower (tower.url)}
            {@const isOfficial = isOfficialRecoveryTower(tower, recoveryOfficialUrl)}
            {@const towerStatus = recoveryTowerStatusByUrl.get(String(tower.url || '').replace(/\/+$/, ''))}
            <div class="recovery-service-row">
              <div class="recovery-service-main">
                <strong>{isOfficial ? 'Official xln tower' : 'Manual service'}</strong>
                <code>{tower.url}</code>
                {#if towerStatus}
                  <small class="recovery-service-status" data-status={towerStatus.status}>
                    <span>{towerStatus.label}</span>
                    <span>{towerStatus.detail}</span>
                  </small>
                {/if}
              </div>
              <div class="recovery-service-actions">
                <select
                  value={normalizeTowerMode(tower.towerMode)}
                  disabled={isOfficial || recoverySaving}
                  aria-label="Recovery service mode"
                  on:change={(event) => updateRecoveryTowerMode(tower.url, (event.currentTarget as HTMLSelectElement).value as RecoveryServiceMode)}
                >
                  <option value="blind_backup">Backup</option>
                  <option value="delayed_last_resort">Last resort</option>
                </select>
                {#if !isOfficial}
                  <button type="button" class="mini-action danger" disabled={recoverySaving} on:click={() => removeRecoveryTower(tower.url)}>
                    Remove
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="manual-service-editor manual-recovery-grid">
        <label>
          <span>Service URL</span>
          <input
            type="url"
            bind:value={recoveryManualUrl}
            placeholder="https://tower.example.com"
            autocomplete="off"
            spellcheck="false"
            disabled={recoverySaving}
          />
        </label>
        <label>
          <span>Role</span>
          <select bind:value={recoveryManualKind} disabled={recoverySaving}>
            <option value="blind_backup">Backup service</option>
            <option value="delayed_last_resort">Last-resort disputer</option>
          </select>
        </label>
        <button type="button" class="secondary-action manual-service-add" disabled={recoverySaving} on:click={addManualRecoveryTower}>
          <PlusCircle size={15} />
          <span>Add service</span>
        </button>
      </div>

      <button type="button" class="primary-action" disabled={!canSaveRecovery} on:click={() => void saveRecoveryConfig()}>
        <Save size={16} />
        <span>{recoverySaving ? 'Saving' : 'Save Recovery Services'}</span>
      </button>
      {#if recoveryDisabledReason}
        <p class="muted-status">{recoveryDisabledReason}</p>
      {/if}
      {#if recoveryMessage}
        <p class:error-status={recoveryMessageTone === 'error'} class:ok-status={recoveryMessageTone === 'ok'} class:muted-status={recoveryMessageTone === 'neutral'}>
          {recoveryMessage}
        </p>
      {/if}
    </section>

    <PushWakePanel
      runtime={$activeRuntime}
      env={runtimeEnv}
      entityId={normalizedEntityId}
      jurisdictionName={jurisdictionLabel}
      towers={recoveryTowerDraft}
      {activeIsLive}
    />
  {:else if settingsSubview === 'display'}
    <section class="panel display-panel" data-testid="settings-display-panel">
      <div class="panel-title">
        <SlidersHorizontal size={15} />
        <span>Display</span>
      </div>
      <label class="settings-control">
        <span>Theme</span>
        <select
          data-testid="settings-theme-select"
          value={$settings.theme}
          on:change={updateTheme}
        >
          {#each themeOptions as option}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>
      <label class="settings-control settings-control--toggle">
        <span class="settings-control-copy">
          <strong>Time Machine</strong>
          <small>Show historical frame navigation in the workspace.</small>
        </span>
        <input
          type="checkbox"
          data-testid="settings-time-machine-toggle"
          checked={$settings.showTimeMachine}
          on:change={(event) => settingsOperations.setShowTimeMachine((event.currentTarget as HTMLInputElement).checked)}
        />
      </label>
    </section>
  {:else}

  <div class="settings-grid">
    <section class="panel">
      <div class="panel-title">
        <SlidersHorizontal size={15} />
        <span>Runtime</span>
      </div>
      <dl class="facts">
        <div><dt>Runtime</dt><dd title={normalizedRuntimeId}>{shortId(normalizedRuntimeId, 18)}</dd></div>
        <div><dt>Height</dt><dd>{formatCount(runtimeHeight || $runtimeControllerHandle.height)}</dd></div>
        <div><dt>Entity</dt><dd title={normalizedEntityId}>{shortId(normalizedEntityId, 18)}</dd></div>
        <div><dt>Signer</dt><dd title={signerId}>{shortId(signerId, 18)}</dd></div>
        <div><dt>Jurisdiction</dt><dd>{jurisdictionLabel || '-'}</dd></div>
      </dl>
    </section>

    <section class="panel">
      <div class="panel-title">
        <ShieldCheck size={15} />
        <span>Capabilities</span>
      </div>
      <dl class="facts">
        <div><dt>Mode</dt><dd>{activeIsLive ? 'live' : 'history'}</dd></div>
        <div><dt>Write</dt><dd>{runtimeCanWrite ? 'admin' : 'inspect'}</dd></div>
        <div><dt>Hub</dt><dd>{isHub ? 'yes' : 'no'}</dd></div>
        <div><dt>Accounts</dt><dd>{formatCount(accountCount)}</dd></div>
        <div><dt>Reserves</dt><dd>{formatCount(reserveCount)}</dd></div>
        <div><dt>Proposals</dt><dd>{formatCount(proposalCount)}</dd></div>
      </dl>
    </section>
  </div>

  <form class="panel profile-panel" on:submit|preventDefault={submitProfile}>
    <div class="panel-title">
      <Save size={15} />
      <span>Profile</span>
    </div>
    <label>
      <span>Name</span>
      <input bind:value={draftName} autocomplete="off" disabled={!canSaveProfile || savingProfile} />
    </label>
    <label>
      <span>Avatar URL</span>
      <input bind:value={draftAvatar} autocomplete="off" disabled={!canSaveProfile || savingProfile} />
    </label>
    <label>
      <span>Bio</span>
      <textarea bind:value={draftBio} rows="3" disabled={!canSaveProfile || savingProfile}></textarea>
    </label>
    <label>
      <span>Website</span>
      <input bind:value={draftWebsite} autocomplete="off" disabled={!canSaveProfile || savingProfile} />
    </label>
    <button type="submit" class="primary-action" disabled={!canSaveProfile}>
      <Save size={16} />
      <span>{savingProfile ? 'Saving' : 'Save Profile'}</span>
    </button>
    {#if saveDisabledReason}
      <p class="muted-status">{saveDisabledReason}</p>
    {/if}
    {#if profileError}
      <p class="error-status" data-testid="entity-settings-profile-error">{profileError}</p>
    {:else if profileSaved}
      <p class="ok-status" data-testid="entity-settings-profile-saved">Profile command submitted</p>
    {/if}
  </form>

  <section class="panel network-panel">
    <div class="panel-title split-title">
      <span>
        <Network size={15} />
        <span>Network</span>
      </span>
      <button
        type="button"
        class="secondary-action"
        disabled={!canImportJMachine}
        on:click={() => {
          networkPanelOpen = !networkPanelOpen;
          importError = '';
          importSaved = false;
        }}
        data-testid="settings-network-add-jmachine-toggle"
      >
        <PlusCircle size={15} />
        <span>{networkPanelOpen ? 'Close' : 'Add J-Machine'}</span>
      </button>
    </div>
    {#if importDisabledReason}
      <p class="muted-status">{importDisabledReason}</p>
    {/if}
    {#if networkPanelOpen}
      <AddJMachine
        busy={importingJMachine}
        on:create={(event) => void handleJMachineCreate(event)}
        on:cancel={() => networkPanelOpen = false}
      />
    {/if}
    {#if importError}
      <p class="error-status" data-testid="entity-settings-jmachine-error">{importError}</p>
    {:else if importSaved}
      <p class="ok-status" data-testid="entity-settings-jmachine-saved">Jurisdiction import complete</p>
    {/if}
  </section>

  {#if isHub || hubPolicy}
    <section class="panel">
      <div class="panel-title">
        <SlidersHorizontal size={15} />
        <span>Hub Policy</span>
      </div>
      <dl class="facts">
        <div><dt>Strategy</dt><dd>{hubPolicy?.matchingStrategy || '-'}</dd></div>
        <div><dt>Version</dt><dd>{formatPolicyValue(hubPolicy?.policyVersion)}</dd></div>
        <div><dt>Routing PPM</dt><dd>{formatPolicyValue(hubPolicy?.routingFeePPM)}</dd></div>
        <div><dt>Base Fee</dt><dd>{formatPolicyValue(hubPolicy?.baseFee)}</dd></div>
        <div><dt>Rebalance Fee BPS</dt><dd>{formatPolicyValue(hubPolicy?.rebalanceLiquidityFeeBps)}</dd></div>
        <div><dt>Timeout MS</dt><dd>{formatPolicyValue(hubPolicy?.rebalanceTimeoutMs)}</dd></div>
      </dl>
    </section>
  {/if}
  {/if}
</section>

<style>
  .settings-projection {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: 100%;
    max-width: 1220px;
    margin: 0 auto;
    padding: 18px 0 32px;
    color: var(--theme-text-primary, #f4f4f5);
  }

  .settings-head,
  .panel-title,
  .runtime-pill,
  .primary-action,
  .secondary-action,
  .split-title > span {
    display: flex;
    align-items: center;
  }

  .settings-head {
    justify-content: space-between;
    gap: 14px;
  }

  .eyebrow {
    margin: 0 0 4px;
    color: var(--theme-accent, #fbbf24);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: 22px;
    line-height: 1.2;
  }

  .runtime-pill {
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 34%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 10%, transparent);
    color: var(--theme-accent, #fbbf24);
    font-size: 12px;
    text-transform: uppercase;
  }

  .settings-tabs {
    align-items: center;
    display: flex;
    gap: 8px;
  }

  .settings-tabs button {
    border: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 84%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-card-bg, #111113) 90%, transparent);
    color: var(--theme-text-secondary, #a1a1aa);
    cursor: pointer;
    font-size: 13px;
    font-weight: 800;
    min-height: 36px;
    padding: 0 14px;
  }

  .settings-tabs button.active {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 42%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent);
    color: var(--theme-text-primary, #f4f4f5);
  }

  .settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .panel {
    border: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 82%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-card-bg, #111113) 94%, transparent);
    padding: 16px;
  }

  .display-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .settings-control--toggle {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 44px;
  }

  .settings-control-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .settings-control-copy strong {
    color: var(--theme-text-primary, #f4f4f5);
    font-size: 13px;
  }

  .settings-control-copy small {
    color: var(--theme-text-muted, #71717a);
    font-size: 12px;
  }

  .settings-control--toggle input {
    width: 18px;
    height: 18px;
    padding: 0;
    accent-color: var(--theme-accent, #fbbf24);
  }

  .panel-title {
    gap: 8px;
    margin-bottom: 12px;
    color: var(--theme-text-secondary, #a1a1aa);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .split-title {
    justify-content: space-between;
    gap: 12px;
  }

  .split-title > span {
    gap: 8px;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 14px;
    margin: 0;
  }

  .facts div,
  label {
    min-width: 0;
  }

  dt,
  label span {
    color: var(--theme-text-muted, #71717a);
    font-size: 12px;
    font-weight: 700;
  }

  dd {
    margin: 3px 0 0;
    overflow: hidden;
    color: var(--theme-text-primary, #f4f4f5);
    font-family: 'SF Mono', 'Monaco', monospace;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .profile-panel {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .profile-panel .panel-title,
  .profile-panel textarea,
  .primary-action,
  .muted-status,
  .error-status,
  .ok-status {
    grid-column: 1 / -1;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #3f3f46) 84%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 94%, transparent);
    color: var(--theme-text-primary, #f4f4f5);
    font: inherit;
    padding: 10px 12px;
  }

  textarea {
    min-height: 82px;
    resize: vertical;
  }

  select {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--theme-input-border, #3f3f46) 84%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 94%, transparent);
    color: var(--theme-text-primary, #f4f4f5);
    font: inherit;
    min-height: 40px;
    padding: 8px 10px;
  }

  .primary-action,
  .secondary-action {
    justify-content: center;
    gap: 8px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 900;
  }

  .primary-action {
    border: 0;
    background: var(--theme-accent, #fbbf24);
    color: #0a0a0a;
    min-height: 44px;
  }

  .secondary-action {
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 40%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 12%, transparent);
    color: var(--theme-accent, #fbbf24);
  }

  .primary-action:disabled,
  .secondary-action:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  .network-panel :global(.add-jmachine) {
    max-width: none;
    padding: 4px 0 0;
  }

  .recovery-panel,
  .recovery-service-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .recovery-coverage-grid {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .recovery-coverage-card {
    border: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 82%, transparent);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 94px;
    min-width: 0;
    padding: 11px;
  }

  .coverage-card-head {
    align-items: flex-start;
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .coverage-card-head strong {
    color: var(--theme-text-primary, #f4f4f5);
    font-size: 12px;
    font-weight: 900;
  }

  .coverage-status {
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 32%, transparent);
    color: var(--theme-text-muted, #71717a);
    display: inline-flex;
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 0;
    line-height: 1;
    padding: 5px 7px;
    text-transform: uppercase;
  }

  .recovery-coverage-card[data-status='ready'] .coverage-status {
    color: #34d399;
  }

  .recovery-coverage-card[data-status='configured'] .coverage-status {
    color: var(--theme-accent, #fbbf24);
  }

  .recovery-coverage-card[data-status='missing'] .coverage-status {
    color: #fb7185;
  }

  .recovery-coverage-card p {
    color: var(--theme-text-muted, #71717a);
    font-size: 12px;
    line-height: 1.35;
    margin: 0;
  }

  .recovery-mode-grid,
  .manual-recovery-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .recovery-mode-option {
    align-items: flex-start;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 86%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 90%, transparent);
    color: var(--theme-text-primary, #f4f4f5);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 92px;
    padding: 12px;
    text-align: left;
  }

  .recovery-mode-option.selected {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 54%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 10%, transparent);
  }

  .recovery-mode-option:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }

  .recovery-mode-title {
    font-size: 13px;
    font-weight: 900;
  }

  .recovery-mode-copy {
    color: var(--theme-text-muted, #71717a);
    font-size: 12px;
    line-height: 1.35;
  }

  .recovery-service-row {
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 80%, transparent);
    border-radius: 8px;
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 12px;
  }

  .recovery-service-main {
    min-width: 0;
  }

  .recovery-service-main strong,
  .recovery-service-main code {
    display: block;
  }

  .recovery-service-main code {
    color: var(--theme-text-muted, #71717a);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recovery-service-status {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 7px;
  }

  .recovery-service-status span:first-child {
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    font-size: 10px;
    font-weight: 900;
    line-height: 1;
    padding: 4px 6px;
    text-transform: uppercase;
  }

  .recovery-service-status span:last-child {
    color: var(--theme-text-muted, #71717a);
    font-size: 11px;
  }

  .recovery-service-status[data-status='receipt'] span:first-child {
    color: #34d399;
  }

  .recovery-service-status[data-status='failure'] span:first-child {
    color: #fb7185;
  }

  .recovery-service-status[data-status='pending'] span:first-child {
    color: var(--theme-text-muted, #71717a);
  }

  .recovery-service-actions {
    align-items: center;
    display: flex;
    gap: 8px;
  }

  .mini-action {
    border: 1px solid color-mix(in srgb, var(--theme-card-border, #27272a) 84%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--theme-input-bg, #09090b) 92%, transparent);
    color: var(--theme-text-primary, #f4f4f5);
    cursor: pointer;
    font-weight: 800;
    min-height: 36px;
    padding: 0 10px;
  }

  .mini-action.danger {
    color: #fb7185;
  }

  .empty-recovery-card {
    border: 1px dashed color-mix(in srgb, var(--theme-card-border, #27272a) 82%, transparent);
    border-radius: 8px;
    color: var(--theme-text-muted, #71717a);
    font-size: 13px;
    padding: 12px;
  }

  .muted-status,
  .error-status,
  .ok-status {
    margin: 0;
    font-size: 13px;
  }

  .muted-status {
    color: var(--theme-text-muted, #71717a);
  }

  .error-status {
    color: #fb7185;
  }

  .ok-status {
    color: #34d399;
  }

  @media (max-width: 760px) {
    .settings-head,
    .settings-grid,
    .recovery-coverage-grid,
    .recovery-mode-grid,
    .manual-recovery-grid,
    .profile-panel,
    .facts {
      grid-template-columns: 1fr;
    }

    .settings-head {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
