<script lang="ts">
  /**
   * Presentation narration: the step's caption as a projector-legible card.
   *
   * It replaces the small subtitle pill in `present=1` mode. Content is exactly the caption
   * NetworkMachineTimeline already derives (authored cue, else runtime activity, else motion),
   * so the card never says something the timeline does not. Under an authored cue the card
   * speaks only the authored words: a per-frame runtime line could contradict them.
   */
  import type { NetworkCaption } from '#lib/network3d/timeline/networkCaption.ts';
  import type { NetworkMachinePresentation } from '#lib/stores/network/networkMachineDemoStore.ts';
  import type { LegendKey } from '#lib/network3d/timeline/presentationStage.ts';
  import { BAR_COLORS, DELTA_MARKER_COLOR, DISPUTE_SLEEVE_COLOR } from '#lib/network3d/AccountBarRenderer.ts';

  export let caption: NetworkCaption | null;
  export let demoTitle: string;
  export let chapter: NetworkMachinePresentation['chapter'] | null = null;
  export let stepIndex: number;
  export let stepCount: number;
  export let playing = false;
  /** Bar legend entries the stage is drawing at this step. */
  export let legendKeys: ReadonlySet<LegendKey> = new Set();
  export let seek: (index: number) => void = () => {};

  $: what = caption ? (caption.what || caption.subtitle) : '';
  // An authored cue may state its own subtitle and `what`; show the short one as the lead.
  $: lead = caption?.source === 'cue' && caption.subtitle && caption.subtitle !== what ? caption.subtitle : '';
  $: why = caption ? (caption.why || caption.mechanic) : '';
  $: sourceLabel = caption?.source === 'cue' ? 'Narrated step' : caption?.source === 'frame' ? 'Runtime frame' : 'Observed on the network';
  $: atEnd = stepCount > 0 && stepIndex === stepCount - 1;
  $: metrics = (caption?.keyMetrics ?? []).slice(0, 3).map(splitMetric);

  /** "Label: value" reads as a big number with a caption; anything else is the number. */
  function splitMetric(metric: string): { label: string; value: string } {
    const separator = metric.indexOf(': ');
    return separator > 0 ? { label: metric.slice(0, separator), value: metric.slice(separator + 2) } : { label: '', value: metric };
  }

  /** The bar legend uses the renderer's own colors, so the key can never disagree with the stage. */
  const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;
  const LEGEND: ReadonlyArray<{ key: LegendKey; label: string; color: string; kind: string }> = [
    { key: 'collateral', label: 'Collateral', color: hex(BAR_COLORS.secured), kind: 'solid' },
    { key: 'creditInUse', label: 'Credit in use (unsecured)', color: hex(BAR_COLORS.unsecured), kind: 'solid' },
    { key: 'creditRoom', label: 'Unused credit limit', color: hex(BAR_COLORS.availableCredit), kind: 'room' },
    { key: 'netPosition', label: 'Net position', color: hex(DELTA_MARKER_COLOR), kind: 'delta' },
    { key: 'dispute', label: 'Dispute open', color: hex(DISPUTE_SLEEVE_COLOR), kind: 'sleeve' },
  ];
  $: legend = LEGEND.filter((entry) => legendKeys.has(entry.key));
  const TONE_MARK: Record<string, string> = { done: '✓', bounded: '≤', outside: '§' };
</script>

<aside
  class="narration"
  data-testid="presentation-narration"
  data-caption-source={caption?.source ?? 'none'}
  style={caption?.accent ? `--accent:${caption.accent}` : ''}
>
  <header>
    <a class="brand" href="/demo" data-sveltekit-reload title="All demos">xln</a>
    <span class="demo">{demoTitle}</span>
    {#if chapter}<span class="part" data-testid="presentation-part">Part {chapter.index + 1} of {chapter.count}</span>{/if}
  </header>

  <div class="step-line">
    <span class="step" data-testid="presentation-step">{stepIndex >= 0 ? `Step ${stepIndex + 1} of ${stepCount}` : `${stepCount} steps`}</span>
    {#if caption}<span class="source">{sourceLabel}</span>{/if}
  </div>

  {#if caption}
    {#key `${stepIndex}:${caption.title}`}
      <div class="body">
        <h1>{caption.title}{#if caption.extraCount > 0}<em>+{caption.extraCount} more</em>{/if}</h1>
        {#if lead}<p class="lead">{lead}</p>{/if}
        {#if what}<p class="what">{what}</p>{/if}
        {#if caption.badges && caption.badges.length > 0}
          <ol class="ladder" data-testid="presentation-badges" aria-label="Finality">
            {#each caption.badges as badge}
              <li class={`rung ${badge.tone}`}>
                <span class="rung-head"><i aria-hidden="true">{TONE_MARK[badge.tone]}</i>{badge.label}</span>
                <span class="rung-detail">{badge.detail}</span>
              </li>
            {/each}
          </ol>
        {/if}
        {#if metrics.length > 0}
          <ul class="metrics" aria-label="Key metrics" data-testid="presentation-metrics">
            {#each metrics as metric}
              <li><strong>{metric.value}</strong>{#if metric.label}<span>{metric.label}</span>{/if}</li>
            {/each}
          </ul>
        {/if}
        {#if why}
          <section>
            <h2>Why it matters</h2>
            <p>{why}</p>
          </section>
        {/if}
        {#if caption.tradfiParallel}
          <section class="tradfi">
            <h2>In banking terms</h2>
            <p>{caption.tradfiParallel}</p>
          </section>
        {/if}
      </div>
    {/key}
  {:else}
    <div class="body">
      <h1>Ready</h1>
      <p class="what">Press <kbd>→</kbd> to step through the network, or <kbd>Space</kbd> to play.</p>
    </div>
  {/if}

  {#if atEnd && chapter?.next}
    <a class="up-next" href={chapter.next.href} data-sveltekit-reload data-testid="presentation-next">
      <span class="up-next-label">Up next <kbd>→</kbd></span>
      <span class="up-next-title">{chapter.next.title}</span>
    </a>
  {:else if atEnd && chapter}
    <a class="up-next" href="/demo" data-sveltekit-reload data-testid="presentation-next">
      <span class="up-next-label">End of the story</span>
      <span class="up-next-title">Back to all demos</span>
    </a>
  {/if}

  <footer>
    {#if legend.length > 0}
      <ul class="legend" data-testid="presentation-legend" aria-label="Account bar legend">
        {#each legend as entry}
          <li data-legend={entry.key}><i class={`swatch ${entry.kind}`} style={`--swatch:${entry.color}`}></i>{entry.label}</li>
        {/each}
      </ul>
    {/if}
    <input
      class="progress"
      type="range"
      min="0"
      max={Math.max(0, stepCount - 1)}
      value={Math.max(0, stepIndex)}
      aria-label="Presentation step"
      data-testid="presentation-scrubber"
      style={`--progress:${stepCount > 1 && stepIndex >= 0 ? (stepIndex / (stepCount - 1)) * 100 : 0}%`}
      on:input={(event) => seek(Number(event.currentTarget.value))}
    />
    <div class="keys"><kbd>←</kbd><kbd>→</kbd> step <span class="sep">·</span> <kbd>Space</kbd> {playing ? 'pause' : 'play'}</div>
  </footer>
</aside>

<style>
  .narration {
    --accent: #38e0b8;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--xln-present-narration-width, 460px);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 34px 34px 22px;
    overflow-y: auto;
    z-index: 25;
    background:
      radial-gradient(120% 60% at 0% 0%, rgba(56, 224, 184, 0.09), transparent 60%),
      linear-gradient(180deg, #0a1120 0%, #070c16 100%);
    border-right: 1px solid rgba(148, 196, 255, 0.12);
    color: #e8eef6;
    font-family: Inter, 'Helvetica Neue', Arial, sans-serif;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  .brand {
    font: 800 22px/1 Inter, 'Helvetica Neue', Arial, sans-serif;
    letter-spacing: -0.02em;
    color: #ffffff;
    text-decoration: none;
  }

  .part {
    margin-left: auto;
    color: #6f86a3;
    font-size: 13px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .up-next {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 9%, transparent);
    color: #ffffff;
    text-decoration: none;
    animation: narration-in 420ms ease-out;
  }

  .up-next:hover {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .up-next-label {
    color: var(--accent);
    font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .up-next-title {
    font-size: 20px;
    font-weight: 700;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    margin: 0 0 4px;
    padding: 0;
    list-style: none;
    color: #c3d0de;
    font-size: 18px;
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .swatch {
    display: inline-block;
    width: 28px;
    height: 12px;
    border-radius: 6px;
    background: var(--swatch);
  }

  .swatch.sleeve {
    background: color-mix(in srgb, var(--swatch) 30%, transparent);
    border: 2px solid var(--swatch);
    box-sizing: border-box;
  }

  .swatch.room {
    background: color-mix(in srgb, var(--swatch) 45%, transparent);
  }

  .swatch.delta {
    width: 4px;
    height: 20px;
    border-radius: 1px;
    box-shadow: 0 0 6px var(--swatch);
  }

  .demo {
    color: #8da2bb;
    font-size: 15px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .step-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 14px;
    border-bottom: 1px solid rgba(148, 196, 255, 0.1);
  }

  .step {
    color: var(--accent);
    font: 700 15px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .source {
    color: #6f86a3;
    font-size: 13px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    animation: narration-in 420ms ease-out;
  }

  h1 {
    margin: 0;
    font-size: clamp(26px, 2.3vw, 36px);
    line-height: 1.15;
    font-weight: 750;
    letter-spacing: -0.015em;
    color: #ffffff;
  }

  h1 em {
    margin-left: 10px;
    font-size: 0.5em;
    font-style: normal;
    font-weight: 600;
    color: #7f95ad;
    vertical-align: middle;
  }

  .lead {
    margin: 0;
    color: var(--accent);
    font-size: 19px;
    line-height: 1.4;
    font-weight: 600;
  }

  .what {
    margin: 0;
    color: #d3dde9;
    font-size: clamp(17px, 1.35vw, 20px);
    line-height: 1.5;
  }

  section {
    padding: 14px 16px;
    border-radius: 10px;
    background: rgba(148, 196, 255, 0.05);
    border: 1px solid rgba(148, 196, 255, 0.09);
  }

  section.tradfi {
    background: rgba(251, 191, 36, 0.06);
    border-color: rgba(251, 191, 36, 0.18);
  }

  h2 {
    margin: 0 0 6px;
    color: #7fa0c2;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  section.tradfi h2 {
    color: #e3b549;
  }

  section p {
    margin: 0;
    color: #dbe4ee;
    font-size: clamp(15px, 1.15vw, 17px);
    line-height: 1.5;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .metrics li {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    border-radius: 10px;
    background: rgba(56, 224, 184, 0.07);
    border: 1px solid rgba(56, 224, 184, 0.2);
  }

  .metrics strong {
    color: #ffffff;
    font-size: clamp(18px, 1.3vw, 23px);
    line-height: 1.15;
    font-weight: 750;
    letter-spacing: -0.01em;
  }

  .metrics span {
    color: #9fb8cc;
    font-size: 13px;
    line-height: 1.3;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .ladder {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .rung {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--rung);
    background: color-mix(in srgb, var(--rung) 10%, transparent);
  }

  .rung.done { --rung: #38e0b8; }
  .rung.bounded { --rung: #f5b942; }
  .rung.outside { --rung: #8fa3ba; }

  .rung-head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #ffffff;
    font-size: 17px;
    font-weight: 700;
  }

  .rung-head i {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--rung);
    color: #06121a;
    font-style: normal;
    font-size: 13px;
    font-weight: 800;
  }

  .rung-detail {
    color: #d3dde9;
    font-size: 14px;
    line-height: 1.4;
  }

  footer {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 12px;
  }

  .progress {
    width: 100%;
    height: 14px;
    margin: 0;
    appearance: none;
    background: linear-gradient(90deg, var(--accent) var(--progress), rgba(148, 196, 255, 0.14) var(--progress)) center / 100% 4px no-repeat;
    cursor: pointer;
  }

  .progress::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
  }

  .progress::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
  }

  .keys {
    color: #6f86a3;
    font-size: 13px;
  }

  .sep {
    margin: 0 4px;
  }

  kbd {
    display: inline-block;
    min-width: 18px;
    margin: 0 2px;
    padding: 2px 6px;
    border: 1px solid rgba(148, 196, 255, 0.25);
    border-bottom-width: 2px;
    border-radius: 5px;
    background: rgba(148, 196, 255, 0.06);
    color: #c7d6e6;
    font: 600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    text-align: center;
  }

  @keyframes narration-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }

  @media (max-width: 900px) {
    .narration {
      top: auto;
      right: 0;
      bottom: 48px;
      width: auto;
      max-height: 46vh;
      padding: 18px 16px 14px;
      gap: 12px;
      border-right: 0;
      border-top: 1px solid rgba(148, 196, 255, 0.14);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .body { animation: none; }
  }
</style>
