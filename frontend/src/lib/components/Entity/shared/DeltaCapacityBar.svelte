<script lang="ts">
  import { settings } from '$lib/stores/settingsStore';

  type DeltaParts = {
    outOwnCredit: bigint;
    outCollateral: bigint;
    outPeerCredit: bigint;
    inOwnCredit: bigint;
    inCollateral: bigint;
    inPeerCredit: bigint;
    outTotalHold?: bigint;
    inTotalHold?: bigint;
  };

  export let derived: DeltaParts;
  export let decimals: number = 18;
  export let heightPx: number = 8;

  $: outTotal = derived.outOwnCredit + derived.outCollateral + derived.outPeerCredit;
  $: inTotal = derived.inOwnCredit + derived.inCollateral + derived.inPeerCredit;
  $: halfMax = outTotal > inTotal ? outTotal : inTotal;

  $: precision = Math.max(2, Math.min(18, Math.floor(Number($settings?.tokenPrecision ?? 6))));
  $: safeDecimals = Math.max(0, Math.floor(Number(decimals) || 18));
  $: visualZeroThreshold = (() => {
    if (precision >= safeDecimals) return 1n;
    const shift = safeDecimals - precision;
    return 10n ** BigInt(Math.max(0, shift));
  })();

  $: outOnly = outTotal > visualZeroThreshold && inTotal <= visualZeroThreshold;
  $: inOnly = inTotal > visualZeroThreshold && outTotal <= visualZeroThreshold;
  $: outHoldRaw = typeof derived.outTotalHold === 'bigint' ? derived.outTotalHold : 0n;
  $: inHoldRaw = typeof derived.inTotalHold === 'bigint' ? derived.inTotalHold : 0n;
  $: outHold = outHoldRaw > outTotal ? outTotal : outHoldRaw;
  $: inHold = inHoldRaw > inTotal ? inTotal : inHoldRaw;
  $: hasHoldOverlay = outHold > 0n || inHold > 0n;

  function pctOf(v: bigint, base: bigint): number {
    return base > 0n ? Number((v * 10000n) / base) / 100 : 0;
  }

  function toFlex(v: bigint): number {
    const n = Number(v / (10n ** 14n));
    return n > 0 ? n : (v > 0n ? 1 : 0);
  }
</script>

<div class="delta-capacity-bar" style="--bar-h: {heightPx}px;">
  {#if halfMax === 0n}
    <div class="bar empty"></div>
  {:else if outOnly || inOnly}
    <div class="bar one-sided">
      {#if outOnly}
        {#if derived.outOwnCredit > 0n}<div class="seg credit" style="flex:{toFlex(derived.outOwnCredit)}"></div>{/if}
        {#if derived.outCollateral > 0n}<div class="seg coll" style="flex:{toFlex(derived.outCollateral)}"></div>{/if}
        {#if derived.outPeerCredit > 0n}<div class="seg debt" style="flex:{toFlex(derived.outPeerCredit)}"></div>{/if}
      {:else}
        {#if derived.inOwnCredit > 0n}<div class="seg debt" style="flex:{toFlex(derived.inOwnCredit)}"></div>{/if}
        {#if derived.inCollateral > 0n}<div class="seg coll" style="flex:{toFlex(derived.inCollateral)}"></div>{/if}
        {#if derived.inPeerCredit > 0n}<div class="seg credit" style="flex:{toFlex(derived.inPeerCredit)}"></div>{/if}
      {/if}
      {#if hasHoldOverlay}
        {#if outOnly && outHold > 0n}
          <div
            class="hold-overlay one-sided out"
            title="Outbound hold"
            style="width:{pctOf(outHold, outTotal)}%"
          ></div>
        {/if}
        {#if inOnly && inHold > 0n}
          <div
            class="hold-overlay one-sided in"
            title="Inbound hold"
            style="width:{pctOf(inHold, inTotal)}%"
          ></div>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="bar center">
      <div class="half out">
        {#if derived.outOwnCredit > 0n}<div class="seg credit" style="width:{pctOf(derived.outOwnCredit, halfMax)}%"></div>{/if}
        {#if derived.outCollateral > 0n}<div class="seg coll" style="width:{pctOf(derived.outCollateral, halfMax)}%"></div>{/if}
        {#if derived.outPeerCredit > 0n}<div class="seg debt" style="width:{pctOf(derived.outPeerCredit, halfMax)}%"></div>{/if}
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
    grid-template-columns: 1fr 2px 1fr;
  }

  .bar.one-sided {
    display: flex;
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
    width: 2px;
    height: 100%;
    background: #52525b;
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
    right: 0;
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
</style>
