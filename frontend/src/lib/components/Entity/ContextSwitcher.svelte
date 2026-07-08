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
  $: currentSubtitle = currentEntity?.entityId
    ? formatEntityMeta(currentEntity.entityId)
    : currentGroup?.selfEntity?.entityId
      ? formatEntityMeta(currentGroup.selfEntity.entityId)
    : currentGroup
      ? resolveRuntimeMeta(currentGroup)
      : 'No runtime selected';

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
      for (const summary of $runtimeView.entities ?? []) add(summary);
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
    const entity = formatEntityMeta(group.selfEntity?.entityId || group.runtimeId);
    return entity ? `${source} · ${entity}` : source;
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
    <div class="runtime-list">
      {#each runtimeMenuGroups as runtimeGroup (runtimeGroup.runtimeId)}
        <section
          class="runtime-menu-group"
          class:active={normalizeId(runtimeGroup.runtimeId) === normalizeId(currentRuntimeId)}
          data-testid="context-runtime-group"
          data-runtime-id={normalizeId(runtimeGroup.runtimeId)}
        >
          <div class="runtime-heading">
            {#if runtimeGroup.avatar}
              <img src={runtimeGroup.avatar} alt="" class="runtime-heading-avatar" />
            {:else}
              <span class="runtime-heading-avatar placeholder">◎</span>
            {/if}
            <span class="runtime-heading-copy">
              <span class="runtime-heading-title">
                <span>{runtimeGroup.runtimeLabel}</span>
                <span class={`runtime-source ${runtimeGroup.source}`} data-testid="context-runtime-source">
                  {runtimeGroup.source}
                </span>
              </span>
              <span class="runtime-heading-meta">{resolveRuntimeMeta(runtimeGroup)}</span>
            </span>
          </div>

          {#each runtimeGroup.jurisdictions as jurisdiction (jurisdiction.key)}
            <section class="jurisdiction-group" data-testid="context-jurisdiction-group" data-jurisdiction={jurisdiction.label}>
              <div class="jurisdiction-heading">
                {#if jurisdiction.badge}
                  <span
                    class={`jurisdiction-heading-badge ${jurisdiction.badge.className}`}
                    title={jurisdiction.badge.title}
                  >
                    {jurisdiction.badge.symbol}
                  </span>
                {/if}
                <span>{jurisdiction.label}</span>
              </div>

              <div class="entity-list">
                {#each jurisdiction.entities as entity (`${normalizeId(entity.runtimeId)}:${normalizeId(entity.entityId)}`)}
                  <button
                    class="entity-row"
                    class:active={normalizeId(entity.entityId) === normalizeId(currentEntityId) && normalizeId(entity.runtimeId) === normalizeId(currentRuntimeId)}
                    data-testid="context-entity-row"
                    data-runtime-id={normalizeId(entity.runtimeId)}
                    data-entity-id={normalizeId(entity.entityId)}
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
                      {#if entity.jurisdictionBadge}
                        <span
                          class={`jurisdiction-badge ${entity.jurisdictionBadge.className}`}
                          title={entity.jurisdictionBadge.title}
                        >
                          {entity.jurisdictionBadge.symbol}
                        </span>
                      {/if}
                    </span>
                    <span class="entity-copy">
                      <span class="entity-name">{isOpaqueIdLabel(entity.name) ? truncateMiddle(entity.entityId) : entity.name}</span>
                      <span class="entity-meta">{formatEntityMeta(entity.entityId)}</span>
                    </span>
                  </button>
                {/each}
              </div>
            </section>
            {/each}
        </section>
      {/each}
		    </div>

	    <div class="menu-footer">
      {#if allowAddJurisdiction}
        <button class="add-runtime-btn" on:click={handleAddJurisdiction}>+ Add Jurisdiction</button>
      {/if}
      {#if allowAddEntity}
        <button class="add-runtime-btn secondary-action" on:click={handleAddEntity}>+ Add Entity</button>
      {/if}
      {#if allowAddRuntime}
        <button class="add-runtime-btn" on:click={handleAddRuntime}>{addRuntimeLabel}</button>
      {/if}
      <button class="reset-btn" on:click={handleReset}>Reset All Data</button>
    </div>
  </div>
</Dropdown>
</div>

<style>
  .context-switcher {
    --dropdown-bg: linear-gradient(180deg, rgba(31, 27, 24, 0.98) 0%, rgba(24, 20, 18, 0.98) 100%);
    --dropdown-bg-hover: linear-gradient(180deg, rgba(38, 33, 29, 0.98) 0%, rgba(29, 24, 21, 0.98) 100%);
    --dropdown-menu-bg: linear-gradient(180deg, rgba(24, 20, 18, 0.98) 0%, rgba(17, 14, 12, 0.98) 100%);
    --dropdown-border: rgba(180, 140, 80, 0.18);
    --dropdown-border-hover: rgba(180, 140, 80, 0.32);
    --dropdown-radius: 14px;
    display: inline-block;
    width: auto;
    max-width: min(360px, 100%);
  }

  .context-switcher :global(.dropdown-wrapper) {
    width: auto;
    max-width: 100%;
  }

  .context-switcher :global(.dropdown-trigger) {
    width: auto;
    min-width: 240px;
    max-width: min(360px, 100%);
    padding: 7px 10px;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  }

  .context-switcher :global(.dropdown-menu) {
    width: auto;
    max-width: min(620px, calc(100vw - 24px)) !important;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.38);
  }

  .pill-trigger {
    display: flex;
    align-items: center;
    gap: 9px;
    width: auto;
    min-width: 0;
  }

  .pill-avatar,
  .entity-avatar {
    width: 28px;
    height: 28px;
    border-radius: 9px;
    flex-shrink: 0;
    object-fit: cover;
    background: transparent;
  }

  .entity-avatar {
    width: 22px;
    height: 22px;
    border-radius: 7px;
  }

  .pill-avatar-wrap,
  .entity-avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .pill-avatar-wrap {
    width: 28px;
    height: 28px;
  }

  .entity-avatar-wrap {
    width: 22px;
    height: 22px;
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
    font-weight: 600;
    color: #f5f5f4;
    font-size: 13px;
    line-height: 1.15;
  }

  .pill-subtitle,
  .entity-meta {
    font-size: 10px;
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
    padding: 6px;
  }

  .runtime-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .runtime-menu-group {
    border: 1px solid rgba(68, 64, 60, 0.8);
    border-radius: 12px;
    background: #11100f;
    padding: 7px;
  }

  .runtime-menu-group.active {
    border-color: rgba(251, 191, 36, 0.36);
  }

  .runtime-heading {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 6px 8px;
  }

  .runtime-heading-avatar {
    width: 24px;
    height: 24px;
    border-radius: 8px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .runtime-heading-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .runtime-heading-title,
  .runtime-heading-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .runtime-heading-title {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #f5f5f4;
    font-size: 12px;
    font-weight: 700;
  }

  .runtime-heading-title > span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .runtime-source {
    flex-shrink: 0;
    border: 1px solid rgba(168, 162, 158, 0.22);
    border-radius: 5px;
    padding: 1px 5px;
    color: #a8a29e;
    font-size: 8px;
    font-weight: 800;
    line-height: 1.35;
    text-transform: uppercase;
  }

  .runtime-source.remote {
    border-color: rgba(96, 165, 250, 0.35);
    color: #93c5fd;
  }

  .runtime-source.browser {
    border-color: rgba(251, 191, 36, 0.28);
    color: #fde68a;
  }

  .runtime-heading-meta {
    color: #a8a29e;
    font-size: 10px;
  }

  .jurisdiction-group {
    border-top: 1px solid rgba(68, 64, 60, 0.65);
    border-radius: 0;
    background: #141210;
    padding: 6px 0 0;
  }

  .jurisdiction-group + .jurisdiction-group {
    margin-top: 6px;
  }

  .jurisdiction-heading {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 7px 7px;
    color: #fbbf24;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
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
    gap: 2px;
  }

  .entity-row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 9px;
    border-radius: 9px;
    background: transparent;
    color: #d6d3d1;
    text-align: left;
  }

  .entity-row,
  .add-runtime-btn {
    border: none;
    cursor: pointer;
  }

  .entity-row:hover,
  .entity-row.active,
  .add-runtime-btn:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .menu-footer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 8px;
  }

  .add-runtime-btn {
    width: 100%;
    padding: 10px 12px;
    border-radius: 11px;
    background: rgba(251, 191, 36, 0.12);
    color: #fde68a;
    font-weight: 600;
  }

  .add-runtime-btn.secondary-action {
    background: rgba(120, 113, 108, 0.12);
    border-color: rgba(120, 113, 108, 0.28);
    color: #d6d3d1;
  }

  .reset-btn {
    width: 100%;
    padding: 9px 12px;
    border-radius: 11px;
    background: rgba(239, 68, 68, 0.08);
    color: rgba(248, 113, 113, 0.8);
    border: 1px solid rgba(239, 68, 68, 0.15);
    font-size: 12px;
    cursor: pointer;
  }
  .reset-btn:hover {
    background: rgba(239, 68, 68, 0.18);
    color: #fca5a5;
  }

  @media (max-width: 900px) {
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

    .pill-subtitle {
      display: none;
    }

    .jurisdiction-heading {
      padding-left: 4px;
    }
  }
</style>
