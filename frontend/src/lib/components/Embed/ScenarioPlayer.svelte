<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { getXLN } from '$lib/stores/xlnRuntimeLoader';
  import {
    currentHeight,
    history,
    setXlnEnvironment,
  } from '$lib/stores/xlnStore';
  import { timeOperations } from '$lib/stores/timeStore';
  import type { Env, EnvSnapshot, XLNModule } from '@xln/runtime/xln-api';

  type ScenarioOption = {
    id: string;
    runtimeId: string;
    runner?: string;
    title: string;
    description: string;
    intent: string;
    tags: string[];
    focus: string[];
  };

  type FrameNode = {
    id: string;
    label: string;
    x: number;
    y: number;
    isHub: boolean;
    disputed: boolean;
    debtCount: number;
    accountCount: number;
  };

  type FrameEdge = {
    key: string;
    from: FrameNode;
    to: FrameNode;
    disputed: boolean;
  };

  type FrameVisual = {
    nodes: FrameNode[];
    edges: FrameEdge[];
    activeDisputes: number;
    debtCount: number;
    accountCount: number;
    title: string;
    description: string;
    collapse: boolean;
  };

  const scenarioOptions: ScenarioOption[] = [
    {
      id: 'hub-collapse',
      runtimeId: 'dispute-lifecycle',
      runner: 'disputeLifecycle',
      title: 'Hub collapse',
      description: 'Unilateral last-resort dispute: user freezes the hub account, waits timeout, finalizes, then reopens.',
      intent: 'Watch what happens when the hub stops cooperating.',
      tags: ['dispute', 'last resort', 'hub'],
      focus: ['dispute', 'freeze', 'finalize', 'debt', 'reopen'],
    },
    {
      id: 'ahb',
      runtimeId: 'ahb',
      runner: 'ahb',
      title: 'Alice-Hub-Bob Triangle',
      description: 'Full bilateral flow: reserves, hub routing, collateral, settlements, disputes, and cooperative close.',
      intent: 'Inspect the full wallet and hub mechanics over time.',
      tags: ['bilateral', 'routing', 'settlement'],
      focus: ['Alice', 'Hub', 'Bob', 'payment', 'settlement'],
    },
    {
      id: 'lock-ahb',
      runtimeId: 'lock-ahb',
      runner: 'lockAhb',
      title: 'HTLC route',
      description: 'Hash-locked multi-hop payment through a hub with secret propagation and timeout protection.',
      intent: 'Preview payment safety without trusting the intermediary.',
      tags: ['htlc', 'routing'],
      focus: ['HTLC', 'secret', 'timeout', 'Hostage'],
    },
    {
      id: 'settle',
      runtimeId: 'settle',
      runner: 'settle',
      title: 'Settlement workspace',
      description: 'Bilateral settlement negotiation: propose, counter, approve, execute, reject.',
      intent: 'Build and inspect settlement UI narratives quickly.',
      tags: ['settlement', 'workspace'],
      focus: ['Settlement', 'propose', 'signed', 'reject'],
    },
    {
      id: 'swap',
      runtimeId: 'swap',
      runner: 'swap',
      title: 'Swap orderbook',
      description: 'Same-jurisdiction bilateral orderbook with limit orders, fills, holds, and cancel flow.',
      intent: 'Check how trading state evolves frame by frame.',
      tags: ['swap', 'orderbook'],
      focus: ['swap', 'order', 'fill', 'cancel'],
    },
  ];

  let selectedScenarioId = scenarioOptions[0]!.id;
  let selectedScenario = scenarioOptions[0]!;
  let frames: EnvSnapshot[] = [];
  let loadedEnv: Env | null = null;
  let currentFrame = 0;
  let status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let statusText = 'Ready to run';
  let errorText = '';
  let playing = false;
  let playbackMs = 700;
  let playTimer: number | null = null;
  let loadSeq = 0;
  let builderInspectText = 'No frame loaded.';

  const emptyVisual: FrameVisual = {
    nodes: [],
    edges: [],
    activeDisputes: 0,
    debtCount: 0,
    accountCount: 0,
    title: '',
    description: '',
    collapse: false,
  };

  $: selectedScenario = scenarioOptions.find((scenario) => scenario.id === selectedScenarioId) || scenarioOptions[0]!;
  $: activeFrame = frames[currentFrame] || null;
  $: visual = activeFrame ? buildFrameVisual(activeFrame, selectedScenario) : emptyVisual;
  $: progressText = frames.length > 0 ? `${currentFrame + 1}/${frames.length}` : '0/0';
  $: builderInspectText = formatBuilderText(activeFrame, visual, selectedScenario, currentFrame, frames.length);

  function mapEntries<T = unknown>(value: unknown): Array<[string, T]> {
    if (value instanceof Map) return Array.from(value.entries()).map(([key, item]) => [String(key), item as T]);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value as Record<string, T>);
    }
    return [];
  }

  function mapSize(value: unknown): number {
    if (value instanceof Map) return value.size;
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).length;
    return 0;
  }

  function normalizeId(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  function shortId(value: string): string {
    const id = normalizeId(value);
    return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
  }

  function profileName(frame: EnvSnapshot, entityId: string): string {
    const target = normalizeId(entityId);
    const profile = (frame.gossip?.profiles || []).find((item) => normalizeId(item.entityId) === target);
    return String(profile?.name || '').trim() || shortId(entityId);
  }

  function profileIsHub(frame: EnvSnapshot, entityId: string, fallbackName: string): boolean {
    const target = normalizeId(entityId);
    const profile = (frame.gossip?.profiles || []).find((item) => normalizeId(item.entityId) === target);
    return profile?.metadata?.isHub === true || /hub/i.test(fallbackName);
  }

  function countDebts(state: Record<string, unknown>): number {
    let count = 0;
    for (const family of ['outDebtsByToken', 'inDebtsByToken']) {
      for (const [, byDebtId] of mapEntries(state[family])) {
        count += mapSize(byDebtId);
      }
    }
    return count;
  }

  function readPosition(replica: Record<string, unknown>, index: number, total: number): { x: number; y: number; raw: boolean } {
    const state = asRecord(replica['state']);
    const raw = (replica['position'] || state['position']) as { x?: unknown; y?: unknown } | undefined;
    const x = Number(raw?.x);
    const y = Number(raw?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, raw: true };
    const angle = total <= 1 ? 0 : (index / total) * Math.PI * 2;
    return { x: Math.cos(angle) * 40, y: Math.sin(angle) * 24, raw: false };
  }

  function normalizePositions(nodes: Array<FrameNode & { rawX: number; rawY: number }>): FrameNode[] {
    if (nodes.length === 0) return [];
    const xs = nodes.map((node) => node.rawX);
    const ys = nodes.map((node) => node.rawY);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    return nodes.map(({ rawX, rawY, ...node }) => ({
      ...node,
      x: 12 + ((rawX - minX) / width) * 76,
      y: 12 + ((rawY - minY) / height) * 40,
    }));
  }

  function frameText(frame: EnvSnapshot): string {
    return [
      frame.meta?.title,
      frame.meta?.subtitle?.title,
      frame.description,
      frame.narrative,
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function frameMatchesFocus(frame: EnvSnapshot, option: ScenarioOption): boolean {
    const text = frameText(frame);
    return option.focus.some((keyword) => text.includes(keyword.toLowerCase()));
  }

  function buildFrameVisual(frame: EnvSnapshot, option: ScenarioOption): FrameVisual {
    const rawNodes: Array<FrameNode & { rawX: number; rawY: number }> = [];
    const nodeById = new Map<string, FrameNode & { rawX: number; rawY: number }>();
    const replicaEntries = mapEntries<Record<string, unknown>>(frame.eReplicas);

    replicaEntries.forEach(([replicaKey, replica], index) => {
      const state = asRecord(replica['state']);
      const entityId = normalizeId(replica['entityId'] || state['entityId'] || replicaKey.split(':')[0]);
      if (!entityId || nodeById.has(entityId)) return;
      const accounts = mapEntries<Record<string, unknown>>(state['accounts']);
      const disputed = accounts.some(([, account]) => Boolean(account?.['activeDispute']));
      const debtCount = countDebts(state);
      const label = profileName(frame, entityId);
      const position = readPosition(replica, index, Math.max(1, replicaEntries.length));
      const node = {
        id: entityId,
        label,
        x: 0,
        y: 0,
        rawX: position.x,
        rawY: position.y,
        isHub: profileIsHub(frame, entityId, label),
        disputed,
        debtCount,
        accountCount: accounts.length,
      };
      nodeById.set(entityId, node);
      rawNodes.push(node);
    });

    const nodes = normalizePositions(rawNodes);
    const normalizedNodeById = new Map(nodes.map((node) => [node.id, node]));
    const edgeMap = new Map<string, FrameEdge>();
    let activeDisputes = 0;
    let debtCount = 0;
    let accountCount = 0;

    for (const [, replica] of replicaEntries) {
      const state = asRecord(replica['state']);
      const sourceId = normalizeId(replica['entityId'] || state['entityId']);
      if (!sourceId) continue;
      debtCount += countDebts(state);
      for (const [counterpartyIdRaw, account] of mapEntries<Record<string, unknown>>(state['accounts'])) {
        const counterpartyId = normalizeId(counterpartyIdRaw);
        const from = normalizedNodeById.get(sourceId);
        const to = normalizedNodeById.get(counterpartyId);
        if (!from || !to || from.id === to.id) continue;
        accountCount += 1;
        const disputed = Boolean(account?.['activeDispute']);
        if (disputed) activeDisputes += 1;
        const key = [from.id, to.id].sort().join('|');
        const existing = edgeMap.get(key);
        edgeMap.set(key, {
          key,
          from,
          to,
          disputed: disputed || existing?.disputed === true,
        });
      }
    }

    const title = String(frame.meta?.title || frame.meta?.subtitle?.title || `Frame ${frame.height}`);
    const description = String(frame.description || frame.narrative || option.description);
    const collapse = option.id === 'hub-collapse' && (
      activeDisputes > 0 ||
      debtCount > 0 ||
      /dispute|finalize|freeze|debt|reopen|non-cooperative/i.test(`${title} ${description}`)
    );

    return {
      nodes,
      edges: Array.from(edgeMap.values()),
      activeDisputes,
      debtCount,
      accountCount,
      title,
      description,
      collapse,
    };
  }

  function preparePreviewEnv(env: Env): Env {
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.scenarioLogLevel = 'error';
    env.timestamp = env.timestamp || 1;
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: {
        ...env.runtimeConfig?.storage,
        enabled: false,
      },
    };
    if (env.runtimeState) env.runtimeState.persistencePaused = true;
    return env;
  }

  function stopPreviewInfra(env: Env | null): void {
    if (!env) return;
    for (const [, jReplica] of mapEntries<Record<string, unknown>>(env.jReplicas)) {
      const adapter = asRecord(jReplica['jadapter']);
      try {
        if (typeof adapter['stopWatching'] === 'function') {
          (adapter['stopWatching'] as () => void)();
        }
      } catch (error) {
        console.warn('[scenario-player] failed to stop J-watcher', error);
      }
    }
    try {
      env.runtimeState?.stopLoop?.();
    } catch (error) {
      console.warn('[scenario-player] failed to stop runtime loop', error);
    }
    if (env.runtimeState) {
      env.runtimeState.loopActive = false;
      env.runtimeState.stopLoop = null;
    }
  }

  async function runRuntimeScenario(xln: XLNModule, option: ScenarioOption, env: Env): Promise<Env> {
    const runtimeAny = xln as XLNModule & {
      scenarios?: Record<string, (target: Env) => Promise<Env | void>>;
      getScenario?: (id: string) => { run: (target: Env) => Promise<Env | void> } | undefined;
      SCENARIOS?: Array<{ id: string; run: (target: Env) => Promise<Env | void> }>;
    };
    const runner = option.runner ? runtimeAny.scenarios?.[option.runner] : undefined;
    if (runner) {
      return (await runner(env)) || env;
    }
    const entry = runtimeAny.getScenario?.(option.runtimeId)
      || runtimeAny.SCENARIOS?.find((scenario) => scenario.id === option.runtimeId);
    if (!entry) throw new Error(`SCENARIO_NOT_FOUND:${option.runtimeId}`);
    return (await entry.run(env)) || env;
  }

  function publishFrame(index: number): void {
    const env = loadedEnv;
    const frame = frames[index];
    if (!env || !frame) return;
    setXlnEnvironment(env);
    history.set(frames);
    currentHeight.set(frame.height);
    timeOperations.updateMaxTimeIndex();
    timeOperations.goToTimeIndex(index);
  }

  function focusFrameIndex(option: ScenarioOption, nextFrames: EnvSnapshot[]): number {
    if (nextFrames.length === 0) return 0;
    if (option.id === 'hub-collapse') {
      const collapseFrame = nextFrames.findIndex((frame) => buildFrameVisual(frame, option).collapse);
      if (collapseFrame >= 0) return collapseFrame;
    }
    const found = nextFrames.findIndex((frame) => frameMatchesFocus(frame, option));
    return found >= 0 ? found : 0;
  }

  async function loadScenario(option = selectedScenario): Promise<void> {
    const seq = ++loadSeq;
    pause();
    status = 'loading';
    statusText = `Running ${option.title}`;
    errorText = '';
    frames = [];
    stopPreviewInfra(loadedEnv);
    loadedEnv = null;
    currentFrame = 0;

    try {
      const xln = await getXLN();
      const env = preparePreviewEnv(xln.createEmptyEnv(`scenario-preview:${option.id}`));
      const resultEnv = preparePreviewEnv(await runRuntimeScenario(xln, option, env));
      stopPreviewInfra(resultEnv);
      const nextFrames = Array.isArray(resultEnv.history) ? resultEnv.history : [];
      if (seq !== loadSeq) return;
      if (nextFrames.length === 0) throw new Error(`SCENARIO_EMPTY_HISTORY:${option.id}`);

      loadedEnv = resultEnv;
      frames = nextFrames;
      currentFrame = focusFrameIndex(option, nextFrames);
      status = 'ready';
      statusText = `${option.title}: ${nextFrames.length} frames`;
      publishFrame(currentFrame);
    } catch (error) {
      if (seq !== loadSeq) return;
      status = 'error';
      errorText = error instanceof Error ? error.message : String(error);
      statusText = 'Scenario failed';
      console.error('[scenario-player] load failed', error);
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

  function formatBuilderText(
    frame: EnvSnapshot | null,
    frameVisual: FrameVisual,
    option: ScenarioOption,
    index: number,
    totalFrames: number,
  ): string {
    if (!frame) return 'No frame loaded.';
    const inputCount = frame.runtimeInput?.entityInputs?.length ?? 0;
    const outputCount = frame.runtimeOutputs?.length ?? 0;
    const logCount = frame.logs?.length ?? 0;
    return [
      `scenario=${option.id}`,
      `runtime=${option.runtimeId}`,
      `frame=${index + 1}/${totalFrames}`,
      `height=${frame.height}`,
      `title=${frameVisual.title}`,
      `inputs=${inputCount}`,
      `outputs=${outputCount}`,
      `logs=${logCount}`,
      `entities=${frameVisual.nodes.length}`,
      `accounts=${frameVisual.accountCount}`,
      `activeDisputes=${frameVisual.activeDisputes}`,
      `debts=${frameVisual.debtCount}`,
    ].join('\n');
  }

  onMount(() => {
    void loadScenario(selectedScenario);
  });

  onDestroy(() => {
    pause();
    stopPreviewInfra(loadedEnv);
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
