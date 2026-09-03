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
  const runtimesPerProcess = HLT_DASHBOARD_DEFAULTS.runtimesPerProcess;
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
  const runtimeProcessCount = $derived(Math.ceil(users / runtimesPerProcess));
  const chart = $derived(layoutHltTpsChart(snapshot?.ledger ?? []));
  const paymentPipeline = $derived(snapshot?.payment ? [
    { label: 'Started', value: snapshot.payment.submittedPayments, color: '#8e8a80' },
    { label: 'H1 accepted', value: snapshot.payment.acceptedPayments, color: '#5d7ea8' },
    { label: 'Completed', value: snapshot.payment.completedPayments, color: '#c49b47' },
    { label: 'ACK drained', value: snapshot.payment.drainedPayments, color: '#72a67a' },
  ] : []);
  const paymentPipelineMax = $derived(Math.max(1, ...paymentPipeline.map(stage => stage.value)));
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

  const startIsolated = async (selectedPhase: 'build' | 'replay'): Promise<void> => {
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
          phase: selectedPhase,
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
      <p class="sub">Record runs an isolated live shard and saves H1 inputs. Replay runs those inputs without users.</p>
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
      {/if}
      <a class="mini-action" href="/qa/quorum">Quorum</a>
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
    <details class="notice-banner" data-testid="hlt-snapshot-error">
      <summary>Previous result uses an older schema and is excluded. A new run will replace it.</summary>
      <code>{snapshot.snapshotError}</code>
    </details>
  {/if}

  {#if run.status !== 'idle'}
    <section class="run-banner" data-testid="hlt-run" data-status={run.status}>
      <div>
        <span>{run.phase === 'replay' ? 'Replay last recording' : 'Live test + recording'}</span>
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
        <details class="run-log-details">
          <summary>Run diagnostics</summary>
          <pre class="run-log" data-testid="hlt-run-log">{run.logTail}</pre>
        </details>
      {/if}
    </section>
  {/if}

  <nav class="hlt-tabs" aria-label="HLT views">
    <button class:active={activeTab === 'control'} type="button" onclick={() => activeTab = 'control'}>Control</button>
    <button class:active={activeTab === 'progress'} type="button" onclick={() => activeTab = 'progress'}>HLT Progress</button>
  </nav>

  {#if activeTab === 'control'}
    <section class="panel phase-panel" data-testid="hlt-phases">
      <h2>Run mode</h2>
      <div class="phase-grid">
        <article class="run-action-card">
          <strong>Record</strong>
          <small>Run real sovereign users, drain ACKs, and save the exact H1 recording.</small>
          <button
            class="hlt-start"
            type="button"
            data-testid="hlt-record"
            disabled={actionBusy || run.active}
            onclick={() => void startIsolated('build')}
          >{actionBusy ? 'Starting…' : 'Start record'}</button>
        </article>
        <article class="run-action-card">
          <strong>Replay</strong>
          <small>Run the last saved H1 inputs without users and verify identical state and outbox.</small>
          <div class="replay-controls-inline">
            <label>
              Mode
              <select bind:value={replayMode} data-testid="hlt-replay-mode">
                <option value="max">Max throughput</option>
                <option value="fixed">Fixed 1000 TPS</option>
                <option value="sweep">Saturation sweep</option>
              </select>
            </label>
            {#if replayMode === 'sweep'}
              <label>
                Offered TPS points
                <input class="text-input" bind:value={replayRates} data-testid="hlt-replay-rates" />
              </label>
            {/if}
          </div>
          <button
            class="hlt-start replay-start"
            type="button"
            data-testid="hlt-replay"
            disabled={actionBusy || run.active}
            onclick={() => void startIsolated('replay')}
          >{actionBusy ? 'Starting…' : 'Start replay'}</button>
        </article>
      </div>
    </section>

  <section class="panel">
    <h2>Population</h2>
    <div class="controls">
      <label>
        Users total <strong data-testid="hlt-users">{users}</strong>
        <input type="range" min="2" max="1000" step="2" bind:value={users} data-testid="hlt-users-input" />
      </label>
      <div class="packing-summary" data-testid="hlt-runtime-packing">
        <span>Runtime processes</span>
        <strong>{runtimeProcessCount}</strong>
        <small>{runtimesPerProcess} users per OS process</small>
      </div>
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
              <span>{trial.engine
                ? `${trial.engine === 'rust' ? 'Rust' : 'TS'} · ${trial.workers} worker${trial.workers === 1 ? '' : 's'}`
                : trial.offeredTps === null ? 'Max throughput' : `Offered ${trial.offeredTps}/s`}</span>
              <strong>{formatTps(trial.accountTxTps)}</strong>
              <p>{trial.frames} frames · {trial.outboxEnvelopes} outbox · pending {trial.finalPendingOutbox}</p>
              <small>{trial.engine
                ? `engine ${formatMs(trial.cpuMs)} · wall ${formatMs(trial.elapsedMs)} · ${trial.accountInputs} account inputs`
                : 'state + ordered outbox hashes identical'}</small>
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
      <article class="result-card">
        <span>Source lag p95 / max</span>
        <strong>{snapshot.payment.sourceDispatchP95Ms} / {snapshot.payment.sourceDispatchMaxMs} ms</strong>
      </article>
      <article class="result-card">
        <span>Queue ACK max</span>
        <strong>{snapshot.payment.sourceAckMaxMs} ms</strong>
      </article>
    </section>
    <section class="panel" data-testid="hlt-payment-pipeline">
      <h2>Payment conservation checkpoints</h2>
      <svg class="pipeline-chart" viewBox="0 0 680 156" role="img" aria-label="Payment checkpoints">
        {#each paymentPipeline as stage, index}
          <text x="0" y={25 + index * 36} fill="#cfc6af" font-size="12">{stage.label}</text>
          <rect x="105" y={10 + index * 36} width="520" height="20" rx="5" fill="rgba(255,255,255,0.05)" />
          <rect x="105" y={10 + index * 36} width={520 * stage.value / paymentPipelineMax} height="20" rx="5" fill={stage.color} />
          <text x="638" y={25 + index * 36} fill="#fff4d8" font-size="12">{stage.value}</text>
        {/each}
      </svg>
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
      <article class="result-card">
        <span>Source lag p95 / max</span>
        <strong>{snapshot.swap.sourceDispatchP95Ms} / {snapshot.swap.sourceDispatchMaxMs} ms</strong>
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
      <h2>Progress to 10 000/s</h2>
      <p class="ledger-legend" data-testid="hlt-ledger-legend">
        <span style="color:#e4695f">● Rust H1 pay/s</span>
        <span style="color:#c49b47">● TS core pay/s</span>
        <span style="color:#5d7ea8">● TS same-J swaps/s</span>
        <span>linear 0–10 000/s · hover a row for what changed</span>
      </p>
      <svg class="chart" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img">
        {#each chart.yTicks as tick}
          <text x="8" y={tick.y + 4} fill="#8e8a80" font-size="11">{tick.label}</text>
          <line x1="44" x2={chart.width - 18} y1={tick.y} y2={tick.y} stroke="rgba(255,255,255,0.08)" />
        {/each}
        <path d={chart.payPath} fill="none" stroke="#c49b47" stroke-width="2" />
        <path d={chart.swapPath} fill="none" stroke="#5d7ea8" stroke-width="2" />
        <path d={chart.rustPayPath} fill="none" stroke="#e4695f" stroke-width="2.5" />
        {#each chart.payPoints as point}
          <circle cx={point.x} cy={point.y} r="4" fill="#c49b47" />
        {/each}
        {#each chart.swapPoints as point}
          <circle cx={point.x} cy={point.y} r="3.5" fill="#5d7ea8" />
        {/each}
        {#each chart.rustPayPoints as point}
          <circle cx={point.x} cy={point.y} r="4.5" fill="#e4695f" />
        {/each}
      </svg>
      <div class="ledger-list">
        {#each [...snapshot.ledger].reverse().slice(0, 12) as run}
          <article class="ledger-item" data-status={run.status} data-engine={run.engine} data-testid="hlt-ledger-row" title={run.detail}>
            <h3><span class="engine-tag" style={`color:${run.engine === 'rust' ? '#e4695f' : '#c49b47'}`}>{run.engine === 'rust' ? 'Rust' : 'TS'}</span> {run.headline}</h3>
            <p>{formatTps(run.paymentsTps)} pay · {formatTps(run.swapsTps)} swap · {run.users} users · {run.commit} · {run.at.slice(0, 16).replace('T', ' ')}</p>
            <p class="ledger-detail">{run.detail}</p>
          </article>
        {/each}
      </div>
    </section>
  {/if}
</div>
