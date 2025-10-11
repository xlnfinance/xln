<script lang="ts">
  /**
   * XLNView - Main panel workspace orchestrator
   * Bloomberg Terminal-style interface with Dockview
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount } from 'svelte';
  import { DockviewComponent } from 'dockview';
  import Graph3DPanel from './panels/Graph3DPanel.svelte';
  import DepositoryPanel from './panels/DepositoryPanel.svelte';
  import { layoutManager } from './utils/layoutManager';
  import 'dockview/dist/styles/dockview.css';

  export let layout: string = 'default';
  export let networkMode: 'simnet' | 'testnet' | 'mainnet' = 'simnet';

  let container: HTMLDivElement;
  let dockview: DockviewComponent;

  // Mock data (in production, comes from xlnStore)
  const mockEntities = [
    { id: '0x01', name: 'Entity 1', position: { x: 0, y: 0, z: 0 } },
    { id: '0x02', name: 'Entity 2', position: { x: 10, y: 0, z: 0 } },
    { id: '0x03', name: 'Entity 3', position: { x: 0, y: 10, z: 0 } },
  ];

  onMount(async () => {
    // Initialize Dockview
    dockview = new DockviewComponent(container, {
      watermarkFrameComponent: 'none',
      createComponent: (options) => {
        const div = document.createElement('div');
        div.style.width = '100%';
        div.style.height = '100%';
        div.style.overflow = 'hidden';

        // Mount Svelte component based on panel type
        if (options.name === 'graph3d') {
          new Graph3DPanel({
            target: div,
            props: {
              entities: mockEntities,
              accounts: [],
              layoutMode: 'force',
              rendererMode: 'webgl',
            },
          });
        } else if (options.name === 'depository') {
          new DepositoryPanel({
            target: div,
          });
        }

        return {
          element: div,
        };
      },
    });

    // Load layout
    const layoutConfig = await layoutManager.loadLayout(layout);
    if (layoutConfig) {
      // For now, manually create default layout
      createDefaultLayout();
    }
  });

  function createDefaultLayout() {
    // Left: Graph3D (60% width)
    const graph3dPanel = dockview.addPanel({
      id: 'graph3d',
      component: 'graph3d',
      title: '🌐 Graph3D',
    });

    // Right: Depository (40% width)
    const depositoryPanel = dockview.addPanel({
      id: 'depository',
      component: 'depository',
      title: '💰 Depository',
      position: { direction: 'right', referencePanel: 'graph3d' },
    });
  }
</script>

<div class="xlnview" bind:this={container}></div>

<style>
  .xlnview {
    width: 100vw;
    height: 100vh;
    background: #1e1e1e;
  }

  :global(.dockview-theme-dark) {
    --dockview-tab-background: #2d2d30;
    --dockview-activeTab-background: #1e1e1e;
    --dockview-separator-border: #007acc;
  }
</style>
