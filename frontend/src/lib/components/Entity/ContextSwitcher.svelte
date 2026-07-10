<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import { allRuntimes, activeRuntime, vaultOperations } from '$lib/stores/vaultStore';
  import {
    activeRuntimeId as activeStoreRuntimeId,
    runtimeOperations,
    runtimes as runtimeEntries,
    type Runtime as StoreRuntime,
  } from '$lib/stores/runtimeStore';
  import { runtimeControllerHandle } from '$lib/stores/runtimeControllerStore';
  import { refreshRuntimeView, runtimeView, setRuntimeViewActiveEntityId } from '$lib/stores/runtimeViewStore';
  import { resetEverything } from '$lib/utils/resetEverything';
  import { xlnFunctions, xlnInstance } from '$lib/stores/xlnStore';
  import type { RuntimeAdapterEntitySummary } from '@xln/runtime/xln-api';
  import type { Tab } from '$lib/types/ui';
  import { entityAvatar, preferredAvatar } from '$lib/utils/avatar';
  import { getJurisdictionBadgeInfo, type JurisdictionBadgeInfo } from '$lib/utils/jurisdictionBadge';
  import { compareStableText } from '$lib/utils/stableSort';

  export let tab: Tab;
  export let allowAddRuntime = false;
  export let allowAddJurisdiction = false;
  export let allowAddEntity = false;
  export let addRuntimeLabel = '+ Add Runtime';

  const dispatch = createEventDispatcher();

  let open = false;
  let focusedRuntimeId = '';

  onMount(() => {
    runtimeOperations.hydrateRemoteRuntimeImports();
  });

  type RuntimeSummary = {
    runtimeId: string;
    runtimeLabel: string;
    signerId: string;
    status: 'connected' | 'syncing' | 'disconnected' | 'error' | 'inactive';
    avatar: string;
    source: 'browser' | 'remote';
    selfEntity: EntitySummary | null;
    derivedEntities: EntitySummary[];
  };

  type EntitySummary = {
    entityId: string;
    signerId: string;
    name: string;
    avatar: string;
    jurisdiction: string;
    jurisdictionBadge: JurisdictionBadgeInfo | null;
    isSelf: boolean;
    isPlaceholder?: boolean;
  };

  type EntityMenuRow = EntitySummary & {
    runtimeId: string;
    groupSignerId: string;
  };

  type JurisdictionGroup = {
    key: string;
    label: string;
    badge: JurisdictionBadgeInfo | null;
    entities: EntityMenuRow[];
  };

  type RuntimeMenuGroup = RuntimeSummary & {
    jurisdictions: JurisdictionGroup[];
  };

  $: xlnReady = !!$xlnInstance;
  $: activeXlnFunctions = xlnReady ? $xlnFunctions : null;
  $: runtimeGroups = buildRuntimeGroups();
  $: runtimeMenuGroups = buildRuntimeMenuGroups(runtimeGroups);
  $: runtimeMutationControlsEnabled = $runtimeControllerHandle.permissions === 'write';
  $: controllerRuntimeId = normalizeId($runtimeControllerHandle.runtimeId || $runtimeControllerHandle.id);
  $: currentGroup = runtimeGroups.find((group) => normalizeId(group.runtimeId) === controllerRuntimeId)
    || runtimeGroups.find((group) => group.runtimeId === $activeStoreRuntimeId)
    || runtimeGroups.find((group) => group.runtimeId === $activeRuntime?.id)
    || null;
  $: currentEntity = resolveCurrentEntity();
  $: currentAvatar = currentEntity?.avatar || currentGroup?.avatar || '';
  $: currentJurisdictionBadge = currentEntity?.jurisdictionBadge || null;
  $: currentRuntimeId = currentGroup?.runtimeId || $activeRuntime?.id || '';
  $: currentEntityId = currentEntity?.entityId || tab.entityId || currentGroup?.selfEntity?.entityId || '';
  $: currentSignerId = currentEntity?.signerId || tab.signerId || currentGroup?.signerId || '';
  $: currentTitle = resolveCurrentTitle();
  $: currentSubtitle = currentGroup
    ? [currentGroup.runtimeLabel, currentEntity?.jurisdiction || 'Unassigned'].filter(Boolean).join(' · ')
    : 'No runtime selected';
  $: if (!open && normalizeId(focusedRuntimeId) !== normalizeId(currentRuntimeId)) {
    focusedRuntimeId = currentRuntimeId;
  }
  $: focusedRuntimeGroup = runtimeMenuGroups.find((group) =>
    normalizeId(group.runtimeId) === normalizeId(focusedRuntimeId || currentRuntimeId)
  ) || runtimeMenuGroups[0] || null;

  function buildRuntimeGroups(): RuntimeSummary[] {
    const groups: RuntimeSummary[] = [];
    for (const runtime of $runtimeEntries.values()) {
      if (runtime.type !== 'remote') continue;
      groups.push(buildRemoteRuntimeGroup(runtime));
    }
    for (const runtime of $allRuntimes) {
      const signer = runtime.signers?.[runtime.activeSignerIndex] || runtime.signers?.[0];
      const signerId = signer?.address || '';
      const runtimeEntry = $runtimeEntries.get(runtime.id);
      const status = runtimeEntry?.status || 'inactive';
      const fallbackSummaries = signer?.entityId ? [{
        entityId: signer.entityId,
        signerId,
        label: signer.entityId,
        height: 0,
        ...(signer.jurisdiction ? { jurisdiction: { name: signer.jurisdiction } } : {}),
      }] : [];
      const entityMap = collectEntitySummaries(
        projectionSummariesForRuntime(runtime.id, fallbackSummaries),
        signerId,
        signer?.entityId || null,
      );
      const selfEntityId = normalizeId(signer?.entityId);
      const selfEntity = selfEntityId ? entityMap.find((entity) => normalizeId(entity.entityId) === selfEntityId) || null : null;
      const derivedEntities = entityMap.filter((entity) => !selfEntity || normalizeId(entity.entityId) !== normalizeId(selfEntity.entityId));
      const runtimeAvatar = preferredAvatar(activeXlnFunctions, signer?.entityId || '', signerId, 32);

      groups.push({
        runtimeId: runtime.id,
        runtimeLabel: runtime.label || runtime.id,
        signerId,
        status,
        avatar: selfEntity?.avatar || runtimeAvatar,
        source: 'browser',
        selfEntity: selfEntity || (selfEntityId ? {
          entityId: signer?.entityId || '',
          signerId,
          name: signer?.entityId || 'Entity',
          avatar: entityAvatar(activeXlnFunctions, signer?.entityId || ''),
          jurisdiction: signer?.jurisdiction || '',
          jurisdictionBadge: getJurisdictionBadgeInfo(signer?.jurisdiction || null, null),
          isSelf: true
        } : null),
        derivedEntities,
      });
    }
    return groups;
  }

  function buildRemoteRuntimeGroup(runtime: StoreRuntime): RuntimeSummary {
    const entities = collectEntitySummaries(
      projectionSummariesForRuntime(runtime.id, remoteRuntimeFallbackSummaries(runtime)),
      '',
      runtime.hubEntityId || null,
    );
    const selfEntity = resolveRemotePrimaryEntity(runtime, entities);
    return {
      runtimeId: runtime.id,
      runtimeLabel: runtime.label || 'Remote runtime',
      signerId: '',
      status: runtime.status,
      avatar: selfEntity?.avatar || '',
      source: 'remote',
      selfEntity,
      derivedEntities: selfEntity
        ? entities.filter((entity) => normalizeId(entity.entityId) !== normalizeId(selfEntity.entityId))
        : entities,
    };
  }

  function jurisdictionKey(entity: EntitySummary): string {
    const name = String(entity.jurisdiction || 'Unassigned').trim() || 'Unassigned';
    return `${name.toLowerCase()}|${entity.jurisdictionBadge?.title || ''}`;
  }

  function jurisdictionLabel(entity: EntitySummary): string {
    return String(entity.jurisdiction || entity.jurisdictionBadge?.title || 'Unassigned').trim() || 'Unassigned';
  }

  function menuRowsForRuntime(group: RuntimeSummary): EntityMenuRow[] {
    const entities = [
      ...(group.selfEntity ? [group.selfEntity] : []),
      ...group.derivedEntities,
    ];
    return entities.map((entity) => ({
      ...entity,
      runtimeId: group.runtimeId,
      groupSignerId: group.signerId,
    }));
  }

  function buildJurisdictionGroups(entities: EntityMenuRow[]): JurisdictionGroup[] {
    const byJurisdiction = new Map<string, JurisdictionGroup>();
    for (const entity of entities.slice().sort(compareEntityRows)) {
      const key = jurisdictionKey(entity);
      const group = byJurisdiction.get(key) ?? {
        key,
        label: jurisdictionLabel(entity),
        badge: entity.jurisdictionBadge,
        entities: [],
      };
      group.entities.push(entity);
      byJurisdiction.set(key, group);
    }
    return Array.from(byJurisdiction.values()).sort((a, b) => compareStableText(a.label, b.label));
  }

  function buildRuntimeMenuGroups(groups: RuntimeSummary[]): RuntimeMenuGroup[] {
    return groups
      .map((group) => ({
        ...group,
        jurisdictions: buildJurisdictionGroups(menuRowsForRuntime(group)),
      }))
      .filter((group) => group.jurisdictions.length > 0);
  }

  function compareEntityRows(a: EntityMenuRow, b: EntityMenuRow): number {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return compareStableText(a.name, b.name) || compareStableText(a.entityId, b.entityId);
  }

  type ContextRuntimeEntitySummary = RuntimeAdapterEntitySummary & { isPlaceholder?: boolean };

  function remoteRuntimeFallbackSummaries(runtime: StoreRuntime): ContextRuntimeEntitySummary[] {
    const summaries: ContextRuntimeEntitySummary[] = [];
    const seen = new Set<string>();
    const add = (
      entityId: string | null | undefined,
      label: string | null | undefined,
      height: number,
      jurisdiction: RuntimeAdapterEntitySummary['jurisdiction'] | undefined,
    ): void => {
      const normalized = normalizeId(entityId);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      summaries.push({
        entityId: normalized,
        label: String(label || normalized).trim(),
        height: Math.max(0, Math.floor(Number(height || 0))),
        isHub: true,
        ...(jurisdiction ? { jurisdiction } : {}),
      });
    };
    const runtimeId = normalizeId(runtime.id);
    const ownedHubEntities = (runtime.hubEntities ?? []).filter((hub) => {
      const ownerRuntimeId = normalizeId(hub.runtimeId);
      return !ownerRuntimeId || ownerRuntimeId === runtimeId;
    });
    for (const hub of ownedHubEntities) {
      add(hub.entityId, hub.label, hub.height, hub.jurisdiction);
    }
    add(runtime.hubEntityId, runtime.hubName || runtime.label, 0, runtime.hubJurisdiction);
    if (summaries.length === 0) {
      const runtimeId = normalizeId(runtime.id);
      if (runtimeId) {
        summaries.push({
          entityId: runtimeId,
          label: String(runtime.hubName || runtime.label || runtimeId).trim(),
          height: Math.max(0, Math.floor(Number(runtime.entityCount || 0))),
          isHub: true,
          isPlaceholder: true,
        });
      }
    }
    return summaries;
  }

  function projectionSummariesForRuntime(
    runtimeId: string,
    fallbackSummaries: ContextRuntimeEntitySummary[],
  ): ContextRuntimeEntitySummary[] {
    const summaries = new Map<string, ContextRuntimeEntitySummary>();
    const add = (summary: ContextRuntimeEntitySummary | null | undefined): void => {
      const entityId = normalizeId(summary?.entityId);
      if (!entityId) return;
      const previous = summaries.get(entityId);
      const merged: ContextRuntimeEntitySummary = {
        entityId,
        label: String(summary?.label || previous?.label || entityId).trim(),
        height: Math.max(0, Math.floor(Number(summary?.height ?? previous?.height ?? 0))),
      };
      const signerId = String(summary?.signerId || previous?.signerId || '').trim();
      const jurisdiction = summary?.jurisdiction ?? previous?.jurisdiction;
      if (signerId) merged.signerId = signerId;
      if (jurisdiction) merged.jurisdiction = jurisdiction;
      if (summary?.isHub === true || previous?.isHub === true) merged.isHub = true;
      if (summary?.isPlaceholder === true || previous?.isPlaceholder === true) merged.isPlaceholder = true;
      summaries.set(entityId, merged);
    };
    for (const summary of fallbackSummaries) add(summary);
    if (normalizeId(runtimeId) === controllerRuntimeId || normalizeId(runtimeId) === normalizeId($runtimeView.runtimeId)) {
      for (const summary of $runtimeView.entities ?? []) {
        const projectionRuntimeId = normalizeId(summary?.runtimeId);
        if (projectionRuntimeId && projectionRuntimeId !== normalizeId(runtimeId)) continue;
        add(summary);
      }
      add($runtimeView.frame?.activeEntity?.summary ?? null);
    }
    return Array.from(summaries.values());
  }

  function normalizeRuntimeEntityLabel(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase().replace(/^remote\s+/, '');
  }

  function remoteEntityNameMatchesRuntimeLabel(runtimeLabel: string, entityName: string): boolean {
    const label = normalizeRuntimeEntityLabel(runtimeLabel);
    const name = normalizeRuntimeEntityLabel(entityName);
    if (!label || !name) return false;
    return name === label || name.startsWith(`${label} `) || name.startsWith(`${label}(`);
  }

  function resolveRemotePrimaryEntity(runtime: StoreRuntime, entities: EntitySummary[]): EntitySummary | null {
    const hubEntityId = normalizeId(runtime.hubEntityId);
    if (hubEntityId) {
      const hubEntity = entities.find((entity) => normalizeId(entity.entityId) === hubEntityId);
      if (hubEntity) return hubEntity;
    }
    const label = String(runtime.label || '').trim();
    if (!label) return null;
    return entities.find((entity) => normalizeRuntimeEntityLabel(entity.name) === normalizeRuntimeEntityLabel(label))
      || entities.find((entity) => remoteEntityNameMatchesRuntimeLabel(label, entity.name))
      || null;
  }

  function collectEntitySummaries(
    summaries: ContextRuntimeEntitySummary[],
    signerId: string,
    selfEntityId: string | null,
  ): EntitySummary[] {
    const seen = new Set<string>();
    const entities: EntitySummary[] = [];

    for (const summary of summaries) {
      const entityId = summary.entityId || '';
      const normalizedEntityId = normalizeId(entityId);
      if (!normalizedEntityId || seen.has(normalizedEntityId)) continue;
      seen.add(normalizedEntityId);
      const rawChainId = summary.jurisdiction?.chainId;
      const chainId = typeof rawChainId === 'number'
        ? rawChainId
        : typeof rawChainId === 'string' && rawChainId.trim()
          ? Number(rawChainId)
          : null;
      entities.push({
        entityId: normalizedEntityId,
        signerId: summary.signerId || signerId,
        name: String(summary.label || entityId).trim(),
        avatar: entityAvatar(activeXlnFunctions, entityId),
        jurisdiction: String(summary.jurisdiction?.name || '').trim(),
        jurisdictionBadge: getJurisdictionBadgeInfo(
          summary.jurisdiction?.name || null,
          Number.isFinite(chainId) ? chainId : null,
        ),
        isSelf: normalizedEntityId === normalizeId(selfEntityId),
        ...(summary.isPlaceholder === true ? { isPlaceholder: true } : {}),
      });
    }

    return entities.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return compareStableText(a.name, b.name);
    });
  }

  function resolveCurrentEntity(): EntitySummary | null {
    if (!currentGroup) return null;
    const currentEntityId = normalizeId(tab.entityId);
    if (!currentEntityId) return currentGroup.selfEntity;
    return currentGroup.selfEntity && normalizeId(currentGroup.selfEntity.entityId) === currentEntityId
      ? currentGroup.selfEntity
      : currentGroup.derivedEntities.find((entity) => normalizeId(entity.entityId) === currentEntityId) || currentGroup.selfEntity;
  }

  function normalizeId(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
  }

  function truncateMiddle(value: string | null | undefined, head = 6, tail = 4): string {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= head + tail + 3) return text;
    return `${text.slice(0, head)}...${text.slice(-tail)}`;
  }

  function formatEntityMeta(value: string | null | undefined): string {
    const entityId = String(value || '').trim();
    if (!entityId) return '';
    const short = activeXlnFunctions?.formatShortEntityId?.(entityId);
    return String(short || truncateMiddle(entityId, 10, 6)).trim();
  }

  function isOpaqueIdLabel(value: string | null | undefined): boolean {
    const text = String(value || '').trim();
    return /^0x[a-f0-9]{16,}$/i.test(text);
  }

  function resolveCurrentTitle(): string {
    if (currentEntity?.name && !isOpaqueIdLabel(currentEntity.name)) return currentEntity.name;
    if (currentGroup?.runtimeLabel) return currentGroup.runtimeLabel;
    if (currentEntity?.entityId) return currentEntity.entityId;
    if (currentGroup?.runtimeId) return currentGroup.runtimeId;
    return 'Select Runtime';
  }

  function resolveRuntimeMeta(group: RuntimeSummary): string {
    const source = group.source === 'remote' ? 'Remote runtime' : 'Browser runtime';
    const entityCount = (group.selfEntity ? 1 : 0) + group.derivedEntities.length;
    return `${source} · ${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}`;
  }

  function runtimeStatusLabel(status: RuntimeSummary['status']): string {
    if (status === 'connected') return 'Online';
    if (status === 'syncing') return 'Syncing';
    if (status === 'error') return 'Error';
    if (status === 'inactive') return 'Saved';
    return 'Offline';
  }

  function focusRuntime(runtimeId: string): void {
    focusedRuntimeId = runtimeId;
  }

  async function selectRemoteRuntime(runtimeId: string, entityId = ''): Promise<void> {
    await runtimeOperations.selectRuntime(runtimeId);
    const normalizedEntityId = normalizeId(entityId);
    if (normalizedEntityId) setRuntimeViewActiveEntityId(normalizedEntityId);
    await refreshRuntimeView(normalizedEntityId ? { entityId: normalizedEntityId } : {});
  }

  async function selectRuntimeEntity(runtimeId: string, signerId: string, entity: EntitySummary) {
    const group = runtimeGroups.find((candidate) => candidate.runtimeId === runtimeId);
    open = false;
    if (group?.source === 'remote') {
      const selectedEntityId = entity.isPlaceholder ? '' : entity.entityId;
      await selectRemoteRuntime(runtimeId, selectedEntityId);
      dispatch('entitySelect', {
        jurisdiction: entity.jurisdiction || 'browservm',
        signerId: entity.signerId || signerId,
        entityId: selectedEntityId
      });
      return;
    }
    await vaultOperations.selectRuntime(runtimeId);
    dispatch('entitySelect', {
      jurisdiction: entity.jurisdiction || 'browservm',
      signerId: entity.signerId || signerId,
      entityId: entity.entityId
    });
  }

  function handleAddRuntime() {
    dispatch('addRuntime');
    open = false;
  }

  function handleAddJurisdiction() {
    dispatch('addJurisdiction');
    open = false;
  }

  function handleAddEntity() {
    dispatch('addEntity');
    open = false;
  }

  async function handleReset() {
    if (!confirm('Reset ALL data? Wallets, accounts, settings — everything will be wiped.')) return;
    open = false;
    await resetEverything({ confirmed: true, reason: 'context-switcher-manual-reset' });
  }
</script>

<div class="context-switcher">
<Dropdown
  bind:open
  minWidth={300}
  maxWidth={620}
  local={true}
  ariaLabel={currentTitle}
  triggerTestId="context-current"
  triggerRuntimeId={currentRuntimeId}
  triggerEntityId={currentEntityId}
  triggerSignerId={currentSignerId}
  triggerJurisdiction={currentEntity?.jurisdiction || ''}
  triggerText={currentTitle}
>
  <span
    slot="trigger"
    class="pill-trigger"
  >
    <span class="pill-avatar-wrap">
      {#if currentAvatar}
        <img src={currentAvatar} alt="" class="pill-avatar" />
      {:else}
        <span class="pill-avatar placeholder">◎</span>
      {/if}
      {#if currentJurisdictionBadge}
        <span
          class={`jurisdiction-badge ${currentJurisdictionBadge.className}`}
          title={currentJurisdictionBadge.title}
        >
          {currentJurisdictionBadge.symbol}
        </span>
      {/if}
    </span>
    <span class="pill-copy">
      <span class="pill-title">{currentTitle}</span>
      <span class="pill-subtitle">{currentSubtitle}</span>
    </span>
    <span class="pill-arrow" class:open aria-hidden="true">›</span>
  </span>

  <div slot="menu" class="switcher-menu">
    <header class="menu-heading">
      <div>
        <strong>Switch context</strong>
        <span>Choose a runtime, then an entity</span>
      </div>
      <span class="context-path">Runtime → Jurisdiction → Entity</span>
    </header>

    <div class="context-browser">
      <nav class="runtime-rail" aria-label="Runtimes" data-testid="context-runtime-rail">
        {#each runtimeMenuGroups as runtimeGroup (runtimeGroup.runtimeId)}
          <button
            type="button"
            class="runtime-menu-group"
            class:focused={normalizeId(runtimeGroup.runtimeId) === normalizeId(focusedRuntimeGroup?.runtimeId)}
            class:current={normalizeId(runtimeGroup.runtimeId) === normalizeId(currentRuntimeId)}
            data-testid="context-runtime-group"
            data-runtime-id={normalizeId(runtimeGroup.runtimeId)}
            on:click={() => focusRuntime(runtimeGroup.runtimeId)}
          >
            <span class={`runtime-status ${runtimeGroup.status}`} title={runtimeStatusLabel(runtimeGroup.status)}></span>
            <span class="runtime-heading-copy">
              <span class="runtime-heading-title" data-testid="context-runtime-label">{runtimeGroup.runtimeLabel}</span>
              <span class="runtime-heading-meta">
                <span data-testid="context-runtime-source">{runtimeGroup.source === 'remote' ? 'Remote' : 'Browser'}</span>
                <span>·</span>
                <span>{runtimeGroup.jurisdictions.length} {runtimeGroup.jurisdictions.length === 1 ? 'network' : 'networks'}</span>
              </span>
            </span>
            {#if normalizeId(runtimeGroup.runtimeId) === normalizeId(currentRuntimeId)}
              <span class="current-mark" aria-label="Current runtime">✓</span>
            {:else}
              <span class="runtime-chevron" aria-hidden="true">›</span>
            {/if}
          </button>
        {/each}
      </nav>

      <section class="runtime-focus" data-testid="context-runtime-focus">
        {#if focusedRuntimeGroup}
          <header class="focus-heading">
            <div>
              <strong>{focusedRuntimeGroup.runtimeLabel}</strong>
              <span>{resolveRuntimeMeta(focusedRuntimeGroup)} · {runtimeStatusLabel(focusedRuntimeGroup.status)}</span>
            </div>
            <code title={focusedRuntimeGroup.runtimeId}>{truncateMiddle(focusedRuntimeGroup.runtimeId, 8, 6)}</code>
          </header>

          <div class="jurisdiction-list">
            {#each focusedRuntimeGroup.jurisdictions as jurisdiction (jurisdiction.key)}
              <section class="jurisdiction-group" data-testid="context-jurisdiction-group" data-jurisdiction={jurisdiction.label}>
                <div class="jurisdiction-heading">
                  <span class="jurisdiction-heading-main">
                    {#if jurisdiction.badge}
                      <span
                        class={`jurisdiction-heading-badge ${jurisdiction.badge.className}`}
                        title={jurisdiction.badge.title}
                      >
                        {jurisdiction.badge.symbol}
                      </span>
                    {/if}
                    <span data-testid="context-jurisdiction-label">{jurisdiction.label}</span>
                  </span>
                  <span>{jurisdiction.entities.length}</span>
                </div>

                <div class="entity-list">
                  {#each jurisdiction.entities as entity (`${normalizeId(entity.runtimeId)}:${normalizeId(entity.entityId)}`)}
                    <button
                      type="button"
                      class="entity-row"
                      class:active={normalizeId(entity.entityId) === normalizeId(currentEntityId) && normalizeId(entity.runtimeId) === normalizeId(currentRuntimeId)}
                      data-testid="context-entity-row"
                      data-runtime-id={normalizeId(entity.runtimeId)}
                      data-entity-id={normalizeId(entity.entityId)}
                      data-entity-label={normalizeId(entity.name)}
                      data-signer-id={normalizeId(entity.signerId || entity.groupSignerId)}
                      data-jurisdiction={entity.jurisdiction || ''}
                      on:click={() => void selectRuntimeEntity(entity.runtimeId, entity.groupSignerId, entity)}
                    >
                      <span class="entity-avatar-wrap">
                        {#if entity.avatar}
                          <img src={entity.avatar} alt="" class="entity-avatar" />
                        {:else}
                          <span class="entity-avatar placeholder">◌</span>
                        {/if}
                      </span>
                      <span class="entity-copy">
                        <span class="entity-name">{isOpaqueIdLabel(entity.name) ? truncateMiddle(entity.entityId) : entity.name}</span>
                        <span class="entity-meta">{formatEntityMeta(entity.entityId)}</span>
                      </span>
                      {#if normalizeId(entity.entityId) === normalizeId(currentEntityId) && normalizeId(entity.runtimeId) === normalizeId(currentRuntimeId)}
                        <span class="entity-current">Current</span>
                      {:else}
                        <span class="entity-select">Select</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              </section>
            {/each}
          </div>
        {:else}
          <div class="empty-context">No runtime entities available.</div>
        {/if}
      </section>
    </div>

    <div class="menu-footer">
      <div class="menu-actions">
        {#if allowAddRuntime}
          <button class="add-runtime-btn" on:click={handleAddRuntime}>{addRuntimeLabel}</button>
        {/if}
        {#if runtimeMutationControlsEnabled && allowAddJurisdiction}
          <button class="add-runtime-btn secondary-action" on:click={handleAddJurisdiction}>+ Jurisdiction</button>
        {/if}
        {#if runtimeMutationControlsEnabled && allowAddEntity}
          <button class="add-runtime-btn secondary-action" on:click={handleAddEntity}>+ Entity</button>
        {/if}
      </div>
      <button class="reset-btn" on:click={handleReset}>Reset all data</button>
    </div>
  </div>
</Dropdown>
</div>

<style>
  .context-switcher {
    --dropdown-bg: color-mix(in srgb, var(--theme-card-bg, #151515) 96%, black);
    --dropdown-bg-hover: color-mix(in srgb, var(--theme-card-bg, #151515) 90%, var(--theme-accent, #fbbf24));
    --dropdown-menu-bg: color-mix(in srgb, var(--theme-card-bg, #111111) 97%, black);
    --dropdown-border: color-mix(in srgb, var(--theme-card-border, #3f3f46) 82%, transparent);
    --dropdown-border-hover: color-mix(in srgb, var(--theme-accent, #fbbf24) 42%, transparent);
    --dropdown-radius: 10px;
    display: inline-block;
    width: auto;
    max-width: min(390px, 100%);
  }

  .context-switcher :global(.dropdown-wrapper) {
    width: auto;
    max-width: 100%;
  }

  .context-switcher :global(.dropdown-trigger) {
    width: auto;
    min-width: 250px;
    max-width: min(390px, 100%);
    padding: 8px 10px;
    box-shadow: none;
  }

  .context-switcher :global(.dropdown-menu) {
    width: min(720px, calc(100vw - 24px)) !important;
    max-width: min(720px, calc(100vw - 24px)) !important;
    max-height: min(620px, calc(100dvh - 96px));
    overflow: hidden;
    box-shadow: 0 22px 64px rgba(0, 0, 0, 0.5);
  }

  .pill-trigger {
    display: flex;
    align-items: center;
    gap: 10px;
    width: auto;
    min-width: 0;
  }

  .pill-avatar,
  .entity-avatar {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    flex-shrink: 0;
    object-fit: cover;
    background: transparent;
  }

  .entity-avatar {
    width: 28px;
    height: 28px;
    border-radius: 8px;
  }

  .pill-avatar-wrap,
  .entity-avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .pill-avatar-wrap {
    width: 30px;
    height: 30px;
  }

  .entity-avatar-wrap {
    width: 28px;
    height: 28px;
  }

  .jurisdiction-badge {
    position: absolute;
    right: -4px;
    bottom: -4px;
    width: 12px;
    height: 12px;
    border-radius: 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 7px;
    font-weight: 800;
    color: #fff;
    border: 1px solid rgba(24, 20, 18, 0.98);
    line-height: 1;
  }

  .jurisdiction-badge.ethereum,
  .jurisdiction-badge.sepolia {
    background: #3b82f6;
  }

  .jurisdiction-badge.base {
    background: #0052ff;
  }

  .jurisdiction-badge.tron {
    background: #ef4444;
  }

  .jurisdiction-badge.local,
  .jurisdiction-badge.generic {
    background: #52525b;
  }

  .placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #a8a29e;
    font-size: 14px;
  }

  .pill-copy,
  .entity-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .pill-title,
  .entity-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill-title {
    font-weight: 750;
    color: #f5f5f4;
    font-size: 13px;
    line-height: 1.15;
  }

  .pill-subtitle,
  .entity-meta {
    font-size: 10.5px;
    color: #a8a29e;
  }

  .entity-name {
    font-weight: 600;
  }

  .pill-arrow {
    color: #a8a29e;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    font-size: 16px;
    line-height: 1;
    flex-shrink: 0;
    transform: rotate(0deg);
    transition: transform 160ms ease, color 160ms ease;
  }

  .pill-arrow.open {
    transform: rotate(90deg);
  }

  .switcher-menu {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .menu-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, #3f3f46) 72%, transparent);
  }

  .menu-heading > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .menu-heading strong {
    color: var(--theme-text-primary, #f5f5f4);
    font-size: 14px;
  }

  .menu-heading span,
  .context-path {
    color: var(--theme-text-muted, #78716c);
    font-size: 10px;
  }

  .context-path {
    font-family: 'SF Mono', 'Monaco', monospace;
    white-space: nowrap;
  }

  .context-browser {
    display: grid;
    grid-template-columns: minmax(190px, 0.38fr) minmax(300px, 0.62fr);
    min-height: 0;
    height: min(460px, calc(100dvh - 230px));
  }

  .runtime-rail,
  .runtime-focus {
    min-height: 0;
    overflow-y: auto;
  }

  .runtime-rail {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px;
    border-right: 1px solid color-mix(in srgb, var(--theme-card-border, #3f3f46) 72%, transparent);
    background: color-mix(in srgb, var(--theme-card-bg, #111111) 82%, black);
  }

  .runtime-menu-group {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) 14px;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 52px;
    padding: 8px 9px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--theme-text-secondary, #d6d3d1);
    cursor: pointer;
    text-align: left;
  }

  .runtime-menu-group:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .runtime-menu-group.focused {
    border-color: color-mix(in srgb, var(--theme-accent, #fbbf24) 34%, transparent);
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 8%, transparent);
  }

  .runtime-status {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: #57534e;
  }

  .runtime-status.connected {
    background: #34d399;
    box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.1);
  }

  .runtime-status.syncing {
    background: #fbbf24;
  }

  .runtime-status.error {
    background: #fb7185;
  }

  .runtime-heading-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .runtime-heading-title,
  .runtime-heading-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .runtime-heading-title {
    color: #f5f5f4;
    font-size: 12px;
    font-weight: 750;
  }

  .runtime-heading-meta {
    display: flex;
    gap: 4px;
    color: #a8a29e;
    font-size: 9.5px;
  }

  .current-mark {
    color: #34d399;
    font-size: 11px;
    font-weight: 900;
  }

  .runtime-chevron {
    color: #78716c;
    font-size: 16px;
  }

  .runtime-focus {
    padding: 12px;
  }

  .focus-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 2px 2px 12px;
  }

  .focus-heading > div {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .focus-heading strong {
    color: var(--theme-text-primary, #f5f5f4);
    font-size: 15px;
  }

  .focus-heading span,
  .focus-heading code {
    color: var(--theme-text-muted, #78716c);
    font-size: 10px;
  }

  .focus-heading code {
    padding: 3px 5px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.04);
  }

  .jurisdiction-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .jurisdiction-group {
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, #3f3f46) 76%, transparent);
    border-radius: 9px;
    background: color-mix(in srgb, var(--theme-card-bg, #151515) 88%, black);
  }

  .jurisdiction-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, #3f3f46) 64%, transparent);
    color: var(--theme-text-secondary, #d6d3d1);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .jurisdiction-heading-main {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .jurisdiction-heading-badge {
    width: 14px;
    height: 14px;
    border-radius: 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    color: #fff;
  }

  .jurisdiction-heading-badge.ethereum,
  .jurisdiction-heading-badge.sepolia {
    background: #3b82f6;
  }

  .jurisdiction-heading-badge.base {
    background: #0052ff;
  }

  .jurisdiction-heading-badge.tron {
    background: #ef4444;
  }

  .jurisdiction-heading-badge.local,
  .jurisdiction-heading-badge.generic {
    background: #52525b;
  }

  .entity-list {
    display: flex;
    flex-direction: column;
  }

  .entity-row {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 52px;
    padding: 8px 10px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: #d6d3d1;
    cursor: pointer;
    text-align: left;
  }

  .entity-row + .entity-row {
    border-top: 1px solid rgba(255, 255, 255, 0.04);
  }

  .entity-row:hover,
  .entity-row.active {
    background: rgba(255, 255, 255, 0.06);
  }

  .entity-row.active {
    box-shadow: inset 2px 0 var(--theme-accent, #fbbf24);
  }

  .entity-current,
  .entity-select {
    font-size: 9px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .entity-current {
    color: #34d399;
  }

  .entity-select {
    color: #78716c;
    opacity: 0;
  }

  .entity-row:hover .entity-select {
    opacity: 1;
  }

  .empty-context {
    display: grid;
    min-height: 180px;
    place-items: center;
    color: var(--theme-text-muted, #78716c);
    font-size: 12px;
  }

  .menu-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 10px;
    border-top: 1px solid color-mix(in srgb, var(--theme-card-border, #3f3f46) 72%, transparent);
  }

  .menu-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .add-runtime-btn {
    min-height: 30px;
    padding: 0 9px;
    border: 1px solid color-mix(in srgb, var(--theme-accent, #fbbf24) 28%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--theme-accent, #fbbf24) 9%, transparent);
    color: #fde68a;
    cursor: pointer;
    font-size: 10px;
    font-weight: 750;
  }

  .add-runtime-btn.secondary-action {
    background: transparent;
    border-color: color-mix(in srgb, var(--theme-card-border, #3f3f46) 82%, transparent);
    color: #d6d3d1;
  }

  .add-runtime-btn:hover {
    background: rgba(255, 255, 255, 0.07);
  }

  .reset-btn {
    padding: 5px 7px;
    border: 0;
    background: transparent;
    color: #a8a29e;
    font-size: 10px;
    cursor: pointer;
    white-space: nowrap;
  }

  .reset-btn:hover {
    color: #fca5a5;
  }

  @media (max-width: 680px) {
    .context-switcher,
    .context-switcher :global(.dropdown-trigger) {
      max-width: 100%;
      width: 100%;
    }

    .context-switcher :global(.dropdown-wrapper),
    .context-switcher :global(.dropdown-menu) {
      width: 100%;
      max-width: min(100%, calc(100vw - 24px)) !important;
    }

    .context-path,
    .pill-subtitle {
      display: none;
    }

    .context-browser {
      grid-template-columns: 1fr;
      height: min(540px, calc(100dvh - 210px));
    }

    .runtime-rail {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(150px, 1fr);
      overflow-x: auto;
      overflow-y: hidden;
      border-right: 0;
      border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border, #3f3f46) 72%, transparent);
    }

    .runtime-focus {
      min-height: 0;
    }

    .menu-footer {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
