<script lang="ts">
  import type { DeltaParts } from './delta-types';

  export let derived: DeltaParts;
  export let decimals: number = 18;
  export let heightPx: number = 8;
  export let layout: 'center' | 'sides' = 'center';
  export let pendingOutDebtMode: 'none' | 'pending' | 'settling' = 'none';

  $: outTotal = derived.outOwnCredit + derived.outCollateral + derived.outPeerCredit;
  $: inTotal = derived.inOwnCredit + derived.inCollateral + derived.inPeerCredit;
  $: combinedTotal = outTotal + inTotal;
  $: halfMax = outTotal > inTotal ? outTotal : inTotal;

  $: outHoldRaw = typeof derived.outTotalHold === 'bigint' ? derived.outTotalHold : 0n;
  $: inHoldRaw = typeof derived.inTotalHold === 'bigint' ? derived.inTotalHold : 0n;
  $: outHold = outHoldRaw > outTotal ? outTotal : outHoldRaw;
  $: inHold = inHoldRaw > inTotal ? inTotal : inHoldRaw;
  $: hasHoldOverlay = outHold > 0n || inHold > 0n;
  $: outStart = outTotal > outHold ? outTotal - outHold : 0n;
  $: inStart = outTotal;

  function pctOf(v: bigint, base: bigint): number {
    return base > 0n ? Number((v * 10000n) / base) / 100 : 0;
  }

</script>

<div class="delta-capacity-bar" style="--bar-h: {heightPx}px;">
  {#if halfMax === 0n}
    <div class="bar empty"></div>
  {:else if layout === 'sides'}
    <div class="bar one-sided">
      {#if derived.outOwnCredit > 0n}<div class="seg credit" style="width:{pctOf(derived.outOwnCredit, combinedTotal)}%"></div>{/if}
      {#if derived.outCollateral > 0n}<div class="seg coll" style="width:{pctOf(derived.outCollateral, combinedTotal)}%"></div>{/if}
      {#if derived.outPeerCredit > 0n}
        <div
          class="seg debt"
          class:striped={pendingOutDebtMode === 'pending'}
          class:settling={pendingOutDebtMode === 'settling'}
          style="width:{pctOf(derived.outPeerCredit, combinedTotal)}%"
        ></div>
      {/if}

      {#if derived.inOwnCredit > 0n}<div class="seg debt" style="width:{pctOf(derived.inOwnCredit, combinedTotal)}%"></div>{/if}
      {#if derived.inCollateral > 0n}<div class="seg coll" style="width:{pctOf(derived.inCollateral, combinedTotal)}%"></div>{/if}
      {#if derived.inPeerCredit > 0n}<div class="seg credit" style="width:{pctOf(derived.inPeerCredit, combinedTotal)}%"></div>{/if}

      {#if outTotal > 0n && inTotal > 0n}
        <div class="mid one-sided-sep" style="left:{pctOf(outTotal, combinedTotal)}%"></div>
      {/if}

      {#if hasHoldOverlay}
        {#if outHold > 0n}
          <div
            class="hold-overlay one-sided out"
            title="Outbound hold"
            style="left:{pctOf(outStart, combinedTotal)}%; width:{pctOf(outHold, combinedTotal)}%"
          ></div>
        {/if}
        {#if inHold > 0n}
          <div
            class="hold-overlay one-sided in"
            title="Inbound hold"
            style="left:{pctOf(inStart, combinedTotal)}%; width:{pctOf(inHold, combinedTotal)}%"
          ></div>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="bar center">
      <div class="half out">
        {#if derived.outOwnCredit > 0n}<div class="seg credit" style="width:{pctOf(derived.outOwnCredit, halfMax)}%"></div>{/if}
        {#if derived.outCollateral > 0n}<div class="seg coll" style="width:{pctOf(derived.outCollateral, halfMax)}%"></div>{/if}
        {#if derived.outPeerCredit > 0n}
          <div
            class="seg debt"
            class:striped={pendingOutDebtMode === 'pending'}
            class:settling={pendingOutDebtMode === 'settling'}
            style="width:{pctOf(derived.outPeerCredit, halfMax)}%"
          ></div>
        {/if}
      </div>
      <div class="mid"></div>
      <div class="half in">
        {#if derived.inOwnCredit > 0n}<div class="seg debt" style="width:{pctOf(derived.inOwnCredit, halfMax)}%"></div>{/if}
        {#if derived.inCollateral > 0n}<div class="seg coll" style="width:{pctOf(derived.inCollateral, halfMax)}%"></div>{/if}
        {#if derived.inPeerCredit > 0n}<div class="seg credit" style="width:{pctOf(derived.inPeerCredit, halfMax)}%"></div>{/if}
      </div>
      {#if hasHoldOverlay}
        {#if outHold > 0n}
          <div
            class="hold-overlay center-out"
            title="Outbound hold"
            style="width:{pctOf(outHold, halfMax) / 2}%"
          ></div>
        {/if}
        {#if inHold > 0n}
          <div
            class="hold-overlay center-in"
            title="Inbound hold"
            style="width:{pctOf(inHold, halfMax) / 2}%"
          ></div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .delta-capacity-bar {
    width: 100%;
  }

  .bar {
    width: 100%;
    height: var(--bar-h);
    border-radius: 999px;
    overflow: hidden;
    background: #27272a;
    display: flex;
    align-items: stretch;
    position: relative;
  }

  .bar.center {
    display: grid;
    grid-template-columns: 1fr 10px 1fr;
  }

  .bar.one-sided {
    display: flex;
    align-items: stretch;
    position: relative;
  }

  .bar.empty {
    opacity: 0.45;
  }

  .half {
    display: flex;
    align-items: stretch;
    height: 100%;
    overflow: hidden;
  }

  .half.out {
    justify-content: flex-end;
  }

  .half.in {
    justify-content: flex-start;
  }

  .mid {
    width: 10px;
    height: 100%;
    background: linear-gradient(
      180deg,
      rgba(71, 85, 105, 0.38) 0%,
      rgba(100, 116, 139, 0.5) 50%,
      rgba(71, 85, 105, 0.38) 100%
    );
    border-left: 1px solid rgba(226, 232, 240, 0.78);
    border-right: 1px solid rgba(148, 163, 184, 0.55);
    position: relative;
    z-index: 4;
    box-shadow: 0 0 8px rgba(148, 163, 184, 0.2);
  }

  .mid.one-sided-sep {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 10px;
    transform: translateX(-5px);
    z-index: 4;
  }

  .seg {
    min-width: 1px;
    height: 100%;
  }

  .seg.credit {
    background: #9ca3af;
  }

  .seg.coll {
    background: #10b981;
  }

  .seg.debt {
    background: #f43f5e;
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

  .hold-overlay {
    position: absolute;
    top: 0;
    bottom: 0;
    pointer-events: none;
    background: rgba(148, 163, 184, 0.36);
    border-left: 1px solid rgba(203, 213, 225, 0.52);
    border-right: 1px solid rgba(203, 213, 225, 0.52);
    z-index: 3;
  }

  .hold-overlay.one-sided.out {
    right: auto;
  }

  .hold-overlay.one-sided.in {
    left: 0;
  }

  .hold-overlay.center-out {
    right: 50%;
  }

  .hold-overlay.center-in {
    left: 50%;
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
