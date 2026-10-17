<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { networkMachineDemo, networkMachinePresentation } from '#lib/stores/network/networkMachineDemoStore.ts';
  import { Pause, Play, RefreshCw, SkipBack, SkipForward } from 'lucide-svelte';
  import { networkMachineConfig, networkMachineOperations } from '#lib/stores/network/networkMachineStore.ts';
  import {
    networkMachineRuntime,
    networkMachineRuntimeOperations,
  } from '#lib/stores/network/networkMachineRuntimeStore.ts';
  import type { NetworkMachineTimelineMode } from '#lib/network3d/networkMachine.ts';
  import { captionForStep } from '#lib/network3d/timeline/networkCaption.ts';
  import { xlnFunctions } from '#lib/stores/xlnStore.ts';
  import FrameSubtitle from '#lib/components/TimeMachine/FrameSubtitle.svelte';
  import PresentationNarration from './PresentationNarration.svelte';
  import DepositoryLedger from './DepositoryLedger.svelte';
  import { depositoryLedger, presentationLegendKeys, type LegendKey } from '#lib/network3d/timeline/presentationStage.ts';

  let playing = false;
  let playbackInterval: number | null = null;
  let speed = 1;
  let localError = '';

  $: steps = $networkMachineRuntime.machine?.steps ?? [];
  $: selectedIndex = $networkMachineRuntime.selectedStepIndex;
  $: selected = $networkMachineRuntime.selectedStep;
  // Entity labels come from the frame we are already showing, so captions say "Alice → Hub"
  // instead of hex, without a second read.
  $: labelByEntityId = new Map<string, string>(
    Array.from($networkMachineRuntime.frames.values())
      .flatMap((frame) => frame.entities)
      .flatMap((entity): Array<[string, string]> => {
        const entityId = String(entity.summary.entityId || '').toLowerCase();
        const label = String(entity.summary.label || entity.core?.profile?.name || '').trim();
        return entityId && label ? [[entityId, label]] : [];
      }),
  );

  // Global caption for the step: derived from runtime activity, overridden by an authored cue.
  $: caption = selected
    ? captionForStep(
        { runtimeId: selected.activeRuntimeId, height: selected.event.height, cues: selected.cues },
        $networkMachineRuntime.activity,
        {
          labelFor: (entityId: string): string => labelByEntityId.get(entityId.toLowerCase()) ?? '',
          formatAmount: (tokenId, amountMinor) => $xlnFunctions.isReady
            ? $xlnFunctions.formatTokenAmount(tokenId, BigInt(amountMinor))
            : '',
          motion: $networkMachineRuntime.motion,
        },
      )
    : null;
  $: progress = steps.length > 1 && selectedIndex >= 0 ? (selectedIndex / (steps.length - 1)) * 100 : 0;
  // Presentation stage facts, read from the frames on screen.
  $: ledger = $networkMachinePresentation && selected
    ? depositoryLedger($networkMachineRuntime.frames, $networkMachineRuntime.previousFrames)
    : null;
  $: legendKeys = $networkMachinePresentation && selected && $xlnFunctions.isReady
    ? presentationLegendKeys($networkMachineRuntime.frames, (delta, isLeft) => $xlnFunctions.deriveDelta(delta, isLeft))
    : new Set<LegendKey>();
  const tokenOf = (tokenId: number) => {
    const info = $xlnFunctions.getTokenInfo(tokenId);
    return { symbol: info.symbol, decimals: info.decimals };
  };

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
    // The graph times its motion to the playback speed, so it reads the same value.
    networkMachineDemo.set({ ...get(networkMachineDemo), speed });
    if (playing) {
      stopPlayback();
      togglePlayback();
    }
  }

  // An embedded demo asks for playback through the URL. The machine is loaded by the route,
  // so wait for its steps to exist and then start once, from the first frame.
  $: if (steps.length > 0 && !playing && networkMachineDemo.consumeAutoplay()) {
    speed = get(networkMachineDemo).speed;
    void selectStep(0).then(() => togglePlayback());
  }

  // A presentation opens on its first step: an empty stage reads as a broken demo.
  let presentationOpened = false;
  $: if ($networkMachinePresentation && !presentationOpened && steps.length > 0 && selectedIndex < 0 && !playing) {
    presentationOpened = true;
    void selectStep(0);
  }

  function stepBy(offset: number): void {
    if (steps.length === 0 || $networkMachineRuntime.loading) return;
    // A presenter's clicker only has →: past a chapter's last step it opens the next chapter.
    const next = $networkMachinePresentation?.chapter?.next;
    if (offset > 0 && next && selectedIndex === steps.length - 1) {
      window.location.assign(next.href);
      return;
    }
    stopPlayback();
    const from = selectedIndex < 0 ? (offset > 0 ? -1 : 0) : selectedIndex;
    void selectStep(Math.min(steps.length - 1, Math.max(0, from + offset)));
  }

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
  }

  /** Presenter keys: ←/→ step, Space plays or pauses, Home/End jump to either end. */
  function handlePresentationKey(event: KeyboardEvent): void {
    if (!$networkMachinePresentation || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
    const actions: Record<string, () => void> = {
      ArrowRight: () => stepBy(1),
      ArrowLeft: () => stepBy(-1),
      ' ': togglePlayback,
      Home: () => { stopPlayback(); if (steps.length > 0) void selectStep(0); },
      End: () => { stopPlayback(); if (steps.length > 0) void selectStep(steps.length - 1); },
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }

  onMount(() => {
    // A route that loaded a scenario owns the machine; refreshing would replace it with
    // whatever runtimes happen to be connected.
    if (get(networkMachineRuntime).machine) return;
    void refresh();
  });
  onDestroy(() => {
    stopPlayback();
    networkMachineRuntimeOperations.dispose();
  });
</script>

<svelte:window on:keydown={handlePresentationKey} />

<div class="network-machine" class:present={$networkMachinePresentation !== null} data-testid="network-machine-timeline">
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

  {#if caption}
    <div class="cue" data-testid="network-machine-cue" data-caption-source={caption.source}>
      <strong>
        {caption.title}
        {#if caption.extraCount > 0}<em>+{caption.extraCount}</em>{/if}
      </strong>
      {#if caption.subtitle}<span>{caption.subtitle}</span>{/if}
      {#if caption.mechanic}<span class="mechanic" title={caption.mechanic}>{caption.mechanic}</span>{/if}
    </div>
  {/if}

  <select aria-label="NetworkMachine timeline density" value={$networkMachineConfig.timelineMode} on:change={(event) => updateTimelineMode(event.currentTarget.value as NetworkMachineTimelineMode)}>
    <option value="all-frames">All R-frames</option>
    <option value="graph-changes">Graph changes</option>
  </select>
  <select aria-label="NetworkMachine playback speed" value={String(speed)} on:change={updateSpeed}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option></select>
  <button class="refresh" data-testid="network-machine-refresh" title="Reload runtime indexes" disabled={$networkMachineRuntime.loading} on:click={() => void refresh()}><RefreshCw size={13} /></button>
  <button class="dock" data-testid="network-machine-mode-toggle" on:click={() => window.location.assign('/ui/')}>Wallet</button>
</div>
{#if $networkMachinePresentation}
  <PresentationNarration
    {caption}
    demoTitle={$networkMachinePresentation.title}
    chapter={$networkMachinePresentation.chapter ?? null}
    stepIndex={selectedIndex}
    stepCount={steps.length}
    {playing}
    {legendKeys}
    seek={(index) => { stopPlayback(); void selectStep(index); }}
  />
  {#if ledger && $xlnFunctions.isReady}<DepositoryLedger {ledger} {tokenOf} stepIndex={selectedIndex} />{/if}
{:else}
  <FrameSubtitle subtitle={caption?.source === 'cue' ? caption : undefined} visible={selected !== null} />
{/if}
{#if localError || $networkMachineRuntime.error}<div class="network-error" role="alert">{localError || $networkMachineRuntime.error}</div>{/if}

<style>
  .network-machine{height:48px;box-sizing:border-box;display:flex;align-items:center;gap:9px;padding:7px 10px;background:#101317;color:#dce7ee;border-top:1px solid rgba(255,255,255,.08);font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}.navigation{display:flex;gap:2px}.navigation button,.refresh,.dock{display:grid;place-items:center;min-width:27px;height:27px;border:1px solid #293b47;border-radius:5px;background:#15212a;color:#cde7f6}.navigation .play{border-color:#236b8c;color:#5ed0ff}.identity{display:grid;gap:2px;min-width:120px}.identity strong{font-size:11px}.identity span{color:#62d88f}input[type=range]{min-width:120px;flex:1;accent-color:#51d889}.event{display:flex;align-items:center;gap:6px;white-space:nowrap}.event strong{color:var(--runtime-color)}.event time{color:#738897}.dot{width:7px;height:7px;border-radius:50%;background:var(--runtime-color);box-shadow:0 0 9px var(--runtime-color)}.cue{display:grid;max-width:340px;overflow:hidden}.cue .mechanic{color:#5f7d95;font-style:italic}.cue strong,.cue span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cue span{color:#879aa7}.cue em{margin-left:5px;font-style:normal;color:#62d88f}select{height:27px;border:1px solid #293b47;border-radius:5px;background:#101b23;color:#c7d9e4;font:inherit}.dock{padding:0 9px;color:#d2b8ff;border-color:#5c3f7a}.network-error{position:absolute;left:10px;right:10px;bottom:52px;z-index:40;padding:7px 9px;border:1px solid #713140;background:#230e14;color:#ff9aae;font:11px/1.3 ui-monospace,monospace}
  /* Presentation: the narration card carries the step counter, progress and keys, so the
     strip itself is not drawn (it stays mounted: it owns playback and the narration). */
  .present{height:0;padding:0;border:0;gap:0}.present>*{display:none}
  @media(max-width:900px){.cue,.event time,.identity strong{display:none}.identity{min-width:auto}}
</style>
