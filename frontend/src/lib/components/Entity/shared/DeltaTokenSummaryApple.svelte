<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { settings } from '$lib/stores/settingsStore';
  import type { DeltaParts } from './delta-types';

  export let symbol: string;
  export let name: string = '';
  export let outAmount: string;
  export let inAmount: string;
  export let derived: DeltaParts;
  export let decimals: number = 18;
  export let actionLabel = '';
  export let actionTokenId: number | null = null;
  export let actionDisabled = false;
  export let expanded = false;

  const dispatch = createEventDispatcher<{ action: { tokenId: number | null }; bartoggle: void }>();

  let open = expanded;
  $: open = expanded;

  function iconForSymbol(rawSymbol: string): { text: string; cls: string } {
    const s = String(rawSymbol || '').toUpperCase();
    if (s === 'USDC') return { text: '$', cls: 'usdc' };
    if (s === 'USDT') return { text: '$', cls: 'usdt' };
    if (s === 'WETH' || s === 'ETH') return { text: 'E', cls: 'weth' };
    return { text: s.slice(0, 1) || 'T', cls: 'other' };
  }
  $: icon = iconForSymbol(symbol);

  const num = (b: bigint | undefined): number => (b == null ? 0 : Number(b));
  function fmt(b: bigint | undefined): string {
    const v = num(b) / 10 ** decimals;
    if (v === 0) return '0';
    if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }

  $: outCap = num(derived.outCapacity);
  $: inCap = num(derived.inCapacity);
  $: total = outCap + inCap;
  $: empty = total <= 0;
  $: pct = (x: number): number => (total > 0 ? Math.max(0, Math.min(100, (x / total) * 100)) : 0);
  $: markerPct = total > 0 ? pct(outCap) : 50;
  $: collStartPct = pct(outCap - num(derived.outCollateral));
  $: collEndPct = pct(outCap + num(derived.inCollateral));
  $: collWidthPct = Math.max(0, collEndPct - collStartPct);
  $: pipsFilled = empty ? 0 : Math.max(1, Math.min(8, Math.round((markerPct / 100) * 8)));
  $: outPct = markerPct;
  $: inPct = Math.max(0, 100 - markerPct);
  $: barStyle = $settings.accountBarStyle ?? 'hairline';

  $: sendCredit = (derived.outOwnCredit ?? 0n) + (derived.outPeerCredit ?? 0n);
  $: recvCredit = (derived.inOwnCredit ?? 0n) + (derived.inPeerCredit ?? 0n);
  $: collateralTotal = (derived.outCollateral ?? 0n) + (derived.inCollateral ?? 0n);

  function toggle(): void {
    open = !open;
    dispatch('bartoggle');
  }
  function emitAction(e: Event): void {
    e.stopPropagation();
    if (actionDisabled) return;
    dispatch('action', { tokenId: actionTokenId });
  }
</script>

<div class="apple-row" class:open>
  <button class="head" type="button" on:click={toggle} aria-expanded={open}>
    <span class="token-icon {icon.cls}">{icon.text}</span>
    <span class="meta">
      <span class="sym">{symbol}</span>
      {#if name}<span class="nm">{name}</span>{/if}
    </span>
    <span class="amt">{outAmount}</span>
    {#if actionLabel}
      <span class="act" role="button" tabindex={actionDisabled ? -1 : 0} on:click={emitAction} on:keydown={(e) => e.key === 'Enter' && emitAction(e)} class:disabled={actionDisabled}>{actionLabel}</span>
    {/if}
    <i class="ti ti-chevron-right chev" aria-hidden="true"></i>
  </button>

  {#if barStyle === 'pips'}
    <div class="bar-wrap pips">
      {#each Array(8) as _, i}
        <span class="pip {i < pipsFilled ? 'on ' + icon.cls : 'off'}"></span>
      {/each}
    </div>
  {:else if barStyle === 'twin'}
    <div class="bar-wrap twin">
      <span class="twin-line {icon.cls}" style="width:{empty ? 0 : Math.max(4, outPct)}%;"></span>
      <span class="twin-line off" style="width:{empty ? 0 : Math.max(4, inPct)}%;"></span>
    </div>
  {:else if barStyle === 'capsule'}
    <div class="bar-wrap">
      <div class="capsule">
        {#if !empty}
          <div class="cap-coll" style="left:{collStartPct}%; width:{collWidthPct}%;"></div>
          <div class="cap-fill {icon.cls}" style="width:{markerPct}%;"></div>
        {/if}
      </div>
    </div>
  {:else if barStyle === 'thread'}
    <div class="bar-wrap">
      <div class="thread"></div>
      {#if !empty}
        <div class="diamond {icon.cls}" style="left:{markerPct}%;"></div>
      {:else}
        <div class="zero"></div>
      {/if}
    </div>
  {:else}
    <div class="bar-wrap">
      <div class="track">
        {#if !empty}
          <div class="reach {icon.cls}" style="width:{markerPct}%;"></div>
          <div class="coll" style="left:{collStartPct}%; width:{collWidthPct}%;"></div>
        {/if}
      </div>
      {#if !empty}
        <div class="dot {icon.cls}" style="left:{markerPct}%;"></div>
      {:else}
        <div class="zero"></div>
      {/if}
    </div>
  {/if}

  <div class="detail">
    {#if empty}
      <div class="empty">No collateral or credit yet · fund with a faucet or deposit.</div>
    {:else}
      <div class="caprow">
        <span class="send">← can send {outAmount}</span>
        <span class="recv">can receive {inAmount} →</span>
      </div>
      <div class="kv"><span>collateral · your / their</span><span>{fmt(derived.outCollateral)} / {fmt(derived.inCollateral)}</span></div>
      <div class="kv"><span>collateral total</span><span>{fmt(collateralTotal)}</span></div>
      <div class="kv"><span>credit on send side</span><span>{fmt(sendCredit)}</span></div>
      <div class="kv"><span>credit on receive side</span><span>{fmt(recvCredit)}</span></div>
      {#if (derived.outTotalHold ?? 0n) > 0n || (derived.inTotalHold ?? 0n) > 0n}
        <div class="kv hold"><span>holds · out / in</span><span>{fmt(derived.outTotalHold)} / {fmt(derived.inTotalHold)}</span></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .apple-row { display: flex; flex-direction: column; }
  .head {
    display: flex; align-items: center; gap: 12px;
    width: 100%; background: transparent; border: none; cursor: pointer;
    padding: 9px 2px 7px; text-align: left; color: inherit;
  }
  .head:hover .chev { color: #9ca3af; }
  .token-icon {
    width: 30px; height: 30px; border-radius: 50%; flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700;
  }
  .token-icon.usdc { background: #2563eb; color: #e6f0ff; }
  .token-icon.usdt { background: #0f9f6e; color: #eafff6; }
  .token-icon.weth { background: #6d28d9; color: #f2e8ff; }
  .token-icon.other { background: #4b5563; color: #f3f4f6; }
  .meta { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
  .sym { font-size: 15px; font-weight: 600; color: #f3f4f6; letter-spacing: -0.01em; }
  .nm { font-size: 11px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .amt { font-size: 17px; font-weight: 600; color: #f3f4f6; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .act {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
    color: #71717a; border: 1px solid #3f3f46; border-radius: 4px; padding: 2px 6px; cursor: pointer;
  }
  .act:hover { color: #f0fdf4; border-color: rgba(134,239,172,0.6); background: rgba(134,239,172,0.18); }
  .act.disabled { opacity: 0.4; pointer-events: none; }
  .chev { font-size: 18px; color: #52525b; transition: transform 0.2s ease; flex: 0 0 auto; }
  .apple-row.open .chev { transform: rotate(90deg); }

  .bar-wrap { position: relative; margin: 2px 2px 0; height: 11px; }
  .track {
    position: absolute; left: 0; right: 0; top: 3px; height: 6px;
    border-radius: 3px; background: rgba(148,163,184,0.13); overflow: hidden;
  }
  .reach { position: absolute; left: 0; top: 0; bottom: 0; opacity: 0.34; }
  .reach.usdc { background: #3b82f6; } .reach.usdt { background: #10b981; }
  .reach.weth { background: #8b5cf6; } .reach.other { background: #cbd5e1; }
  .coll { position: absolute; top: 0; bottom: 0; background: rgba(148,163,184,0.5); }
  .dot { position: absolute; top: 0; width: 11px; height: 11px; border-radius: 50%; transform: translateX(-5.5px); border: 2.5px solid #0d0f12; box-sizing: border-box; }
  .dot.usdc { background: #3b82f6; } .dot.usdt { background: #10b981; }
  .dot.weth { background: #8b5cf6; } .dot.other { background: #cbd5e1; }
  .zero { position: absolute; left: 50%; top: 2px; width: 1px; height: 7px; background: rgba(148,163,184,0.3); }

  .bar-wrap.pips { display: flex; align-items: center; gap: 4px; }
  .pip { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
  .pip.off { background: rgba(148,163,184,0.16); }
  .pip.on.usdc { background: #3b82f6; }
  .pip.on.usdt { background: #10b981; }
  .pip.on.weth { background: #8b5cf6; }
  .pip.on.other { background: #cbd5e1; }

  .bar-wrap.twin { display: flex; flex-direction: column; justify-content: center; gap: 5px; }
  .twin-line { height: 3px; border-radius: 2px; }
  .twin-line.off { background: rgba(148,163,184,0.18); }
  .twin-line.usdc { background: #3b82f6; }
  .twin-line.usdt { background: #10b981; }
  .twin-line.weth { background: #8b5cf6; }
  .twin-line.other { background: #cbd5e1; }

  .capsule { position: absolute; left: 0; right: 0; top: 3px; height: 7px; border-radius: 4px; background: rgba(148,163,184,0.14); overflow: hidden; }
  .cap-coll { position: absolute; top: 0; bottom: 0; background: rgba(148,163,184,0.4); }
  .cap-fill { position: absolute; left: 0; top: 0; bottom: 0; }
  .cap-fill.usdc { background: #3b82f6; } .cap-fill.usdt { background: #10b981; }
  .cap-fill.weth { background: #8b5cf6; } .cap-fill.other { background: #cbd5e1; }

  .thread { position: absolute; left: 0; right: 0; top: 6px; height: 1px; background: rgba(148,163,184,0.22); }
  .diamond { position: absolute; top: 3px; width: 7px; height: 7px; transform: translateX(-3.5px) rotate(45deg); }
  .diamond.usdc { background: #3b82f6; } .diamond.usdt { background: #10b981; }
  .diamond.weth { background: #8b5cf6; } .diamond.other { background: #cbd5e1; }

  .detail { overflow: hidden; max-height: 0; opacity: 0; transition: max-height 0.25s ease, opacity 0.2s ease; }
  .apple-row.open .detail { max-height: 240px; opacity: 1; padding-bottom: 8px; }
  .caprow { display: flex; justify-content: space-between; font-size: 11px; color: #9ca3af; margin: 10px 0 8px; }
  .send { color: #d1d5db; }
  .recv { color: #d1d5db; }
  .kv { display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0; color: #9ca3af; }
  .kv span:last-child { color: #e5e7eb; font-variant-numeric: tabular-nums; }
  .kv.hold span:last-child { color: #fbbf24; }
  .empty { font-size: 12px; color: #6b7280; padding: 10px 0 4px; }
</style>
