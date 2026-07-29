<script lang="ts">
  /**
   * Demo playback surface: the network and its narration, nothing else.
   *
   * A demo is not a workspace, so it does not pay for the workspace's layout engine. Dockview
   * sizes itself from its container at construction; inside an embed (hidden tab, offscreen
   * iframe, mount race) that box can still be zero, and every panel then collapses to its
   * minimum with no resize event to recover from. A single full-bleed panel has no such
   * failure mode.
   */

  import { writable, type Writable } from 'svelte/store';
  import type { RuntimeState } from '@xln/runtime/xln-api';
  import type { EnvSnapshot } from '$types';
  import Graph3DPanel from './panels/Graph3DPanel.svelte';
  import NetworkStage2D from './core/NetworkStage2D.svelte';
  import NetworkPlayer from './core/NetworkPlayer.svelte';
  import { networkMachineDemo } from '$lib/stores/networkMachineDemoStore';

  export let runtimeFrameEnv: Writable<RuntimeState | null>;
  export let runtimeFrameHistory: Writable<EnvSnapshot[]>;
  export let runtimeFrameTimeIndex: Writable<number>;
  export let runtimeFrameIsLive: Writable<boolean>;

  const graphInitSignal = writable<boolean>(true);
</script>

<div class="demo-root">
  {#if $networkMachineDemo.stage === '2d'}
    <NetworkStage2D />
  {:else}
    <Graph3DPanel
      {runtimeFrameEnv}
      {runtimeFrameHistory}
      {runtimeFrameTimeIndex}
      {runtimeFrameIsLive}
      {graphInitSignal}
      demoMode
    />
  {/if}
  <NetworkPlayer />
</div>

<style>
  /*
   * The scene fills the frame and the player draws on top of it. A chrome strip below the
   * graph would take its height from the only thing worth looking at.
   */
  .demo-root {
    position: relative;
    width: 100%;
    height: 100dvh;
    background: #08090b;
    color: var(--theme-text-primary, #e4e4e7);
    overflow: hidden;
  }
</style>
