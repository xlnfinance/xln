<script lang="ts">
  import {
    Activity,
    AlertTriangle,
    CheckCircle2,
    CircleGauge,
    Coins,
    Database,
    GitBranch,
    HardDrive,
    Landmark,
    Layers3,
    LoaderCircle,
    Radio,
    Route,
    Server,
    ShieldCheck,
    Store,
    WalletCards,
    Wifi,
  } from 'lucide-svelte';

  type IconComponent = typeof Activity;

  type HealthData = {
    timestamp: number;
    coreOk?: boolean | undefined;
    systemOk?: boolean | undefined;
    degraded?: string[];
    boot?: {
      phase?: string | null;
      startedAt?: number | null;
      completedAt?: number | null;
      error?: string | null;
    };
    reset?: {
      inProgress?: boolean;
      completedAt?: number | null;
      lastError?: string | null;
      hasError?: boolean;
    };
    jMachines?: Array<{
      name: string;
      status: 'healthy' | 'degraded' | 'down';
      lastBlock?: number;
    }>;
    hubs?: Array<{
      entityId: string;
      name: string;
      online?: boolean;
      status?: 'healthy' | 'degraded' | 'down';
    }>;
    relay?: {
      activeClientCount?: number;
      clientCount?: number;
      profileCount?: number;
    };
    system: {
      runtime: boolean;
      p2p?: boolean;
      relay: boolean;
    };
    process?: {
      children?: Array<{
        role?: string;
        name: string;
        online: boolean;
        restartCount?: number;
        apiPort?: number;
        lastErrorLine?: string | null;
      }>;
    };
    disk?: {
      ok?: boolean;
      freeGiB?: number;
      freeBytes?: number;
      usedPct?: number;
    };
    storage?: { ok?: boolean };
    hubMesh?: {
      ok?: boolean;
      direct?: { openLinkCount?: number };
      pairs?: Array<{ ok: boolean }>;
    };
    marketMaker?: {
      enabled?: boolean;
      ok?: boolean;
      entityId?: string | null;
      startupPhase?: string | null;
      expectedOffersPerHub?: number;
      expectedOffersPerPair?: number;
      hubCount?: number;
      cross?: {
        applicable?: boolean;
        ok?: boolean;
        expectedRoutes?: number;
        expectedOffersPerRoute?: number;
        expectedOffersPerPair?: number;
        routeCount?: number;
        routes?: Array<{
          sourceJurisdiction?: string;
          targetJurisdiction?: string;
          offers?: number;
          ready?: boolean;
          depthReady?: boolean;
          expectedOffers?: number;
          pairs?: Array<{
            pairId?: string;
            offers?: number;
            ready?: boolean;
            depthReady?: boolean;
            expectedOffers?: number;
          }>;
        }>;
      };
      hubs?: Array<{
        hubEntityId: string;
        offers: number;
        ready: boolean;
        depthReady?: boolean;
        pairs?: Array<{
          pairId: string;
          offers: number;
          ready: boolean;
          depthReady?: boolean;
          expectedOffers?: number;
        }>;
      }>;
    };
    custody?: {
      enabled?: boolean;
      ok?: boolean;
      entityId?: string | null;
    };
    bootstrapReserves?: {
      ok?: boolean;
      targetMet?: boolean;
      requiredTokenCount?: number;
      entityCount?: number;
      entities?: Array<{
        entityId: string;
        role?: 'hub' | 'market-maker';
        ready: boolean;
        targetMet: boolean;
        tokens: Array<{
          tokenId: number;
          symbol: string;
          ready: boolean;
          targetMet?: boolean;
        }>;
      }>;
    };
  };

  type Props = {
    health: HealthData;
    rpcOk: boolean | null;
    rpcLatencyMs: number | null;
    criticalCount?: number;
  };

  type BootstrapStage = {
    key: string;
    label: string;
    value: string;
    detail: string;
    ok: boolean | null;
    progress: number;
    tone: 'blue' | 'green' | 'amber' | 'red' | 'violet';
    icon: IconComponent;
  };

  type ProcessLane = {
    key: string;
    label: string;
    value: string;
    detail: string;
    ok: boolean;
    icon: IconComponent;
  };

  let { health, rpcOk, rpcLatencyMs, criticalCount = 0 }: Props = $props();

  const terminalReady = $derived(
    health.systemOk === true &&
      (health.marketMaker?.enabled !== true || health.marketMaker?.startupPhase === 'offers-ready'),
  );
  const stages = $derived.by(() => buildBootstrapStages(health, rpcOk));
  const activeStageIndex = $derived(stages.findIndex((stage) => stage.ok !== true));
  const overallProgress = $derived(Math.round(
    stages.reduce((sum, stage) => sum + stage.progress, 0) / Math.max(1, stages.length),
  ));
  const processLanes = $derived.by(() => buildProcessLanes(health));
  const mmHubs = $derived(health.marketMaker?.hubs ?? []);
  const mmCrossRoutes = $derived(health.marketMaker?.cross?.routes ?? []);
  const reserveEntities = $derived(health.bootstrapReserves?.entities ?? []);

  function numberOrZero(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function ratioPercent(done: number, total: number): number {
    if (!Number.isFinite(total) || total <= 0) return done > 0 ? 100 : 0;
    return clampPercent((done / total) * 100);
  }

  function formatCount(value: number | null | undefined): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return new Intl.NumberFormat('en-US').format(Math.max(0, Math.floor(n)));
  }

  function formatLatency(ms: number | null): string {
    if (typeof ms !== 'number') return 'checking';
    return `${Math.max(0, Math.round(ms))}ms`;
  }

  function formatTime(ts: number | null | undefined): string {
    if (!ts) return '-';
    return new Date(ts).toLocaleTimeString();
  }

  function short(id?: string | null, len = 8): string {
    const value = String(id || '');
    if (!value) return '-';
    return value.length <= len ? value : `${value.slice(0, len)}...${value.slice(-4)}`;
  }

  function progressStyle(progress: number): string {
    return `--progress:${clampPercent(progress)}%`;
  }

  function boolProgress(ok: boolean | null): number {
    if (ok === true) return 100;
    if (ok === false) return 0;
    return 35;
  }

  function buildBootstrapStages(data: HealthData, rpcHealthy: boolean | null): BootstrapStage[] {
    const hubs = data.hubs ?? [];
    const onlineHubs = hubs.filter((hub) => hub.online === true).length;
    const totalHubs = hubs.length;
    const jMachines = data.jMachines ?? [];
    const healthyJ = jMachines.filter((machine) => machine.status === 'healthy').length;
    const jDetail = jMachines.length > 0
      ? `${healthyJ}/${jMachines.length} J-machines healthy`
      : 'runtime health active';
    const meshPairs = data.hubMesh?.pairs ?? [];
    const meshReadyPairs = meshPairs.filter((pair) => pair.ok).length;
    const custodyEnabled = data.custody?.enabled === true;
    const custodyOk = custodyEnabled ? data.custody?.ok === true : true;
    const reserveEntities = data.bootstrapReserves?.entities ?? [];
    const readyReserveEntities = reserveEntities.filter((entity) => entity.ready && entity.targetMet).length;
    const reservesOk = data.bootstrapReserves?.ok === true && data.bootstrapReserves?.targetMet === true;
    const mmEnabled = data.marketMaker?.enabled === true;
    const mmHubCount = (data.marketMaker?.hubs?.length ?? data.marketMaker?.hubCount ?? 0);
    const mmExpectedHubOffers = numberOrZero(data.marketMaker?.expectedOffersPerHub);
    const mmOfferTotal = (data.marketMaker?.hubs ?? []).reduce((sum, hub) => sum + numberOrZero(hub.offers), 0);
    const mmExpectedTotal = mmExpectedHubOffers * Math.max(1, mmHubCount);
    const mmFullHubs = (data.marketMaker?.hubs ?? []).filter((hub) =>
      hub.depthReady === true || (mmExpectedHubOffers > 0 && numberOrZero(hub.offers) >= mmExpectedHubOffers),
    ).length;
    const cross = data.marketMaker?.cross;
    const routeCount = cross?.routes?.length ?? cross?.routeCount ?? 0;
    const expectedRoutes = numberOrZero(cross?.expectedRoutes);
    const crossDepthRoutes = (cross?.routes ?? []).filter((route) => route.depthReady === true).length;
    const crossApplicable = cross?.applicable !== false && (expectedRoutes > 0 || routeCount > 0);
    const storageOk = (data.storage?.ok ?? data.disk?.ok) === true;
    const resetOk = data.reset?.inProgress === true
      ? null
      : data.reset?.lastError || data.reset?.hasError
        ? false
        : true;

    return [
      {
        key: 'reset',
        label: 'Reset barrier',
        value: data.reset?.inProgress ? 'running' : data.reset?.completedAt ? 'complete' : 'clear',
        detail: data.reset?.lastError ? 'last reset error present' : `completed ${formatTime(data.reset?.completedAt)}`,
        ok: resetOk,
        progress: boolProgress(resetOk),
        tone: resetOk === false ? 'red' : 'blue',
        icon: LoaderCircle,
      },
      {
        key: 'runtime',
        label: 'Runtime + RPC',
        value: data.system.runtime ? formatLatency(rpcLatencyMs) : 'down',
        detail: jDetail,
        ok: data.system.runtime && rpcHealthy !== false ? true : rpcHealthy === null ? null : false,
        progress: data.system.runtime ? (rpcHealthy === false ? 55 : 100) : 0,
        tone: 'green',
        icon: Activity,
      },
      {
        key: 'hubs',
        label: 'Hub processes',
        value: `${onlineHubs}/${totalHubs || 3} online`,
        detail: `${formatCount(data.relay?.profileCount ?? totalHubs)} gossip profiles`,
        ok: totalHubs > 0 ? onlineHubs === totalHubs : null,
        progress: ratioPercent(onlineHubs, totalHubs || 3),
        tone: 'blue',
        icon: Server,
      },
      {
        key: 'mesh',
        label: 'Direct mesh',
        value: `${formatCount(data.hubMesh?.direct?.openLinkCount ?? 0)} links`,
        detail: `${meshReadyPairs}/${meshPairs.length || 3} peer pairs ready`,
        ok: data.hubMesh?.ok ?? null,
        progress: data.hubMesh?.ok === true ? 100 : ratioPercent(meshReadyPairs, meshPairs.length || 3),
        tone: 'violet',
        icon: GitBranch,
      },
      {
        key: 'relay',
        label: 'Relay sockets',
        value: `${formatCount(data.relay?.activeClientCount ?? data.relay?.clientCount ?? 0)} clients`,
        detail: data.system.relay ? 'relay accepting runtime traffic' : 'relay not ready',
        ok: data.system.relay === true,
        progress: boolProgress(data.system.relay === true),
        tone: 'blue',
        icon: Radio,
      },
      {
        key: 'custody',
        label: 'Custody',
        value: custodyEnabled ? (custodyOk ? 'ready' : 'blocked') : 'disabled',
        detail: custodyEnabled ? short(data.custody?.entityId, 14) : 'not required for this boot',
        ok: custodyOk,
        progress: boolProgress(custodyOk),
        tone: custodyOk ? 'green' : 'red',
        icon: WalletCards,
      },
      {
        key: 'reserves',
        label: 'Bootstrap reserves',
        value: `${readyReserveEntities}/${reserveEntities.length || data.bootstrapReserves?.entityCount || 0} entities`,
        detail: `${formatCount(data.bootstrapReserves?.requiredTokenCount ?? 0)} token targets`,
        ok: reservesOk,
        progress: reserveEntities.length > 0
          ? ratioPercent(readyReserveEntities, reserveEntities.length)
          : boolProgress(data.bootstrapReserves?.ok ?? null),
        tone: 'amber',
        icon: Coins,
      },
      {
        key: 'mm-books',
        label: 'MM same-chain books',
        value: mmEnabled ? `${mmFullHubs}/${mmHubCount || 3} hubs` : 'disabled',
        detail: `${formatCount(mmOfferTotal)}/${formatCount(mmExpectedTotal)} resting offers`,
        ok: mmEnabled ? mmFullHubs > 0 && mmFullHubs >= (mmHubCount || 3) : true,
        progress: mmEnabled ? ratioPercent(mmOfferTotal, mmExpectedTotal) : 100,
        tone: 'green',
        icon: Store,
      },
      {
        key: 'mm-cross',
        label: 'MM cross routes',
        value: crossApplicable ? `${crossDepthRoutes || (cross?.ok ? expectedRoutes : 0)}/${expectedRoutes || routeCount} routes` : 'neutral',
        detail: `phase ${data.marketMaker?.startupPhase ?? 'unknown'}`,
        ok: mmEnabled && crossApplicable ? cross?.ok === true : true,
        progress: !mmEnabled || !crossApplicable
          ? 100
          : cross?.ok === true
            ? 100
            : ratioPercent(crossDepthRoutes, expectedRoutes || routeCount),
        tone: 'violet',
        icon: Route,
      },
      {
        key: 'terminal',
        label: 'Terminal ready',
        value: terminalReady ? 'offers-ready' : (data.degraded ?? []).join(', ') || 'pending',
        detail: criticalCount > 0 ? `${criticalCount} critical signals` : 'no bootstrap side effects after ready',
        ok: terminalReady && criticalCount === 0,
        progress: terminalReady ? (criticalCount === 0 ? 100 : 80) : boolProgress(data.systemOk ?? null),
        tone: terminalReady ? 'green' : 'amber',
        icon: CheckCircle2,
      },
      {
        key: 'storage',
        label: 'Storage',
        value: data.disk?.freeGiB !== undefined ? `${data.disk.freeGiB.toFixed(1)} GiB free` : 'tracked',
        detail: `${data.disk?.usedPct ?? 0}% disk used`,
        ok: storageOk,
        progress: boolProgress(storageOk),
        tone: storageOk ? 'blue' : 'red',
        icon: HardDrive,
      },
    ];
  }

  function buildProcessLanes(data: HealthData): ProcessLane[] {
    const children = data.process?.children ?? [];
    return children.map((child) => {
      const role = String(child.role || '').toLowerCase();
      const icon = role === 'market-maker' ? Store : role === 'hub' ? Landmark : Server;
      return {
        key: `${child.role || 'runtime'}-${child.name}-${child.apiPort ?? ''}`,
        label: child.name,
        value: child.online ? 'online' : 'down',
        detail: child.lastErrorLine || `:${child.apiPort ?? '-'} restarts ${child.restartCount ?? 0}`,
        ok: child.online,
        icon,
      };
    });
  }
</script>

<section id="bootstrap" class="bootstrap-live" aria-label="Bootstrap live status">
  <div class="bootstrap-hero">
    <div class="boot-ring" style={progressStyle(overallProgress)} class:ready={terminalReady}>
      <CircleGauge size={40} strokeWidth={1.9} />
      <strong>{overallProgress}%</strong>
    </div>
    <div class="boot-title">
      <div class="eyebrow">bootstrap live</div>
      <h2>{health.marketMaker?.startupPhase ?? health.boot?.phase ?? 'runtime'}</h2>
      <div class="boot-meta">
        <span class:ok={health.systemOk === true} class:bad={health.systemOk === false}>
          {health.systemOk ? 'system green' : 'system gated'}
        </span>
        <span>{formatTime(health.timestamp)}</span>
        <span>{formatLatency(rpcLatencyMs)} rpc</span>
      </div>
    </div>
    <div class="boot-summary">
      <div>
        <strong>{health.marketMaker?.expectedOffersPerHub ?? 0}</strong>
        <span>offers per hub</span>
      </div>
      <div>
        <strong>{health.marketMaker?.cross?.expectedRoutes ?? 0}</strong>
        <span>cross routes</span>
      </div>
      <div>
        <strong>{health.hubMesh?.direct?.openLinkCount ?? 0}</strong>
        <span>direct links</span>
      </div>
    </div>
  </div>

  <div class="stage-rail" aria-label="Bootstrap stages">
    {#each stages as stage, index (stage.key)}
      {@const StageIcon = stage.icon}
      <article
        class="stage-card tone-{stage.tone}"
        class:complete={stage.ok === true}
        class:blocked={stage.ok === false}
        class:active={index === activeStageIndex}
        style={progressStyle(stage.progress)}
      >
        <div class="stage-icon">
          <StageIcon size={19} strokeWidth={2.2} />
        </div>
        <div class="stage-body">
          <div class="stage-top">
            <strong>{stage.label}</strong>
            <span>{stage.progress}%</span>
          </div>
          <p>{stage.value}</p>
          <small>{stage.detail}</small>
          <div class="progress-line"><i></i></div>
        </div>
      </article>
    {/each}
  </div>

  <div class="boot-grids">
    <section class="lane-panel">
      <div class="lane-head">
        <Layers3 size={17} />
        <strong>Process lanes</strong>
      </div>
      <div class="lane-list">
        {#if processLanes.length === 0}
          <div class="empty-line">No managed child process payload.</div>
        {:else}
          {#each processLanes as lane (lane.key)}
            {@const LaneIcon = lane.icon}
            <article class="lane-row" class:ok={lane.ok} class:bad={!lane.ok}>
              <div class="lane-icon"><LaneIcon size={16} /></div>
              <div>
                <strong>{lane.label}</strong>
                <span>{lane.detail}</span>
              </div>
              <b>{lane.value}</b>
            </article>
          {/each}
        {/if}
      </div>
    </section>

    <section class="lane-panel wide">
      <div class="lane-head">
        <Store size={17} />
        <strong>Market maker books</strong>
      </div>
      <div class="book-grid">
        {#if mmHubs.length === 0}
          <div class="empty-line">No same-chain book payload.</div>
        {:else}
          {#each mmHubs as hub (hub.hubEntityId)}
            {@const expected = numberOrZero(health.marketMaker?.expectedOffersPerHub)}
            {@const progress = ratioPercent(numberOrZero(hub.offers), expected)}
            <article class="book-card" class:ok={hub.depthReady === true || (expected > 0 && hub.offers >= expected)} style={progressStyle(progress)}>
              <div class="book-main">
                <strong>{short(hub.hubEntityId, 12)}</strong>
                <span>{formatCount(hub.offers)}/{formatCount(expected)} offers</span>
              </div>
              <div class="progress-line"><i></i></div>
              <div class="pair-pills">
                {#each (hub.pairs ?? []).slice(0, 6) as pair (pair.pairId)}
                  {@const pairExpected = numberOrZero(pair.expectedOffers || health.marketMaker?.expectedOffersPerPair)}
                  <span class:ok={pair.depthReady === true || (pairExpected > 0 && pair.offers >= pairExpected)}>
                    {pair.pairId}: {pair.offers}/{pairExpected}
                  </span>
                {/each}
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </section>
  </div>

  <div class="boot-grids bottom">
    <section class="lane-panel wide">
      <div class="lane-head">
        <Route size={17} />
        <strong>Cross-j depth</strong>
      </div>
      <div class="route-grid">
        {#if mmCrossRoutes.length === 0}
          <div class="empty-line">No cross route payload.</div>
        {:else}
          {#each mmCrossRoutes.slice(0, 8) as route, index (`route-${index}`)}
            {@const expected = numberOrZero(route.expectedOffers || health.marketMaker?.cross?.expectedOffersPerRoute)}
            {@const progress = ratioPercent(numberOrZero(route.offers), expected)}
            <article class="route-card" class:ok={route.depthReady === true} style={progressStyle(progress)}>
              <div>
                <strong>{route.sourceJurisdiction || 'source'} -> {route.targetJurisdiction || 'target'}</strong>
                <span>{formatCount(route.offers)}/{formatCount(expected)} offers</span>
              </div>
              <div class="progress-line"><i></i></div>
            </article>
          {/each}
        {/if}
      </div>
    </section>

    <section class="lane-panel">
      <div class="lane-head">
        <ShieldCheck size={17} />
        <strong>Reserve targets</strong>
      </div>
      <div class="reserve-list">
        {#if reserveEntities.length === 0}
          <div class="empty-line">No reserve entity payload.</div>
        {:else}
          {#each reserveEntities as entity (entity.entityId)}
            <article class="reserve-row" class:ok={entity.ready && entity.targetMet}>
              <div>
                <strong>{entity.role ?? 'entity'} {short(entity.entityId, 9)}</strong>
                <span>{entity.tokens.filter((token) => token.ready && token.targetMet !== false).length}/{entity.tokens.length} tokens</span>
              </div>
              <div class="coin-strip">
                {#each entity.tokens.slice(0, 5) as token (`${entity.entityId}-${token.tokenId}`)}
                  <span class:ok={token.ready && token.targetMet !== false}>{token.symbol || token.tokenId}</span>
                {/each}
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </section>
  </div>

  {#if criticalCount > 0}
    <div class="critical-strip">
      <AlertTriangle size={17} />
      <span>{criticalCount} critical signals in the current relay window</span>
    </div>
  {/if}
</section>

<style>
  .bootstrap-live {
    margin-bottom: 12px;
    padding: 14px;
    border: 1px solid rgba(79, 177, 255, 0.22);
    border-radius: 14px;
    background:
      radial-gradient(circle at 20% 0%, rgba(58, 150, 255, 0.16), transparent 30%),
      radial-gradient(circle at 82% 12%, rgba(30, 217, 133, 0.14), transparent 28%),
      linear-gradient(180deg, #0f1418, #090b0d);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.24);
  }

  .bootstrap-hero {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(260px, auto);
    align-items: center;
    gap: 16px;
    margin-bottom: 14px;
  }

  .boot-ring {
    --progress: 0%;
    width: 116px;
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background:
      conic-gradient(#1bd985 var(--progress), rgba(255, 255, 255, 0.08) 0),
      #0a0d10;
    position: relative;
    color: #eaf7f0;
  }

  .boot-ring::after {
    content: '';
    position: absolute;
    inset: 11px;
    border-radius: 50%;
    background: #0d1114;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .boot-ring :global(svg),
  .boot-ring strong {
    position: relative;
    z-index: 1;
  }

  .boot-ring strong {
    margin-top: 52px;
    font-size: 18px;
  }

  .boot-ring.ready {
    box-shadow: 0 0 0 8px rgba(27, 217, 133, 0.08);
  }

  .boot-title h2 {
    margin: 3px 0 0;
    color: #f6f1e8;
    font-size: clamp(26px, 3vw, 42px);
    line-height: 1;
    letter-spacing: 0;
  }

  .boot-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }

  .boot-meta span,
  .boot-summary div,
  .stage-card,
  .lane-panel,
  .book-card,
  .route-card,
  .reserve-row {
    border: 1px solid rgba(255, 255, 255, 0.09);
    background: rgba(8, 10, 12, 0.72);
  }

  .boot-meta span {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 0 10px;
    color: #aab6c3;
    font-size: 12px;
  }

  .boot-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(84px, 1fr));
    gap: 8px;
  }

  .boot-summary div {
    min-height: 72px;
    display: grid;
    align-content: center;
    gap: 4px;
    border-radius: 10px;
    padding: 10px;
  }

  .boot-summary strong {
    color: #f3f7fb;
    font-size: 22px;
  }

  .boot-summary span {
    color: #8fa0ae;
    font-size: 11px;
    text-transform: uppercase;
  }

  .stage-rail {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }

  .stage-card {
    --progress: 0%;
    min-height: 118px;
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr);
    gap: 10px;
    border-radius: 12px;
    padding: 12px;
    position: relative;
    overflow: hidden;
  }

  .stage-card::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: #627386;
  }

  .stage-card.active {
    border-color: rgba(79, 177, 255, 0.46);
  }

  .stage-card.complete {
    border-color: rgba(27, 217, 133, 0.34);
  }

  .stage-card.blocked {
    border-color: rgba(255, 91, 115, 0.42);
  }

  .tone-green::before { background: #1bd985; }
  .tone-blue::before { background: #4fb1ff; }
  .tone-amber::before { background: #f2b84b; }
  .tone-red::before { background: #ff5b73; }
  .tone-violet::before { background: #a78bfa; }

  .stage-icon,
  .lane-icon {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.06);
    color: #dbeafe;
  }

  .stage-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .stage-top strong,
  .lane-head strong,
  .lane-row strong,
  .book-main strong,
  .route-card strong,
  .reserve-row strong {
    color: #eef5fb;
    font-size: 13px;
  }

  .stage-top span {
    color: #9fb2c3;
    font-size: 12px;
    font-weight: 800;
  }

  .stage-body p {
    margin: 6px 0 0;
    color: #f4c76d;
    font-weight: 800;
  }

  .stage-body small,
  .lane-row span,
  .book-main span,
  .route-card span,
  .reserve-row span,
  .empty-line {
    color: #8fa0ae;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .progress-line {
    height: 6px;
    margin-top: 10px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.07);
  }

  .progress-line i {
    display: block;
    width: var(--progress);
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #4fb1ff, #1bd985);
  }

  .boot-grids {
    display: grid;
    grid-template-columns: minmax(280px, 0.8fr) minmax(0, 1.2fr);
    gap: 10px;
  }

  .boot-grids.bottom {
    grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
    margin-top: 10px;
  }

  .lane-panel {
    border-radius: 12px;
    padding: 12px;
  }

  .lane-panel.wide {
    min-width: 0;
  }

  .lane-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    color: #9fc9ff;
  }

  .lane-list,
  .book-grid,
  .route-grid,
  .reserve-list {
    display: grid;
    gap: 8px;
  }

  .lane-row {
    min-height: 56px;
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    border-radius: 10px;
    padding: 8px;
    background: rgba(255, 255, 255, 0.035);
  }

  .lane-row b {
    color: #f4c76d;
    font-size: 12px;
  }

  .lane-row.ok b,
  .ok {
    color: #1bd985;
  }

  .lane-row.bad b,
  .bad {
    color: #ff5b73;
  }

  .book-grid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .book-card,
  .route-card,
  .reserve-row {
    --progress: 0%;
    border-radius: 10px;
    padding: 10px;
  }

  .book-card.ok,
  .route-card.ok,
  .reserve-row.ok {
    border-color: rgba(27, 217, 133, 0.28);
  }

  .book-main {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .pair-pills,
  .coin-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .pair-pills span,
  .coin-strip span {
    max-width: 100%;
    border-radius: 999px;
    padding: 4px 7px;
    background: rgba(255, 255, 255, 0.06);
    color: #aab6c3;
    font-size: 10px;
  }

  .pair-pills span.ok,
  .coin-strip span.ok {
    color: #0b1510;
    background: #1bd985;
  }

  .route-card {
    display: grid;
    gap: 8px;
  }

  .route-card > div:first-child {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }

  .reserve-row {
    display: grid;
    gap: 8px;
  }

  .critical-strip {
    min-height: 42px;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    border: 1px solid rgba(255, 91, 115, 0.38);
    border-radius: 10px;
    padding: 9px 11px;
    color: #ff9db0;
    background: rgba(255, 91, 115, 0.08);
  }

  @media (max-width: 980px) {
    .bootstrap-hero,
    .boot-grids,
    .boot-grids.bottom {
      grid-template-columns: 1fr;
    }

    .boot-summary {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @media (max-width: 640px) {
    .bootstrap-live {
      padding: 10px;
    }

    .bootstrap-hero {
      align-items: stretch;
    }

    .boot-ring {
      width: 96px;
      margin: 0 auto;
    }

    .boot-title h2 {
      font-size: 28px;
      text-align: center;
    }

    .boot-meta,
    .boot-summary,
    .book-main,
    .route-card > div:first-child {
      flex-direction: column;
      align-items: stretch;
    }

    .boot-summary {
      grid-template-columns: 1fr;
    }

    .stage-rail {
      grid-template-columns: 1fr;
    }
  }
</style>
