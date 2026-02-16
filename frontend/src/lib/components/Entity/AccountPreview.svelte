<script lang="ts">
  import type { AccountMachine } from '$lib/types/ui';
  import { createEventDispatcher } from 'svelte';
  import { xlnFunctions } from '../../stores/xlnStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { settings } from '../../stores/settingsStore';
  import { p2pState } from '../../stores/xlnStore';
  import EntityIdentity from '../shared/EntityIdentity.svelte';

  export let account: AccountMachine;
  export let counterpartyId: string;
  export let entityId: string;
  export let isSelected: boolean = false;

  const dispatch = createEventDispatcher();

  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;

  // Gossip helpers
  function getGossipProfiles(): any[] {
    const envData = entityEnv?.env ? (entityEnv.env as any) : null;
    if (!envData?.gossip) return [];
    return typeof envData.gossip.getProfiles === 'function'
      ? envData.gossip.getProfiles()
      : (envData.gossip.profiles || []);
  }

  function getProfile(id: string): any {
    return getGossipProfiles().find((p: any) =>
      String(p?.entityId || '').toLowerCase() === String(id).toLowerCase()
    );
  }

  $: counterpartyName = getProfile(counterpartyId)?.metadata?.name || '';

  $: isHub = (() => {
    const profile = getProfile(counterpartyId);
    if (!profile) return false;
    return !!(profile.metadata?.isHub === true ||
      (Array.isArray(profile.capabilities) && profile.capabilities.includes('hub')));
  })();

  // P2P connection state
  $: connState = (() => {
    const profile = getProfile(counterpartyId);
    const runtimeId = profile?.runtimeId;
    if (!runtimeId) return 'unknown';
    if (!$p2pState.connected) return 'disconnected';
    const peerQueued = $p2pState.queue.perTarget[runtimeId.toLowerCase()] ?? 0;
    return peerQueued > 0 ? 'queued' : 'connected';
  })();

  // Aggregate across all deltas
  $: agg = (() => {
    if (!account.deltas || account.deltas.size === 0 || !activeXlnFunctions) {
      return { outCap: 0n, inCap: 0n, outCredit: 0n, outColl: 0n, outDebt: 0n,
               inCredit: 0n, inColl: 0n, inDebt: 0n, outTotal: 0n, inTotal: 0n,
               tokenCount: 0, primaryTokenId: 1, primarySymbol: '?' };
    }

    const isLeft = entityId < counterpartyId;
    let outCap = 0n, inCap = 0n;
    let outCredit = 0n, outColl = 0n, outDebt = 0n;
    let inCredit = 0n, inColl = 0n, inDebt = 0n;
    let primaryTokenId = 1;
    let primarySymbol = '?';

    for (const [tokenId, delta] of account.deltas.entries()) {
      const d = activeXlnFunctions.deriveDelta(delta, isLeft);
      outCap += d.outCapacity;
      inCap += d.inCapacity;
      outCredit += d.outOwnCredit;
      outColl += d.outCollateral;
      outDebt += d.outPeerCredit;
      inDebt += d.inOwnCredit;
      inColl += d.inCollateral;
      inCredit += d.inPeerCredit;
      const info = activeXlnFunctions.getTokenInfo(tokenId);
      if (info?.symbol) { primaryTokenId = tokenId; primarySymbol = info.symbol; }
    }

    const outTotal = outCredit + outColl + outDebt;
    const inTotal = inDebt + inColl + inCredit;

    return { outCap, inCap, outCredit, outColl, outDebt,
             inCredit, inColl, inDebt, outTotal, inTotal,
             tokenCount: account.deltas.size, primaryTokenId, primarySymbol };
  })();

  $: halfMax = agg.outTotal > agg.inTotal ? agg.outTotal : agg.inTotal;
  $: pctOf = (v: bigint, base: bigint) => base > 0n ? Number((v * 10000n) / base) / 100 : 0;

  $: isPending = account.mempool.length > 0 || (account as any).pendingFrame;

  function handleClick() {
    dispatch('select', { accountId: counterpartyId });
  }

  function handleFaucet(e: MouseEvent) {
    e.stopPropagation();
    dispatch('faucet', { counterpartyId, tokenId: agg.primaryTokenId });
  }
</script>

<div
  class="account-preview"
  class:selected={isSelected}
  on:click={handleClick}
  on:keydown={(e) => e.key === 'Enter' && handleClick()}
  role="button"
  tabindex="0"
>
  <!-- Row 1: Entity + status -->
  <div class="row-header">
    <div class="entity-col">
      <EntityIdentity entityId={counterpartyId} name={counterpartyName} size={22} clickable={false} compact={false} copyable={false} showAddress={true} />
    </div>
    <div class="status-col">
      <span class="conn-dot {connState}"></span>
      <span class="badge" class:synced={!isPending} class:pending={isPending}>
        {isPending ? 'Pending' : 'Synced'}
      </span>
      <button class="btn-faucet" on:click={handleFaucet}>Faucet</button>
    </div>
  </div>

  <!-- Row 2: Aggregate bar -->
  {#if agg.outTotal > 0n || agg.inTotal > 0n}
    <div class="row-bar">
      <span class="cap-label">OUT {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.outCap) || '0'}</span>
      <span class="cap-token">{agg.primarySymbol}{agg.tokenCount > 1 ? ` +${agg.tokenCount - 1}` : ''}</span>
      <span class="cap-label">IN {activeXlnFunctions?.formatTokenAmount(agg.primaryTokenId, agg.inCap) || '0'}</span>
    </div>

    {#if $settings.barLayout === 'center'}
      <div class="bar center">
        <div class="half out">
          {#if agg.outCredit > 0n}<div class="seg credit" style="width:{pctOf(agg.outCredit, halfMax)}%"></div>{/if}
          {#if agg.outColl > 0n}<div class="seg coll" style="width:{pctOf(agg.outColl, halfMax)}%"></div>{/if}
          {#if agg.outDebt > 0n}<div class="seg debt" style="width:{pctOf(agg.outDebt, halfMax)}%"></div>{/if}
        </div>
        <div class="mid"></div>
        <div class="half in">
          {#if agg.inDebt > 0n}<div class="seg debt" style="width:{pctOf(agg.inDebt, halfMax)}%"></div>{/if}
          {#if agg.inColl > 0n}<div class="seg coll" style="width:{pctOf(agg.inColl, halfMax)}%"></div>{/if}
          {#if agg.inCredit > 0n}<div class="seg credit" style="width:{pctOf(agg.inCredit, halfMax)}%"></div>{/if}
        </div>
      </div>
    {:else}
      <div class="bar sides">
        <div class="side out">
          {#if agg.outDebt > 0n}<div class="seg debt" style="flex:{Number(agg.outDebt)}"></div>{/if}
          {#if agg.outColl > 0n}<div class="seg coll" style="flex:{Number(agg.outColl)}"></div>{/if}
          {#if agg.outCredit > 0n}<div class="seg credit" style="flex:{Number(agg.outCredit)}"></div>{/if}
        </div>
        <div class="gap"></div>
        <div class="side in">
          {#if agg.inDebt > 0n}<div class="seg debt" style="flex:{Number(agg.inDebt)}"></div>{/if}
          {#if agg.inColl > 0n}<div class="seg coll" style="flex:{Number(agg.inColl)}"></div>{/if}
          {#if agg.inCredit > 0n}<div class="seg credit" style="flex:{Number(agg.inCredit)}"></div>{/if}
        </div>
      </div>
    {/if}
  {:else}
    <div class="empty">No capacity</div>
  {/if}

  {#if account.settlementWorkspace}
    <span class="settle {account.settlementWorkspace.status}">
      {account.settlementWorkspace.status.replace(/_/g, ' ')}
    </span>
  {/if}
</div>

<style>
  .account-preview {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 12px 14px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .account-preview:hover {
    border-color: #3f3f46;
    background: #1c1c20;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }
  .account-preview.selected {
    border-color: #fbbf24;
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.04) 0%, transparent 100%);
  }

  /* ── Header ───────────────────────────────────── */
  .row-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    gap: 10px;
  }
  .entity-col { min-width: 0; flex: 1; }
  .status-col {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-shrink: 0;
  }

  .conn-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .conn-dot.connected { background: #4ade80; box-shadow: 0 0 4px rgba(74, 222, 128, 0.4); }
  .conn-dot.queued { background: #fbbf24; animation: pulse 2s infinite; box-shadow: 0 0 4px rgba(251, 191, 36, 0.4); }
  .conn-dot.disconnected { background: #3f3f46; }
  .conn-dot.unknown { background: transparent; border: 1px solid #3f3f46; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .badge {
    font-size: 0.6em;
    padding: 3px 8px;
    border-radius: 5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .badge.synced { color: #4ade80; background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.12); }
  .badge.pending { color: #fbbf24; background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.12); }

  .btn-faucet {
    font-size: 0.6em;
    padding: 3px 10px;
    border-radius: 5px;
    border: 1px solid #3f3f46;
    background: transparent;
    color: #71717a;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    transition: all 0.15s;
  }
  .btn-faucet:hover {
    border-color: #0ea5e9;
    color: #0ea5e9;
    background: rgba(14, 165, 233, 0.05);
  }

  /* ── Bar labels ───────────────────────────────── */
  .row-bar {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-family: 'JetBrains Mono','SF Mono','Monaco','Menlo',monospace;
    font-size: 0.65em;
    letter-spacing: 0.02em;
    margin-bottom: 4px;
  }
  .cap-label { color: #71717a; font-weight: 500; }
  .cap-token { color: #a1a1aa; font-weight: 600; }

  /* ── Bar core ─────────────────────────────────── */
  .bar {
    display: flex;
    align-items: stretch;
    height: 8px;
    background: #27272a;
    border-radius: 4px;
    overflow: hidden;
  }
  .seg { min-width: 2px; transition: width 0.3s ease, flex 0.3s ease; }
  .seg.credit { background: #52525b; }
  .seg.coll { background: linear-gradient(180deg, #34d399, #10b981); }
  .seg.debt { background: linear-gradient(180deg, #fb7185, #f43f5e); }

  /* Center mode */
  .bar.center { flex-direction: row; }
  .half { flex:1; display:flex; align-items:stretch; overflow:hidden; }
  .half.out { justify-content: flex-end; }
  .half.in { justify-content: flex-start; }
  .mid { width:2px; background:#52525b; flex-shrink:0; border-radius:1px; }

  /* Sides mode */
  .bar.sides { gap:3px; background:transparent; }
  .side { flex:1; display:flex; align-items:stretch; height:8px; background:#27272a; border-radius:4px; overflow:hidden; }
  .side.out { justify-content: flex-end; }
  .side.in { justify-content: flex-start; }
  .gap { width:2px; flex-shrink:0; }

  /* ── Misc ──────────────────────────────────────── */
  .empty { font-size:0.65em; color:#52525b; padding:4px 0; font-style: italic; }

  .settle {
    display: inline-block;
    margin-top: 6px;
    font-size: 0.55em;
    padding: 3px 8px;
    border-radius: 5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    color: #71717a;
    background: rgba(113,113,122,0.08);
    border: 1px solid rgba(113,113,122,0.1);
  }
  .settle.awaiting_counterparty { color:#fbbf24; background:rgba(251,191,36,0.08); border-color: rgba(251,191,36,0.12); }
  .settle.ready_to_submit { color:#4ade80; background:rgba(74,222,128,0.08); border-color: rgba(74,222,128,0.12); }
  .settle.submitted { color:#60a5fa; background:rgba(96,165,250,0.08); border-color: rgba(96,165,250,0.12); }
</style>
