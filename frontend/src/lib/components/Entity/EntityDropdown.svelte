<script lang="ts">
  /**
   * EntityDropdown - Unified entity/signer selector
   * Declarative Svelte (no innerHTML), uses base Dropdown component
   */
  import { createEventDispatcher } from 'svelte';
  import { replicas, xlnFunctions, xlnInstance, xlnEnvironment } from '../../stores/xlnStore';
  import { visibleReplicas } from '../../stores/timeStore';
  import Dropdown from '$lib/components/UI/Dropdown.svelte';
  import type { EntityReplica, Tab } from '$lib/types/ui';
  import { resolveEntityName, scheduleGossipProfileFetch } from '$lib/utils/entityNaming';

  export let tab: Tab;
  export let jurisdictionFilter: string | null = null;
  export let selectedJurisdiction: string | null = null;
  export let allowAdd: boolean = false;
  export let allowAddJurisdiction: boolean = false;
  export let replicasOverride: Map<string, EntityReplica> | null = null;
  export let envOverride: { jReplicas?: unknown } | null = null;

  const dispatch = createEventDispatcher();

  let isOpen = false;
  let searchTerm = '';

  $: xlnReady = !!$xlnInstance;
  $: activeReplicas = replicasOverride || $visibleReplicas || $replicas;
  $: activeXlnFunctions = xlnReady ? $xlnFunctions : null;
  $: activeEnv = envOverride || $xlnEnvironment;

  // Build tree structure reactively (grouped by signer, not entity)
  interface SignerNode {
    signerId: string;
    address: string;
    avatarUrl: string;
    entities: EntityNode[];
  }

  interface EntityNode {
    entityId: string;
    name: string;
    shortId: string;
    avatarUrl: string;
    signerId: string;
  }

  interface JMachineNode {
    name: string;
  }

  $: jMachines = buildJMachines(activeEnv);
  $: signerTree = buildSignerTree(
    activeReplicas,
    activeXlnFunctions,
    searchTerm
  );

  function buildJMachines(env: { jReplicas?: unknown } | null | undefined): JMachineNode[] {
    const jReplicas = env?.jReplicas;
    if (!jReplicas) return [];

    const list = jReplicas instanceof Map
      ? Array.from(jReplicas.values())
      : Array.isArray(jReplicas)
        ? jReplicas
        : Object.values(jReplicas);

    return list
      .map((jr: { name?: string } | unknown) => ({ name: (jr as { name?: string })?.name }))
      .filter((jr: JMachineNode) => jr.name);
  }

  function buildSignerTree(
    replicas: Map<string, EntityReplica> | null | undefined,
    xlnFuncs: {
      generateEntityAvatar?: (entityId: string) => string;
      generateSignerAvatar?: (signerId: string) => string;
    } | null,
    search: string,
  ): SignerNode[] {
    if (!replicas) return [];

    const signerGroups = new Map<string, EntityReplica[]>();

    // Group by signerId
    for (const replica of replicas.values()) {
      const signerId = replica.signerId;
      if (!signerGroups.has(signerId)) {
        signerGroups.set(signerId, []);
      }
      signerGroups.get(signerId)!.push(replica);
    }

    const nodes: SignerNode[] = [];
    const searchLower = search.toLowerCase();

    for (const [signerId, entityReplicas] of signerGroups) {
      const entities: EntityNode[] = [];

      for (const replica of entityReplicas) {
        const entityId = replica.entityId;
        const name = getEntityName(replica);
        const shortId = entityId;
        const displayName = name || `Entity ${entityId}`;

        // Filter by search - match against entityId, signerId, or shortId
        if (search &&
            !entityId.toLowerCase().includes(searchLower) &&
            !signerId.toLowerCase().includes(searchLower)) {
          continue;
        }

        entities.push({
          entityId,
          name: displayName,
          shortId,
          avatarUrl: xlnFuncs.generateEntityAvatar?.(entityId) || '',
          signerId
        });
      }

      if (entities.length === 0) continue;

      nodes.push({
        signerId,
        address: signerId, // signerId IS the EOA address now
        avatarUrl: xlnFuncs.generateSignerAvatar?.(signerId) || '',
        entities
      });
    }

    return nodes;
  }

  function getEntityName(replica: EntityReplica): string {
    const name = resolveEntityName(replica?.entityId || '', activeEnv);
    return name || replica.state?.name || '';
  }

  // Current selection display
  $: displayText = getDisplayText(tab, activeReplicas, activeXlnFunctions);

  function getDisplayText(
    tab: Tab,
    replicas: Map<string, EntityReplica> | null | undefined,
    xlnFuncs: { formatEntityId?: (id: string) => string } | null,
  ): string {
    if (!tab.entityId || !replicas) return 'Select Entity';

    const replicaKey = `${tab.entityId}:${tab.signerId}`;
    const replica = replicas.get(replicaKey);
    const entityNum = tab.entityId;

    if (replica) {
      const name = getEntityName(replica);
      return name ? `${name} (${entityNum})` : `Entity ${entityNum}`;
    }
    return `Entity ${entityNum}`;
  }

  function selectSigner(signerId: string) {
    dispatch('signerSelect', { signerId });
    isOpen = false;
    searchTerm = '';
  }

  function selectEntity(signerId: string, entityId: string) {
    dispatch('entitySelect', {
      jurisdiction: 'browservm',
      signerId,
      entityId
    });
    isOpen = false;
    searchTerm = '';
  }

  function selectJurisdiction(name: string) {
    dispatch('jurisdictionSelect', { name });
    isOpen = false;
    searchTerm = '';
  }

  function handleAddEntity() {
    if (!allowAdd) return;
    dispatch('addEntity', { jurisdiction: jurisdictionFilter || selectedJurisdiction });
    isOpen = false;
    searchTerm = '';
  }

  function handleAddJurisdiction() {
    if (!allowAddJurisdiction) return;
    dispatch('addJurisdiction', {});
    isOpen = false;
    searchTerm = '';
  }

  function handleAddSigner() {
    dispatch('addSigner', {});
    isOpen = false;
    searchTerm = '';
  }

  $: canAddEntity = allowAdd && !!(jurisdictionFilter || selectedJurisdiction);
  $: canAddJurisdiction = allowAddJurisdiction && !!activeEnv;
  $: if (isOpen && activeReplicas) {
    scheduleGossipProfileFetch(Array.from(activeReplicas.values()).map((replica) => replica.entityId));
  }
</script>

<Dropdown bind:open={isOpen} minWidth={420} maxWidth={650}>
  <span slot="trigger" class="trigger-content">
    <span class="trigger-icon">🏛️</span>
    <span class="trigger-text">{displayText}</span>
    <span class="trigger-arrow" class:open={isOpen}>▼</span>
  </span>

  <div slot="menu" class="menu-content">
    <!-- Search -->
    <div class="search-box">
      <input
        type="text"
        placeholder="Search..."
        bind:value={searchTerm}
        on:click|stopPropagation
      />
    </div>

    <!-- EOA Wallet removed - External tokens now shown inside Entity panel -->

    <!-- Signer Tree (entities as children) -->
    <div class="entity-list">
      {#if signerTree.length === 0}
        <div class="empty-state">
          {#if searchTerm}
            <div class="empty-text">No matches for "{searchTerm}"</div>
          {:else}
            <div class="empty-icon">🏢</div>
            <div class="empty-text">No accounts yet</div>
            {#if canAddEntity}
              <div class="empty-hint">Click "+ Add Entity" below to create one</div>
            {/if}
          {/if}
        </div>
      {:else}
        {#each signerTree as signer (signer.signerId)}
          <div class="entity-group">
            <!-- Signer header (with identicon, truncated address) -->
            <div class="entity-header">
              {#if signer.avatarUrl}
                <img src={signer.avatarUrl} alt="" class="avatar" />
              {/if}
              <span class="entity-name" title={signer.address}>
                {signer.address.slice(0, 6)}...{signer.address.slice(-4)}
              </span>
            </div>

            <!-- Entities under this signer -->
            {#each signer.entities as entity, i (entity.entityId)}
              <button
                class="signer-item"
                class:last={i === signer.entities.length - 1}
                on:click={() => selectEntity(entity.signerId, entity.entityId)}
              >
                <span class="tree-branch">{i === signer.entities.length - 1 ? '└─' : '├─'}</span>
                {#if entity.avatarUrl}
                  <img src={entity.avatarUrl} alt="" class="avatar-sm" />
                {/if}
                <span class="signer-addr">{entity.name}</span>
              </button>
            {/each}
          </div>
        {/each}
      {/if}

      {#if canAddEntity}
        <button class="menu-item add-item" on:click={handleAddEntity}>
          <span class="menu-label">+ Add Entity</span>
        </button>
      {/if}
    </div>

    <!-- Add Signer (at bottom of entities) -->
    {#if signerTree.length > 0}
      <button class="menu-item add-item" on:click={handleAddSigner}>
        <span class="menu-label">+ Add Signer</span>
      </button>
    {/if}

    <!-- J-Machines section -->
    {#if jMachines.length > 0}
      <div class="menu-divider"></div>
      {#each jMachines as jm (jm.name)}
        <button
          class="menu-item jmachine-item"
          class:active={selectedJurisdiction === jm.name}
          on:click={() => selectJurisdiction(jm.name)}
        >
          <span class="menu-icon">🏛️</span>
          <span class="menu-label">{jm.name}</span>
        </button>
      {/each}
      {#if canAddJurisdiction}
        <button class="menu-item add-item" on:click={handleAddJurisdiction}>
          <span class="menu-label">+ Add J-Machine</span>
        </button>
      {/if}
    {/if}
  </div>
</Dropdown>

<style>
  .trigger-content {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .trigger-icon {
    font-size: 16px;
    flex-shrink: 0;
  }

  .trigger-text {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-arrow {
    color: #888;
    font-size: 10px;
    transition: transform 0.2s;
    flex-shrink: 0;
  }

  .trigger-arrow.open {
    transform: rotate(180deg);
  }

  /* Menu */
  .menu-content {
    display: flex;
    flex-direction: column;
  }

  .menu-section-label {
    padding: 6px 12px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #777;
  }

  .search-box {
    padding: 8px;
    border-bottom: 1px solid #333;
  }

  .search-box input {
    width: 100%;
    padding: 8px 12px;
    background: #252525;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e1e1e1;
    font-size: 13px;
  }

  .search-box input::placeholder {
    color: #666;
  }

  .search-box input:focus {
    outline: none;
    border-color: #007acc;
  }

  .entity-list {
    padding: 4px 0;
    max-height: 50vh;
    overflow-y: auto;
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE/Edge */
  }

  .entity-list::-webkit-scrollbar {
    display: none; /* Chrome/Safari/Opera */
  }

  .jmachine-list {
    padding: 4px 0;
  }

  .jmachine-item {
    justify-content: flex-start;
  }

  .jmachine-item.active {
    background: rgba(0, 122, 255, 0.18);
  }

  .menu-icon {
    font-size: 14px;
  }

  .empty-state {
    padding: 32px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
  }

  .empty-icon {
    font-size: 40px;
    opacity: 0.2;
  }

  .empty-text {
    color: rgba(255, 255, 255, 0.6);
    font-size: 14px;
    font-weight: 500;
  }

  .empty-hint {
    color: rgba(255, 255, 255, 0.35);
    font-size: 12px;
    max-width: 200px;
    line-height: 1.4;
  }

  .entity-group {
    padding: 4px 0;
  }

  .entity-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    color: #aaa;
    font-size: 13px;
    font-weight: 500;
  }

  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 4px;
  }

  .avatar-sm {
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }

  .entity-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .signer-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 12px 6px 20px;
    background: transparent;
    border: none;
    color: #ccc;
    font-size: 12px;
    font-family: 'SF Mono', Consolas, monospace;
    cursor: pointer;
    transition: background 0.1s;
    text-align: left;
  }

  .signer-item:hover {
    background: rgba(0, 122, 204, 0.15);
  }

  .tree-branch {
    color: #555;
    font-size: 11px;
    width: 20px;
  }

  .signer-addr {
    flex: 1;
  }

  .menu-divider {
    height: 1px;
    background: #333;
    margin: 4px 8px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    color: #e1e1e1;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
  }

  .menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .add-item {
    color: #7aa8ff;
  }

  .add-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }
</style>
