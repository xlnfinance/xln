<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import { allRuntimes, activeRuntime as activeVault, vaultOperations } from '$lib/stores/vaultStore';
  import { runtimes as runtimeEntries } from '$lib/stores/runtimeStore';
  import { resetEverything } from '$lib/utils/resetEverything';
  import { xlnFunctions, xlnInstance } from '$lib/stores/xlnStore';
  import type { Tab, EntityReplica } from '$lib/types/ui';
  import { resolveEntityName } from '$lib/utils/entityNaming';

  export let tab: Tab;
  export let allowAddRuntime = false;
  export let allowDeleteRuntime = false;
  export let addRuntimeLabel = '+ Add Runtime';

  const dispatch = createEventDispatcher();

  let open = false;

  type RuntimeSummary = {
    runtimeId: string;
    runtimeLabel: string;
    signerId: string;
    status: 'connected' | 'syncing' | 'disconnected' | 'error' | 'inactive';
    signerAvatarUrl: string;
    selfEntity: EntitySummary | null;
    derivedEntities: EntitySummary[];
  };

  type EntitySummary = {
    entityId: string;
    name: string;
    avatarUrl: string;
    isSelf: boolean;
  };

  $: xlnReady = !!$xlnInstance;
  $: activeXlnFunctions = xlnReady ? $xlnFunctions : null;
  $: runtimeGroups = buildRuntimeGroups();
  $: currentGroup = runtimeGroups.find((group) => group.runtimeId === $activeVault?.id) || null;
  $: currentEntity = resolveCurrentEntity();
  $: currentAvatar = currentEntity?.avatarUrl || currentGroup?.signerAvatarUrl || '';
  $: currentTitle = resolveCurrentTitle();
  $: currentSubtitle = currentEntity?.entityId
    ? truncateMiddle(currentEntity.entityId)
    : currentGroup?.selfEntity?.entityId
      ? truncateMiddle(currentGroup.selfEntity.entityId)
    : 'No runtime selected';

  function buildRuntimeGroups(): RuntimeSummary[] {
    const groups: RuntimeSummary[] = [];
    for (const runtime of $allRuntimes) {
      const signer = runtime.signers?.[runtime.activeSignerIndex] || runtime.signers?.[0];
      const signerId = signer?.address || '';
      const runtimeEntry = $runtimeEntries.get(runtime.id);
      const status = runtimeEntry?.status || 'inactive';
      const env = runtimeEntry?.env || null;
      const entityMap = collectEntities(env, signerId, signer?.entityId || null);
      const selfEntityId = normalizeId(signer?.entityId);
      const selfEntity = selfEntityId ? entityMap.find((entity) => normalizeId(entity.entityId) === selfEntityId) || null : null;
      const derivedEntities = entityMap.filter((entity) => !selfEntity || normalizeId(entity.entityId) !== normalizeId(selfEntity.entityId));

      groups.push({
        runtimeId: runtime.id,
        runtimeLabel: runtime.label || runtime.id,
        signerId,
        status,
        signerAvatarUrl: signerId ? activeXlnFunctions?.generateSignerAvatar?.(signerId) || '' : '',
        selfEntity: selfEntity || (selfEntityId ? {
          entityId: signer?.entityId || '',
          name: signer?.entityId || 'Entity',
          avatarUrl:
            signer?.entityId && activeXlnFunctions?.isReady
              ? activeXlnFunctions.generateEntityAvatar?.(signer.entityId) || ''
              : '',
          isSelf: true
        } : null),
        derivedEntities,
      });
    }
    return groups;
  }

  function collectEntities(
    env: { eReplicas?: unknown } | null,
    signerId: string,
    selfEntityId: string | null,
  ): EntitySummary[] {
    const replicas = env?.eReplicas;
    const entries = replicas instanceof Map
      ? Array.from(replicas.values())
      : Array.isArray(replicas)
        ? replicas
        : Object.values((replicas || {}) as Record<string, unknown>);

    const signerLower = normalizeId(signerId);
    const seen = new Set<string>();
    const entities: EntitySummary[] = [];

    for (const rawReplica of entries) {
      const replica = rawReplica as EntityReplica;
      if (normalizeId(replica?.signerId) !== signerLower) continue;
      const entityId = replica?.entityId || '';
      const normalizedEntityId = normalizeId(entityId);
      if (!normalizedEntityId || seen.has(normalizedEntityId)) continue;
      seen.add(normalizedEntityId);
      entities.push({
        entityId,
        name: getEntityLabel(entityId, env, replica),
        avatarUrl: activeXlnFunctions?.isReady ? activeXlnFunctions.generateEntityAvatar?.(entityId) || '' : '',
        isSelf: normalizedEntityId === normalizeId(selfEntityId),
      });
    }

    return entities.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function getEntityLabel(entityId: string, env: unknown, replica: EntityReplica | null | undefined): string {
    const resolved = resolveEntityName(entityId, env as Parameters<typeof resolveEntityName>[1]);
    return resolved || replica?.state?.name || entityId;
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

  function isOpaqueIdLabel(value: string | null | undefined): boolean {
    const text = String(value || '').trim();
    return /^0x[a-f0-9]{16,}$/i.test(text);
  }

  function resolveCurrentTitle(): string {
    if (currentEntity?.name && !isOpaqueIdLabel(currentEntity.name)) return currentEntity.name;
    if (currentGroup?.runtimeLabel) return currentGroup.runtimeLabel;
    if (currentEntity?.entityId) return truncateMiddle(currentEntity.entityId);
    if (currentGroup?.runtimeId) return truncateMiddle(currentGroup.runtimeId);
    return 'Select Runtime';
  }

  function resolveRuntimeMeta(group: RuntimeSummary): string {
    return truncateMiddle(group.selfEntity?.entityId || group.runtimeId);
  }

  async function selectRuntimeEntity(runtimeId: string, signerId: string, entityId: string) {
    await vaultOperations.selectRuntime(runtimeId);
    dispatch('entitySelect', {
      jurisdiction: 'browservm',
      signerId,
      entityId
    });
    open = false;
  }

  async function selectRuntimeSelf(group: RuntimeSummary) {
    await vaultOperations.selectRuntime(group.runtimeId);
    if (group.selfEntity) {
      dispatch('entitySelect', {
        jurisdiction: 'browservm',
        signerId: group.signerId,
        entityId: group.selfEntity.entityId
      });
    }
    open = false;
  }

  function handleAddRuntime() {
    dispatch('addRuntime');
    open = false;
  }

  function handleDeleteRuntime(event: MouseEvent, runtimeId: string) {
    event.stopPropagation();
    dispatch('deleteRuntime', { runtimeId });
    open = false;
  }

  async function handleReset() {
    if (!confirm('Reset ALL data? Wallets, accounts, settings — everything will be wiped.')) return;
    open = false;
    await resetEverything();
  }
</script>

<div class="context-switcher">
<Dropdown bind:open minWidth={300} maxWidth={380} local={true}>
  <span slot="trigger" class="pill-trigger">
    {#if currentAvatar}
      <img src={currentAvatar} alt="" class="pill-avatar" />
    {:else}
      <span class="pill-avatar placeholder">◎</span>
    {/if}
    <span class="pill-copy">
      <span class="pill-title">{currentTitle}</span>
      <span class="pill-subtitle">{currentSubtitle}</span>
    </span>
    <span class="pill-arrow" class:open aria-hidden="true">›</span>
  </span>

  <div slot="menu" class="switcher-menu">
    <div class="runtime-list">
      {#each runtimeGroups as group (group.runtimeId)}
        <section class="runtime-group" class:active={group.runtimeId === $activeVault?.id}>
          <div class="runtime-row">
            <button class="runtime-main" on:click={() => selectRuntimeSelf(group)}>
              {#if group.signerAvatarUrl}
                <img src={group.signerAvatarUrl} alt="" class="runtime-avatar" />
              {:else}
                <span class="runtime-avatar placeholder">◎</span>
              {/if}
              <span class="runtime-copy">
                <span class="runtime-name">
                  {#if group.selfEntity?.name && !isOpaqueIdLabel(group.selfEntity.name)}
                    {group.selfEntity.name}
                  {:else}
                    {group.runtimeLabel}
                  {/if}
                </span>
                <span class="runtime-meta">
                  {resolveRuntimeMeta(group)}
                </span>
              </span>
              <span class="status-badge {group.status}">{group.status}</span>
            </button>
            {#if allowDeleteRuntime}
              <button class="runtime-delete" on:click={(event) => handleDeleteRuntime(event, group.runtimeId)} title="Delete runtime">
                ×
              </button>
            {/if}
          </div>

          {#if group.derivedEntities.length > 0}
            <div class="derived-list">
              {#each group.derivedEntities as entity (entity.entityId)}
                <button class="entity-row" on:click={() => selectRuntimeEntity(group.runtimeId, group.signerId, entity.entityId)}>
                  {#if entity.avatarUrl}
                    <img src={entity.avatarUrl} alt="" class="entity-avatar" />
                  {:else}
                    <span class="entity-avatar placeholder">◌</span>
                  {/if}
                  <span class="entity-copy">
                    <span class="entity-name">{isOpaqueIdLabel(entity.name) ? truncateMiddle(entity.entityId) : entity.name}</span>
                    <span class="entity-meta">{truncateMiddle(entity.entityId)}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>

    <div class="menu-footer">
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
    max-width: min(380px, calc(100vw - 24px)) !important;
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
  .runtime-avatar,
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

  .placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #a8a29e;
    font-size: 14px;
  }

  .pill-copy,
  .runtime-copy,
  .entity-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .pill-title,
  .runtime-name,
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
  .runtime-meta,
  .entity-meta {
    font-size: 10px;
    color: #a8a29e;
  }

  .runtime-name {
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
    gap: 6px;
  }

  .runtime-group {
    border: 1px solid #292524;
    border-radius: 12px;
    background: #141210;
    overflow: hidden;
  }

  .runtime-group.active {
    border-color: rgba(251, 191, 36, 0.45);
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.12);
  }

  .runtime-row {
    display: flex;
    align-items: stretch;
    gap: 6px;
    padding: 6px;
  }

  .runtime-main,
  .entity-row,
  .add-runtime-btn,
  .runtime-delete {
    border: none;
    cursor: pointer;
  }

  .runtime-main {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 9px 10px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    color: #f5f5f4;
    text-align: left;
  }

  .runtime-main:hover,
  .entity-row:hover,
  .add-runtime-btn:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .status-badge {
    flex-shrink: 0;
    padding: 4px 9px;
    border-radius: 999px;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border: 1px solid transparent;
  }

  .status-badge.connected {
    color: #86efac;
    background: rgba(34, 197, 94, 0.12);
    border-color: rgba(34, 197, 94, 0.24);
  }

  .status-badge.syncing {
    color: #fde68a;
    background: rgba(234, 179, 8, 0.12);
    border-color: rgba(234, 179, 8, 0.24);
  }

  .status-badge.disconnected,
  .status-badge.error,
  .status-badge.inactive {
    color: #fca5a5;
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.24);
  }

  .runtime-delete {
    width: 34px;
    border-radius: 10px;
    background: rgba(239, 68, 68, 0.08);
    color: rgba(248, 113, 113, 0.92);
    font-size: 20px;
    line-height: 1;
  }

  .derived-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 6px 6px 46px;
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

    .runtime-row {
      flex-direction: column;
    }

    .runtime-delete {
      width: 100%;
      min-height: 36px;
    }

    .derived-list {
      padding-left: 8px;
    }
  }
</style>
