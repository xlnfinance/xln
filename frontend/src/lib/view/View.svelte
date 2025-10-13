<script lang="ts">
  /**
   * View - Main embeddable workspace
   * Single source for XLN dashboard (4 panels: Graph3D, Entities, Depository, Architect)
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import { onMount } from 'svelte';
  import { DockviewComponent } from 'dockview';
  import Graph3DPanel from './panels/Graph3DPanel.svelte';
  import EntitiesPanel from './panels/EntitiesPanel.svelte';
  import DepositoryPanel from './panels/DepositoryPanel.svelte';
  import ArchitectPanel from './panels/ArchitectPanel.svelte';
  import 'dockview/dist/styles/dockview.css';

  export let layout: string = 'default';
  export let networkMode: 'simnet' | 'testnet' | 'mainnet' = 'simnet';

  let container: HTMLDivElement;
  let dockview: DockviewComponent;

  onMount(() => {
    // Create Dockview
    dockview = new DockviewComponent(container, {
      className: 'dockview-theme-dark',
      createComponent: (options) => {
        const div = document.createElement('div');
        div.style.width = '100%';
        div.style.height = '100%';

        // Mount Svelte component
        if (options.name === 'graph3d') {
          new Graph3DPanel({ target: div });
        } else if (options.name === 'entities') {
          new EntitiesPanel({ target: div });
        } else if (options.name === 'depository') {
          new DepositoryPanel({ target: div });
        } else if (options.name === 'architect') {
          new ArchitectPanel({ target: div });
        }

        return { element: div };
      },
    });

    // Default 4-panel layout
    const graph3d = dockview.addPanel({
      id: 'graph3d',
      component: 'graph3d',
      title: '🌐 Graph3D',
    });

    const entities = dockview.addPanel({
      id: 'entities',
      component: 'entities',
      title: '🏢 Entities',
      position: { direction: 'right', referencePanel: 'graph3d' },
    });

    const depository = dockview.addPanel({
      id: 'depository',
      component: 'depository',
      title: '💰 Depository',
      position: { direction: 'below', referencePanel: 'entities' },
    });

    const architect = dockview.addPanel({
      id: 'architect',
      component: 'architect',
      title: '🎬 Architect',
      position: { direction: 'within', referencePanel: 'depository' },
    });
  });
</script>

<div class="view-container" bind:this={container}></div>

<style>
  .view-container {
    width: 100%;
    height: 100vh;
    background: #1e1e1e;
  }

  :global(.dockview-theme-dark .dockview-tab) {
    background: #2d2d30;
    color: #ccc;
  }

  :global(.dockview-theme-dark .dockview-tab.active) {
    background: #1e1e1e;
    color: #fff;
  }

  :global(.dockview-theme-dark .dockview-separator) {
    background: #007acc;
  }
</style>
