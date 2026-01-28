<script lang="ts">
  /**
   * UserMode - Simple single-entity view for consumer users
   *
   * Shows only the active signer's entity panel without network graph complexity.
   * Clean, focused interface for send/receive/balance operations.
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount } from 'svelte';
  import { writable } from 'svelte/store';
  import { activeSigner } from '$lib/stores/vaultStore';
  import EntityPanelTabs from '$lib/components/Entity/EntityPanelTabs.svelte';
  import { setEntityEnvContext, type HistoryFrame } from './components/entity/shared/EntityEnvContext';
  import type { Tab } from '$lib/types/ui';
  import './utils/frontendLogger'; // Initialize global log control

  // Props (Svelte 5 runes syntax)
  let {
    embedMode = false,
    scenarioId = ''
  }: {
    embedMode?: boolean;
    scenarioId?: string;
  } = $props();

  // Isolated XLN environment for user mode (same pattern as View.svelte)
  const localEnvStore = writable<any>(null);
  const localHistoryStore = writable<any[]>([]);
  const localTimeIndex = writable<number>(-1);
  const localIsLive = writable<boolean>(true);

  // Set context for EntityPanel
  setEntityEnvContext({
    isolatedEnv: localEnvStore,
    isolatedHistory: localHistoryStore,
    isolatedTimeIndex: localTimeIndex,
    isolatedIsLive: localIsLive,
  });

  // Entity state
  let myEntityId = $state<string | null>(null);
  let myEntityName = $state<string>('');
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Create tab for EntityPanel
  let localTab: Tab = $state({
    id: 'user-entity',
    title: 'My Wallet',
    entityId: '',
    signerId: '',
    jurisdiction: 'browservm',
    isActive: true,
  });

  onMount(async () => {
    try {
      // Initialize isolated XLN runtime (same as View.svelte)
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Create BrowserVM
      const { BrowserEVM } = XLN;
      const browserVM = new BrowserEVM();
      await browserVM.init();
      console.log('[UserMode] BrowserVM initialized');

      const depositoryAddress = browserVM.getDepositoryAddress();
      XLN.setBrowserVMJurisdiction(depositoryAddress, browserVM);

      // Expose for debugging
      (window as any).__xlnBrowserVM = browserVM;

      // Initialize xlnInstance for utility functions
      const { xlnInstance } = await import('$lib/stores/xlnStore');
      xlnInstance.set(XLN);

      // Create empty environment
      let env = XLN.createEmptyEnv();

      // Initialize with empty frame 0
      env.history = [{
        height: 0,
        timestamp: Date.now(),
        eReplicas: new Map(),
        runtimeInput: { runtimeTxs: [], entityInputs: [] },
        runtimeOutputs: [],
        description: 'Frame 0: Empty slate',
        title: 'Initial State'
      }];

      // Set to isolated stores
      localEnvStore.set(env);
      localHistoryStore.set(env.history || []);
      localTimeIndex.set(-1); // LIVE mode
      localIsLive.set(true);

      // Find entity for active signer
      const signer = $activeSigner;
      if (signer && signer.entityId) {
        // Check if entity exists in runtime
        const entityReplica = env.eReplicas?.get(signer.entityId);
        if (entityReplica) {
          myEntityId = signer.entityId;
          myEntityName = signer.name || 'My Entity';

          // Update tab with entity info
          localTab = {
            id: 'user-entity',
            title: myEntityName,
            entityId: myEntityId,
            signerId: signer.address,
            jurisdiction: 'browservm',
            isActive: true,
          };

          console.log('[UserMode] Found entity:', myEntityId.slice(0, 10));
        } else {
          error = 'Entity not found. Create an entity in Dev mode first.';
          console.log('[UserMode] Entity not found for signer:', signer.address);
        }
      } else {
        error = 'No active signer. Create a wallet in /vault first.';
        console.log('[UserMode] No active signer');
      }

      loading = false;
    } catch (err) {
      console.error('[UserMode] Failed to initialize:', err);
      error = 'Failed to initialize runtime: ' + (err as Error).message;
      loading = false;
    }
  });
</script>

<div class="user-mode">
  {#if loading}
    <div class="loading">
      <div class="spinner"></div>
      <p>Loading your wallet...</p>
    </div>
  {:else if error}
    <div class="error">
      <h2>Setup Required</h2>
      <p>{error}</p>
      <div class="error-actions">
        <a href="/vault" class="btn">Create Wallet</a>
        <button class="btn btn-secondary" onclick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  {:else if myEntityId}
    <!-- Show EntityPanelTabs for user's entity -->
    <div class="entity-container">
      <EntityPanelTabs tab={localTab} isLast={true} />
    </div>
  {:else}
    <div class="empty">
      <h2>No Entity Found</h2>
      <p>Switch to Dev mode to create your first entity.</p>
    </div>
  {/if}
</div>

<style>
  .user-mode {
    width: 100%;
    height: 100vh;
    background: #0a0a0f;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .loading,
  .error,
  .empty {
    text-align: center;
    color: rgba(255, 255, 255, 0.9);
    max-width: 500px;
    padding: 2rem;
  }

  .loading .spinner {
    width: 48px;
    height: 48px;
    border: 4px solid rgba(168, 85, 247, 0.2);
    border-top-color: rgba(168, 85, 247, 0.8);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 0 auto 1rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error h2,
  .empty h2 {
    font-size: 1.5rem;
    margin-bottom: 1rem;
    color: #fff;
  }

  .error p,
  .empty p {
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.6;
    margin-bottom: 1.5rem;
  }

  .error-actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
  }

  .btn {
    padding: 0.75rem 1.5rem;
    background: rgba(168, 85, 247, 0.2);
    border: 1px solid rgba(168, 85, 247, 0.4);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 0.9rem;
    font-family: 'SF Mono', monospace;
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;
    display: inline-block;
  }

  .btn:hover {
    background: rgba(168, 85, 247, 0.3);
    border-color: rgba(168, 85, 247, 0.6);
  }

  .btn-secondary {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .btn-secondary:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.3);
  }

  .entity-container {
    width: 100%;
    height: 100%;
    max-width: 1200px;
    margin: 0 auto;
    background: #1e1e1e;
    overflow: auto;
  }

  /* Override EntityPanel styles for fullscreen mode */
  .entity-container :global(.entity-panel) {
    border-right: none;
    min-width: unset;
    height: 100%;
  }
</style>
