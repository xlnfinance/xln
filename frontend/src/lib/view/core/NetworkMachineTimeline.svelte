<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Pause, Play, RefreshCw, SkipBack, SkipForward } from 'lucide-svelte';
  import { appState, appStateOperations } from '$lib/stores/appStateStore';
  import { networkMachineConfig, networkMachineOperations } from '$lib/stores/networkMachineStore';
  import {
    networkMachineRuntime,
    networkMachineRuntimeOperations,
  } from '$lib/stores/networkMachineRuntimeStore';
  import type { NetworkMachineTimelineMode } from '$lib/network3d/networkMachine';

  let playing = false;
  let playbackInterval: number | null = null;
  let speed = 1;
  let localError = '';

  $: steps = $networkMachineRuntime.machine?.steps ?? [];
  $: selectedIndex = $networkMachineRuntime.selectedStepIndex;
  $: selected = $networkMachineRuntime.selectedStep;
  $: progress = steps.length > 1 && selectedIndex >= 0 ? (selectedIndex / (steps.length - 1)) * 100 : 0;

  const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || 'NetworkMachine failed');

  async function refresh(): Promise<void> {
    localError = '';
    try {
      networkMachineOperations.load();
      await networkMachineRuntimeOperations.refresh();
    } catch (error) {
      localError = errorMessage(error);
    }
  }

  async function selectStep(index: number): Promise<void> {
    localError = '';
    try {
      await networkMachineRuntimeOperations.selectStep(index);
    } catch (error) {
      localError = errorMessage(error);
      stopPlayback();
    }
  }

  function goLive(): void {
    stopPlayback();
    networkMachineRuntimeOperations.goLive();
  }

  function stopPlayback(): void {
    playing = false;
    if (playbackInterval === null) return;
    window.clearInterval(playbackInterval);
    playbackInterval = null;
  }

  function togglePlayback(): void {
    if (playing) {
      stopPlayback();
      return;
    }
    if (steps.length === 0) return;
    playing = true;
    if (selectedIndex < 0 || selectedIndex >= steps.length - 1) void selectStep(0);
    playbackInterval = window.setInterval(() => {
      if ($networkMachineRuntime.loading) return;
      const current = $networkMachineRuntime.selectedStepIndex;
      if (current >= steps.length - 1) {
        stopPlayback();
        return;
      }
      void selectStep(Math.max(0, current + 1));
    }, 1_000 / speed);
  }

  function updateTimelineMode(mode: NetworkMachineTimelineMode): void {
    stopPlayback();
    networkMachineOperations.setTimelineMode(mode);
    networkMachineRuntimeOperations.goLive();
    networkMachineRuntimeOperations.recompile();
  }

  function updateSpeed(event: Event): void {
    speed = Number((event.currentTarget as HTMLSelectElement).value);
    if (playing) {
      stopPlayback();
      togglePlayback();
    }
  }

  onMount(() => { void refresh(); });
  onDestroy(() => {
    stopPlayback();
    networkMachineRuntimeOperations.dispose();
  });
</script>

<div class="network-machine" data-testid="network-machine-timeline">
  <div class="navigation">
    <button title="First network frame" disabled={steps.length === 0 || $networkMachineRuntime.loading} on:click={() => void selectStep(0)}><SkipBack size={13} /></button>
    <button class="play" title="Play NetworkMachine" disabled={steps.length === 0} on:click={togglePlayback}>{#if playing}<Pause size={15} />{:else}<Play size={15} />{/if}</button>
    <button title="Live network" on:click={goLive}><SkipForward size={13} /></button>
  </div>

  <div class="identity">
    <strong>{$networkMachineConfig.title}</strong>
    <span data-testid="network-machine-frame-badge">{selected ? `${selectedIndex + 1}/${steps.length}` : `LIVE/${steps.length}`}</span>
  </div>

  <input
    data-testid="network-machine-scrubber"
    type="range"
    min="0"
    max={Math.max(0, steps.length - 1)}
    value={Math.max(0, selectedIndex)}
    disabled={steps.length === 0 || $networkMachineRuntime.loading}
    style={`--xln-slider-progress:${progress}%`}
    on:input={(event) => void selectStep(Number(event.currentTarget.value))}
  />

  {#if selected}
    <div class="event" data-testid="network-machine-selected-event" style={`--runtime-color:${selected.activeRuntimeColor}`}>
      <span class="dot"></span><strong>{selected.activeRuntimeId}</strong><span>h{selected.event.height}</span><time>{new Date(selected.event.timestamp).toISOString()}</time>
    </div>
  {/if}

  {#if selected?.cues.length}
    <div class="cue" data-testid="network-machine-cue">
      <strong>{selected.cues[0]?.title}</strong>
      {#if selected.cues[0]?.subtitle}<span>{selected.cues[0]?.subtitle}</span>{/if}
    </div>
  {/if}

  <select aria-label="NetworkMachine timeline density" value={$networkMachineConfig.timelineMode} on:change={(event) => updateTimelineMode(event.currentTarget.value as NetworkMachineTimelineMode)}>
    <option value="all-frames">All R-frames</option>
    <option value="graph-changes">Graph changes</option>
  </select>
  <select aria-label="NetworkMachine playback speed" value={speed} on:change={updateSpeed}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option></select>
  <button class="refresh" data-testid="network-machine-refresh" title="Reload runtime indexes" disabled={$networkMachineRuntime.loading} on:click={() => void refresh()}><RefreshCw size={13} /></button>
  <button class="dock" data-testid="network-machine-mode-toggle" on:click={() => appStateOperations.setMode($appState.mode === 'dev' ? 'user' : 'dev')}>{$appState.mode === 'dev' ? 'User' : 'Dock'}</button>
</div>
{#if localError || $networkMachineRuntime.error}<div class="network-error" role="alert">{localError || $networkMachineRuntime.error}</div>{/if}

<style>
  .network-machine{height:48px;box-sizing:border-box;display:flex;align-items:center;gap:9px;padding:7px 10px;background:#101317;color:#dce7ee;border-top:1px solid rgba(255,255,255,.08);font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}.navigation{display:flex;gap:2px}.navigation button,.refresh,.dock{display:grid;place-items:center;min-width:27px;height:27px;border:1px solid #293b47;border-radius:5px;background:#15212a;color:#cde7f6}.navigation .play{border-color:#236b8c;color:#5ed0ff}.identity{display:grid;gap:2px;min-width:120px}.identity strong{font-size:11px}.identity span{color:#62d88f}input[type=range]{min-width:120px;flex:1;accent-color:#51d889}.event{display:flex;align-items:center;gap:6px;white-space:nowrap}.event strong{color:var(--runtime-color)}.event time{color:#738897}.dot{width:7px;height:7px;border-radius:50%;background:var(--runtime-color);box-shadow:0 0 9px var(--runtime-color)}.cue{display:grid;max-width:250px;overflow:hidden}.cue strong,.cue span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cue span{color:#879aa7}select{height:27px;border:1px solid #293b47;border-radius:5px;background:#101b23;color:#c7d9e4;font:inherit}.dock{padding:0 9px;color:#d2b8ff;border-color:#5c3f7a}.network-error{position:absolute;left:10px;right:10px;bottom:52px;z-index:40;padding:7px 9px;border:1px solid #713140;background:#230e14;color:#ff9aae;font:11px/1.3 ui-monospace,monospace}
  @media(max-width:900px){.cue,.event time,.identity strong{display:none}.identity{min-width:auto}}
</style>
