<script lang="ts">
  import '../qa.css';
  import './hlt.css';
  import { onMount } from 'svelte';
  import {
    HLT_DASHBOARD_DEFAULTS,
    layoutHltTpsChart,
    previewHltDashboard,
    type HltDashboardConfig,
    type HltDashboardMode,
  } from '@xln/core/qa/hlt/hlt-dashboard-preview';
  import { consumeQaTokenFromUrl, qaFetch } from '$lib/qa/apiClient';
  import { decodeHltDashboardPayload, formatMs, formatTps, type HltDashboardPayload, type HltRunView } from '$lib/qa/hlt';

  const IDLE_RUN: HltRunView = {
    active: false,
    status: 'idle',
    pid: null,
    phase: null,
    workDir: null,
    logPath: null,
    recordingPath: null,
    reportPath: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    logTail: '',
  };

  let users = $state(HLT_DASHBOARD_DEFAULTS.users);
  let runtimesPerProcess = $state(HLT_DASHBOARD_DEFAULTS.runtimesPerProcess);
  let ratePerUserPerSecond = $state(HLT_DASHBOARD_DEFAULTS.ratePerUserPerSecond);
  let durationSeconds = $state(HLT_DASHBOARD_DEFAULTS.durationSeconds);
  let hubs = $state(HLT_DASHBOARD_DEFAULTS.hubs);
  let mode = $state<HltDashboardMode>(HLT_DASHBOARD_DEFAULTS.mode);
  let profile = $state(HLT_DASHBOARD_DEFAULTS.profile);
  // Number inputs can't bind directly to a bigint; the config's bigint fields
  // are derived from these at the point of use.
  let paymentAmountMinInput = $state(Number(HLT_DASHBOARD_DEFAULTS.paymentAmountMin));
  let paymentAmountMaxInput = $state(Number(HLT_DASHBOARD_DEFAULTS.paymentAmountMax));
  const paymentAmountMin = $derived(BigInt(Math.max(1, Math.round(paymentAmountMinInput))));
  const paymentAmountMax = $derived(BigInt(Math.max(Number(paymentAmountMin), Math.round(paymentAmountMaxInput))));
  let copied = $state(false);
  let loadError = $state<string | null>(null);
  let snapshot = $state<HltDashboardPayload | null>(null);
  let actionBusy = $state(false);
  let activeTab = $state<'control' | 'progress'>('control');
  let phase = $state<'build' | 'replay'>('build');
  let replayMode = $state<'max' | 'fixed' | 'sweep'>('max');
  let replayRates = $state('250,500,750,1000,1500,2000');

  const config = $derived<HltDashboardConfig>({
    users,
    runtimesPerProcess,
    ratePerUserPerSecond,
    durationSeconds,
    mix: mode === 'same' ? '1:0' : '0:1',
    hubs,
    marketMakers: HLT_DASHBOARD_DEFAULTS.marketMakers,
    mode,
    profile,
    paymentAmountMin,
    paymentAmountMax,
  });
  const preview = $derived(previewHltDashboard(config));
  const chart = $derived(layoutHltTpsChart(snapshot?.ledger ?? []));
  const maxPerfTotal = $derived(Math.max(1, ...(snapshot?.perf.rows ?? []).map(row => row.totalMs)));
  const run = $derived(snapshot?.run ?? IDLE_RUN);

  const readErrorMessage = async (response: Response): Promise<string> => {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    return typeof payload?.error === 'string' ? payload.error : `HLT_HTTP_${response.status}`;
  };

  const loadSnapshot = async (): Promise<void> => {
    const response = await qaFetch('/api/qa/hlt');
    const payload = decodeHltDashboardPayload(await response.json());
    snapshot = payload;
  };

  const startIsolated = async (): Promise<void> => {
    actionBusy = true;
    loadError = null;
    try {
      const response = await qaFetch('/api/qa/hlt/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          users,
          runtimesPerProcess,
          rate: ratePerUserPerSecond,
          duration: durationSeconds,
          hubs,
          mode,
          profile,
          paymentMin: String(paymentAmountMin),
          paymentMax: String(paymentAmountMax),
          phase,
          replayMode,
          replayRates,
        }),
      });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      await loadSnapshot();
    } catch (error: unknown) {
      loadError = error instanceof Error ? error.message : String(error);
    } finally {
      actionBusy = false;
    }
  };

  const abortIsolated = async (): Promise<void> => {
    actionBusy = true;
    loadError = null;
    try {
      const response = await qaFetch('/api/qa/hlt/abort', { method: 'POST' });
      if (!response.ok) throw new Error(await readErrorMessage(response));
      await loadSnapshot();
    } catch (error: unknown) {
      loadError = error instanceof Error ? error.message : String(error);
    } finally {
      actionBusy = false;
    }
  };

  const copyCommand = async (): Promise<void> => {
    await navigator.clipboard.writeText(preview.isolatedCommand.replaceAll(' \\\n', ' '));
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 1_500);
  };

  onMount(() => {
    consumeQaTokenFromUrl();
    void loadSnapshot().catch((error: unknown) => {
      loadError = error instanceof Error ? error.message : String(error);
    });
    const timer = setInterval(() => {
      if (!run.active) return;
      void loadSnapshot().catch((error: unknown) => {
        loadError = error instanceof Error ? error.message : String(error);
      });
    }, 1_000);
    return () => clearInterval(timer);
  });
</script>

<div class="hlt-shell" data-testid="hlt-dashboard">
  <header class="hlt-head">
    <div>
      <div class="eyebrow">Load stand</div>
      <h1>HLT</h1>
      <p class="sub">Start launches a separate smoke shard with its own ports. Live bun run dev stays on 8080/8082.</p>
    </div>
    <div class="hlt-head-actions">
      {#if run.active}
        <button
          class="hlt-stop"
          type="button"
          data-testid="hlt-abort"
          disabled={actionBusy}
          onclick={() => void abortIsolated()}
        >
          {actionBusy ? 'Stopping…' : 'Stop shard'}
        </button>
      {:else}
        <button
          class="hlt-start"
          type="button"
          data-testid="hlt-start"
          disabled={actionBusy}
          onclick={() => void startIsolated()}
        >
          {actionBusy ? 'Starting…' : phase === 'build' ? 'Build frame chains' : 'Replay H1'}
        </button>
      {/if}
      <a class="mini-action" href="/qa">QA cockpit</a>
      <button class="mini-action" type="button" data-testid="hlt-copy-command" onclick={() => void copyCommand()}>
        {copied ? 'Copied' : 'Copy smoke'}
      </button>
    </div>
  </header>

  {#if loadError}
    <div class="error-banner" data-testid="hlt-error">{loadError}</div>
  {/if}

  {#if snapshot?.snapshotError}
    <div class="error-banner" data-testid="hlt-snapshot-error">
      Historical HLT artifact rejected: {snapshot.snapshotError}
    </div>
  {/if}

  {#if run.status !== 'idle'}
    <section class="run-banner" data-testid="hlt-run" data-status={run.status}>
      <div>
        <span>{run.phase === 'replay' ? 'Hub replay' : 'Build chains'}</span>
        <strong data-testid="hlt-run-status">{run.status}{run.pid === null ? '' : ` · pid ${run.pid}`}</strong>
        {#if run.workDir}
          <p class="run-meta" data-testid="hlt-run-workdir">{run.workDir}</p>
        {/if}
        {#if run.error}
          <p class="run-meta">{run.error}</p>
        {/if}
        {#if run.recordingPath}
          <p class="run-meta">recording · {run.recordingPath}</p>
        {/if}
      </div>
      {#if run.logTail}
        <pre class="run-log" data-testid="hlt-run-log">{run.logTail}</pre>
      {/if}
    </section>
  {/if}

  <nav class="hlt-tabs" aria-label="HLT views">
    <button class:active={activeTab === 'control'} type="button" onclick={() => activeTab = 'control'}>Control</button>
    <button class:active={activeTab === 'progress'} type="button" onclick={() => activeTab = 'progress'}>HLT Progress</button>
  </nav>

  {#if activeTab === 'control'}
    <section class="panel phase-panel" data-testid="hlt-phases">
      <h2>Two-phase HLT</h2>
      <div class="phase-grid">
        <button class:active={phase === 'build'} type="button" onclick={() => phase = 'build'}>
          <span>1</span><strong>Build chains</strong><small>Real sovereign users, faucet, traffic, ACK drain, sealed H1 WAL.</small>
        </button>
        <button class:active={phase === 'replay'} type="button" onclick={() => phase = 'replay'}>
          <span>2</span><strong>Hub replay</strong><small>Checkpoint restore, exact input replay, state + ordered outbox hash equality.</small>
        </button>
      </div>
      {#if phase === 'replay'}
        <div class="controls replay-controls">
          <label>
            Replay mode
            <select bind:value={replayMode} data-testid="hlt-replay-mode">
              <option value="max">Max throughput</option>
              <option value="fixed">Fixed 1000 TPS</option>
              <option value="sweep">Saturation sweep</option>
            </select>
          </label>
          <label>
            Offered TPS points
            <input class="text-input" bind:value={replayRates} data-testid="hlt-replay-rates" />
          </label>
        </div>
      {/if}
    </section>

  <section class="panel">
    <h2>Population</h2>
    <div class="controls">
      <label>
        Users total <strong data-testid="hlt-users">{users}</strong>
        <input type="range" min="2" max="1000" step="2" bind:value={users} data-testid="hlt-users-input" />
      </label>
      <label>
        Sovereign runtimes / process <strong data-testid="hlt-users-per-process">{runtimesPerProcess}</strong>
        <input type="range" min="1" max="200" step="1" bind:value={runtimesPerProcess} data-testid="hlt-users-per-process-input" />
      </label>
      <label>
        Actions / user / s <strong>{ratePerUserPerSecond}</strong>
        <input type="range" min="1" max="10" step="1" bind:value={ratePerUserPerSecond} />
      </label>
      <label>
        Duration s <strong>{durationSeconds}</strong>
        <input type="range" min="1" max="60" step="1" bind:value={durationSeconds} />
      </label>
      <label>
        Workload
        <select bind:value={mode} data-testid="hlt-mode">
          <option value="payments">Payments</option>
          <option value="same">Same-J swaps</option>
          <option value="mixed">Pay + swap</option>
          <option value="cross">Cross-J swaps</option>
        </select>
      </label>
      <label>
        Hubs
        <select bind:value={hubs} data-testid="hlt-hubs">
          <option value="H1">H1</option>
          <option value="H1,H2">H1,H2</option>
          <option value="H1,H2,H3">H1,H2,H3</option>
        </select>
      </label>
      <label>
        Payment amount min <strong>{paymentAmountMin}</strong>
        <input type="range" min="1" max="10000" step="1" bind:value={paymentAmountMinInput} data-testid="hlt-payment-amount-min-input" />
      </label>
      <label>
        Payment amount max <strong>{paymentAmountMax}</strong>
        <input type="range" min="1" max="10000" step="1" bind:value={paymentAmountMaxInput} data-testid="hlt-payment-amount-max-input" />
      </label>
      <label>
        Hub profiles
        <input type="checkbox" bind:checked={profile} />
      </label>
    </div>
  </section>

  <section class="metric-row">
    <article class="metric-card">
      <span>Daemons</span>
      <strong data-testid="hlt-daemons">{preview.daemons}</strong>
    </article>
    <article class="metric-card">
      <span>Pay / s offered</span>
      <strong data-testid="hlt-offered-pay">{formatTps(preview.offeredPayPerSecond)}</strong>
    </article>
    <article class="metric-card">
      <span>Swap / s offered</span>
      <strong data-testid="hlt-offered-swap">{formatTps(preview.offeredSwapPerSecond)}</strong>
    </article>
    <article class="metric-card">
      <span>Rounds</span>
      <strong>{preview.rounds}</strong>
    </article>
  </section>
  {/if}

  {#if activeTab === 'progress'}
    {#if snapshot?.replay}
      <section class="panel" data-testid="hlt-replay-result">
        <h2>Exact H1 replay</h2>
        <div class="replay-trials">
          {#each snapshot.replay.trials as trial}
            <article class="result-card">
              <span>{trial.offeredTps === null ? 'Max throughput' : `Offered ${trial.offeredTps}/s`}</span>
              <strong>{formatTps(trial.accountTxTps)}</strong>
              <p>{trial.frames} frames · {trial.outboxEnvelopes} outbox · pending {trial.finalPendingOutbox}</p>
              <small>state + ordered outbox hashes identical</small>
            </article>
          {/each}
        </div>
      </section>
    {/if}

  {#if snapshot?.payment}
    <section class="result-grid" data-testid="hlt-payment-result">
      <article class="result-card">
        <span>Delivered pay TPS</span>
        <strong data-testid="hlt-result-tps">{formatTps(snapshot.payment.deliveredTps)}</strong>
      </article>
      <article class="result-card">
        <span>H1 frames</span>
        <strong data-testid="hlt-result-frames">{snapshot.payment.hubFrames}</strong>
      </article>
      <article class="result-card">
        <span>Pays / frame</span>
        <strong>{snapshot.payment.paymentsPerFrame.toFixed(1)}</strong>
      </article>
      <article class="result-card">
        <span>Wall</span>
        <strong>{formatMs(snapshot.payment.elapsedMs)}</strong>
      </article>
    </section>
  {/if}

  {#if snapshot?.swap}
    <section class="result-grid" data-testid="hlt-swap-result">
      <article class="result-card">
        <span>Matched TPS</span>
        <strong>{formatTps(snapshot.swap.matchedTps)}</strong>
      </article>
      <article class="result-card">
        <span>Settled TPS</span>
        <strong>{formatTps(snapshot.swap.fullySettledTps)}</strong>
      </article>
      <article class="result-card">
        <span>Hub frames</span>
        <strong>{snapshot.swap.hubFrames}</strong>
      </article>
      <article class="result-card">
        <span>Settled wall</span>
        <strong>{formatMs(snapshot.swap.fullySettledElapsedMs)}</strong>
      </article>
    </section>
  {/if}

  {#if snapshot && snapshot.hubPerf.length > 0}
    <section class="panel" data-testid="hlt-hub-perf">
      <h2>Hub CPU TPS</h2>
      {#each snapshot.hubPerf as hub}
        <p>
          {hub.hubLabel}: process avg {hub.processAvgMs.toFixed(1)} ms
          {hub.cpuTps === null ? '' : ` · ${formatTps(hub.cpuTps)}`}
        </p>
      {/each}
    </section>
  {/if}

  {#if snapshot}
    <section class="panel" data-testid="hlt-perf">
      <h2>Hottest functions</h2>
      {#if snapshot.perf.rows.length === 0}
        <p class="empty">No process.profile lines yet. Enable hub profiles on the next isolated smoke.</p>
      {:else}
        {#each snapshot.perf.rows as row}
          <div class="perf-row" data-testid="hlt-perf-row">
            <div>
              <div class="perf-bar" style={`width:${(row.totalMs / maxPerfTotal) * 100}%`}></div>
              <div class="perf-meta">{row.runtime} {row.metric} · n={row.count} avg {row.avgMs.toFixed(1)} ms</div>
            </div>
            <div class="perf-meta">{row.totalMs.toFixed(0)} ms</div>
          </div>
        {/each}
      {/if}
    </section>
  {/if}
  {/if}

  {#if activeTab === 'control'}
  <section class="panel">
    <h2>Hub split</h2>
    <div class="share-row">
      <div class="share-track" data-testid="hlt-hub-share">
        <div class="share-single" style={`width:${preview.hubShare.workerSingleHubPct}%`}></div>
        <div class="share-multi" style={`width:${preview.hubShare.workerMultiHubPct}%`}></div>
      </div>
      <span>single-hub {preview.hubShare.workerSingleHubPct}% · 2+ hub {preview.hubShare.workerMultiHubPct}%</span>
    </div>
    <p class="warning">{preview.hubShare.note}</p>
    <p class="warning">{preview.warning}</p>
  </section>

  <pre class="command-box" data-testid="hlt-command">{preview.isolatedCommand}</pre>
  {/if}

  {#if activeTab === 'progress' && snapshot}
    <section class="panel" data-testid="hlt-ledger">
      <h2>Progress to 1000/s</h2>
      <svg class="chart" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img">
        {#each chart.yTicks as tick}
          <text x="8" y={tick.y + 4} fill="#8e8a80" font-size="11">{tick.label}</text>
          <line x1="44" x2={chart.width - 18} y1={tick.y} y2={tick.y} stroke="rgba(255,255,255,0.08)" />
        {/each}
        <path d={chart.payPath} fill="none" stroke="#c49b47" stroke-width="2" />
        <path d={chart.swapPath} fill="none" stroke="#5d7ea8" stroke-width="2" />
        {#each chart.payPoints as point}
          <circle cx={point.x} cy={point.y} r="4" fill="#c49b47" />
        {/each}
        {#each chart.swapPoints as point}
          <circle cx={point.x} cy={point.y} r="3.5" fill="#5d7ea8" />
        {/each}
      </svg>
      <div class="ledger-list">
        {#each [...snapshot.ledger].reverse().slice(0, 8) as run}
          <article class="ledger-item" data-status={run.status} data-testid="hlt-ledger-row">
            <h3>{run.headline}</h3>
            <p>{formatTps(run.paymentsTps)} pay · {formatTps(run.swapsTps)} swap · {run.users} users · {run.commit}</p>
          </article>
        {/each}
      </div>
    </section>
  {/if}
</div>
