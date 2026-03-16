<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import { allRuntimes, activeRuntime as activeVault, vaultOperations } from '$lib/stores/vaultStore';
  import { runtimes as runtimeEntries } from '$lib/stores/runtimeStore';
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
  $: currentSubtitle = currentGroup
    ? truncateMiddle(currentGroup.signerId || currentGroup.runtimeId)
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
          avatarUrl: signer?.entityId ? activeXlnFunctions?.generateEntityAvatar?.(signer.entityId) || '' : '',
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
        avatarUrl: activeXlnFunctions?.generateEntityAvatar?.(entityId) || '',
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
    if (group.selfEntity?.name && !isOpaqueIdLabel(group.selfEntity.name) && group.selfEntity.name !== group.runtimeLabel) {
      return `${group.selfEntity.name} • ${truncateMiddle(group.signerId || group.runtimeId)}`;
    }
    return truncateMiddle(group.signerId || group.runtimeId);
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
</script>

<div class="context-switcher">
<Dropdown bind:open minWidth={320} maxWidth={640}>
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
    <span class="pill-arrow" class:open>▾</span>
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
                <span class="runtime-name">{group.runtimeLabel}</span>
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
                  <span class="entity-name">{isOpaqueIdLabel(entity.name) ? truncateMiddle(entity.entityId) : entity.name}</span>
                </button>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>

    {#if allowAddRuntime}
      <div class="menu-footer">
        <button class="add-runtime-btn" on:click={handleAddRuntime}>{addRuntimeLabel}</button>
      </div>
    {/if}
  </div>
</Dropdown>
</div>

<style>
  .context-switcher {
    display: inline-block;
    max-width: min(360px, 100%);
  }

  .context-switcher :global(.dropdown-wrapper) {
    width: auto;
    max-width: 100%;
  }

  .context-switcher :global(.dropdown-trigger) {
    width: auto;
    min-width: 220px;
    max-width: min(320px, calc(100vw - 32px));
    padding: 6px 8px;
  }

  .pill-trigger {
    display: flex;
    align-items: center;
    gap: 10px;
    width: auto;
    min-width: 0;
  }

  .pill-avatar,
  .runtime-avatar,
  .entity-avatar {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    flex-shrink: 0;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.06);
  }

  .entity-avatar {
    width: 24px;
    height: 24px;
    border-radius: 8px;
  }

  .placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #a8a29e;
    font-size: 14px;
  }

  .pill-copy,
  .runtime-copy {
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
  }

  .pill-subtitle,
  .runtime-meta {
    font-size: 11px;
    color: #a8a29e;
  }

  .runtime-name {
    font-weight: 600;
  }

  .pill-arrow {
    color: #a8a29e;
    font-size: 12px;
    flex-shrink: 0;
  }

  .switcher-menu {
    padding: 8px;
  }

  .runtime-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .runtime-group {
    border: 1px solid #292524;
    border-radius: 14px;
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
    gap: 8px;
    padding: 8px;
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
    gap: 10px;
    width: 100%;
    padding: 10px;
    border-radius: 12px;
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
    padding: 4px 8px;
    border-radius: 999px;
    font-size: 10px;
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
    width: 36px;
    border-radius: 12px;
    background: rgba(239, 68, 68, 0.08);
    color: rgba(248, 113, 113, 0.92);
    font-size: 22px;
    line-height: 1;
  }

  .derived-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px 8px 52px;
  }

  .entity-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border-radius: 10px;
    background: transparent;
    color: #d6d3d1;
    text-align: left;
  }

  .menu-footer {
    padding-top: 10px;
  }

  .add-runtime-btn {
    width: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(251, 191, 36, 0.12);
    color: #fde68a;
    font-weight: 600;
  }

  @media (max-width: 900px) {
    .context-switcher,
    .context-switcher :global(.dropdown-trigger) {
      max-width: 100%;
      width: 100%;
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
