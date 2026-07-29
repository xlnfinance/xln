<script lang="ts">
  /**
   * The demo player.
   *
   * A demo and a workspace want opposite things from the same machine. The dock is an
   * instrument: every control visible, density selectable, nothing hidden. A demo is a
   * story: the caption is the largest thing on screen, the acts are navigable, and the
   * controls that only make sense while debugging are simply absent.
   *
   * It draws over the scene rather than beside it, because a strip of chrome under the
   * graph steals the height that makes the network readable.
   */

  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { Pause, Play, SkipBack } from 'lucide-svelte';
  import { networkMachineDemo } from '$lib/stores/networkMachineDemoStore';
  import { networkMachineRuntime, networkMachineRuntimeOperations } from '$lib/stores/networkMachineRuntimeStore';
  import { captionForStep } from '$lib/network3d/networkCaption';
  import { deriveNetworkActs, actIndexOfStep } from '$lib/network3d/networkActs';
  import { summarizeNetwork, percent, type VitalsAccount } from '$lib/network3d/networkVitals';
  import { xlnFunctions } from '$lib/stores/xlnStore';

  const SPEEDS = [1, 2, 4] as const;

  let playing = false;
  let playbackInterval: number | null = null;
  let speed: number = 1;

  $: steps = $networkMachineRuntime.machine?.steps ?? [];
  $: selectedIndex = $networkMachineRuntime.selectedStepIndex;
  $: selected = $networkMachineRuntime.selectedStep;
  $: activity = $networkMachineRuntime.activity;

  $: labelByEntityId = new Map<string, string>(
    Array.from($networkMachineRuntime.frames.values())
      .flatMap((frame) => frame.entities)
      .flatMap((entity): Array<[string, string]> => {
        const entityId = String(entity.summary.entityId || '').toLowerCase();
        const label = String(entity.summary.label || entity.core?.profile?.name || '').trim();
        return entityId && label ? [[entityId, label]] : [];
      }),
  );

  $: caption = selected
    ? captionForStep(
        { runtimeId: selected.activeRuntimeId, height: selected.event.height, cues: selected.cues },
        activity,
        {
          labelFor: (entityId: string): string => labelByEntityId.get(entityId.toLowerCase()) ?? '',
          formatAmount: (tokenId, amountMinor) => $xlnFunctions.isReady
            ? $xlnFunctions.formatTokenAmount(tokenId, BigInt(amountMinor))
            : '',
        },
      )
    : null;

  // The chapter track is built from the whole story, loaded once. Using the selected
  // step's activity would grow the track act by act as playback discovers it.
  $: storyActivity = $networkMachineRuntime.storyActivity;
  // Vitals come from the frames the scene is drawing, so the headline and the picture can
  // never disagree about the same moment.
  $: vitals = (() => {
    const frames = Array.from($networkMachineRuntime.frames.values());
    const entities = frames.flatMap((frame) => frame.entities);
    const tokenId = 1;
    const reserves = entities.map((entity) => {
      const held = entity.core?.reserves;
      return held instanceof Map ? (held.get(tokenId) ?? 0n) : 0n;
    });
    const seen = new Set<string>();
    const accounts: VitalsAccount[] = [];
    for (const entity of entities) {
      for (const item of entity.accounts?.items ?? []) {
        const record = item as {
          leftEntity?: string; rightEntity?: string;
          deltas?: Map<number, unknown>; activeDispute?: unknown;
        };
        const key = `${String(record.leftEntity ?? '')}|${String(record.rightEntity ?? '')}`.toLowerCase();
        if (seen.has(key)) continue;
        const delta = record.deltas instanceof Map ? record.deltas.get(tokenId) : undefined;
        if (!delta || !$xlnFunctions.isReady) continue;
        seen.add(key);
        const derived = $xlnFunctions.deriveDelta(delta as never, true);
        accounts.push({
          collateral: derived.collateral,
          delta: derived.delta,
          creditExtended: derived.ownCreditLimit + derived.peerCreditLimit,
          creditDrawn: derived.ownCreditUsed + derived.peerCreditUsed,
          disputed: Boolean(record.activeDispute),
        });
      }
    }
    return summarizeNetwork(reserves, accounts);
  })();

  const compact = (amount: bigint): string =>
    $xlnFunctions.isReady ? $xlnFunctions.formatTokenAmount(1, amount) : String(amount);

  $: acts = deriveNetworkActs(
    steps.map((step) => ({ index: step.index, runtimeId: step.activeRuntimeId, height: step.event.height })),
    storyActivity.length > 0 ? storyActivity : activity,
  );
  $: currentActIndex = actIndexOfStep(acts, selectedIndex);
  $: progress = steps.length > 1 && selectedIndex >= 0 ? (selectedIndex / (steps.length - 1)) * 100 : 0;

  // Scenario time starts at zero, so an absolute clock renders as 1970 and tells the viewer
  // nothing. Elapsed time since the first step is the number that means something.
  $: baseTimestamp = steps[0]?.event.timestamp ?? 0;
  $: elapsed = selected ? Math.max(0, selected.event.timestamp - baseTimestamp) : 0;
  const elapsedText = (ms: number): string =>
    ms < 1000 ? `+${ms}ms` : ms < 60_000 ? `+${(ms / 1000).toFixed(1)}s` : `+${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;

  async function selectStep(index: number): Promise<void> {
    await networkMachineRuntimeOperations.selectStep(index);
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

  function cycleSpeed(): void {
    speed = SPEEDS[(SPEEDS.indexOf(speed as typeof SPEEDS[number]) + 1) % SPEEDS.length] ?? 1;
    if (playing) {
      stopPlayback();
      togglePlayback();
    }
  }

  let storyLoadedFor = '';
  $: if (steps.length > 0) {
    const signature = `${steps.length}:${steps[0]?.activeRuntimeId ?? ''}:${steps[steps.length - 1]?.event.height ?? 0}`;
    if (signature !== storyLoadedFor) {
      storyLoadedFor = signature;
      void networkMachineRuntimeOperations.loadStoryActivity();
      // Land on the first step. "Live" means no frame is selected and none is loaded, so a
      // demo that opens there shows an empty stage until someone thinks to drag the
      // scrubber — the machine has a whole story and starts by showing none of it.
      if ($networkMachineRuntime.selectedStepIndex < 0) void selectStep(0);
    }
  }

  $: if (steps.length > 0 && !playing && networkMachineDemo.consumeAutoplay()) {
    speed = get(networkMachineDemo).speed;
    void selectStep(0).then(() => togglePlayback());
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === ' ') {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (event.key === 'ArrowRight' && selectedIndex < steps.length - 1) void selectStep(selectedIndex + 1);
    if (event.key === 'ArrowLeft' && selectedIndex > 0) void selectStep(selectedIndex - 1);
  }

  onMount(() => window.addEventListener('keydown', onKeydown));
  onDestroy(() => {
    window.removeEventListener('keydown', onKeydown);
    stopPlayback();
    networkMachineRuntimeOperations.dispose();
  });
</script>

<div class="player" data-testid="network-player">
  <div class="progress"><span style={`width:${progress}%`}></span></div>

  <div class="topline">
    <span class="source" style={`--runtime-color:${selected?.activeRuntimeColor ?? '#5DCAA5'}`}>
      <i></i>{selected?.activeRuntimeId ?? 'network'}
    </span>
    {#if currentActIndex >= 0}
      <span class="act" data-testid="network-player-act">
        act {currentActIndex + 1} / {acts.length} · {acts[currentActIndex]?.title}
      </span>
    {/if}
  </div>

  {#if vitals.accounts > 0}
    <div class="vitals" data-testid="network-player-vitals">
      <span><em>{percent(vitals.offChainShare)}</em>off-chain</span>
      <span><em>{compact(vitals.inAccounts)}</em>in accounts</span>
      <span><em>{compact(vitals.onChain)}</em>on chain</span>
      <span><em>{percent(vitals.deltaUtilisation)}</em>Δ used</span>
      <span><em>{compact(vitals.creditDrawn)}</em>credit drawn</span>
      <span class:alert={vitals.disputes > 0}><em>{vitals.disputes}</em>disputes</span>
    </div>
  {/if}

  {#if caption}
    {#key selectedIndex}
      <div class="caption" data-testid="network-player-caption" data-caption-source={caption.source}>
        <strong>{caption.title}</strong>
        {#if caption.subtitle}<span class="lede">{caption.subtitle}</span>{/if}
        {#if caption.mechanic}<span class="mechanic">{caption.mechanic}</span>{/if}
      </div>
    {/key}
  {/if}

  <div class="transport">
    <button
      class="play"
      aria-label={playing ? 'Pause' : 'Play'}
      disabled={steps.length === 0}
      on:click={togglePlayback}
    >{#if playing}<Pause size={16} />{:else}<Play size={16} />{/if}</button>
    <button class="restart" aria-label="Restart" disabled={steps.length === 0} on:click={() => { stopPlayback(); void selectStep(0); }}><SkipBack size={13} /></button>

    <div class="timeline" data-testid="network-player-acts">
      <div class="track">
        {#each acts as act, actIndex (act.fromIndex)}
          <button
            class="act-segment"
            class:current={actIndex === currentActIndex}
            data-kind={act.kind}
            style={`flex:${act.stepCount}`}
            title={`${act.title} — ${act.stepCount} steps`}
            on:click={() => { stopPlayback(); void selectStep(act.fromIndex); }}
          ><span class="fill"></span></button>
        {/each}
      </div>

      <input
        class="scrubber"
        data-testid="network-player-scrubber"
        type="range"
        min="0"
        max={Math.max(0, steps.length - 1)}
        step="1"
        value={Math.max(0, selectedIndex)}
        aria-label="Step"
        disabled={steps.length === 0}
        style={`--progress:${progress}%`}
        on:input={(event) => { stopPlayback(); void selectStep(Number(event.currentTarget.value)); }}
      />

      <div class="labels">
        {#each acts as act, actIndex (act.fromIndex)}
          <span class:current={actIndex === currentActIndex} data-kind={act.kind} style={`flex:${act.stepCount}`}>{act.title}</span>
        {/each}
      </div>
    </div>

    <span class="counter">{selectedIndex >= 0 ? selectedIndex + 1 : steps.length}/{steps.length}</span>
    {#if selected}<span class="clock">{elapsedText(elapsed)}</span>{/if}
    <button class="speed" aria-label="Playback speed" on:click={cycleSpeed}>{speed}×</button>
  </div>
</div>

{#if $networkMachineRuntime.error}
  <div class="player-error" role="alert">{$networkMachineRuntime.error}</div>
{/if}

<style>
  .player {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    pointer-events: none;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    color: #e8ecf1;
  }
  .player > * { pointer-events: auto; }

  .progress { position: absolute; top: 0; left: 0; right: 0; height: 2px; background: rgba(255,255,255,.07); }
  .progress span { display: block; height: 2px; background: #5DCAA5; transition: width .35s cubic-bezier(.4,0,.2,1); }

  .topline {
    position: absolute; top: 14px; left: 18px; right: 18px;
    display: flex; justify-content: space-between; align-items: center;
    font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: .05em; color: #6b7583;
  }
  .source { display: inline-flex; align-items: center; gap: 6px; }
  .source i { width: 6px; height: 6px; border-radius: 50%; background: var(--runtime-color); }
  .act { color: #8b95a5; letter-spacing: .09em; }

  /* Under the source line, above the scene: read before you look, like a ticker. */
  .vitals {
    position: absolute; top: 42px; left: 18px; right: 18px;
    display: flex; flex-wrap: wrap; gap: 22px;
    font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #5f6875;
  }
  .vitals span { display: inline-flex; align-items: baseline; gap: 6px; }
  .vitals em { font-style: normal; font-size: 15px; color: #cfd6df; }
  .vitals span.alert em { color: #e24b4a; }

  .caption {
    padding: 0 18px 14px;
    max-width: 720px;
    background: linear-gradient(to top, rgba(8,9,11,.92), rgba(8,9,11,0));
    animation: rise .32s cubic-bezier(.2,.7,.3,1);
  }
  @keyframes rise { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
  .caption strong { display: block; font-size: 26px; font-weight: 500; line-height: 1.2; }
  .caption .lede { display: block; margin-top: 6px; font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #5DCAA5; }
  .caption .mechanic { display: block; margin-top: 6px; font-size: 13px; line-height: 1.5; color: #8b95a5; }

  .transport {
    display: flex; align-items: center; gap: 14px;
    padding: 11px 18px 13px;
    background: rgba(8,9,11,.94);
    border-top: 1px solid rgba(255,255,255,.06);
  }
  .transport button { border: 1px solid #303845; background: transparent; color: #e8ecf1; border-radius: 6px; cursor: pointer; }
  .transport button:disabled { opacity: .4; cursor: default; }
  .play { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; flex: none; }
  .restart { width: 27px; height: 27px; display: grid; place-items: center; flex: none; color: #8b95a5; }
  .speed { height: 25px; padding: 0 8px; font: 11px/1 ui-monospace, monospace; color: #8b95a5; flex: none; }

  .timeline { flex: 1; min-width: 0; }
  .track { display: flex; gap: 3px; }
  .act-segment { height: 5px; padding: 0; border: 0; border-radius: 2px; background: #2a313a; overflow: hidden; }
  .act-segment .fill { display: block; height: 100%; width: 0; }
  .act-segment.current .fill { width: 100%; background: #5DCAA5; }
  .act-segment.current[data-kind="dispute"] .fill { background: #E24B4A; }
  .act-segment.current[data-kind="settlement"] .fill { background: #EF9F27; }

  /*
   * Chapters are for jumping; the scrubber is for stepping. A player needs both — losing
   * per-step control to a chapter track makes the timeline coarser, not better.
   */
  .scrubber {
    -webkit-appearance: none; appearance: none;
    display: block; width: 100%; height: 16px; margin: 3px 0 0;
    background: transparent; cursor: pointer;
  }
  .scrubber::-webkit-slider-runnable-track {
    height: 3px; border-radius: 2px;
    background: linear-gradient(to right, #5DCAA5 var(--progress), #2a313a var(--progress));
  }
  .scrubber::-moz-range-track { height: 3px; border-radius: 2px; background: #2a313a; }
  .scrubber::-moz-range-progress { height: 3px; border-radius: 2px; background: #5DCAA5; }
  .scrubber::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 11px; height: 11px; margin-top: -4px;
    border: 0; border-radius: 50%; background: #e8ecf1;
  }
  .scrubber::-moz-range-thumb { width: 11px; height: 11px; border: 0; border-radius: 50%; background: #e8ecf1; }
  .scrubber:disabled { opacity: .4; cursor: default; }

  .labels { display: flex; gap: 3px; font: 11px/1 ui-sans-serif, system-ui, sans-serif; color: #5f6875; }
  .labels span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .labels span.current { color: #cfd6df; }
  .labels span.current[data-kind="dispute"] { color: #E24B4A; }
  .labels span.current[data-kind="settlement"] { color: #EF9F27; }

  .counter, .clock { font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #8b95a5; flex: none; }

  .player-error {
    position: absolute; left: 18px; right: 18px; bottom: 78px; z-index: 40;
    padding: 8px 10px; border: 1px solid #713140; border-radius: 6px;
    background: #230e14; color: #ff9aae;
    font: 11px/1.4 ui-monospace, monospace;
  }

  @media (max-width: 720px) {
    .caption strong { font-size: 20px; }
    .labels { display: none; }
    .clock { display: none; }
  }
</style>
