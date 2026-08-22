<script context="module" lang="ts">
  export type LoadTestingMetrics = {
    attempted: number;
    submitted: number;
    skipped: number;
    failed: number;
    stpPrevented: number;
    stpPercent: number;
  };

  export type LoadTestingControllerState = {
    payRate: number;
    swapRate: number;
    durationMinutes: number;
    elapsedSeconds: number;
    running: boolean;
    metrics: LoadTestingMetrics;
  };

  export type LoadTestingCallbacks = {
    setPayRate: (rate: number) => void;
    setSwapRate: (rate: number) => void;
    setDurationMinutes: (minutes: number) => void;
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
  };
</script>

<script lang="ts">
  export let state: LoadTestingControllerState = {
    payRate: 1,
    swapRate: 1,
    durationMinutes: 10,
    elapsedSeconds: 0,
    running: false,
    metrics: {
      attempted: 0,
      submitted: 0,
      skipped: 0,
      failed: 0,
      stpPrevented: 0,
      stpPercent: 0,
    },
  };

  export let callbacks: LoadTestingCallbacks;
  export let disabled = false;

  const numericValue = (event: Event): number => Number((event.currentTarget as HTMLInputElement).value);
  const formatRate = (rate: number): string => rate.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const formatCount = (count: number): string => Math.max(0, count).toLocaleString();
  const formatTime = (seconds: number): string => {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${minutes}:${remainder.toString().padStart(2, '0')}`;
  };

  $: totalSeconds = Math.max(60, state.durationMinutes * 60);
  $: elapsedSeconds = Math.min(Math.max(0, state.elapsedSeconds), totalSeconds);
  $: progressPercent = (elapsedSeconds / totalSeconds) * 100;
  $: stpPercent = Math.min(100, Math.max(0, state.metrics.stpPercent));
</script>

<section class="load-panel" data-testid="account-load-testing-panel" aria-labelledby="load-testing-title">
  <header class="panel-header">
    <div>
      <p class="eyebrow">Best-effort traffic</p>
      <h3 id="load-testing-title">Load Testing</h3>
      <p class="summary">Available routes only. Capacity misses are skipped without retries or bursts.</p>
    </div>
    <span class:running={state.running} class="status-pill">
      <span class="status-dot" aria-hidden="true"></span>
      {state.running ? 'Running' : 'Ready'}
    </span>
  </header>

  <div class="controls-grid">
    <label class="control" for="load-pay-rate">
      <span class="control-title">
        <span>Pay rate</span>
        <strong>{formatRate(state.payRate)} <small>ops/s</small></strong>
      </span>
      <input
        id="load-pay-rate"
        data-testid="load-pay-rate"
        type="range"
        min="0.1"
        max="100"
        step="0.1"
        value={state.payRate}
        disabled={disabled || state.running}
        on:input={(event) => callbacks.setPayRate(numericValue(event))}
      />
      <span class="range-meta"><span>$1–5 each</span><span>0.1–100 ops/s</span></span>
    </label>

    <label class="control" for="load-swap-rate">
      <span class="control-title">
        <span>Swap rate</span>
        <strong>{formatRate(state.swapRate)} <small>ops/s</small></strong>
      </span>
      <input
        id="load-swap-rate"
        data-testid="load-swap-rate"
        type="range"
        min="0.1"
        max="100"
        step="0.1"
        value={state.swapRate}
        disabled={disabled || state.running}
        on:input={(event) => callbacks.setSwapRate(numericValue(event))}
      />
      <span class="range-meta"><span>$10–15 each</span><span>0.1–100 ops/s</span></span>
    </label>

    <label class="control duration-control" for="load-duration">
      <span class="control-title">
        <span>Duration</span>
        <strong>{state.durationMinutes} <small>min</small></strong>
      </span>
      <input
        id="load-duration"
        data-testid="load-duration"
        type="range"
        min="1"
        max="100"
        step="1"
        value={state.durationMinutes}
        disabled={disabled || state.running}
        on:input={(event) => callbacks.setDurationMinutes(numericValue(event))}
      />
      <span class="range-meta"><span>1 minute</span><span>100 minutes</span></span>
    </label>
  </div>

  <div class="run-card">
    <div class="run-row">
      <div class="run-copy">
        <span>{state.running ? 'Test in progress' : 'Configured load'}</span>
        <strong>{formatRate(state.payRate + state.swapRate)} ops/s</strong>
      </div>
      <button
        type="button"
        class:stop={state.running}
        disabled={disabled}
        data-testid={state.running ? 'load-test-stop' : 'load-test-start'}
        on:click={() => state.running ? callbacks.stop() : callbacks.start()}
      >
        {state.running ? 'Stop test' : 'Start test'}
      </button>
    </div>

    <div class="progress-heading">
      <span>{formatTime(elapsedSeconds)} elapsed</span>
      <span>{Math.round(progressPercent)}%</span>
    </div>
    <div
      class="progress-track"
      role="progressbar"
      aria-label="Load test progress"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(progressPercent)}
    >
      <span style={`width: ${progressPercent}%`}></span>
    </div>
    <p class="progress-foot">Target {formatTime(totalSeconds)} · Pay and Swap schedules run independently</p>
  </div>

  <div class="metrics" aria-label="Load test metrics">
    <article>
      <span>Attempted</span>
      <strong>{formatCount(state.metrics.attempted)}</strong>
    </article>
    <article>
      <span>Submitted</span>
      <strong>{formatCount(state.metrics.submitted)}</strong>
    </article>
    <article class="muted-metric">
      <span>Skipped</span>
      <strong>{formatCount(state.metrics.skipped)}</strong>
    </article>
    <article class:has-failures={state.metrics.failed > 0}>
      <span>Failed</span>
      <strong>{formatCount(state.metrics.failed)}</strong>
    </article>
    <article class="stp-metric">
      <span>STP</span>
      <strong>{formatCount(state.metrics.stpPrevented)} · {stpPercent.toFixed(1)}%</strong>
      <div class="stp-track" aria-hidden="true"><span style={`width: ${stpPercent}%`}></span></div>
    </article>
  </div>
</section>

<style>
  .load-panel {
    display: grid;
    gap: 16px;
    padding: 18px;
    color: #f4f4f5;
    border: 1px solid #292d35;
    border-radius: 14px;
    background:
      radial-gradient(circle at top right, rgba(59, 130, 246, 0.1), transparent 34%),
      #111318;
    box-shadow: 0 18px 42px rgba(0, 0, 0, 0.18);
  }

  .panel-header,
  .run-row,
  .control-title,
  .range-meta,
  .progress-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .panel-header { align-items: flex-start; }
  h3, p { margin: 0; }
  h3 { font-size: 18px; letter-spacing: -0.015em; }

  .eyebrow {
    margin-bottom: 4px;
    color: #60a5fa;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .summary {
    max-width: 560px;
    margin-top: 6px;
    color: #9198a5;
    font-size: 12px;
    line-height: 1.45;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: 0 0 auto;
    padding: 6px 9px;
    color: #a1a1aa;
    border: 1px solid #343842;
    border-radius: 999px;
    background: rgba(20, 22, 27, 0.82);
    font-size: 11px;
    font-weight: 700;
  }

  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #71717a; }
  .status-pill.running { color: #86efac; border-color: rgba(34, 197, 94, 0.3); }
  .status-pill.running .status-dot { background: #22c55e; box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.12); }

  .controls-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .control {
    display: grid;
    gap: 11px;
    padding: 14px;
    border: 1px solid #292e37;
    border-radius: 11px;
    background: rgba(9, 11, 15, 0.66);
  }

  .duration-control { grid-column: 1 / -1; }
  .control-title { align-items: baseline; color: #c9ced7; font-size: 12px; font-weight: 650; }
  .control-title strong { color: #f8fafc; font-size: 16px; font-variant-numeric: tabular-nums; }
  .control-title small { color: #818997; font-size: 10px; font-weight: 600; }
  .range-meta { color: #707887; font-size: 10px; }

  input[type='range'] {
    width: 100%;
    height: 4px;
    margin: 3px 0;
    accent-color: #3b82f6;
    cursor: pointer;
  }

  input[type='range']:disabled { cursor: not-allowed; opacity: 0.48; }

  .run-card {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid rgba(59, 130, 246, 0.22);
    border-radius: 11px;
    background: rgba(30, 64, 175, 0.08);
  }

  .run-row { align-items: center; }
  .run-copy { display: grid; gap: 2px; color: #8f98a7; font-size: 11px; }
  .run-copy strong { color: #e8edf5; font-size: 14px; font-variant-numeric: tabular-nums; }

  button {
    min-height: 38px;
    padding: 0 16px;
    color: #fff;
    border: 1px solid #4b7bf5;
    border-radius: 9px;
    background: linear-gradient(180deg, #4779ef, #315dcc);
    box-shadow: 0 7px 18px rgba(37, 99, 235, 0.2);
    font: inherit;
    font-size: 12px;
    font-weight: 750;
    cursor: pointer;
  }

  button.stop { color: #fecaca; border-color: rgba(248, 113, 113, 0.45); background: rgba(127, 29, 29, 0.38); box-shadow: none; }
  button:disabled { cursor: not-allowed; opacity: 0.48; }
  .progress-heading { color: #9aa2af; font-size: 10px; font-variant-numeric: tabular-nums; }
  .progress-track, .stp-track { overflow: hidden; height: 5px; border-radius: 999px; background: #272b33; }
  .progress-track > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #3b82f6, #22d3ee); transition: width 180ms linear; }
  .progress-foot { color: #747d8a; font-size: 10px; }

  .metrics {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }

  .metrics article {
    display: grid;
    gap: 5px;
    min-width: 0;
    padding: 12px;
    border: 1px solid #292d35;
    border-radius: 10px;
    background: rgba(8, 10, 14, 0.58);
  }

  .metrics article > span { overflow: hidden; color: #848c99; font-size: 10px; text-overflow: ellipsis; }
  .metrics strong { font-size: 16px; font-variant-numeric: tabular-nums; }
  .metrics .muted-metric strong { color: #fbbf24; }
  .metrics .has-failures strong { color: #fb7185; }
  .metrics .stp-metric { border-color: rgba(34, 197, 94, 0.24); }
  .metrics .stp-metric strong { color: #86efac; }
  .stp-track { height: 3px; margin-top: 2px; }
  .stp-track > span { display: block; height: 100%; border-radius: inherit; background: #22c55e; }

  @media (max-width: 720px) {
    .load-panel { padding: 14px; }
    .controls-grid { grid-template-columns: 1fr; }
    .duration-control { grid-column: auto; }
    .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metrics .stp-metric { grid-column: 1 / -1; }
  }

  @media (max-width: 430px) {
    .panel-header { align-items: stretch; flex-direction: column; }
    .status-pill { align-self: flex-start; }
    .run-row { align-items: stretch; flex-direction: column; }
    button { width: 100%; }
  }
</style>
