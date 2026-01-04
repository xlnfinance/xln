<script lang="ts">
  import Breadcrumb from './Breadcrumb.svelte';
  import { navSelection, navigationOperations } from '$lib/stores/navigationStore';
  import { runtimes, activeRuntimeId } from '$lib/stores/runtimeStore';
  import { activeVault, allVaults } from '$lib/stores/vaultStore';

  // Compute items for each level based on current selection

  // Runtime items
  $: runtimeItems = Array.from($runtimes.values()).map(runtime => ({
    id: runtime.id,
    label: runtime.label,
    count: runtime.env?.eReplicas?.size || 0
  }));

  // Jurisdiction items (from active runtime)
  $: jurisdictionItems = (() => {
    if (!$navSelection.runtime) return [];
    const runtime = $runtimes.get($navSelection.runtime);
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
    if (!$navSelection.runtime) return [];
    const runtime = $runtimes.get($navSelection.runtime);
    if (!runtime?.env?.eReplicas) return [];

    const entities: Array<{id: string, label: string, count?: number}> = [];
    for (const [replicaKey, replica] of runtime.env.eReplicas.entries()) {
      // Extract entity ID from replica key (format: "entityId:signerId")
      const [entityId] = replicaKey.split(':');
      if (!entityId) continue;

      // Filter by selected signer
      if ($navSelection.signer && !replicaKey.includes($navSelection.signer)) {
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
    if (!$navSelection.runtime || !$navSelection.entity) return [];
    const runtime = $runtimes.get($navSelection.runtime);
    if (!runtime?.env?.eReplicas) return [];

    // Find replica for this entity
    let targetReplica: any = null;
    for (const [replicaKey, replica] of runtime.env.eReplicas.entries()) {
      if (replicaKey.startsWith($navSelection.entity + ':')) {
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
    navigationOperations.navigate('runtime', id);
    // Also update activeRuntimeId for time machine
    activeRuntimeId.set(id);
  }

  function handleJurisdictionSelect(id: string) {
    navigationOperations.navigate('jurisdiction', id);
  }

  function handleSignerSelect(id: string) {
    navigationOperations.navigate('signer', id);
  }

  function handleEntitySelect(id: string) {
    navigationOperations.navigate('entity', id);
  }

  function handleAccountSelect(id: string) {
    navigationOperations.navigate('account', id);
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
    selected={$navSelection.runtime}
    onSelect={handleRuntimeSelect}
    onNew={createRuntime}
  />

  <Breadcrumb
    label="Jurisdiction"
    items={jurisdictionItems}
    selected={$navSelection.jurisdiction}
    onSelect={handleJurisdictionSelect}
    onNew={createJurisdiction}
    disabled={!$navSelection.runtime || jurisdictionItems.length === 0}
  />

  <Breadcrumb
    label="Signer"
    items={signerItems}
    selected={$navSelection.signer}
    onSelect={handleSignerSelect}
    onNew={null}
    disabled={signerItems.length === 0}
  />

  <Breadcrumb
    label="Entity"
    items={entityItems}
    selected={$navSelection.entity}
    onSelect={handleEntitySelect}
    onNew={createEntity}
    disabled={!$navSelection.runtime || entityItems.length === 0}
  />

  <Breadcrumb
    label="Account"
    items={accountItems}
    selected={$navSelection.account}
    onSelect={handleAccountSelect}
    onNew={null}
    disabled={!$navSelection.entity || accountItems.length === 0}
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
