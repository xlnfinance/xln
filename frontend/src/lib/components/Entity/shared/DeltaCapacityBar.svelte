<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { settings } from '$lib/stores/settingsStore';
  import type { DeltaCapacityBarPresentation, DeltaParts, DeltaVisualScale } from './delta-types';

  export let derived: DeltaParts;
  export let heightPx: number = 4;
  export let layout: 'center' | 'sides' = 'center';
  export let pendingOutDebtMode: 'none' | 'pending' | 'settling' = 'none';
  export let visualScale: DeltaVisualScale | null = null;
  export let interactive = false;
  export let expanded = false;
  export let presentation: DeltaCapacityBarPresentation | null = null;

  const dispatch = createEventDispatcher<{ activate: void }>();

  const CENTER_GAP_PX = 10;
  const SIDES_GAP_PX = 10;
  const MIN_VISIBLE_SIDE_PX = 0;
  const CREDIT_GRADIENT_MAX_PX = 300;

  $: outTotal = derived.outOwnCredit + derived.outCollateral + derived.outPeerCredit;
  $: inTotal = derived.inOwnCredit + derived.inCollateral + derived.inPeerCredit;
  $: halfMax = outTotal > inTotal ? outTotal : inTotal;

  // Settings flags
  $: creditGradient = presentation?.creditGradient ?? $settings.barCreditGradient ?? true;
  $: animTransition = presentation?.animations?.transition ?? $settings.barAnimTransition ?? true;
  $: animSweep = presentation?.animations?.sweep ?? $settings.barAnimSweep ?? false;
  $: animGlow = presentation?.animations?.glow ?? $settings.barAnimGlow ?? false;
  $: animRipple = presentation?.animations?.ripple ?? $settings.barAnimRipple ?? false;

  $: transitionMs = durationMs('transition', presentation?.durationsMs?.transition, 400);
  $: sweepMs = durationMs('sweep', presentation?.durationsMs?.sweep, 700);
  $: glowMs = durationMs('glow', presentation?.durationsMs?.glow, 600);
  $: rippleMs = durationMs('ripple', presentation?.durationsMs?.ripple, 800);
  $: stripeMs = durationMs('stripe', presentation?.durationsMs?.stripe, 800);
  $: settlingMs = durationMs('settling', presentation?.durationsMs?.settling, 1000);

  $: creditColor = presentation?.colors?.credit ?? 'rgba(255, 255, 255, 0.75)';
  $: collateralColor = presentation?.colors?.collateral ?? '#22c55e';
  $: debtColor = presentation?.colors?.debt ?? '#ef4444';
  $: trackColor = presentation?.colors?.track ?? 'rgba(39, 39, 42, 0.9)';
  $: deltaColor = presentation?.colors?.delta ?? '#dc6b6b';
  $: deltaShadow = presentation?.colors?.delta
    ? `color-mix(in srgb, ${deltaColor} 30%, transparent)`
    : 'rgba(220, 107, 107, 0.3)';
  $: presentationStyle = [
    `--bar-h:${heightPx}px`,
    `--center-gap:${CENTER_GAP_PX}px`,
    `--sides-gap:${SIDES_GAP_PX}px`,
    `--bar-credit-color:${creditColor}`,
    `--bar-collateral-color:${collateralColor}`,
    `--bar-debt-color:${debtColor}`,
    `--bar-track-color:${trackColor}`,
    `--bar-delta-color:${deltaColor}`,
    `--bar-delta-shadow:${deltaShadow}`,
    `--bar-transition-duration:${transitionMs}ms`,
    `--bar-sweep-duration:${sweepMs}ms`,
    `--bar-glow-duration:${glowMs}ms`,
    `--bar-ripple-duration:${rippleMs}ms`,
    `--bar-stripe-duration:${stripeMs}ms`,
    `--bar-settling-duration:${settlingMs}ms`
  ].join(';');

  $: outVisualOwnUsd = visualScale?.outOwnCreditUsd ?? 0;
  $: outVisualCollUsd = visualScale?.outCollateralUsd ?? 0;
  $: outVisualDebtUsd = visualScale?.outPeerCreditUsd ?? 0;
  $: inVisualOwnUsd = visualScale?.inOwnCreditUsd ?? 0;
  $: inVisualCollUsd = visualScale?.inCollateralUsd ?? 0;
  $: inVisualCreditUsd = visualScale?.inPeerCreditUsd ?? 0;
  $: hasVisualScale = visualScale !== null;
  $: usdPerPx = $settings.accountBarUsdPerPx ?? 100;
  $: visualUsdPerPx = usdPerPx * 2;
  $: outOwnWidthPx = widthPxForUsd(outVisualOwnUsd, visualUsdPerPx);
  $: outCollWidthPx = widthPxForUsd(outVisualCollUsd, visualUsdPerPx);
  $: outDebtWidthPx = widthPxForUsd(outVisualDebtUsd, visualUsdPerPx);
  $: inOwnWidthPx = widthPxForUsd(inVisualOwnUsd, visualUsdPerPx);
  $: inCollWidthPx = widthPxForUsd(inVisualCollUsd, visualUsdPerPx);
  $: inCreditWidthPx = widthPxForUsd(inVisualCreditUsd, visualUsdPerPx);
  $: outWidthPx = widthPxForUsd(visualScale?.outCapacityUsd ?? 0, visualUsdPerPx);
  $: inWidthPx = widthPxForUsd(visualScale?.inCapacityUsd ?? 0, visualUsdPerPx);
  $: outCenterWidthStyle = shellWidthStyle(outWidthPx, CENTER_GAP_PX);
  $: inCenterWidthStyle = shellWidthStyle(inWidthPx, CENTER_GAP_PX);
  $: outSideWidthStyle = shellWidthStyle(outWidthPx, SIDES_GAP_PX);
  $: inSideWidthStyle = shellWidthStyle(inWidthPx, SIDES_GAP_PX);

  function pctOf(value: bigint, base: bigint): number {
    return base > 0n ? Number((value * 10000n) / base) / 100 : 0;
  }

  function durationMs(name: string, value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`DeltaCapacityBar ${name} duration must be a finite non-negative number`);
    }
    return value;
  }

  function widthPxForUsd(valueUsd: number, usdPerPixel: number): number {
    if (!Number.isFinite(valueUsd) || valueUsd <= 0 || !Number.isFinite(usdPerPixel) || usdPerPixel <= 0) return 0;
    return Math.max(MIN_VISIBLE_SIDE_PX, Math.round((valueUsd / usdPerPixel) * 100) / 100);
  }

  function shellWidthStyle(widthPx: number, gapPx: number): string {
    return `width:min(${widthPx}px, calc(50% - ${gapPx / 2}px));max-width:calc(50% - ${gapPx / 2}px)`;
  }

  function segmentWidthStyle(widthPx: number): string {
    return `width:${Math.max(0, widthPx)}px`;
  }

  function creditSegStyle(widthPx: number): string {
    const w = Math.max(0, widthPx);
    if (creditGradient && w > CREDIT_GRADIENT_MAX_PX) {
      return `width:${CREDIT_GRADIENT_MAX_PX}px;-webkit-mask-image:linear-gradient(to right,black 80%,transparent 100%);mask-image:linear-gradient(to right,black 80%,transparent 100%)`;
    }
    return `width:${w}px`;
  }

  function creditPctStyle(pct: number): string {
    if (creditGradient && pct > 60) {
      return `width:${pct}%;-webkit-mask-image:linear-gradient(to right,black 70%,transparent 100%);mask-image:linear-gradient(to right,black 70%,transparent 100%)`;
    }
    return `width:${pct}%`;
  }

  // Sweep animation: trigger on capacity change (right-to-left = inbound from hub)
  let sweepActive = false;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let glowActive = false;
  let glowTimer: ReturnType<typeof setTimeout> | undefined;
  let rippleActive = false;
  let rippleTimer: ReturnType<typeof setTimeout> | undefined;
  let prevOutCap = 0n;
  let prevInCap = 0n;

  function activateSweep(): void {
    if (sweepTimer !== undefined) clearTimeout(sweepTimer);
    sweepActive = true;
    sweepTimer = setTimeout(() => { sweepActive = false; }, sweepMs);
  }

  function activateGlow(): void {
    if (glowTimer !== undefined) clearTimeout(glowTimer);
    glowActive = true;
    glowTimer = setTimeout(() => { glowActive = false; }, glowMs);
  }

  function activateRipple(): void {
    if (rippleTimer !== undefined) clearTimeout(rippleTimer);
    rippleActive = true;
    rippleTimer = setTimeout(() => { rippleActive = false; }, rippleMs);
  }

  $: {
    const curOut = derived.outCapacity;
    const curIn = derived.inCapacity;
    const initialized = prevOutCap !== 0n || prevInCap !== 0n;
    const changed = curOut !== prevOutCap || curIn !== prevInCap;
    if (initialized && changed) {
      if (animSweep) activateSweep();
      if (animGlow) activateGlow();
      if (animRipple) activateRipple();
    }
    prevOutCap = curOut;
    prevInCap = curIn;
  }

  onDestroy(() => {
    if (sweepTimer !== undefined) clearTimeout(sweepTimer);
    if (glowTimer !== undefined) clearTimeout(glowTimer);
    if (rippleTimer !== undefined) clearTimeout(rippleTimer);
  });

  function activate(event?: MouseEvent | KeyboardEvent): void {
    if (!interactive) return;
    event?.stopPropagation();
    dispatch('activate');
  }
</script>

<svelte:element
  this={interactive ? 'button' : 'div'}
  class="delta-capacity-bar"
  class:visual-center={hasVisualScale && layout === 'center'}
  class:visual-sides={hasVisualScale && layout === 'sides'}
  class:interactive={interactive}
  class:anim-transition={animTransition}
  class:anim-glow={glowActive}
  type={interactive ? 'button' : undefined}
  role={interactive ? 'button' : undefined}
  aria-expanded={interactive ? expanded : undefined}
  on:click={activate}
  style={presentationStyle}
>
  {#if hasVisualScale}
    <div class="track"></div>
    {#if sweepActive}<div class="sweep-line"></div>{/if}
    {#if rippleActive}<div class="ripple-ring"></div>{/if}

    {#if layout === 'center'}
      <div class="axis">
        <div class="delta-cut"></div>
      </div>

      {#if outWidthPx > 0}
        <div class="shell out center-shell" style={outCenterWidthStyle}>
          {#if outOwnWidthPx > 0}<div class="seg credit" style={creditSegStyle(outOwnWidthPx)}></div>{/if}
          {#if outCollWidthPx > 0}<div class="seg coll" style={segmentWidthStyle(outCollWidthPx)}></div>{/if}
          {#if outVisualDebtUsd > 0}
            <div
              class="seg debt"
              class:striped={pendingOutDebtMode === 'pending'}
              class:settling={pendingOutDebtMode === 'settling'}
              style={segmentWidthStyle(outDebtWidthPx)}
            ></div>
          {/if}
        </div>
      {/if}

      {#if inWidthPx > 0}
        <div class="shell in center-shell" style={inCenterWidthStyle}>
          {#if inOwnWidthPx > 0}<div class="seg debt" style={segmentWidthStyle(inOwnWidthPx)}></div>{/if}
          {#if inCollWidthPx > 0}<div class="seg coll" style={segmentWidthStyle(inCollWidthPx)}></div>{/if}
          {#if inCreditWidthPx > 0}<div class="seg credit" style={creditSegStyle(inCreditWidthPx)}></div>{/if}
        </div>
      {/if}
    {:else}
      {#if outWidthPx > 0}
        <div class="shell out side-shell" style={outSideWidthStyle}>
          {#if outOwnWidthPx > 0}<div class="seg credit" style={creditSegStyle(outOwnWidthPx)}></div>{/if}
          {#if outCollWidthPx > 0}<div class="seg coll" style={segmentWidthStyle(outCollWidthPx)}></div>{/if}
          {#if outVisualDebtUsd > 0}
            <div
              class="seg debt"
              class:striped={pendingOutDebtMode === 'pending'}
              class:settling={pendingOutDebtMode === 'settling'}
              style={segmentWidthStyle(outDebtWidthPx)}
            ></div>
          {/if}
        </div>
      {/if}

      {#if inWidthPx > 0}
        <div class="shell in side-shell" style={inSideWidthStyle}>
          {#if inOwnWidthPx > 0}<div class="seg debt" style={segmentWidthStyle(inOwnWidthPx)}></div>{/if}
          {#if inCollWidthPx > 0}<div class="seg coll" style={segmentWidthStyle(inCollWidthPx)}></div>{/if}
          {#if inCreditWidthPx > 0}<div class="seg credit" style={creditSegStyle(inCreditWidthPx)}></div>{/if}
        </div>
      {/if}
    {/if}
  {:else if halfMax === 0n}
    <div class="bar empty"></div>
  {:else if layout === 'sides'}
    <div class="bar one-sided">
      {#if derived.outOwnCredit > 0n}<div class="seg credit" style={creditPctStyle(pctOf(derived.outOwnCredit, outTotal + inTotal))}></div>{/if}
      {#if derived.outCollateral > 0n}<div class="seg coll" style={`width:${pctOf(derived.outCollateral, outTotal + inTotal)}%`}></div>{/if}
      {#if derived.outPeerCredit > 0n}
        <div
          class="seg debt"
          class:striped={pendingOutDebtMode === 'pending'}
          class:settling={pendingOutDebtMode === 'settling'}
          style={`width:${pctOf(derived.outPeerCredit, outTotal + inTotal)}%`}
        ></div>
      {/if}

      {#if derived.inOwnCredit > 0n}<div class="seg debt" style={`width:${pctOf(derived.inOwnCredit, outTotal + inTotal)}%`}></div>{/if}
      {#if derived.inCollateral > 0n}<div class="seg coll" style={`width:${pctOf(derived.inCollateral, outTotal + inTotal)}%`}></div>{/if}
      {#if derived.inPeerCredit > 0n}<div class="seg credit" style={creditPctStyle(pctOf(derived.inPeerCredit, outTotal + inTotal))}></div>{/if}

      {#if outTotal > 0n && inTotal > 0n}
        <div class="mid one-sided-sep" style={`left:${pctOf(outTotal, outTotal + inTotal)}%`}>
          <div class="delta-cut"></div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="bar center split-center">
      <div class="half out">
        {#if derived.outOwnCredit > 0n}<div class="seg credit" style={creditPctStyle(pctOf(derived.outOwnCredit, halfMax))}></div>{/if}
        {#if derived.outCollateral > 0n}<div class="seg coll" style={`width:${pctOf(derived.outCollateral, halfMax)}%`}></div>{/if}
        {#if derived.outPeerCredit > 0n}
          <div
            class="seg debt"
            class:striped={pendingOutDebtMode === 'pending'}
            class:settling={pendingOutDebtMode === 'settling'}
            style={`width:${pctOf(derived.outPeerCredit, halfMax)}%`}
          ></div>
        {/if}
      </div>
      <div class="mid">
        <div class="delta-cut"></div>
      </div>
      <div class="half in">
        {#if derived.inOwnCredit > 0n}<div class="seg debt" style={`width:${pctOf(derived.inOwnCredit, halfMax)}%`}></div>{/if}
        {#if derived.inCollateral > 0n}<div class="seg coll" style={`width:${pctOf(derived.inCollateral, halfMax)}%`}></div>{/if}
        {#if derived.inPeerCredit > 0n}<div class="seg credit" style={creditPctStyle(pctOf(derived.inPeerCredit, halfMax))}></div>{/if}
      </div>
    </div>
  {/if}
</svelte:element>

<style>
  .delta-capacity-bar {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    position: relative;
    appearance: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: initial;
  }

  .delta-capacity-bar.interactive {
    cursor: pointer;
  }

  .delta-capacity-bar.interactive:focus-visible {
    outline: 2px solid rgba(251, 191, 36, 0.78);
    outline-offset: 4px;
    border-radius: 6px;
  }

  .track {
    width: 100%;
    height: var(--bar-h);
    border-radius: 999px;
    background: var(--bar-track-color);
    box-shadow: inset 0 0 0 0.5px rgba(82, 82, 91, 0.35);
  }

  .axis,
  .mid {
    position: absolute;
    top: 0;
    bottom: 0;
    width: var(--center-gap);
    background: transparent;
    border: none;
    box-shadow: none;
    z-index: 4;
  }

  .axis {
    left: 50%;
    transform: translateX(-50%);
  }

  .bar {
    width: 100%;
    height: var(--bar-h);
    display: flex;
    align-items: center;
    position: relative;
  }

  .bar.empty {
    border-radius: 999px;
    background: var(--bar-track-color);
    box-shadow: inset 0 0 0 0.5px rgba(82, 82, 91, 0.35);
    opacity: 0.45;
  }

  .bar.one-sided {
    border-radius: 999px;
    overflow: hidden;
    background: var(--bar-track-color);
    box-shadow: inset 0 0 0 0.5px rgba(82, 82, 91, 0.35);
    display: flex;
    align-items: stretch;
  }

  .bar.split-center {
    justify-content: center;
  }

  .shell {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 0;
    border-radius: 999px;
    overflow: hidden;
    display: flex;
    align-items: stretch;
    background: transparent;
    box-shadow: none;
    z-index: 2;
  }

  /* Smooth width transition when enabled */
  .anim-transition .shell,
  .anim-transition .seg,
  .anim-transition .half {
    transition: width var(--bar-transition-duration) ease-out;
  }

  .visual-center .shell.out.center-shell {
    right: calc(50% + var(--center-gap) / 2);
    justify-content: flex-end;
    background: transparent;
    box-shadow: none;
  }

  .visual-center .shell.in.center-shell {
    left: calc(50% + var(--center-gap) / 2);
    justify-content: flex-start;
    background: transparent;
    box-shadow: none;
  }

  .visual-sides .shell.out.side-shell {
    left: 0;
    justify-content: flex-start;
  }

  .visual-sides .shell.in.side-shell {
    right: 0;
    justify-content: flex-end;
  }

  .half {
    display: flex;
    align-items: stretch;
    height: 100%;
    overflow: hidden;
    min-width: 0;
    flex: 1 1 auto;
    background: transparent;
    box-shadow: none;
    border-radius: 999px;
  }

  .half.out {
    justify-content: flex-end;
  }

  .half.in {
    justify-content: flex-start;
  }

  .mid {
    flex: 0 0 auto;
  }

  .mid.one-sided-sep {
    width: 12px;
    background: transparent;
    transform: translateX(-6px);
  }

  /* Delta boundary — subtle cut mark */
  .delta-cut {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 1.5px;
    height: calc(var(--bar-h) + 6px);
    background: var(--bar-delta-color);
    border-radius: 0;
    box-shadow: 0 0 3px var(--bar-delta-shadow);
    z-index: 5;
    pointer-events: none;
  }

  .seg {
    min-width: 1px;
    height: 100%;
    opacity: 0.92;
  }

  /* credit = bright white — peer credit promise */
  .seg.credit {
    background: var(--bar-credit-color);
  }

  /* coll = electric green — hard collateral */
  .seg.coll {
    background: var(--bar-collateral-color);
  }

  /* debt = hot red — uncollateralized exposure */
  .seg.debt {
    background: var(--bar-debt-color);
  }

  .seg.debt.striped {
    background: repeating-linear-gradient(
      -45deg,
      #f43f5e 0px,
      #f43f5e 3px,
      #fbbf24 3px,
      #fbbf24 6px
    );
    background-size: 8px 8px;
    animation: stripe-scroll var(--bar-stripe-duration) linear infinite;
  }

  .seg.debt.settling {
    background: linear-gradient(180deg, #fbbf24, #f59e0b);
    animation: settling-pulse var(--bar-settling-duration) ease-in-out infinite;
  }

  /* ── Glow animation ── */
  .anim-glow .shell,
  .anim-glow .bar:not(.empty) {
    animation: bar-glow var(--bar-glow-duration) ease-out;
  }

  @keyframes bar-glow {
    0% { filter: brightness(1.8) drop-shadow(0 0 8px rgba(34, 197, 94, 0.5)); }
    100% { filter: brightness(1) drop-shadow(0 0 0 transparent); }
  }

  /* ── Sweep animation (right-to-left = inbound from hub to user) ── */
  .sweep-line {
    position: absolute;
    top: -1px;
    bottom: -1px;
    width: 30px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.6), rgba(251, 191, 36, 0.3), transparent);
    z-index: 10;
    animation: sweep-rtl var(--bar-sweep-duration) ease-out forwards;
    pointer-events: none;
  }

  @keyframes sweep-rtl {
    0% { right: -30px; opacity: 1; }
    100% { right: 100%; opacity: 0; }
  }

  /* ── Ripple animation (expanding ring from center) ── */
  .ripple-ring {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid rgba(251, 191, 36, 0.6);
    transform: translate(-50%, -50%);
    z-index: 10;
    animation: ripple-expand var(--bar-ripple-duration) ease-out forwards;
    pointer-events: none;
  }

  @keyframes ripple-expand {
    0% { width: 10px; height: 10px; opacity: 1; border-width: 2px; }
    100% { width: 200px; height: 40px; opacity: 0; border-width: 1px; }
  }

  @keyframes stripe-scroll {
    0% { background-position: 0 0; }
    100% { background-position: 8px 8px; }
  }

  @keyframes settling-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  @media (prefers-reduced-motion: reduce) {
    .anim-transition .shell,
    .anim-transition .seg,
    .anim-transition .half {
      transition: none;
    }

    .anim-glow .shell,
    .anim-glow .bar:not(.empty),
    .seg.debt.striped,
    .seg.debt.settling {
      animation: none;
    }

    .sweep-line,
    .ripple-ring {
      display: none;
    }
  }
</style>
