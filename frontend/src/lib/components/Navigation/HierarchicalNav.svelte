<script lang="ts">
  import Breadcrumb from './Breadcrumb.svelte';
  import { appState, appStateOperations } from '$lib/stores/appStateStore';
  import { runtimes, runtimeOperations } from '$lib/stores/runtimeStore';
  import { activeRuntime, activeSigner } from '$lib/stores/vaultStore';
  import { runtimeView } from '$lib/stores/runtimeViewStore';
  import { buildHierarchicalNavigationView } from './runtime-navigation-view';

  $: navigationView = buildHierarchicalNavigationView($runtimes, $appState.navigation, $activeRuntime, $runtimeView);

  let runtimeSwitchError = '';

  // Handlers
  async function handleRuntimeSelect(id: string) {
    runtimeSwitchError = '';
    try {
      const switched = await runtimeOperations.selectRuntime(id);
      if (!switched) throw new Error(`Runtime switch rejected: ${id}`);
      appStateOperations.navigate('runtime', id);
    } catch (error) {
      runtimeSwitchError = error instanceof Error ? error.message : String(error || 'Runtime switch failed');
      console.error('[HierarchicalNav] Runtime switch failed:', error);
    }
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
    appStateOperations.navigate('signer', $activeSigner.address);
  }

  // Auto-select entity when signer has one
  $: if ($activeSigner?.entityId && !$appState.navigation.entity) {
    appStateOperations.navigate('entity', $activeSigner.entityId);
  }
</script>

<nav class="hierarchical-nav">
  <Breadcrumb
    label="Runtime"
    items={navigationView.runtimeItems}
    selected={$appState.navigation.runtime}
    onSelect={handleRuntimeSelect}
    onNew={null}
  />
  {#if runtimeSwitchError}
    <span class="nav-error" role="alert">{runtimeSwitchError}</span>
  {/if}

  <Breadcrumb
    label="Jurisdiction"
    items={navigationView.jurisdictionItems}
    selected={$appState.navigation.jurisdiction}
    onSelect={handleJurisdictionSelect}
    onNew={null}
    disabled={!$appState.navigation.runtime || navigationView.jurisdictionItems.length === 0}
  />

  <Breadcrumb
    label="Signer"
    items={navigationView.signerItems}
    selected={$appState.navigation.signer}
    onSelect={handleSignerSelect}
    onNew={null}
    disabled={navigationView.signerItems.length === 0}
  />

  <Breadcrumb
    label="Entity"
    items={navigationView.entityItems}
    selected={$appState.navigation.entity}
    onSelect={handleEntitySelect}
    onNew={null}
    disabled={!$appState.navigation.runtime || navigationView.entityItems.length === 0}
  />

  <Breadcrumb
    label="Account"
    items={navigationView.accountItems}
    selected={$appState.navigation.account}
    onSelect={handleAccountSelect}
    onNew={null}
    disabled={!$appState.navigation.entity || navigationView.accountItems.length === 0}
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

  .nav-error {
    color: #ff6b6b;
    font-size: 12px;
    font-family: 'SF Mono', monospace;
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
