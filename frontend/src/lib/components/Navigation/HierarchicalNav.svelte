<script lang="ts">
  import Breadcrumb from './Breadcrumb.svelte';
  import { appState, appStateOperations } from '$lib/stores/appStateStore';
  import { runtimes, activeRuntimeId } from '$lib/stores/runtimeStore';
  import { activeVault, activeSigner, allVaults } from '$lib/stores/vaultStore';

  // Compute items for each level based on current selection

  // Runtime items
  $: runtimeItems = Array.from($runtimes.values()).map(runtime => ({
    id: runtime.id,
    label: runtime.label,
    count: runtime.env?.eReplicas?.size || 0
  }));

  // Jurisdiction items (from active runtime)
  $: jurisdictionItems = (() => {
    if (!$appState.navigation.runtime) return [];
    const runtime = $runtimes.get($appState.navigation.runtime);
    if (!runtime?.env?.jReplicas) return [];

    return Array.from(runtime.env.jReplicas.keys()).map(jName => ({
      id: jName,
      label: jName,
      count: 0 // Could show entity count per jurisdiction
    }));
  })();

  // Signer items (from active vault)
  $: signerItems = (() => {
    if (!$activeVault) return [];
    return $activeVault.signers.map(signer => ({
      id: signer.address,
      label: signer.name
    }));
  })();

  // Entity items (from active runtime, filtered by signer if selected)
  $: entityItems = (() => {
    if (!$appState.navigation.runtime) return [];
    const runtime = $runtimes.get($appState.navigation.runtime);
    if (!runtime?.env?.eReplicas) return [];

    const entities: Array<{id: string, label: string, count?: number}> = [];
    for (const [replicaKey, replica] of runtime.env.eReplicas.entries()) {
      // Extract entity ID from replica key (format: "entityId:signerId")
      const [entityId] = replicaKey.split(':');
      if (!entityId) continue;

      // Filter by selected signer
      if ($appState.navigation.signer && !replicaKey.includes($appState.navigation.signer)) {
        continue;
      }

      // Count accounts for this entity
      const accountCount = (replica as any).state?.accounts?.size || 0;

      entities.push({
        id: entityId,
        label: `E${entityId.slice(0, 6)}`,
        count: accountCount
      });
    }

    return entities;
  })();

  // Account items (from selected entity)
  $: accountItems = (() => {
    if (!$appState.navigation.runtime || !$appState.navigation.entity) return [];
    const runtime = $runtimes.get($appState.navigation.runtime);
    if (!runtime?.env?.eReplicas) return [];

    // Find replica for this entity
    let targetReplica: any = null;
    for (const [replicaKey, replica] of runtime.env.eReplicas.entries()) {
      if (replicaKey.startsWith($appState.navigation.entity + ':')) {
        targetReplica = replica;
        break;
      }
    }

    if (!targetReplica?.state?.accounts) return [];

    const accounts: Array<{id: string, label: string}> = [];
    for (const [accountKey] of targetReplica.state.accounts) {
      accounts.push({
        id: accountKey,
        label: `A${accountKey.slice(0, 8)}`
      });
    }

    return accounts;
  })();

  // Handlers
  function handleRuntimeSelect(id: string) {
    appStateOperations.navigate('runtime', id);
    // Also update activeRuntimeId for time machine
    activeRuntimeId.set(id);
  }

  function handleJurisdictionSelect(id: string) {
    appStateOperations.navigate('jurisdiction', id);
  }

  function handleSignerSelect(id: string) {
    appStateOperations.navigate('signer', id);
  }

  function handleEntitySelect(id: string) {
    appStateOperations.navigate('entity', id);
  }

  function handleAccountSelect(id: string) {
    appStateOperations.navigate('account', id);
  }

  // Auto-select signer when vault becomes active
  $: if ($activeSigner && !$appState.navigation.signer) {
    console.log('[HierarchicalNav] Auto-selecting signer:', $activeSigner.address.slice(0, 10));
    appStateOperations.navigate('signer', $activeSigner.address);
  }

  // Auto-select entity when signer has one
  $: if ($activeSigner?.entityId && !$appState.navigation.entity) {
    console.log('[HierarchicalNav] Auto-selecting entity:', $activeSigner.entityId.slice(0, 10));
    appStateOperations.navigate('entity', $activeSigner.entityId);
  }

  // New actions
  function createRuntime() {
    console.log('TODO: Create new runtime');
  }

  function createJurisdiction() {
    console.log('TODO: Create new jurisdiction');
  }

  function createEntity() {
    console.log('TODO: Create new entity');
  }
</script>

<nav class="hierarchical-nav">
  <Breadcrumb
    label="Runtime"
    items={runtimeItems}
    selected={$appState.navigation.runtime}
    onSelect={handleRuntimeSelect}
    onNew={createRuntime}
  />

  <Breadcrumb
    label="Jurisdiction"
    items={jurisdictionItems}
    selected={$appState.navigation.jurisdiction}
    onSelect={handleJurisdictionSelect}
    onNew={createJurisdiction}
    disabled={!$appState.navigation.runtime || jurisdictionItems.length === 0}
  />

  <Breadcrumb
    label="Signer"
    items={signerItems}
    selected={$appState.navigation.signer}
    onSelect={handleSignerSelect}
    onNew={null}
    disabled={signerItems.length === 0}
  />

  <Breadcrumb
    label="Entity"
    items={entityItems}
    selected={$appState.navigation.entity}
    onSelect={handleEntitySelect}
    onNew={createEntity}
    disabled={!$appState.navigation.runtime || entityItems.length === 0}
  />

  <Breadcrumb
    label="Account"
    items={accountItems}
    selected={$appState.navigation.account}
    onSelect={handleAccountSelect}
    onNew={null}
    disabled={!$appState.navigation.entity || accountItems.length === 0}
  />
</nav>

<style>
  .hierarchical-nav {
    display: flex;
    gap: 8px;
    padding: 8px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    height: 48px;
    align-items: center;
    overflow-x: auto;
  }

  @media (max-width: 768px) {
    .hierarchical-nav {
      flex-wrap: wrap;
      height: auto;
      gap: 6px;
      padding: 6px;
    }
  }
</style>
