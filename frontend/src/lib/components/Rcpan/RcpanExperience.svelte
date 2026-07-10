<script lang="ts">
  import { onMount } from 'svelte';
  import { BadgeCheck, Landmark, Pause, Play, ReceiptText, RotateCcw, Scale, ShieldCheck } from 'lucide-svelte';
  import { settingsOperations } from '$lib/stores/settingsStore';
  import RcpanControls from './RcpanControls.svelte';
  import RcpanDisputeMicroscope from './RcpanDisputeMicroscope.svelte';
  import RcpanSalesHero from './RcpanSalesHero.svelte';
  import RcpanSystemComparison from './RcpanSystemComparison.svelte';
  import {
    cloneMicroscopeControls,
    type RcpanMicroscopeControls,
    type RcpanScenarioId,
  } from './microscope-playground';
  import {
    deriveMicroscopeTimeline,
    phaseStartMs,
    RCPAN_SCENARIOS,
  } from './microscope-timeline';
  import { deriveRcpanMicroscopeFrame } from './microscope-model';
  import { formatUsdMicros } from './microscope-tokens';
  import './rcpan-experience.css';

  let controls = cloneMicroscopeControls();
  let elapsedFloat = 0;
  let elapsedMs = 0;

  function setClock(next: number): void {
    elapsedFloat = next;
    elapsedMs = Math.floor(next);
  }

  function updateControls(next: RcpanMicroscopeControls): void {
    const scenarioChanged = next.scenarioMode !== controls.scenarioMode;
    controls = next;
    if (scenarioChanged) setClock(0);
  }

  function restart(): void {
    setClock(0);
  }

  function selectScenario(id: RcpanScenarioId | 'auto'): void {
    controls = { ...controls, scenarioMode: id, playing: true };
    setClock(0);
  }

  function jumpTo(phase: 'payment' | 'dispute-open'): void {
    const scenarioId = timeline.scenario.id;
    setClock(phaseStartMs(scenarioId, phase, controls.phaseDurationMs, controls.scenarioMode));
    controls = { ...controls, playing: true };
    requestAnimationFrame(() => document.getElementById('account-microscope')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function togglePlayback(): void {
    controls = { ...controls, playing: !controls.playing };
  }

  function percent(value: bigint): number {
    if (frame.metrics.grossUsdMicros === 0n) return 0;
    return Number(value * 10_000n / frame.metrics.grossUsdMicros) / 100;
  }

  onMount(() => {
    settingsOperations.initialize();
    let animationFrame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const frameMs = Math.min(100, Math.max(0, now - previous));
      previous = now;
      if (controls.playing) {
        elapsedFloat += frameMs * controls.playbackSpeed;
        const whole = Math.floor(elapsedFloat);
        if (whole !== elapsedMs) elapsedMs = whole;
      }
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  });

  $: timeline = deriveMicroscopeTimeline(elapsedMs, controls.phaseDurationMs, controls.scenarioMode);
  $: frame = deriveRcpanMicroscopeFrame(timeline, controls);
  $: collateralPercent = percent(frame.metrics.collateralUsdMicros);
  $: reservePercent = percent(frame.metrics.reservePaidUsdMicros);
  $: debtPercent = percent(frame.metrics.newDebtUsdMicros);
</script>

<div class="rcpan-page">
  <RcpanSalesHero on:payment={() => jumpTo('payment')} on:dispute={() => jumpTo('dispute-open')} />

  <main class="rcpan-main">
    <section class="upgrade-strip" aria-label="The three xln account upgrades">
      <article><ReceiptText size={18} /><span><b>01 · Portable proof</b><small>Both sides sign the same balance.</small></span></article>
      <article><ShieldCheck size={18} /><span><b>02 · Visible protection</b><small>Collateral, then reserve, then explicit debt.</small></span></article>
      <article><Scale size={18} /><span><b>03 · Executable dispute</b><small>Code allocates collateral, reserve, and explicit debt.</small></span></article>
    </section>

    <section class="microscope-section" id="account-microscope" aria-labelledby="microscope-title">
      <header class="microscope-intro">
        <div>
          <span>One payment · two account regimes</span>
          <h2 id="microscope-title">Watch ownership become enforceable.</h2>
          <p>Same User, same H1, same payment. Only the guarantees change.</p>
        </div>
        <div class="playback-card">
          <span><i></i>{timeline.phase.replaceAll('-', ' ')}</span>
          <strong>{timeline.scenario.label}</strong>
          <div>
            <button type="button" on:click={togglePlayback} aria-label={controls.playing ? 'Pause simulation' : 'Play simulation'}>
              {#if controls.playing}<Pause size={14} />{:else}<Play size={14} />{/if}
            </button>
            <button type="button" on:click={restart} aria-label="Restart scenario"><RotateCcw size={14} /></button>
          </div>
        </div>
      </header>

      <nav class="scenario-tabs" aria-label="Dispute settlement scenarios">
        <button class:active={controls.scenarioMode === 'auto'} type="button" on:click={() => selectScenario('auto')}>
          <span>Auto tour</span><small>All three cases</small>
        </button>
        {#each RCPAN_SCENARIOS as scenario (scenario.id)}
          <button class:active={timeline.scenario.id === scenario.id && controls.scenarioMode !== 'auto'} type="button" on:click={() => selectScenario(scenario.id)}>
            <span>{scenario.shortLabel}</span><small>{scenario.label}</small>
          </button>
        {/each}
      </nav>

      <div class="system-grid" class:court-right={controls.courtPlacement === 'right'}>
        <article class="system-story fcuan-story">
          <header>
            <span class="system-mark"><Landmark size={15} /> FCUAN · today</span>
            <h3>An IOU inside H1</h3>
            <p>H1's record says what User owns. User cannot execute that record.</p>
            <div class="system-number"><small>operator-only claim</small><b>{formatUsdMicros(frame.fcuan.exposureUsdMicros)}</b></div>
          </header>
          <RcpanDisputeMicroscope account={frame.fcuan.account} court={frame.fcuan.court} courtPlacement={controls.courtPlacement} />
        </article>

        <article class="system-story rcpan-story">
          <header>
            <span class="system-mark"><BadgeCheck size={15} /> xln · RCPAN</span>
            <h3>A receipt User can execute</h3>
            <p>Both sides sign. Code allocates protection and updates reserves.</p>
            <div class="system-number"><small>explicit debt now</small><b>{formatUsdMicros(frame.rcpan.exposureUsdMicros)}</b></div>
          </header>
          <RcpanDisputeMicroscope account={frame.rcpan.account} court={frame.rcpan.court} courtPlacement={controls.courtPlacement} />
        </article>
      </div>

      <section class="waterfall" aria-label="Current xln settlement waterfall">
        <header>
          <div><span>Initial settlement waterfall</span><strong>{formatUsdMicros(frame.metrics.grossUsdMicros)} signed balance</strong></div>
          <small>{frame.metrics.allTokensConserved ? '✓ Every token conserved during finalization' : 'Conservation error'}</small>
        </header>
        <div class="waterfall-bar">
          {#if collateralPercent > 0}<i class="collateral" style={`width:${collateralPercent}%`}></i>{/if}
          {#if reservePercent > 0}<i class="reserve" style={`width:${reservePercent}%`}></i>{/if}
          {#if debtPercent > 0}<i class="debt" style={`width:${debtPercent}%`}></i>{/if}
        </div>
        <div class="waterfall-legend">
          <span><i class="collateral"></i><b>Collateral</b>{formatUsdMicros(frame.metrics.collateralUsdMicros)}</span>
          <span><i class="reserve"></i><b>H1 reserve</b>{formatUsdMicros(frame.metrics.reservePaidUsdMicros)}</span>
          <span><i class="debt"></i><b>Debt created</b>{formatUsdMicros(frame.metrics.newDebtUsdMicros)}</span>
        </div>
      </section>
    </section>

    <RcpanSystemComparison />
    <RcpanControls {timeline} value={controls} onChange={updateControls} onRestart={restart} />
  </main>

  <footer class="rcpan-footer">
    <span><ShieldCheck size={14} /> Exact <code>deriveDelta()</code> account bars · exact Depository finalization order</span>
    <a href="https://github.com/xlnfinance/xln/blob/main/jurisdictions/contracts/Depository.sol" target="_blank" rel="noreferrer">Read Depository.sol</a>
  </footer>
</div>
