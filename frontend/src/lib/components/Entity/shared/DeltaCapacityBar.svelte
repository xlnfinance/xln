<script lang="ts">
  import { settings } from '$lib/stores/settingsStore';
  import type { DeltaParts, DeltaVisualScale } from './delta-types';

  export let derived: DeltaParts;
  export let heightPx: number = 8;
  export let layout: 'center' | 'sides' = 'center';
  export let pendingOutDebtMode: 'none' | 'pending' | 'settling' = 'none';
  export let visualScale: DeltaVisualScale | null = null;

  const CENTER_GAP_PX = 8;
  const SIDES_GAP_PX = 14;
  const MIN_VISIBLE_SIDE_PX = 3;

  $: outTotal = derived.outOwnCredit + derived.outCollateral + derived.outPeerCredit;
  $: inTotal = derived.inOwnCredit + derived.inCollateral + derived.inPeerCredit;
  $: halfMax = outTotal > inTotal ? outTotal : inTotal;

  $: outCapacityUsd = visualScale?.outCapacityUsd ?? 0;
  $: inCapacityUsd = visualScale?.inCapacityUsd ?? 0;
  $: outVisualOwnUsd = visualScale?.outOwnCreditUsd ?? 0;
  $: outVisualCollUsd = visualScale?.outCollateralUsd ?? 0;
  $: outVisualDebtUsd = visualScale?.outPeerCreditUsd ?? 0;
  $: inVisualOwnUsd = visualScale?.inOwnCreditUsd ?? 0;
  $: inVisualCollUsd = visualScale?.inCollateralUsd ?? 0;
  $: inVisualCreditUsd = visualScale?.inPeerCreditUsd ?? 0;
  $: outSegmentTotalUsd = outVisualOwnUsd + outVisualCollUsd + outVisualDebtUsd;
  $: inSegmentTotalUsd = inVisualOwnUsd + inVisualCollUsd + inVisualCreditUsd;
  $: hasVisualScale = visualScale !== null;
  $: usdPerPx = $settings.accountBarUsdPerPx ?? 100;
  $: outWidthPx = widthPxForUsd(outCapacityUsd, usdPerPx);
  $: inWidthPx = widthPxForUsd(inCapacityUsd, usdPerPx);
  $: outCenterWidthStyle = shellWidthStyle(outWidthPx, CENTER_GAP_PX);
  $: inCenterWidthStyle = shellWidthStyle(inWidthPx, CENTER_GAP_PX);
  $: outSideWidthStyle = shellWidthStyle(outWidthPx, SIDES_GAP_PX);
  $: inSideWidthStyle = shellWidthStyle(inWidthPx, SIDES_GAP_PX);

  function pctOf(value: bigint, base: bigint): number {
    return base > 0n ? Number((value * 10000n) / base) / 100 : 0;
  }

  function pctOfNumber(value: number, base: number): number {
    return base > 0 ? (value / base) * 100 : 0;
  }

  function widthPxForUsd(valueUsd: number, usdPerPixel: number): number {
    if (!Number.isFinite(valueUsd) || valueUsd <= 0 || !Number.isFinite(usdPerPixel) || usdPerPixel <= 0) return 0;
    return Math.max(MIN_VISIBLE_SIDE_PX, Math.round((valueUsd / usdPerPixel) * 100) / 100);
  }

  function shellWidthStyle(widthPx: number, gapPx: number): string {
    return `width:min(${widthPx}px, calc(50% - ${gapPx / 2}px))`;
  }
</script>

<div
  class="delta-capacity-bar"
  class:visual-center={hasVisualScale && layout === 'center'}
  class:visual-sides={hasVisualScale && layout === 'sides'}
  style={`--bar-h:${heightPx}px; --center-gap:${CENTER_GAP_PX}px; --sides-gap:${SIDES_GAP_PX}px;`}
>
  {#if hasVisualScale}
    <div class="track"></div>

    {#if layout === 'center'}
      <div class="axis"></div>

      {#if outWidthPx > 0}
        <div class="shell out center-shell" style={outCenterWidthStyle}>
          {#if outVisualOwnUsd > 0}<div class="seg credit" style={`width:${pctOfNumber(outVisualOwnUsd, outSegmentTotalUsd)}%`}></div>{/if}
          {#if outVisualCollUsd > 0}<div class="seg coll" style={`width:${pctOfNumber(outVisualCollUsd, outSegmentTotalUsd)}%`}></div>{/if}
          {#if outVisualDebtUsd > 0}
            <div
              class="seg debt"
              class:striped={pendingOutDebtMode === 'pending'}
              class:settling={pendingOutDebtMode === 'settling'}
              style={`width:${pctOfNumber(outVisualDebtUsd, outSegmentTotalUsd)}%`}
            ></div>
          {/if}
        </div>
      {/if}

      {#if inWidthPx > 0}
        <div class="shell in center-shell" style={inCenterWidthStyle}>
          {#if inVisualOwnUsd > 0}<div class="seg debt" style={`width:${pctOfNumber(inVisualOwnUsd, inSegmentTotalUsd)}%`}></div>{/if}
          {#if inVisualCollUsd > 0}<div class="seg coll" style={`width:${pctOfNumber(inVisualCollUsd, inSegmentTotalUsd)}%`}></div>{/if}
          {#if inVisualCreditUsd > 0}<div class="seg credit" style={`width:${pctOfNumber(inVisualCreditUsd, inSegmentTotalUsd)}%`}></div>{/if}
        </div>
      {/if}
    {:else}
      {#if outWidthPx > 0}
        <div class="shell out side-shell" style={outSideWidthStyle}>
          {#if outVisualOwnUsd > 0}<div class="seg credit" style={`width:${pctOfNumber(outVisualOwnUsd, outSegmentTotalUsd)}%`}></div>{/if}
          {#if outVisualCollUsd > 0}<div class="seg coll" style={`width:${pctOfNumber(outVisualCollUsd, outSegmentTotalUsd)}%`}></div>{/if}
          {#if outVisualDebtUsd > 0}
            <div
              class="seg debt"
              class:striped={pendingOutDebtMode === 'pending'}
              class:settling={pendingOutDebtMode === 'settling'}
              style={`width:${pctOfNumber(outVisualDebtUsd, outSegmentTotalUsd)}%`}
            ></div>
          {/if}
        </div>
      {/if}

      {#if inWidthPx > 0}
        <div class="shell in side-shell" style={inSideWidthStyle}>
          {#if inVisualOwnUsd > 0}<div class="seg debt" style={`width:${pctOfNumber(inVisualOwnUsd, inSegmentTotalUsd)}%`}></div>{/if}
          {#if inVisualCollUsd > 0}<div class="seg coll" style={`width:${pctOfNumber(inVisualCollUsd, inSegmentTotalUsd)}%`}></div>{/if}
          {#if inVisualCreditUsd > 0}<div class="seg credit" style={`width:${pctOfNumber(inVisualCreditUsd, inSegmentTotalUsd)}%`}></div>{/if}
        </div>
      {/if}
    {/if}
  {:else if halfMax === 0n}
    <div class="bar empty"></div>
  {:else if layout === 'sides'}
    <div class="bar one-sided">
      {#if derived.outOwnCredit > 0n}<div class="seg credit" style={`width:${pctOf(derived.outOwnCredit, outTotal + inTotal)}%`}></div>{/if}
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
      {#if derived.inPeerCredit > 0n}<div class="seg credit" style={`width:${pctOf(derived.inPeerCredit, outTotal + inTotal)}%`}></div>{/if}

      {#if outTotal > 0n && inTotal > 0n}
        <div class="mid one-sided-sep" style={`left:${pctOf(outTotal, outTotal + inTotal)}%`}></div>
      {/if}
    </div>
  {:else}
    <div class="bar center legacy-center">
      <div class="half out">
        {#if derived.outOwnCredit > 0n}<div class="seg credit" style={`width:${pctOf(derived.outOwnCredit, halfMax)}%`}></div>{/if}
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
      <div class="mid"></div>
      <div class="half in">
        {#if derived.inOwnCredit > 0n}<div class="seg debt" style={`width:${pctOf(derived.inOwnCredit, halfMax)}%`}></div>{/if}
        {#if derived.inCollateral > 0n}<div class="seg coll" style={`width:${pctOf(derived.inCollateral, halfMax)}%`}></div>{/if}
        {#if derived.inPeerCredit > 0n}<div class="seg credit" style={`width:${pctOf(derived.inPeerCredit, halfMax)}%`}></div>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .delta-capacity-bar {
    width: 100%;
    position: relative;
  }

  .track {
    width: 100%;
    height: var(--bar-h);
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.14);
    box-shadow: inset 0 0 0 1px rgba(100, 116, 139, 0.14);
  }

  .axis,
  .mid {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    background: linear-gradient(
      180deg,
      rgba(71, 85, 105, 0.22) 0%,
      rgba(148, 163, 184, 0.46) 50%,
      rgba(71, 85, 105, 0.22) 100%
    );
    border-left: 1px solid rgba(226, 232, 240, 0.52);
    border-right: 1px solid rgba(148, 163, 184, 0.34);
    box-shadow: 0 0 6px rgba(148, 163, 184, 0.12);
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
    background: rgba(39, 39, 42, 0.72);
    box-shadow: inset 0 0 0 1px rgba(82, 82, 91, 0.35);
    opacity: 0.45;
  }

  .bar.one-sided {
    border-radius: 999px;
    overflow: hidden;
    background: rgba(39, 39, 42, 0.72);
    box-shadow: inset 0 0 0 1px rgba(82, 82, 91, 0.35);
    display: flex;
    align-items: stretch;
  }

  .bar.legacy-center {
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
    background: rgba(226, 232, 240, 0.07);
    box-shadow:
      inset 0 0 0 1px rgba(148, 163, 184, 0.16),
      0 0 0 1px rgba(15, 23, 42, 0.12);
    z-index: 2;
  }

  .visual-center .shell.out.center-shell {
    right: calc(50% + var(--center-gap) / 2);
    justify-content: flex-end;
  }

  .visual-center .shell.in.center-shell {
    left: calc(50% + var(--center-gap) / 2);
    justify-content: flex-start;
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
    background: rgba(39, 39, 42, 0.72);
    box-shadow: inset 0 0 0 1px rgba(82, 82, 91, 0.35);
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
    transform: translateX(-5px);
  }

  .seg {
    min-width: 1px;
    height: 100%;
    opacity: 0.92;
  }

  .seg.credit {
    background: linear-gradient(180deg, rgba(203, 213, 225, 0.9), rgba(148, 163, 184, 0.95));
  }

  .seg.coll {
    background: linear-gradient(180deg, rgba(52, 211, 153, 0.92), rgba(16, 185, 129, 0.96));
  }

  .seg.debt {
    background: linear-gradient(180deg, rgba(251, 113, 133, 0.94), rgba(244, 63, 94, 0.98));
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
    animation: stripe-scroll 0.8s linear infinite;
  }

  .seg.debt.settling {
    background: linear-gradient(180deg, #fbbf24, #f59e0b);
    animation: settling-pulse 1s ease-in-out infinite;
  }

  @keyframes stripe-scroll {
    0% { background-position: 0 0; }
    100% { background-position: 8px 8px; }
  }

  @keyframes settling-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
</style>
