<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { Env, EnvSnapshot } from '@xln/runtime/xln-api';
  import EntityMiniPanel from './EntityMiniPanel.svelte';
  import Graph3DFpsOverlay from './Graph3DFpsOverlay.svelte';
  import VRControlsHUD from './VRControlsHUD.svelte';

  export let container: HTMLDivElement;
  export let showMiniPanel = false;
  export let miniPanelEntityId = '';
  export let miniPanelEntityName = '';
  export let miniPanelPosition: { x: number; y: number } = { x: 0, y: 0 };
  export let runtimeFrameEnv: Writable<Env | null>;
  export let runtimeFrameHistory: Writable<EnvSnapshot[]>;
  export let runtimeFrameTimeIndex: Writable<number>;
  export let showFpsOverlay = false;
  export let renderFps = 0;
  export let frameTime = 0;
  export let entityCount = 0;
  export let connectionCount = 0;
  export let particleCount = 0;
  export let barsMode: 'close' | 'spread' = 'close';
  export let isVRActive = false;
  export let closeMiniPanel: () => void = () => {};
  export let handleMiniPanelAction: (event: CustomEvent) => void = () => {};
  export let handleOpenFullPanel: (event: CustomEvent) => void = () => {};
  export let toggleBarsMode: () => void = () => {};
  export let handleVrPaymentClick: () => void = () => {};
  export let handleVrAutoRotateClick: () => void = () => {};
  export let exitVR: () => void = () => {};
</script>

<div class="graph3d-wrapper">
  <div bind:this={container} class="graph3d-panel"></div>

  {#if showMiniPanel}
    <EntityMiniPanel
      entityId={miniPanelEntityId}
      entityName={miniPanelEntityName}
      position={miniPanelPosition}
      {runtimeFrameEnv}
      {runtimeFrameHistory}
      {runtimeFrameTimeIndex}
      on:close={closeMiniPanel}
      on:action={handleMiniPanelAction}
      on:openFull={handleOpenFullPanel}
    />
  {/if}

  {#if showFpsOverlay}
    <Graph3DFpsOverlay
      {renderFps}
      {frameTime}
      {entityCount}
      {connectionCount}
      {particleCount}
      {barsMode}
      onToggleBars={toggleBarsMode}
    />
  {/if}

  <VRControlsHUD
    {isVRActive}
    {entityCount}
    currentFPS={renderFps}
    onPaymentClick={handleVrPaymentClick}
    onAutoRotateClick={handleVrAutoRotateClick}
    onExitVR={exitVR}
  />
</div>

<style>
  .graph3d-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
    background: #000;
  }

  .graph3d-panel {
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
  }

  :global(.graph3d-panel canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
