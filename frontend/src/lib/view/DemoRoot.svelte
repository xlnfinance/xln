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
  import TimeMachine from './core/TimeMachine.svelte';

  export let runtimeFrameEnv: Writable<RuntimeState | null>;
  export let runtimeFrameHistory: Writable<EnvSnapshot[]>;
  export let runtimeFrameTimeIndex: Writable<number>;
  export let runtimeFrameIsLive: Writable<boolean>;

  const graphInitSignal = writable<boolean>(true);
</script>

<div class="demo-root">
  <div class="demo-stage">
    <Graph3DPanel
      {runtimeFrameEnv}
      {runtimeFrameHistory}
      {runtimeFrameTimeIndex}
      {runtimeFrameIsLive}
      {graphInitSignal}
      demoMode
    />
  </div>
  <div class="demo-narration">
    <TimeMachine
      history={runtimeFrameHistory}
      timeIndex={runtimeFrameTimeIndex}
      isLive={runtimeFrameIsLive}
      env={runtimeFrameEnv}
      dockMode
      demoMode
    />
  </div>
</div>

<style>
  .demo-root {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100dvh;
    background: #000;
    color: var(--theme-text-primary, #e4e4e7);
  }

  .demo-stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .demo-narration {
    flex: 0 0 auto;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
</style>
