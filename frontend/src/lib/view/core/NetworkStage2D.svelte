<script lang="ts">
  /**
   * 2D stage: one account, at a size where it can be read.
   *
   * The step names two parties, so those two get the frame — their account's capacity bar
   * spans it, with every region labelled in real type. The rest of the network is a
   * context map, not the subject. Nothing here is scenario-specific: the frame comes from
   * whatever the selected step is about.
   */

  import type { RuntimeAdapterGraphFrame } from '@xln/runtime/xln-api';
  import type { Delta } from '$types';
  import { networkMachineRuntime } from '$lib/stores/networkMachineRuntimeStore';
  import { focusEntityIdsForStep } from '$lib/network3d/networkCaption';
  import { compactAmount, ringLayout, stageBarFor, type StageRegionKind } from '$lib/network3d/networkStage2d';
  import { xlnFunctions } from '$lib/stores/xlnStore';

  /**
   * Colour carries the meaning: amber is capacity granted, teal is collateral posted, red
   * is credit actually drawn. The two collateral shades say who holds it — bright is the
   * party on the left of the marker, muted is the peer.
   */
  const REGION_FILL: Record<StageRegionKind, string> = {
    ownCreditFree: '#c9902a',
    ownCreditDrawn: '#e24b4a',
    collateralOwn: '#35d6c3',
    collateralPeer: '#2b7c70',
    peerCreditDrawn: '#e24b4a',
    peerCreditFree: '#c9902a',
  };
  const REGION_LABEL: Record<StageRegionKind, string> = {
    ownCreditFree: 'credit available',
    ownCreditDrawn: 'credit drawn',
    collateralPeer: 'collateral',
    collateralOwn: 'collateral',
    peerCreditDrawn: 'credit drawn',
    peerCreditFree: 'credit available',
  };

  const id = (value: unknown): string => String(value ?? '').trim().toLowerCase();

  $: frames = Array.from($networkMachineRuntime.frames.values()) as RuntimeAdapterGraphFrame[];
  $: entities = frames.flatMap((frame) => frame.entities);
  $: selected = $networkMachineRuntime.selectedStep;

  $: focusIds = selected
    ? focusEntityIdsForStep(
        { runtimeId: selected.activeRuntimeId, height: selected.event.height, cues: selected.cues },
        $networkMachineRuntime.activity,
      )
    : [];

  const labelOf = (entityId: string): string => {
    const entity = entities.find((candidate) => id(candidate.summary.entityId) === id(entityId));
    return String(entity?.summary.label || entity?.core?.profile?.name || entityId.slice(0, 6));
  };

  type AccountView = {
    leftId: string;
    rightId: string;
    tokenId: number;
    deltas: Map<number, Delta>;
  };

  /** The account between two entities, from whichever side recorded it. */
  const accountBetween = (a: string, b: string): AccountView | null => {
    for (const entity of entities) {
      for (const account of entity.accounts?.items ?? []) {
        const left = id((account as { leftEntity?: string }).leftEntity);
        const right = id((account as { rightEntity?: string }).rightEntity);
        if (!((left === id(a) && right === id(b)) || (left === id(b) && right === id(a)))) continue;
        const deltas = (account as { deltas?: Map<number, Delta> }).deltas;
        if (!(deltas instanceof Map) || deltas.size === 0) continue;
        const tokenId = Array.from(deltas.keys()).sort((x, y) => x - y)[0];
        if (tokenId === undefined) continue;
        return { leftId: left, rightId: right, tokenId, deltas };
      }
    }
    return null;
  };

  const counterpartiesOf = (entityId: string): string[] => {
    const ids = new Set<string>();
    for (const entity of entities) {
      for (const item of entity.accounts?.items ?? []) {
        const left = id((item as { leftEntity?: string }).leftEntity);
        const right = id((item as { rightEntity?: string }).rightEntity);
        if (left === id(entityId)) ids.add(right);
        if (right === id(entityId)) ids.add(left);
      }
    }
    return Array.from(ids);
  };

  /**
   * The account this step is about.
   *
   * The step names a payer and a payee, and a routed payment has no account between them —
   * it has a hop. When the pair is not adjacent, show the first hop out of the payer:
   * that is the account the payment actually moved.
   */
  const accountForStep = (from: string, to: string): AccountView | null => {
    const direct = accountBetween(from, to);
    if (direct) return direct;
    for (const hop of counterpartiesOf(from)) {
      if (accountBetween(hop, to)) return accountBetween(from, hop);
    }
    return null;
  };

  $: account = focusIds.length >= 2 ? accountForStep(focusIds[0] ?? '', focusIds[1] ?? '') : null;

  $: focusDelta = account?.deltas.get(account.tokenId) ?? null;
  $: derived = focusDelta && $xlnFunctions.isReady
    ? $xlnFunctions.deriveDelta(focusDelta, true)
    : null;
  $: bar = derived ? stageBarFor(derived) : null;

  const money = (tokenId: number, amount: bigint): string =>
    $xlnFunctions.isReady ? $xlnFunctions.formatTokenAmount(tokenId, amount) : String(amount);

  const reserveOf = (entityId: string, tokenId: number): string => {
    const entity = entities.find((candidate) => id(candidate.summary.entityId) === id(entityId));
    const reserves = entity?.core?.reserves;
    const amount = reserves instanceof Map ? (reserves.get(tokenId) ?? 0n) : 0n;
    const decimals = $xlnFunctions.isReady ? ($xlnFunctions.getTokenInfo?.(tokenId)?.decimals ?? 6) : 6;
    return compactAmount(Number(amount) / 10 ** decimals);
  };

  const symbolOf = (tokenId: number): string =>
    $xlnFunctions.isReady ? ($xlnFunctions.getTokenInfo?.(tokenId)?.symbol ?? '') : '';

  // Context map: every entity on a deterministic ring, edges where an account exists.
  $: mapEntityIds = Array.from(new Set(entities.map((entity) => id(entity.summary.entityId)))).sort();
  $: mapPoints = ringLayout(mapEntityIds.length, 46);
  $: mapEdges = (() => {
    const seen = new Set<string>();
    const edges: Array<{ a: number; b: number; focused: boolean }> = [];
    for (const entity of entities) {
      for (const item of entity.accounts?.items ?? []) {
        const left = id((item as { leftEntity?: string }).leftEntity);
        const right = id((item as { rightEntity?: string }).rightEntity);
        const key = [left, right].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const a = mapEntityIds.indexOf(left);
        const b = mapEntityIds.indexOf(right);
        if (a < 0 || b < 0) continue;
        const focused = focusIds.includes(left) && focusIds.includes(right);
        edges.push({ a, b, focused });
      }
    }
    return edges;
  })();

  const BAR_X = 130;
  const BAR_W = 740;
  const BAR_Y = 286;
  const BAR_H = 52;
  $: markerX = BAR_X + (bar?.markerAt ?? 0.5) * BAR_W;
</script>

<div class="stage" data-testid="network-stage-2d">
  <svg viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Account capacity">
    {#if bar && account && derived}
      <text class="party left" x={BAR_X} y={BAR_Y - 74}>{labelOf(account.leftId)}</text>
      <text class="reserve left" x={BAR_X} y={BAR_Y - 50}>
        {reserveOf(account.leftId, account.tokenId)} {symbolOf(account.tokenId)} reserve
      </text>
      <text class="party right" x={BAR_X + BAR_W} y={BAR_Y - 74}>{labelOf(account.rightId)}</text>
      <text class="reserve right" x={BAR_X + BAR_W} y={BAR_Y - 50}>
        {reserveOf(account.rightId, account.tokenId)} {symbolOf(account.tokenId)} reserve
      </text>

      <rect class="trough" x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H} rx="4" />
      {#each bar.regions as region (region.kind)}
        <rect
          class="region"
          data-kind={region.kind}
          x={BAR_X + region.start * BAR_W}
          y={BAR_Y}
          width={Math.max(0, region.size * BAR_W)}
          height={BAR_H}
          fill={REGION_FILL[region.kind]}
        />
      {/each}
      <rect class="frame" x={BAR_X} y={BAR_Y} width={BAR_W} height={BAR_H} rx="4" />

      {#each bar.regions.filter((region) => region.size > 0.06) as region (region.kind)}
        <text class="region-amount" data-kind={region.kind} x={BAR_X + (region.start + region.size / 2) * BAR_W} y={BAR_Y + 32}>
          {money(account.tokenId, region.amount)}
        </text>
        <text class="region-label" x={BAR_X + (region.start + region.size / 2) * BAR_W} y={BAR_Y + BAR_H + 22}>
          {REGION_LABEL[region.kind]}
        </text>
      {/each}

      <g class="marker">
        <line x1={markerX} x2={markerX} y1={BAR_Y - 14} y2={BAR_Y + BAR_H + 6} />
        <polygon points={`${markerX - 7},${BAR_Y - 16} ${markerX + 7},${BAR_Y - 16} ${markerX},${BAR_Y - 4}`} />
        <text class="marker-label" x={Math.min(BAR_X + BAR_W - 46, Math.max(BAR_X + 46, markerX))} y={BAR_Y - 26}>
          Δ {money(account.tokenId, derived.delta)}
        </text>
      </g>

      <text class="axis-hint left" x={BAR_X} y={BAR_Y + BAR_H + 54}>
        {labelOf(account.leftId)} can send {money(account.tokenId, derived.outCapacity)} →
      </text>
      <text class="axis-hint right" x={BAR_X + BAR_W} y={BAR_Y + BAR_H + 54}>
        ← {labelOf(account.rightId)} can send {money(account.tokenId, derived.inCapacity)}
      </text>
    {:else}
      <text class="empty" x="500" y="300">Waiting for an account to show</text>
    {/if}

    <g class="map" transform="translate(872, 128)">
      {#each mapEdges as edge (`${edge.a}-${edge.b}`)}
        <line
          class:focused={edge.focused}
          x1={mapPoints[edge.a]?.x ?? 0}
          y1={mapPoints[edge.a]?.y ?? 0}
          x2={mapPoints[edge.b]?.x ?? 0}
          y2={mapPoints[edge.b]?.y ?? 0}
        />
      {/each}
      {#each mapEntityIds as entityId, index (entityId)}
        <circle
          class:focused={focusIds.includes(entityId)}
          cx={mapPoints[index]?.x ?? 0}
          cy={mapPoints[index]?.y ?? 0}
          r={focusIds.includes(entityId) ? 7 : 5}
        />
        <text class="map-label" x={mapPoints[index]?.x ?? 0} y={(mapPoints[index]?.y ?? 0) - 12}>{labelOf(entityId)}</text>
      {/each}
    </g>
  </svg>
</div>

<style>
  .stage { position: absolute; inset: 0; display: grid; place-items: center; background: #08090b; }
  svg { width: 100%; height: 100%; }

  text { font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; fill: #e8ecf1; }

  .party { font-size: 30px; font-weight: 500; }
  .party.right, .reserve.right, .axis-hint.right { text-anchor: end; }
  .reserve { font-size: 14px; fill: #8b95a5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .trough { fill: #14181e; }
  .frame { fill: none; stroke: rgba(255,255,255,.14); }
  /* Geometry animates so a step reads as a change to one account, not a new picture. */
  .region { transition: x .38s cubic-bezier(.4,0,.2,1), width .38s cubic-bezier(.4,0,.2,1); }

  /* Dark ink on the bright fills, light ink on the dark ones — never one rule for both. */
  .region-amount { font-size: 13px; text-anchor: middle; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; fill: #0b1114; }
  .region-amount[data-kind="ownCreditDrawn"],
  .region-amount[data-kind="peerCreditDrawn"],
  .region-amount[data-kind="collateralPeer"] { fill: #f4f7fa; }
  .region-label { font-size: 12px; text-anchor: middle; fill: #8b95a5; }

  .marker line { stroke: #f4f7fa; stroke-width: 2; }
  .marker polygon { fill: #f4f7fa; }
  .marker-label { font-size: 13px; text-anchor: middle; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; fill: #f4f7fa; }

  .axis-hint { font-size: 13px; fill: #6b7583; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .map line { stroke: #2a313a; stroke-width: 1.5; }
  .map line.focused { stroke: #5DCAA5; stroke-width: 2.5; }
  .map circle { fill: #2a313a; }
  .map circle.focused { fill: #5DCAA5; }
  .map-label { font-size: 11px; text-anchor: middle; fill: #6b7583; }

  .empty { font-size: 15px; text-anchor: middle; fill: #5f6875; }
</style>
