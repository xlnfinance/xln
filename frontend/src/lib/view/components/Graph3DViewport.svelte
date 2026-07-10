<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { Env, EnvSnapshot } from '@xln/runtime/xln-api';
  import EntityMiniPanel from './EntityMiniPanel.svelte';
  import Graph3DFpsOverlay from './Graph3DFpsOverlay.svelte';
  import VRControlsHUD from './VRControlsHUD.svelte';
  import type { RuntimeGraphCanonicity } from '$lib/network3d/runtimeGraphProjection';

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
  export let runtimeScope = 'merged';
  export let runtimeScopeOptions: Array<{ value: string; label: string }> = [];
  export let canonicity: RuntimeGraphCanonicity = 'timestamp';
  export let sourceCount = 0;
  export let desyncCount = 0;
  export let timelineRuntimeId = '';
  export let timelineRuntimeColor = '';
  export let timelineHeight = 0;
  export let timelineTimestamp = 0;
  export let runtimeNodeLabels: string[] = [];
  export let onRuntimeScopeChange: (scope: string) => void = () => {};
  export let onCanonicityChange: (policy: RuntimeGraphCanonicity) => void = () => {};
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

  <div class="runtime-projection-controls" data-testid="graph-runtime-projection-controls">
    <label>
      <span>View</span>
      <select
        value={runtimeScope}
        aria-label="Graph runtime view"
        on:change={(event) => onRuntimeScopeChange(event.currentTarget.value)}
      >
        {#each runtimeScopeOptions as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Reference</span>
      <select
        value={canonicity}
        aria-label="Merged graph reference policy"
        on:change={(event) => onCanonicityChange(event.currentTarget.value as RuntimeGraphCanonicity)}
      >
        <option value="timestamp">Latest timestamp</option>
        <option value="height">Highest height</option>
        <option value="left">Left entity</option>
        <option value="right">Right entity</option>
        <option value="hub">Hub view</option>
      </select>
    </label>
    <span class="projection-status" title="Different runtime states are expected network desynchronization">
      {sourceCount} source{sourceCount === 1 ? '' : 's'} · {desyncCount} desync
    </span>
    <span class="sr-only" data-testid="graph-runtime-node-summary">{runtimeNodeLabels.join(' · ')}</span>
  </div>

  {#if timelineRuntimeId}
    <div
      class="timeline-runtime-highlight"
      data-testid="network-machine-runtime-highlight"
      style={`--runtime-color:${timelineRuntimeColor}`}
    >
      <span class="runtime-dot"></span>
      <strong>{timelineRuntimeId}</strong>
      <span>h{timelineHeight}</span>
      <time datetime={new Date(timelineTimestamp).toISOString()}>{new Date(timelineTimestamp).toISOString()}</time>
    </div>
  {/if}

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

  .runtime-projection-controls {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: 12;
    display: flex;
    align-items: end;
    gap: 8px;
    padding: 8px;
    border: 1px solid rgba(105, 210, 255, 0.22);
    border-radius: 8px;
    background: rgba(5, 10, 16, 0.88);
    color: #c9d7e5;
    font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    backdrop-filter: blur(10px);
  }

  .runtime-projection-controls label {
    display: grid;
    gap: 4px;
  }

  .runtime-projection-controls label > span {
    color: #6f8498;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .runtime-projection-controls select {
    min-width: 132px;
    border: 1px solid #23384a;
    border-radius: 5px;
    padding: 5px 24px 5px 7px;
    background: #09131d;
    color: #e2edf5;
    font: inherit;
  }

  .projection-status {
    padding: 6px 4px;
    color: #7da1ba;
    white-space: nowrap;
  }

  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }

  .timeline-runtime-highlight {
    position: absolute;
    left: 12px;
    top: 82px;
    z-index: 12;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 9px;
    border: 1px solid color-mix(in srgb, var(--runtime-color) 65%, transparent);
    border-radius: 7px;
    background: rgba(5, 10, 16, 0.88);
    color: #c9d7e5;
    font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .timeline-runtime-highlight strong { color: var(--runtime-color); }
  .timeline-runtime-highlight time { color: #738b9f; }
  .runtime-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--runtime-color); box-shadow: 0 0 12px var(--runtime-color); }

  :global(.graph3d-panel canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
