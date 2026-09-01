<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { getXLN } from '$lib/stores/bootstrap/xlnRuntimeLoader';
  import {
    currentHeight,
    history,
    setXlnEnvironment,
  } from '$lib/stores/xlnStore';
  import { timeOperations } from '$lib/stores/timeStore';
  import { errorLog } from '$lib/stores/errorLogStore';
  import type { RuntimeReplica, EnvSnapshot } from '@xln/core/api/public/runtime-module';
  import {
    EMPTY_SCENARIO_VISUAL as emptyVisual,
    DEFAULT_SCENARIO_ID as defaultScenarioId,
    SCENARIO_OPTIONS as scenarioOptions,
    buildScenarioFrameVisual as buildFrameVisual,
    focusScenarioFrameIndex as focusFrameIndex,
    formatScenarioBuilderText as formatBuilderText,
  } from '../../../../packages/runtime-client/src/scenario-player-model';
  import {
    formatScenarioError as formatErrorMessage,
    recordBrowserScenario,
    stopScenarioPreviewInfra as stopPreviewInfra,
  } from '../../../../packages/runtime-client/src/scenario-runtime';

  let selectedScenarioId = defaultScenarioId;
  let selectedScenario = scenarioOptions.find((scenario) => scenario.id === defaultScenarioId)!;
  let frames: EnvSnapshot[] = [];
  let loadedEnv: RuntimeReplica | null = null;
  let currentFrame = 0;
  let status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let statusText = 'Ready to run';
  let errorText = '';
  let playing = false;
  let playbackMs = 700;
  let playTimer: number | null = null;
  let loadSeq = 0;
  let builderInspectText = 'No frame loaded.';
  let diagnosticMessages: string[] = [];

  $: selectedScenario = scenarioOptions.find((scenario) => scenario.id === selectedScenarioId)
    || scenarioOptions.find((scenario) => scenario.id === defaultScenarioId)!;
  $: activeFrame = frames[currentFrame] || null;
  $: visual = activeFrame ? buildFrameVisual(activeFrame, selectedScenario) : emptyVisual;
  $: progressText = frames.length > 0 ? `${currentFrame + 1}/${frames.length}` : '0/0';
  $: builderInspectText = formatBuilderText(activeFrame, visual, selectedScenario, currentFrame, frames.length);

  function appendDiagnostics(messages: string[]): void {
    if (messages.length === 0) return;
    diagnosticMessages = [...diagnosticMessages, ...messages].slice(-6);
  }

  function publishFrame(index: number): void {
    const env = loadedEnv;
    const frame = frames[index];
    if (!env || !frame) return;
    setXlnEnvironment(env);
    history.set(frames);
    currentHeight.set(frame.state.height);
    timeOperations.updateMaxTimeIndex();
    timeOperations.goToTimeIndex(index);
  }

  async function loadScenario(option = selectedScenario): Promise<void> {
    const seq = ++loadSeq;
    const startedAt = performance.now();
    pause();
    status = 'loading';
    statusText = `Running ${option.title}`;
    errorText = '';
    diagnosticMessages = [];
    frames = [];
    appendDiagnostics(stopPreviewInfra(loadedEnv, 'previous scenario'));
    loadedEnv = null;
    currentFrame = 0;

    try {
      const xln = await getXLN();
      const recording = await recordBrowserScenario(xln, option);
      const resultEnv = recording.env;
      appendDiagnostics(stopPreviewInfra(resultEnv, option.title));
      const nextFrames = recording.frames;
      if (seq !== loadSeq) return;
      if (nextFrames.length === 0) throw new Error(`SCENARIO_EMPTY_HISTORY:${option.id}`);

      loadedEnv = resultEnv;
      frames = nextFrames;
      currentFrame = focusFrameIndex(option, nextFrames);
      status = 'ready';
      statusText = `${option.title}: ${nextFrames.length} frames`;
      publishFrame(currentFrame);
      console.info(`E2E-TIMING:scenario_player.${option.id}=${Math.round(performance.now() - startedAt)}ms`);
    } catch (error) {
      if (seq !== loadSeq) return;
      status = 'error';
      errorText = formatErrorMessage(error);
      statusText = 'Scenario failed';
      errorLog.log(
        `SCENARIO_PLAYER_FAILED:${option.id}:elapsedMs=${Math.round(performance.now() - startedAt)}:${errorText}`,
        'Scenario Player',
        error,
      );
    }
  }

  function goToFrame(index: number): void {
    if (frames.length === 0) return;
    currentFrame = Math.max(0, Math.min(frames.length - 1, Math.floor(index)));
    publishFrame(currentFrame);
  }

  function step(delta: number): void {
    goToFrame(currentFrame + delta);
  }

  function play(): void {
    if (playing || frames.length <= 1) return;
    playing = true;
    playTimer = window.setInterval(() => {
      if (currentFrame >= frames.length - 1) {
        pause();
        return;
      }
      step(1);
    }, playbackMs);
  }

  function pause(): void {
    playing = false;
    if (playTimer !== null) {
      window.clearInterval(playTimer);
      playTimer = null;
    }
  }

  function restart(): void {
    pause();
    goToFrame(focusFrameIndex(selectedScenario, frames));
  }

  async function handleScenarioChange(): Promise<void> {
    await loadScenario(selectedScenario);
  }

  async function previewInWallet(): Promise<void> {
    publishFrame(currentFrame);
    const params = new URLSearchParams({
      locktest: '1',
      scenarioPreview: '1',
      scenario: selectedScenarioId,
      frame: String(currentFrame),
    });
    await goto(`/app?${params.toString()}`);
  }

  onMount(() => {
    void loadScenario(selectedScenario);
  });

  onDestroy(() => {
    pause();
    stopPreviewInfra(loadedEnv, 'destroy');
  });
</script>

<section
  class="scenario-player"
  data-testid="scenario-player"
  data-state={status}
  data-scenario-id={selectedScenarioId}
>
  <header class="player-topbar">
    <div class="title-block">
      <span class="eyebrow">time machine</span>
      <h1>Visual scenario player</h1>
    </div>
    <div class="top-actions">
      <a class="secondary-link" href="/app" target="_blank" rel="noreferrer" data-testid="open-live-wallet">
        Open live wallet
      </a>
      <button
        type="button"
        class="primary-action"
        on:click={previewInWallet}
        disabled={status !== 'ready'}
        data-testid="preview-in-wallet"
      >
        Preview in wallet
      </button>
    </div>
  </header>

  <div class="scenario-toolbar">
    <label class="scenario-select-label" for="scenario-select">Scenario</label>
    <select
      id="scenario-select"
      bind:value={selectedScenarioId}
      on:change={handleScenarioChange}
      disabled={status === 'loading'}
      data-testid="scenario-select"
    >
      {#each scenarioOptions as option}
        <option value={option.id}>{option.title}</option>
      {/each}
    </select>
    <button type="button" on:click={() => loadScenario(selectedScenario)} disabled={status === 'loading'} data-testid="scenario-run">
      Run
    </button>
    <output class:bad={status === 'error'} data-testid="scenario-status">{statusText}</output>
  </div>

  <div class="workspace-grid">
    <aside class="scenario-list" aria-label="Scenario presets">
      {#each scenarioOptions as option}
        <button
          type="button"
          class:selected={option.id === selectedScenarioId}
          on:click={async () => {
            selectedScenarioId = option.id;
            await loadScenario(option);
          }}
          disabled={status === 'loading'}
          data-testid={`scenario-card-${option.id}`}
        >
          <strong>{option.title}</strong>
          <span>{option.intent}</span>
          <small>{option.tags.join(' / ')}</small>
        </button>
      {/each}
    </aside>

    <section class="preview-pane" aria-label="Scenario preview">
      <div class="graph-shell">
        {#if status === 'loading'}
          <div class="loading-layer" data-testid="scenario-loading">Running deterministic runtime scenario...</div>
        {:else if status === 'error'}
          <div class="error-layer" data-testid="scenario-error">{errorText}</div>
        {/if}
        {#if diagnosticMessages.length > 0}
          <div class="diagnostic-layer" data-testid="scenario-diagnostics">
            {#each diagnosticMessages as message}
              <span>{message}</span>
            {/each}
          </div>
        {/if}
        <svg class="scenario-graph" viewBox="0 0 100 64" role="img" aria-label="Scenario entity graph" data-testid="scenario-graph">
          <defs>
            <filter id="hubGlow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="1.6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {#each visual.edges as edge (edge.key)}
            <line
              class:disputed={edge.disputed}
              x1={edge.from.x}
              y1={edge.from.y}
              x2={edge.to.x}
              y2={edge.to.y}
            />
          {/each}
          {#each visual.nodes as node (node.id)}
            <g
              class:hub={node.isHub}
              class:disputed={node.disputed}
              class:debtor={node.debtCount > 0}
              data-testid="scenario-node"
            >
              <circle cx={node.x} cy={node.y} r={node.isHub ? 4.8 : 4.1} />
              <text x={node.x} y={node.y + 8.2}>{node.label}</text>
            </g>
          {/each}
        </svg>
      </div>

      <section class="frame-narrative">
        <div>
          <span class="frame-kicker">frame {progressText}</span>
          <h2 data-testid="scenario-frame-title">{visual.title || selectedScenario.title}</h2>
          <p>{visual.description || selectedScenario.description}</p>
        </div>
        {#if visual.collapse}
          <div class="collapse-badge" data-testid="scenario-collapse-badge">hub collapse / dispute path</div>
        {/if}
      </section>

      <div class="timeline" data-testid="scenario-timeline">
        <input
          type="range"
          min="0"
          max={Math.max(0, frames.length - 1)}
          value={currentFrame}
          on:input={(event) => goToFrame(Number((event.currentTarget as HTMLInputElement).value))}
          disabled={frames.length === 0}
          aria-label="Scenario frame"
          data-testid="scenario-frame-range"
        />
        <div class="transport">
          <button type="button" on:click={restart} disabled={status !== 'ready'} title="Restart" data-testid="scenario-restart">Restart</button>
          <button type="button" on:click={() => step(-1)} disabled={currentFrame <= 0} title="Previous frame" data-testid="scenario-prev">Prev</button>
          {#if playing}
            <button type="button" on:click={pause} disabled={status !== 'ready'} data-testid="scenario-pause">Pause</button>
          {:else}
            <button type="button" on:click={play} disabled={status !== 'ready' || frames.length <= 1} data-testid="scenario-play">Play</button>
          {/if}
          <button type="button" on:click={() => step(1)} disabled={currentFrame >= frames.length - 1} title="Next frame" data-testid="scenario-next">Next</button>
          <select bind:value={playbackMs} aria-label="Playback speed" data-testid="scenario-speed">
            <option value={1000}>1x</option>
            <option value={700}>1.5x</option>
            <option value={350}>3x</option>
          </select>
        </div>
      </div>
    </section>

    <aside class="builder-pane">
      <div class="builder-section">
        <span class="eyebrow">builder</span>
        <h2>{selectedScenario.title}</h2>
        <p>{selectedScenario.description}</p>
      </div>
      <div class="metrics-grid">
        <div><strong>{visual.nodes.length}</strong><span>entities</span></div>
        <div><strong>{visual.accountCount}</strong><span>accounts</span></div>
        <div><strong>{visual.activeDisputes}</strong><span>disputes</span></div>
        <div><strong>{visual.debtCount}</strong><span>debts</span></div>
      </div>
      <label class="builder-notes">
        <span>Frame inspect</span>
        <textarea readonly bind:value={builderInspectText} data-testid="scenario-builder-inspect"></textarea>
      </label>
    </aside>
  </div>
</section>

<style>
  .scenario-player {
    box-sizing: border-box;
    height: calc(100dvh - 57px);
    padding: 20px 24px 0;
    background: #090a0c;
    color: #f4f4f5;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    overflow: hidden;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  :global(main.with-topbar:has([data-testid="scenario-player"])) {
    height: calc(100dvh - 57px);
    min-height: calc(100dvh - 57px);
    overflow: hidden;
  }

  .player-topbar,
  .scenario-toolbar,
  .workspace-grid {
    width: 100%;
    max-width: 1560px;
    margin: 0 auto;
  }

  .player-topbar {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }

  .title-block h1,
  .builder-section h2,
  .frame-narrative h2 {
    margin: 0;
    letter-spacing: 0;
  }

  .title-block h1 {
    font-size: 28px;
    line-height: 1.1;
  }

  .eyebrow,
  .frame-kicker,
  .builder-notes span {
    color: #9ca3af;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .top-actions,
  .scenario-toolbar,
  .transport {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .secondary-link,
  .primary-action,
  .scenario-toolbar button,
  .transport button,
  .transport select,
  .scenario-toolbar select {
    min-height: 36px;
    border-radius: 7px;
    font: inherit;
    font-size: 13px;
  }

  .secondary-link,
  .scenario-toolbar button,
  .transport button,
  .transport select,
  .scenario-toolbar select {
    border: 1px solid #2b3038;
    background: #111318;
    color: #e5e7eb;
  }

  .secondary-link {
    display: inline-flex;
    align-items: center;
    padding: 0 12px;
    text-decoration: none;
  }

  .primary-action {
    border: 1px solid rgba(61, 220, 151, 0.44);
    background: #143326;
    color: #d9ffed;
    padding: 0 14px;
    font-weight: 800;
  }

  button,
  select,
  input[type="range"] {
    cursor: pointer;
  }

  button:disabled,
  select:disabled,
  input:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .scenario-toolbar {
    padding: 8px 0 16px;
  }

  .scenario-select-label {
    color: #a1a1aa;
    font-size: 13px;
    font-weight: 700;
  }

  .scenario-toolbar select {
    min-width: 240px;
    padding: 0 10px;
  }

  .scenario-toolbar button,
  .transport button,
  .transport select {
    padding: 0 10px;
  }

  output {
    color: #a7f3d0;
    font-size: 13px;
  }

  output.bad {
    color: #ff9b8f;
  }

  .workspace-grid {
    display: grid;
    grid-template-columns: 260px minmax(420px, 1fr) 300px;
    gap: 14px;
    align-items: stretch;
    min-height: 0;
  }

  .scenario-list,
  .builder-pane,
  .preview-pane {
    min-width: 0;
    min-height: 0;
  }

  .scenario-list {
    display: grid;
    align-content: start;
    gap: 6px;
    overflow: auto;
  }

  .scenario-list button {
    display: grid;
    gap: 5px;
    width: 100%;
    min-height: 86px;
    padding: 10px 8px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: #d4d4d8;
    text-align: left;
  }

  .scenario-list button.selected {
    border-color: rgba(61, 220, 151, 0.44);
    background: rgba(61, 220, 151, 0.09);
  }

  .scenario-list strong {
    font-size: 13px;
  }

  .scenario-list span,
  .scenario-list small,
  .builder-section p,
  .frame-narrative p {
    color: #a1a1aa;
    line-height: 1.45;
  }

  .scenario-list span,
  .scenario-list small {
    font-size: 11px;
  }

  .preview-pane {
    display: grid;
    grid-template-rows: minmax(260px, 1fr) auto auto;
    overflow: hidden;
  }

  .graph-shell {
    position: relative;
    min-height: 260px;
    background: #050608;
  }

  .scenario-graph {
    width: 100%;
    height: 100%;
    min-height: 260px;
  }

  .scenario-graph line {
    stroke: #4b5563;
    stroke-width: 0.42;
    opacity: 0.7;
  }

  .scenario-graph line.disputed {
    stroke: #ff876d;
    stroke-width: 0.76;
    stroke-dasharray: 1.4 1.2;
  }

  .scenario-graph circle {
    fill: #3b82f6;
    stroke: #bcd3ff;
    stroke-width: 0.45;
  }

  .scenario-graph g.hub circle {
    fill: #13c987;
    stroke: #d9ffed;
    filter: url("#hubGlow");
  }

  .scenario-graph g.disputed circle {
    fill: #ef4444;
    stroke: #ffe4df;
  }

  .scenario-graph g.debtor circle {
    stroke: #facc15;
    stroke-width: 0.72;
  }

  .scenario-graph text {
    fill: #e5e7eb;
    font-size: 2.5px;
    font-weight: 700;
    text-anchor: middle;
    paint-order: stroke;
    stroke: #050608;
    stroke-width: 0.65;
    letter-spacing: 0;
  }

  .loading-layer,
  .error-layer {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: grid;
    place-items: center;
    background: rgba(5, 6, 8, 0.78);
    color: #d4d4d8;
    font-weight: 800;
  }

  .error-layer {
    color: #ff9b8f;
    padding: 24px;
    text-align: center;
  }

  .diagnostic-layer {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 3;
    display: grid;
    gap: 4px;
    max-width: min(520px, calc(100% - 24px));
    padding: 10px 12px;
    border: 1px solid rgba(255, 155, 143, 0.46);
    border-radius: 7px;
    background: rgba(47, 19, 16, 0.9);
    color: #ffd4cc;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.35;
  }

  .frame-narrative {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 0 10px;
    border-top: 1px solid #20242b;
  }

  .frame-narrative h2 {
    margin-top: 4px;
    font-size: 20px;
  }

  .frame-narrative p {
    max-width: 820px;
    margin: 8px 0 0;
    font-size: 13px;
  }

  .collapse-badge {
    align-self: start;
    white-space: nowrap;
    border: 1px solid rgba(255, 135, 109, 0.5);
    border-radius: 999px;
    background: rgba(239, 68, 68, 0.12);
    color: #ffc0b3;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 800;
  }

  .timeline {
    display: grid;
    gap: 10px;
    padding: 10px 0 12px;
    border-top: 1px solid #20242b;
  }

  .timeline input[type="range"] {
    width: 100%;
  }

  .builder-pane {
    display: grid;
    grid-template-rows: auto auto 1fr;
    gap: 14px;
    overflow: hidden;
  }

  .builder-section h2 {
    margin-top: 4px;
    font-size: 18px;
  }

  .builder-section p {
    margin: 8px 0 0;
    font-size: 12px;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .metrics-grid div {
    min-width: 0;
    padding: 0 0 9px;
    border-bottom: 1px solid #20242b;
  }

  .metrics-grid strong,
  .metrics-grid span {
    display: block;
  }

  .metrics-grid strong {
    color: #f4f4f5;
    font-size: 18px;
  }

  .metrics-grid span {
    color: #9ca3af;
    font-size: 11px;
  }

  .builder-notes {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
    gap: 8px;
  }

  .builder-notes textarea {
    width: 100%;
    min-height: 0;
    height: 100%;
    resize: none;
    box-sizing: border-box;
    border: 1px solid #20242b;
    border-radius: 7px;
    background: #050608;
    color: #d4d4d8;
    padding: 10px;
    font: 12px/1.45 "SF Mono", ui-monospace, monospace;
  }

  @media (max-width: 1100px) {
    .scenario-player {
      height: auto;
      min-height: calc(100dvh - 57px);
      padding-bottom: 16px;
      overflow: visible;
    }

    :global(main.with-topbar:has([data-testid="scenario-player"])) {
      height: auto;
      overflow: visible;
    }

    .workspace-grid {
      grid-template-columns: 1fr;
      overflow: visible;
    }

    .scenario-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 680px) {
    .scenario-player {
      padding: 14px;
    }

    .player-topbar,
    .frame-narrative {
      align-items: start;
      flex-direction: column;
    }

    .scenario-list {
      grid-template-columns: 1fr;
    }

    .scenario-toolbar select {
      min-width: 0;
      width: 100%;
    }
  }
</style>
