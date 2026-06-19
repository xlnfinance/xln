<script lang="ts">
  /**
   * Architect Panel - God-mode controls (extracted from NetworkTopology sidebar)
   * 5 modes: Explore, Build, Economy, Governance, Resolve
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { get } from 'svelte/store';
  import { onDestroy, onMount } from 'svelte';
  import { panelBridge } from '../utils/panelBridge';
  // @ts-ignore - Vite raw import
  import ahbScenarioCode from '../../../../../runtime/scenarios/ahb.ts?raw';
  // @ts-ignore - Vite raw import
  import settleScenarioCode from '../../../../../runtime/scenarios/settle.ts?raw';
  import { shortAddress } from '$lib/utils/format';
  import { getXLN } from '$lib/stores/xlnStore';
  import type { XLNModule } from '@xln/runtime/xln-api';
  import type { JAdapter } from '@xln/runtime/jadapter';
  import { activeRuntime as activeRuntimeStore } from '$lib/stores/runtimeStore';
  import { activeRuntime as activeVaultRuntime } from '$lib/stores/vaultStore';
  import SolvencyPanel from './SolvencyPanel.svelte';

  // Receive isolated env as props (passed from View.svelte) - REQUIRED
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;
  export let isolatedTimeIndex: Writable<number>;
  export let isolatedIsLive: Writable<boolean>;

  type Mode = 'explore' | 'build' | 'economy' | 'solvency' | 'governance' | 'resolve';
  let currentMode: Mode = 'economy';
  let loading = false;
  let lastAction = '';

  // Reserve operations state
  let selectedEntityForMint = '';
  let mintAmount = '1000000'; // 1M units
  let r2rFromEntity = '';
  let r2rToEntity = '';
  let r2rAmount = '500000'; // 500K units

  // Entity registration mode
  let numberedEntities = false; // Default: lazy (in-memory only, no blockchain needed)
  let newEntityName = 'alice'; // For manual entity creation in Build mode

  // S&P 500 tickers (top 50)
  const SP500_TICKERS = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
    'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS',
    'UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'TMO', 'MRK',
    'WMT', 'PG', 'KO', 'PEP', 'COST', 'HD', 'MCD', 'NKE',
    'XOM', 'CVX', 'BA', 'CAT', 'GE', 'MMM',
    'DIS', 'NFLX', 'CMCSA', 'T', 'VZ',
    'INTC', 'CSCO', 'ORCL', 'CRM', 'AMD'
  ];

  // Xlnomy state
  let showCreateXlnomyModal = false;
  let newXlnomyName = 'Testnet';
  let newXlnomyEvmType: 'browservm' | 'reth' | 'erigon' | 'monad' = 'browservm';
  let newXlnomyRpcUrl = 'http://localhost:8545';
  let newXlnomyBlockTime = '1000';

  // Get available Xlnomies from env
  $: jurisdictions = $isolatedEnv?.jReplicas ? Array.from($isolatedEnv.jReplicas.keys()) : [];
  $: activeJurisdiction = $isolatedEnv?.activeJurisdiction || '';

  // Check if env is ready
  $: envReady = $isolatedEnv !== null && $isolatedEnv !== undefined;

  // CRITICAL: mutations are only valid against the active live runtime frame.
  $: isLiveActionFrame = Boolean($isolatedIsLive) && $isolatedTimeIndex === -1;

  let cachedXLN: XLNModule | null = null;

  async function getJAdapterFromEnv(): Promise<JAdapter | null> {
    if (!$isolatedEnv) return null;
    const xln = cachedXLN ?? await getXLN();
    cachedXLN = xln;
    return xln.getActiveJAdapter?.($isolatedEnv) ?? null;
  }

  async function requireBrowserVMDebugAdapter(action: string): Promise<JAdapter> {
    const jadapter = await getJAdapterFromEnv();
    if (!jadapter || jadapter.mode !== 'browservm' || !jadapter.debugFundReservesBatch) {
      throw new Error(`${action} requires BrowserVM debug mode`);
    }
    return jadapter;
  }

  async function debugFundReservesBatch(
    mints: Array<{ entityId: string; tokenId: number; amount: bigint }>
  ): Promise<void> {
    if (mints.length === 0) return;
    if (!requireLiveMode('reserve funding')) {
      throw new Error('reserve funding requires LIVE mode');
    }
    const jadapter = await requireBrowserVMDebugAdapter('Reserve funding');
    await jadapter.debugFundReservesBatch(mints);
  }

  async function ingressRuntimeInput(
    XLN: any,
    input: { runtimeTxs: any[]; entityInputs: any[] },
    action = 'runtime action'
  ): Promise<void> {
    if (!requireLiveMode(action)) {
      throw new Error(`${action} requires LIVE mode`);
    }
    XLN.enqueueRuntimeInput($isolatedEnv, input);
  }

  /** Guard function - blocks mutations when viewing history */
  function requireLiveMode(action: string): boolean {
    if (!isLiveActionFrame) {
      lastAction = `${action} requires LIVE mode. Switch to the current runtime state before acting.`;
      console.warn('[Architect] Blocked mutation outside live mode:', action);
      return false;
    }
    return true;
  }

  function publishCurrentEnv(frames: any[] = $isolatedEnv?.history || []): void {
    isolatedIsLive.set(true);
    isolatedTimeIndex.set(-1);
    isolatedHistory.set(frames);
    isolatedEnv.set($isolatedEnv);
  }

  const DEMO_RUNTIME_SEED = '';

  function resolveRuntimeSeed(): string | null {
    const vaultRuntime = get(activeVaultRuntime);
    if (vaultRuntime?.seed !== undefined && vaultRuntime?.seed !== null) {
      return vaultRuntime.seed;
    }

    const runtimeMeta = get(activeRuntimeStore);
    if (runtimeMeta?.seed !== undefined && runtimeMeta?.seed !== null) {
      return runtimeMeta.seed;
    }

    if ($isolatedEnv?.runtimeSeed !== undefined && $isolatedEnv?.runtimeSeed !== null) {
      return $isolatedEnv.runtimeSeed;
    }

    return null;
  }

  function ensureScenarioEnv(XLN: any, label: string): void {
    let seed = resolveRuntimeSeed();
    if (seed === null || seed === undefined) {
      seed = DEMO_RUNTIME_SEED;
      console.warn(`[${label}] No runtime seed found; using demo seed.`);
    }
    if (!$isolatedEnv) {
      $isolatedEnv = XLN.createEmptyEnv(seed ?? null);
      isolatedEnv.set($isolatedEnv);
    }

    if (seed !== null && seed !== undefined && $isolatedEnv.runtimeSeed !== seed) {
      $isolatedEnv.runtimeSeed = seed;
    }

    if ($isolatedEnv.runtimeSeed === undefined || $isolatedEnv.runtimeSeed === null) {
      throw new Error(`${label}: runtimeSeed missing - unlock vault or set XLN_RUNTIME_SEED`);
    }

    if (!$isolatedEnv.eReplicas) {
      $isolatedEnv.eReplicas = new Map();
    }

    isolatedEnv.set($isolatedEnv);
  }

  // Get entity IDs for dropdowns (extract entityId from replica keys)
  let entityIds: string[] = [];
  $: entityIds = $isolatedEnv?.eReplicas
    ? Array.from($isolatedEnv.eReplicas.keys() as Iterable<string>).map((key: string) => key.split(':')[0] || key).filter((id: string, idx: number, arr: string[]) => arr.indexOf(id) === idx)
    : [];

  // Listen for VR payment gestures
  const handleVRPayment = async ({ from, to }: { from: string; to: string }) => {
    r2rFromEntity = from;
    r2rToEntity = to;
    r2rAmount = '500000'; // Default $500K
    await sendR2RTransaction();
  };
  const unsubVRPayment = panelBridge.on('vr:payment', handleVRPayment);

  // Auto-demo mode (triggered when entering VR for Bernanke wow)
  const handleAutoDemo = async () => {

    // Step 1: Fund all entities if not already funded
    if (entityIds.length > 0) {
      await fundAllEntities();

      // Step 2: Start payment loop after 2 seconds
      setTimeout(() => {
        startFedPaymentLoop();
      }, 2000);
    }
  };
  const unsubAutoDemo = panelBridge.on('auto-demo:start', handleAutoDemo);

  // Clean up subscriptions on component destroy
  onDestroy(() => {
    unsubVRPayment();
    unsubAutoDemo();
  });

  /** Mint reserves to selected entity */
  async function mintReservesToEntity() {
    if (!requireLiveMode('mint reserves')) return;
    if (!selectedEntityForMint || !$isolatedEnv) {
      lastAction = ' Select an entity first';
      return;
    }

    loading = true;
    lastAction = `Minting ${mintAmount} to ${shortAddress(selectedEntityForMint)}...`;

    try {
      const amount = BigInt(mintAmount);
      await debugFundReservesBatch([{ entityId: selectedEntityForMint, tokenId: 1, amount }]);

      lastAction = `✅ Minted ${mintAmount} to entity (on-chain)`;

      publishCurrentEnv();
    } catch (err: any) {
      lastAction = ` ${err.message}`;
      console.error('[Architect] Mint error:', err);
    } finally {
      loading = false;
    }
  }

  /** Send R2R (Reserve-to-Reserve) transaction via J-Machine (Depository.sol) */
  async function sendR2RTransaction() {
    if (!requireLiveMode('send R2R transaction')) return;
    if (!r2rFromEntity || !r2rToEntity || r2rFromEntity === r2rToEntity) {
      lastAction = '⚠️ Select different FROM and TO entities';
      return;
    }

    if (!$isolatedEnv) {
      lastAction = '⚠️ Environment not ready';
      return;
    }

    const jadapter = await getJAdapterFromEnv();
    if (!jadapter?.getReserves) {
      lastAction = '⚠️ JAdapter not available';
      return;
    }

    loading = true;
    lastAction = `Sending R2R: ${shortAddress(r2rFromEntity)} → ${shortAddress(r2rToEntity)}...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Debug: check reserves before R2R
      const amount = BigInt(r2rAmount);
      const fromReserve = await jadapter.getReserves(r2rFromEntity, 1);

      if (fromReserve < amount) {
        throw new Error(`Insufficient reserves: have ${fromReserve}, need ${amount}`);
      }

      const replicaKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find((key) => key.startsWith(`${r2rFromEntity}:`));
      const replica = replicaKey ? $isolatedEnv.eReplicas.get(replicaKey) : null;
      const signerId = replica?.signerId;
      if (!signerId) {
        throw new Error(`Missing signer for ${shortAddress(r2rFromEntity)}`);
      }
      await ingressRuntimeInput(XLN, {
        runtimeTxs: [],
        entityInputs: [{
          entityId: r2rFromEntity,
          signerId,
          entityTxs: [{
            type: 'r2r',
            data: {
              toEntityId: r2rToEntity,
              tokenId: 1,
              amount,
            },
          }],
        }],
      }, 'send R2R transaction');

      lastAction = `✅ R2R sent: ${r2rAmount} units (on-chain)`;

      publishCurrentEnv();
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] R2R error:', err);
    } finally {
      loading = false;
    }
  }

  // ============================================================================
  // TUTORIAL SYSTEM - Autopilot Mode
  // ============================================================================

  let tutorialActive = false;
  // Scenario Code - shows actual scenarios/ahb.ts from /runtime (via Vite raw import)
  let scenarioCodeTextarea: HTMLTextAreaElement;
  const scenarioCode = ahbScenarioCode;

  // Find line number for current frame in scenarios/ahb.ts
  function getFrameLineNumber(frameIndex: number): number {
    const lines = scenarioCode.split('\n');
    // Match patterns like "FRAME 12:", "Frame 12:", "FRAME 12 ", etc.
    const framePattern = new RegExp(`FRAME\\s+${frameIndex}[:\\s]`, 'i');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line && framePattern.test(line)) {
        return i;
      }
    }
    return 0;
  }

  // Scroll textarea to current frame when timeIndex changes
  $: if (scenarioCodeTextarea && $isolatedTimeIndex >= 0) {
    const lineNumber = getFrameLineNumber($isolatedTimeIndex);
    const lineHeight = 18; // Approximate line height in pixels
    scenarioCodeTextarea.scrollTop = lineNumber * lineHeight - 50;
  }

  /** Run preset by ID */
  async function runPreset(presetId: string) {
    if (presetId === 'empty') {
      // Create empty J-Machine (just jurisdiction, no entities)
      if (!activeJurisdiction) {
        showCreateXlnomyModal = true;
      }
      lastAction = ' Empty J-Machine ready - add entities manually';
      return;
    }
  }

  /** Start AHB Tutorial with autopilot */
  let ahbRunning = false; // Guard against double execution
  async function startAHBTutorial() {
    if (!requireLiveMode('run AHB tutorial')) return;
    if (ahbRunning) {
      return;
    }
    ahbRunning = true;
    loading = true;
    tutorialActive = true;
    try {
      const XLN = await getXLN();

      // Ensure env exists with seed + eReplicas
      ensureScenarioEnv(XLN, 'AHB');
      const jadapter = await getJAdapterFromEnv();

      // CRITICAL: Clear old state BEFORE running demo
      $isolatedEnv.eReplicas.clear();
      $isolatedEnv.history = [];

      // Run the ACTUAL AHB scenario (same code as CLI)
      await XLN.scenarios.ahb($isolatedEnv);

      const frames = $isolatedEnv.history || [];

      publishCurrentEnv(frames);

      lastAction = `AHB: ${frames.length} frames loaded. Use TimeMachine to navigate.`;

      // NO autopilot - user controls historical frames via TimeMachine.
      // Keep the workspace LIVE on the scenario's final runtime env by default.
      tutorialActive = false; // Don't show tutorial UI - just use TimeMachine
    } catch (err: any) {
      // CRITICAL: Still update history with frames created before error
      const frames = $isolatedEnv?.history || [];
      if (frames.length > 0) {
        publishCurrentEnv(frames);
        lastAction = `AHB: ${frames.length} frames (stopped at error). ${err.message}`;
      } else {
        lastAction = `❌ ${err.message}`;
      }
      console.error('[Tutorial] AHB error:', err);
      tutorialActive = false;
    } finally {
      loading = false;
      ahbRunning = false; // Reset guard
    }
  }

  /** Start HTLC Tutorial (lock-ahb scenario) */
  let htlcRunning = false;
  async function startHTLCTutorial() {
    if (!requireLiveMode('run HTLC tutorial')) return;
    if (htlcRunning) {
      return;
    }
    htlcRunning = true;
    loading = true;
    try {
      const XLN = await getXLN();
      ensureScenarioEnv(XLN, 'HTLC');
      $isolatedEnv.eReplicas.clear();
      $isolatedEnv.history = [];
      await XLN.scenarios.lockAhb($isolatedEnv);

      const frames = $isolatedEnv.history || [];
      publishCurrentEnv(frames);
      lastAction = `HTLC: ${frames.length} frames loaded.`;
    } catch (err: any) {
      const frames = $isolatedEnv?.history || [];
      if (frames.length > 0) {
        publishCurrentEnv(frames);
        lastAction = `HTLC: ${frames.length} frames (error). ${err.message}`;
      } else {
        lastAction = `❌ ${err.message}`;
      }
      console.error('[HTLC] error:', err);
    } finally {
      loading = false;
      htlcRunning = false;
    }
  }

  /** Start Swap Tutorial */
  let swapRunning = false;
  async function startSwapTutorial() {
    if (!requireLiveMode('run swap tutorial')) return;
    if (swapRunning) {
      return;
    }
    swapRunning = true;
    loading = true;
    try {
      const XLN = await getXLN();
      ensureScenarioEnv(XLN, 'Swap');
      $isolatedEnv.eReplicas.clear();
      $isolatedEnv.history = [];
      await XLN.scenarios.swap($isolatedEnv);

      const frames = $isolatedEnv.history || [];
      publishCurrentEnv(frames);
      lastAction = `Swap: ${frames.length} frames loaded.`;
    } catch (err: any) {
      const frames = $isolatedEnv?.history || [];
      if (frames.length > 0) {
        publishCurrentEnv(frames);
        lastAction = `Swap: ${frames.length} frames (error). ${err.message}`;
      } else {
        lastAction = `❌ ${err.message}`;
      }
      console.error('[SWAP] error:', err);
    } finally {
      loading = false;
      swapRunning = false;
    }
  }

  /** Start Swap Market (8 users, 3 orderbooks) */
  async function runSwapMarket() {
    if (!requireLiveMode('run swap-market')) return;
    loading = true;
    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      ensureScenarioEnv(XLN, 'Swap Market');
      $isolatedEnv.eReplicas.clear();
      $isolatedEnv.history = [];
      await XLN.scenarios.swapMarket($isolatedEnv);

      const frames = $isolatedEnv.history || [];
      publishCurrentEnv(frames);

      lastAction = `Swap Market: ${frames.length} frames`;
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
    } finally {
      loading = false;
    }
  }

  /** Start Rapid Fire stress test */
  async function runRapidFire() {
    if (!requireLiveMode('run rapid-fire')) return;
    loading = true;
    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      ensureScenarioEnv(XLN, 'Rapid Fire');
      $isolatedEnv.eReplicas.clear();
      $isolatedEnv.history = [];
      await XLN.scenarios.rapidFire($isolatedEnv);

      const frames = $isolatedEnv.history || [];
      publishCurrentEnv(frames);

      lastAction = `Rapid Fire: ${frames.length} frames`;
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
    } finally {
      loading = false;
    }
  }

  /** Reset to fresh runtime instance */
  async function resetScenario() {
    if (!requireLiveMode('reset scenario')) return;
    loading = true;
    try {
      const XLN = await getXLN();

      const seed = resolveRuntimeSeed() ?? DEMO_RUNTIME_SEED;
      const freshEnv = XLN.createEmptyEnv(seed);
      isolatedEnv.set(freshEnv);

      // Reset UI state
      isolatedHistory.set([]);
      isolatedTimeIndex.set(-1);
      isolatedIsLive.set(true);
      tutorialActive = false;
      lastAction = 'Reset complete - ready for new scenario';
    } catch (err: any) {
      console.error('[Reset] Error:', err);
      lastAction = `❌ Reset failed: ${err.message}`;
    } finally {
      loading = false;
    }
  }

  /** Start Grid Scalability Scenario */
  let gridRunning = false;
  async function startGridScenario() {
    if (!requireLiveMode('run grid scenario')) return;
    if (gridRunning) {
      return;
    }
    gridRunning = true;
    loading = true;
    tutorialActive = true;
    try {
      const XLN = await getXLN();

      ensureScenarioEnv(XLN, 'Grid');

      // Clear old state BEFORE running demo
      $isolatedEnv.eReplicas.clear();
      $isolatedEnv.jReplicas?.clear();
      $isolatedEnv.history = [];

      // Run the grid scenario
      await XLN.scenarios.grid($isolatedEnv);

      const frames = $isolatedEnv.history || [];
      publishCurrentEnv(frames);
      lastAction = 'Grid Scalability scenario loaded';
    } catch (err: any) {
      if (err && typeof err === 'object' && 'message' in err) {
        lastAction = `❌ ${err.message}`;
      } else {
        lastAction = `❌ ${err}`;
      }
      console.error('[Grid] Error:', err);
      tutorialActive = false;
    } finally {
      loading = false;
      gridRunning = false;
    }
  }

  /** Start Settlement Workspace Scenario */
  let settleRunning = false;
  async function startSettleScenario() {
    if (!requireLiveMode('run settlement scenario')) return;
    if (settleRunning) {
      return;
    }
    settleRunning = true;
    loading = true;
    tutorialActive = true;
    try {
      const XLN = await getXLN();

      ensureScenarioEnv(XLN, 'Settle');

      // Clear old state BEFORE running demo
      $isolatedEnv.eReplicas.clear();
      $isolatedEnv.jReplicas?.clear();
      $isolatedEnv.history = [];

      // Run the settle scenario
      await (XLN.scenarios as any).settle($isolatedEnv);

      const frames = $isolatedEnv.history || [];
      publishCurrentEnv(frames);
      lastAction = 'Settlement Workspace scenario loaded';
    } catch (err: any) {
      if (err && typeof err === 'object' && 'message' in err) {
        lastAction = `❌ ${err.message}`;
      } else {
        lastAction = `❌ ${err}`;
      }
      console.error('[Settle] Error:', err);
      tutorialActive = false;
    } finally {
      loading = false;
      settleRunning = false;
    }
  }

  /** BANKER DEMO STEP 1: Create 3×3 Hub */
  async function createHub() {
    if (!requireLiveMode('create hub')) return;
    loading = true;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Auto-create default jurisdiction if none exists
      if (!$isolatedEnv?.activeJurisdiction) {
        lastAction = 'Connecting to testnet...';

        // Auto-import testnet (prod anvil) - shared J-machine
        await ingressRuntimeInput(XLN, {
          runtimeTxs: [{
            type: 'importJ',
            data: {
              name: 'Testnet',
              chainId: 31337,
              ticker: 'USDC',
              rpcs: ['https://xln.finance/rpc'], // Prod anvil
            }
          }],
          entityInputs: []
        });

        // Process queued importReplica transactions
        await ingressRuntimeInput(XLN, {
          runtimeTxs: [],
          entityInputs: []
        });
      }

      if (entityIds.length > 0) {
        lastAction = ' Hub already exists';
        loading = false;
        return;
      }

      lastAction = 'Creating 3×3 hub (9 entities)...';

      const xlnomy = $isolatedEnv.jReplicas.get($isolatedEnv.activeJurisdiction);
      if (!xlnomy) throw new Error('Active xlnomy not found');

      const jPos = xlnomy.jMachine.position;

      // Create 9 entities in 3×3 grid at y=320
      const entities = [];
      for (let i = 0; i < 9; i++) {
        const row = Math.floor(i / 3);
        const col = i % 3;
        const x = jPos.x + (col - 1) * 40;
        const z = jPos.z + (row - 1) * 40;
        const y = jPos.y + 20; // y=320

        const signerId = `${$isolatedEnv.activeJurisdiction}_e${i}`;
        const encoder = new TextEncoder();
        const data = encoder.encode(`${$isolatedEnv.activeJurisdiction}:e${i}:${Date.now()}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const entityId = '0x' + hashHex;

        entities.push({
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: $isolatedEnv.activeJurisdiction
            },
            isProposer: true,
            position: { x, y, z }
          }
        });
      }

      // Import all entities
      await ingressRuntimeInput(XLN, {
        runtimeTxs: entities,
        entityInputs: []
      });

      lastAction = ` Created 3×3 hub (9 entities at y=320)`;

      publishCurrentEnv();
    } catch (err: any) {
      lastAction = ` ${err.message}`;
      console.error('[Architect] Create hub error:', err);
    } finally {
      loading = false;
    }
  }

  /** BANKER DEMO STEP 2: Fund all entities */
  async function fundAllEntities() {
    if (entityIds.length === 0) {
      lastAction = ' Create hub first';
      return;
    }

    loading = true;
    lastAction = `Funding ${entityIds.length} entities...`;

    try {
      await debugFundReservesBatch(
        entityIds.map((entityId) => ({
          entityId,
          tokenId: 1,
          amount: 1_000_000n,
        })),
      );

      lastAction = ` Funded all ${entityIds.length} entities with $1M`;

      publishCurrentEnv();
    } catch (err: any) {
      lastAction = ` ${err.message}`;
      console.error('[Architect] Fund all error:', err);
    } finally {
      loading = false;
    }
  }

  /** BANKER DEMO STEP 3: Send one random payment */
  async function sendRandomPayment() {
    if (!requireLiveMode('send payment')) return;
    if (entityIds.length < 2) {
      lastAction = ' Need at least 2 entities';
      return;
    }

    loading = true;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Pick 2 random different entities
      const from = entityIds[Math.floor(Math.random() * entityIds.length)];
      let to = entityIds[Math.floor(Math.random() * entityIds.length)];
      while (to === from && entityIds.length > 1) {
        to = entityIds[Math.floor(Math.random() * entityIds.length)];
      }

      const fromReplicaKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(from + ':'));
      const fromReplica = fromReplicaKey ? $isolatedEnv.eReplicas.get(fromReplicaKey) : null;

      if (!fromReplica || !from || !to) {
        throw new Error('Entity not found');
      }

      lastAction = `Sending payment ${from.slice(0, 8)} → ${to.slice(0, 8)}...`;

      // Check if account exists
      const hasAccount = fromReplica.state?.accounts?.has(to);

      // Open account if needed
      if (!hasAccount) {
        await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: [{
          entityId: from,
          signerId: fromReplica.signerId,
          entityTxs: [{
            type: 'openAccount',
            data: { targetEntityId: to }
          }]
        }] }, 'send payment');
      }

      // Send payment
      const amount = Math.floor(Math.random() * 100000) + 10000; // 10K-110K
      await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: [{
        entityId: from,
        signerId: fromReplica.signerId,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: to,
            tokenId: 1,
            amount: BigInt(amount),
            route: [from, to],
            description: 'Random banker demo payment'
          }
        }]
      }] }, 'send payment');

      lastAction = ` Payment: ${shortAddress(from)} → ${shortAddress(to)} ($${(amount/1000).toFixed(0)}K)`;

      publishCurrentEnv();
    } catch (err: any) {
      lastAction = ` ${err.message}`;
      console.error('[Architect] Random payment error:', err);
    } finally {
      loading = false;
    }
  }

  /** Quick Action: Send 20% of balance to random entity */
  async function send20PercentTransfer() {
    if (!requireLiveMode('send transfer')) return;
    if (!$isolatedEnv || entityIds.length < 2) {
      lastAction = ' Need at least 2 entities';
      return;
    }

    loading = true;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Pick random sender with reserves > 0
      const entitiesWithReserves = entityIds.filter(id => {
        const key = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
        const replica = key ? $isolatedEnv.eReplicas.get(key) : null;
        const reserves = replica?.state?.reserves?.get(0) || 0n;
        return BigInt(reserves) > 0n;
      });

      if (entitiesWithReserves.length === 0) {
        lastAction = ' No entities have reserves';
        loading = false;
        return;
      }

      const from = entitiesWithReserves[Math.floor(Math.random() * entitiesWithReserves.length)];
      const fromReplicaKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(from + ':'));
      const fromReplica = fromReplicaKey ? $isolatedEnv.eReplicas.get(fromReplicaKey) : null;

      if (!fromReplica) throw new Error('Sender replica not found');

      const reserves = BigInt(fromReplica.state?.reserves?.get(0) || 0n);
      const amount = (reserves * 20n) / 100n;

      if (amount <= 0n) {
        lastAction = ' Insufficient reserves for 20% transfer';
        loading = false;
        return;
      }

      // Pick random recipient (not self)
      let to = entityIds[Math.floor(Math.random() * entityIds.length)];
      let attempts = 0;
      while (to === from && attempts < 10) {
        to = entityIds[Math.floor(Math.random() * entityIds.length)];
        attempts++;
      }

      if (to === from) {
        lastAction = ' Could not find different entity';
        loading = false;
        return;
      }

      const hasAccount = fromReplica.state?.accounts?.has(to);
      const txBatch = [];

      if (!hasAccount) {
        txBatch.push({
          entityId: from,
          signerId: fromReplica.signerId,
          entityTxs: [{ type: 'openAccount', data: { targetEntityId: to } }]
        });
      }

      txBatch.push({
        entityId: from,
        signerId: fromReplica.signerId,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: to,
            tokenId: 1,
            amount,
            route: [from, to],
            description: '20% balance transfer'
          }
        }]
      });

      await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: txBatch }, 'send transfer');

      lastAction = ` 20% Transfer: ${shortAddress(from!)} → ${shortAddress(to!)} ($${(Number(amount)/1000).toFixed(0)}K)`;

      publishCurrentEnv();
    } catch (err) {
      const error = err as Error;
      lastAction = ` ${error.message}`;
      console.error('[Architect] 20% transfer error:', err);
    } finally {
      loading = false;
    }
  }

  /** SCALE STRESS TEST: Add 100 Entities (Prove Scalability) */
  async function scaleStressTest() {
    if (!$isolatedEnv?.activeJurisdiction) {
      lastAction = ' Create jurisdiction first';
      return;
    }

    loading = true;
    lastAction = 'Creating 100 entities... (FPS test)';

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      const xlnomy = $isolatedEnv.jReplicas.get($isolatedEnv.activeJurisdiction);
      if (!xlnomy) throw new Error('Active xlnomy not found');

      // Create 100 entities in 10x10 grid
      const entityInputs = [];

      for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
          const x = (col - 4.5) * 40; // Spread across 400px
          const z = (row - 4.5) * 40;
          const y = 50; // Same height

          const signerId = `scale_test_bank_${row}_${col}`;
          const entityInput = {
            signerId,
            runtimeTxs: [{
              type: 'importReplica',
              entityState: {
                nonces: new Map(),
                accounts: new Map(),
                reserves: new Map([[0, 100_000n]]), // $100K each
                position: { x, y, z }
              }
            }]
          };

          entityInputs.push(entityInput);
        }
      }

      // Batch create all 100 entities in ONE frame
      await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: entityInputs }, 'scale stress test');

      lastAction = ` Created 100 entities! Check FPS overlay (should be 60+)`;

      publishCurrentEnv();
    } catch (err) {
      const error = err as Error;
      lastAction = ` ${error.message}`;
      console.error('[Scale Test] Error:', err);
    } finally {
      loading = false;
    }
  }

  /** BANKER DEMO STEP 4: Reset */
  async function resetDemo() {
    stopFedPaymentLoop(); // Stop any running payment loops
    lastAction = 'Reset not implemented yet (reload page for now)';
  }

  /** Get topology preset (inline until we export from runtime.js) */
  function getTopologyPresetInline(type: 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid' | 'sp500' | 'ahb') {
    if (type === 'ahb') {
      // Alice-Hub-Bob: Simplest payment demo (3 entities)
      return {
        type: 'ahb',
        layers: [
          { name: 'Hub', yPosition: 100, entityCount: 1, xzSpacing: 0, color: '#FFD700', size: 2.0, emissiveIntensity: 1.0, initialReserves: 10_000_000n, canMintMoney: false },
          { name: 'Users', yPosition: 50, entityCount: 2, xzSpacing: 80, color: '#0088FF', size: 1.0, emissiveIntensity: 0.5, initialReserves: 100_000n, canMintMoney: false }
        ],
        rules: {
          allowedPairs: [
            { from: 'Hub', to: 'Users' }, { from: 'Users', to: 'Hub' },
            { from: 'Users', to: 'Users' } // Alice can pay Bob directly or via Hub
          ],
          allowDirectInterbank: true,
          requireHubRouting: false,
          maxHops: 2,
          defaultCreditLimits: new Map()
        },
        crisisThreshold: 0,
        crisisMode: null
      };
    } else if (type === 'hybrid') {
      return {
        type: 'hybrid',
        layers: [
          { name: 'Federal Reserve', yPosition: 300, entityCount: 1, xzSpacing: 0, color: '#FFD700', size: 50.0, emissiveIntensity: 2.0, initialReserves: 100_000_000n, canMintMoney: true },
          { name: 'Big Four Banks', yPosition: 200, entityCount: 4, xzSpacing: 150, color: '#00ff41', size: 30.0, emissiveIntensity: 0.5, initialReserves: 1_000_000n, canMintMoney: false },
          { name: 'Community Banks', yPosition: 100, entityCount: 4, xzSpacing: 200, color: '#FFFF00', size: 20.0, emissiveIntensity: 0.2, initialReserves: 100_000n, canMintMoney: false },
          { name: 'Customers', yPosition: 0, entityCount: 12, xzSpacing: 80, color: '#0088FF', size: 15.0, emissiveIntensity: 0.1, initialReserves: 10_000n, canMintMoney: false }
        ],
        rules: {
          allowedPairs: [
            { from: 'Federal Reserve', to: 'Big Four Banks' }, { from: 'Big Four Banks', to: 'Federal Reserve' },
            { from: 'Big Four Banks', to: 'Big Four Banks' },
            { from: 'Big Four Banks', to: 'Community Banks' }, { from: 'Community Banks', to: 'Big Four Banks' },
            { from: 'Community Banks', to: 'Community Banks' },
            { from: 'Big Four Banks', to: 'Customers' }, { from: 'Community Banks', to: 'Customers' },
            { from: 'Customers', to: 'Big Four Banks' }, { from: 'Customers', to: 'Community Banks' }
          ],
          allowDirectInterbank: true,
          requireHubRouting: false,
          maxHops: 4,
          defaultCreditLimits: new Map()
        },
        crisisThreshold: 0.20,
        crisisMode: 'star'
      };
    } else if (type === 'star') {
      // MINIMAL STAR: 1 Fed + 2 Banks = 3 entities (matches topology-presets.ts)
      return {
        type: 'star',
        layers: [
          { name: 'Federal Reserve', yPosition: 200, entityCount: 1, xzSpacing: 0, color: '#FFD700', size: 10.0, emissiveIntensity: 2.0, initialReserves: 100_000_000n, canMintMoney: true },
          { name: 'Commercial Banks', yPosition: 100, entityCount: 2, xzSpacing: 100, color: '#00ff41', size: 1.0, emissiveIntensity: 0.3, initialReserves: 1_000_000n, canMintMoney: false }
          // MINIMAL: Removed customers layer (was 12 entities)
        ],
        rules: {
          allowedPairs: [
            { from: 'Federal Reserve', to: 'Commercial Banks' },
            { from: 'Commercial Banks', to: 'Federal Reserve' }
            // MINIMAL: Removed customer connections
          ],
          allowDirectInterbank: false,
          requireHubRouting: true,
          maxHops: 2, // Reduced from 3
          defaultCreditLimits: new Map()
        },
        crisisThreshold: 0.20,
        crisisMode: 'star'
      };
    } else if (type === 'sp500') {
      // S&P 500: Real corporate settlement network
      return {
        type: 'sp500',
        layers: [
          { name: 'Federal Reserve', yPosition: 300, entityCount: 1, xzSpacing: 0, color: '#FFD700', size: 12.0, emissiveIntensity: 2.5, initialReserves: 1_000_000_000n, canMintMoney: true },
          { name: 'Clearing Banks', yPosition: 200, entityCount: 4, xzSpacing: 120, color: '#00ff88', size: 2.0, emissiveIntensity: 0.8, initialReserves: 100_000_000n, canMintMoney: false },
          { name: 'S&P 500 Companies', yPosition: 100, entityCount: 47, xzSpacing: 60, color: '#0088ff', size: 0.8, emissiveIntensity: 0.3, initialReserves: 10_000_000n, canMintMoney: false }
        ],
        rules: {
          allowedPairs: [
            { from: 'Federal Reserve', to: 'Clearing Banks' },
            { from: 'Clearing Banks', to: 'Federal Reserve' },
            { from: 'Clearing Banks', to: 'S&P 500 Companies' },
            { from: 'S&P 500 Companies', to: 'Clearing Banks' },
            { from: 'S&P 500 Companies', to: 'S&P 500 Companies' } // P2P corporate settlement
          ],
          allowDirectInterbank: true, // S&P companies can trade directly
          requireHubRouting: false,
          maxHops: 3,
          defaultCreditLimits: new Map()
        },
        crisisThreshold: 0.15,
        crisisMode: 'star'
      };
    } else {
      // Default to hybrid for other types (will implement mesh/tiered/correspondent later)
      return getTopologyPresetInline('hybrid');
    }
  }

  /** CREATE ECONOMY WITH TOPOLOGY - Main entry point */
  async function createEconomyWithTopology(topologyType: 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid' | 'sp500' | 'ahb') {
    if (!requireLiveMode('create economy')) return;

    loading = true;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // VaultStore handles J-machine import - Architect should NOT auto-create
      if (!$isolatedEnv?.activeJurisdiction) {
        lastAction = 'Waiting for J-machine...';
        loading = false;
        console.warn('[Architect] No J-machine - VaultStore should import Testnet');
        return;
      }

      if (entityIds.length > 0) {
        lastAction = ' Economy already exists (reload page to reset)';
        console.error('[Architect] Economy already exists, entityIds:', entityIds.length);
        loading = false;
        return;
      }

      lastAction = `Creating ${topologyType.toUpperCase()} economy...`;

      // Get topology preset
      const topology = getTopologyPresetInline(topologyType);

      // Create entities based on topology layers
      await createEntitiesFromTopology(topology);

      // Start payment loop
      setTimeout(() => startSmartPaymentLoop(topology), 2000);

      const totalEntities = topology.layers.reduce((sum: number, layer: any) => sum + layer.entityCount, 0);
      lastAction = ` Created ${topologyType.toUpperCase()} economy: ${totalEntities} entities across ${topology.layers.length} layers`;

      publishCurrentEnv();
    } catch (err: any) {
      lastAction = ` ${err.message}`;
      console.error('[Architect] Topology creation error:', err);
      console.error('[Architect] Full error stack:', err.stack);
    } finally {
      loading = false;
    }
  }

  /** Create entities based on topology configuration */
  async function createEntitiesFromTopology(topology: any) {
    if (!requireLiveMode('create entities')) return;

    const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
    const XLN = await import(/* @vite-ignore */ runtimeUrl);

    const xlnomy = $isolatedEnv.jReplicas.get($isolatedEnv.activeJurisdiction);
    if (!xlnomy) {
      console.error('[createEntities] Active xlnomy not found:', $isolatedEnv.activeJurisdiction);
      throw new Error('Active xlnomy not found');
    }

    const jPos = xlnomy.jMachine.position;

    const entities = [];
    const layerEntityIds: Map<string, string[]> = new Map(); // layerName → entityIds

    // Create entities for each layer
    for (const layer of topology.layers) {
      const layerIds: string[] = [];

      for (let i = 0; i < layer.entityCount; i++) {
        // Position calculation
        let x: number, y: number, z: number;
        y = layer.yPosition;

        if (layer.entityCount === 1) {
          // Single entity (Fed, ECB, etc) - center
          x = jPos.x;
          z = jPos.z;
        } else {
          // Multiple entities - spread in circle
          const angle = (i / layer.entityCount) * Math.PI * 2;
          x = jPos.x + Math.cos(angle) * layer.xzSpacing;
          z = jPos.z + Math.sin(angle) * layer.xzSpacing;
        }

        // Generate entity ID (use real ticker for S&P 500 companies)
        let signerId: string;
        if (layer.name === 'S&P 500 Companies' && i < SP500_TICKERS.length) {
          signerId = `${$isolatedEnv.activeJurisdiction}_${SP500_TICKERS[i]}`;
        } else {
          signerId = `${$isolatedEnv.activeJurisdiction}_${layer.name.toLowerCase().replace(/\s/g, '_')}_${i}`;
        }
        const data = new TextEncoder().encode(`${$isolatedEnv.activeJurisdiction}:${layer.name}:${i}:${Date.now()}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const entityId = '0x' + hashHex;

        entities.push({
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: $isolatedEnv.activeJurisdiction
            },
            isProposer: true,
            position: { x, y, z }
          }
        });

        layerIds.push(entityId);
      }

      layerEntityIds.set(layer.name, layerIds);
    }

    // Import all entities
    await ingressRuntimeInput(XLN, {
      runtimeTxs: entities,
      entityInputs: []
    });

    // PERF FIX: Batch all funding into ONE process() call instead of 1 per entity
    const fundingMints: Array<{ entityId: string; tokenId: number; amount: bigint }> = [];
    for (const layer of topology.layers) {
      const ids = layerEntityIds.get(layer.name) || [];

      for (const entityId of ids) {
        fundingMints.push({
          entityId,
          tokenId: 1,
          amount: BigInt(layer.initialReserves),
        });
      }
    }

    await debugFundReservesBatch(fundingMints);

    // PERF + REALISM: Proximity-based account creation (not all-to-all)
    const accountInputs = [];
    const accountsOpened = new Set<string>(); // Track to avoid duplicates

    // Helper: Calculate euclidean distance
    const distance = (pos1: {x: number; y: number; z: number}, pos2: {x: number; y: number; z: number}): number => {
      const dx = pos1.x - pos2.x;
      const dy = pos1.y - pos2.y;
      const dz = pos1.z - pos2.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };

    // Get entity position from created entities array
    const entityPositions = new Map<string, {x: number; y: number; z: number}>();
    entities.forEach((e: any) => {
      if (e.data?.position) {
        entityPositions.set(e.entityId, e.data.position);
      }
    });

    for (const rule of topology.rules.allowedPairs) {
      const fromLayerIds = layerEntityIds.get(rule.from) || [];
      const toLayerIds = layerEntityIds.get(rule.to) || [];

      // Proximity-based connections (realistic banking)
      for (const fromId of fromLayerIds) {
        const fromPos = entityPositions.get(fromId);
        if (!fromPos) continue;

        // Find nearest hubs in target layer
        const hubsByDistance = toLayerIds
          .map(toId => ({
            id: toId,
            distance: distance(fromPos, entityPositions.get(toId) || {x: 0, y: 0, z: 0})
          }))
          .filter(h => h.id !== fromId) // Skip self
          .sort((a, b) => a.distance - b.distance);

        // Realistic distribution: 70% connect to 1 hub, 25% to 2, 5% to 3-4
        const rand = Math.random();
        const connectionCount = rand < 0.70 ? 1 : rand < 0.95 ? 2 : rand < 0.98 ? 3 : 4;
        const selectedHubs = hubsByDistance.slice(0, Math.min(connectionCount, hubsByDistance.length));

        for (const hub of selectedHubs) {
          // Check if already opened (canonical order)
          const accountKey = fromId < hub.id ? `${fromId}:${hub.id}` : `${hub.id}:${fromId}`;
          if (accountsOpened.has(accountKey)) continue;
          accountsOpened.add(accountKey);

          const fromReplicaKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(fromId + ':'));
          const fromReplica = fromReplicaKey ? $isolatedEnv.eReplicas.get(fromReplicaKey) : null;

          if (fromReplica) {
            accountInputs.push({
              entityId: fromId,
              signerId: fromReplica.signerId,
              entityTxs: [{
                type: 'openAccount',
                data: { targetEntityId: hub.id }
              }]
            });
          }
        }
      }
    }

    // Single batch: all accounts opened in ONE frame
    if (accountInputs.length > 0) {
      await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: accountInputs }, 'open demo accounts');
    }
  }

  /** Smart Payment Loop: 20% circular payments + Smart QE */
  let fedPaymentInterval: any = null;

  async function startSmartPaymentLoop(topology: any) {
    if (fedPaymentInterval) clearInterval(fedPaymentInterval);

    fedPaymentInterval = setInterval(async () => {
      try {
        if (!requireLiveMode('smart payment loop')) {
          stopFedPaymentLoop();
          return;
        }
        const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
        const XLN = await import(/* @vite-ignore */ runtimeUrl);

        // STEP 1: Smart QE (Fed mints if system liquidity low)
        await runSmartQE(XLN, topology);

        // STEP 2: 20% circular payments (all entities trade)
        await run20PercentPayments(XLN);

        // STEP 3: Crisis detection (for HYBRID topology)
        if (topology.type === 'hybrid') {
          await detectAndHandleCrisis(XLN, topology);
        }

        publishCurrentEnv();

      } catch (err: any) {
        console.error('[Smart Loop] Error:', err);
      }
    }, 5000); // Every 5 seconds (optimized for frame count)
  }

  /** Smart QE: Fed mints based on system liquidity */
  async function runSmartQE(XLN: any, topology: any) {
    // Find Fed/Central Bank entity (first layer with canMintMoney)
    const centralBankLayer = topology.layers.find((l: any) => l.canMintMoney);
    if (!centralBankLayer) return;

    const fedId = entityIds.find(id => {
      const key = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.eReplicas.get(key) : null;
      return replica?.signerId?.includes(centralBankLayer.name.toLowerCase().replace(/\s/g, '_'));
    });

    if (!fedId) return;

    // Calculate system liquidity
    let totalReserves = 0n;
    let totalEntities = 0;

    for (const id of entityIds) {
      const key = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.eReplicas.get(key) : null;
      if (replica?.state?.reserves) {
        const tokenReserves = replica.state.reserves.get(0) || 0n;
        totalReserves += BigInt(tokenReserves);
        totalEntities++;
      }
    }

    const averageReserves = totalEntities > 0 ? totalReserves / BigInt(totalEntities) : 0n;
    const targetAverage = 100_000n; // Target $100K per entity

    // If average < target, Fed prints
    if (averageReserves < targetAverage) {
      const deficit = (targetAverage - averageReserves) * BigInt(totalEntities);
      const mintAmount = deficit > 1_000_000n ? 1_000_000n : deficit; // Max $1M per tick

      const fedKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(fedId + ':'));
      const fedReplica = fedKey ? $isolatedEnv.eReplicas.get(fedKey) : null;

      if (fedReplica) {
        await debugFundReservesBatch([{ entityId: fedId, tokenId: 1, amount: mintAmount }]);
      }
    }
  }

  /** 20% Circular Payments: Everyone sends 20% to random peer */
  async function run20PercentPayments(XLN: any) {
    // Get all entities with reserves > 0
    const activeEntities = entityIds.filter(id => {
      const key = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.eReplicas.get(key) : null;
      const reserves = replica?.state?.reserves?.get(0) || 0n;
      return BigInt(reserves) > 0n;
    });

    // Each entity sends 20% to random peer
    for (const fromId of activeEntities) {
      const fromKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(fromId + ':'));
      const fromReplica = fromKey ? $isolatedEnv.eReplicas.get(fromKey) : null;
      if (!fromReplica) continue;

      const reserves = BigInt(fromReplica.state?.reserves?.get(0) || 0n);
      if (reserves <= 0n) continue;

      const amount = (reserves * 20n) / 100n; // 20% of balance
      if (amount <= 0n) continue;

      // Pick random target (not self)
      let toId = activeEntities[Math.floor(Math.random() * activeEntities.length)]!;
      let attempts = 0;
      while (toId === fromId && attempts < 10) {
        toId = activeEntities[Math.floor(Math.random() * activeEntities.length)]!;
        attempts++;
      }

      if (toId === fromId) continue; // Skip if couldn't find different entity

      // Check if account exists
      const hasAccount = fromReplica.state?.accounts?.has(toId);

      if (!hasAccount) {
        // Open account first
        await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: [{
          entityId: fromId,
          signerId: fromReplica.signerId,
          entityTxs: [{
            type: 'openAccount',
            data: { targetEntityId: toId }
          }]
        }] }, 'smart payment loop');
      }

      // Send 20% payment
      await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: [{
        entityId: fromId,
        signerId: fromReplica.signerId,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: toId,
            tokenId: 1,
            amount: amount,
            route: [fromId, toId],
            description: `20% circular payment`
          }
        }]
      }] }, 'smart payment loop');
    }
  }

  /** Crisis Detection: Reserves < 20% threshold */
  async function detectAndHandleCrisis(XLN: any, topology: any) {
    // Check each entity's reserve ratio
    for (const id of entityIds) {
      const key = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.eReplicas.get(key) : null;
      if (!replica) continue;

      const reserves = BigInt(replica.state?.reserves?.get(0) || 0n);

      // Calculate total deposits (sum of all credit extended to this entity)
      let totalDeposits = 0n;
      if (replica.state?.accounts) {
        for (const [_, account] of replica.state.accounts.entries()) {
          // Sum positive balances (credit extended TO this entity)
          const deltas = account.deltas;
          if (deltas) {
            for (const [_, delta] of deltas.entries()) {
              const offdelta = BigInt(delta.offdelta || 0n);
              if (offdelta > 0n) {
                totalDeposits += offdelta;
              }
            }
          }
        }
      }

      // Crisis if reserves < 20% of deposits
      if (totalDeposits > 0n) {
        const ratio = (reserves * 100n) / totalDeposits;
        if (ratio < 20n) {
          const targetReserves = (totalDeposits * 20n) / 100n;
          const rescueAmount = targetReserves > reserves ? targetReserves - reserves : 0n;
          if (rescueAmount > 0n) {
            await debugFundReservesBatch([{ entityId: id, tokenId: 1, amount: rescueAmount }]);
          }
        }
      }
    }
  }

  /** VR/topology payment loop. */
  async function startFedPaymentLoop() {
    if (!requireLiveMode('Fed payment loop')) return;
    if (fedPaymentInterval) clearInterval(fedPaymentInterval);

    const bankEntityIds = entityIds.filter(id => {
      const key = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.eReplicas.get(key) : null;
      return replica?.signerId && !replica.signerId.includes('_fed');
    });

    const fedId = entityIds.find(id => {
      const key = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.eReplicas.get(key) : null;
      return replica?.signerId?.includes('_fed');
    });

    if (!fedId || bankEntityIds.length === 0) {
      return;
    }

    let tick = 0;

    fedPaymentInterval = setInterval(async () => {
      try {
        if (!requireLiveMode('Fed payment loop')) {
          stopFedPaymentLoop();
          return;
        }
        const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
        const XLN = await import(/* @vite-ignore */ runtimeUrl);

        tick++;
        const action = tick % 4; // 4-step cycle

        if (action === 0) {
          // Fed lends to random bank
          const bank = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          const amount = Math.floor(Math.random() * 500000) + 100000; // $100K-$600K

          const fedKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(fedId + ':'));
          const fedReplica = fedKey ? $isolatedEnv.eReplicas.get(fedKey) : null;

          if (fedReplica) {
            await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: [{
              entityId: fedId,
              signerId: fedReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: bank,
                  tokenId: 1,
                  amount: BigInt(amount),
                  route: [fedId, bank],
                  description: `Fed discount window lending`
                }
              }]
            }] }, 'Fed payment loop');
          }
        } else if (action === 1) {
          // Random bank borrows from Fed (reverse direction)
          const bank = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          const amount = Math.floor(Math.random() * 300000) + 50000; // $50K-$350K

          const bankKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(bank + ':'));
          const bankReplica = bankKey ? $isolatedEnv.eReplicas.get(bankKey) : null;

          if (bankReplica) {
            await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: [{
              entityId: bank,
              signerId: bankReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: fedId,
                  tokenId: 1,
                  amount: BigInt(amount),
                  route: [bank, fedId],
                  description: `Bank repaying Fed loan`
                }
              }]
            }] }, 'Fed payment loop');
          }
        } else {
          // Interbank payment (Bank → Bank)
          const from = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          let to = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          while (to === from && bankEntityIds.length > 1) {
            to = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          }

          const amount = Math.floor(Math.random() * 200000) + 25000; // $25K-$225K

          const fromKey = (Array.from($isolatedEnv.eReplicas.keys()) as string[]).find(k => k.startsWith(from + ':'));
          const fromReplica = fromKey ? $isolatedEnv.eReplicas.get(fromKey) : null;

          if (fromReplica) {
            // Check if account exists
            const hasAccount = fromReplica.state?.accounts?.has(to);

            if (!hasAccount) {
              // Open account first
              await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: [{
                entityId: from,
                signerId: fromReplica.signerId,
                entityTxs: [{
                  type: 'openAccount',
                  data: { targetEntityId: to }
                }]
              }] }, 'Fed payment loop');
            }

            // Send payment
            await ingressRuntimeInput(XLN, { runtimeTxs: [], entityInputs: [{
              entityId: from,
              signerId: fromReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: to,
                  tokenId: 1,
                  amount: BigInt(amount),
                  route: [from, to],
                  description: `Interbank settlement`
                }
              }]
            }] }, 'Fed payment loop');
          }
        }

        publishCurrentEnv();

      } catch (err: any) {
        console.error('[Fed Loop] Payment error:', err);
      }
    }, 5000); // Every 5 seconds (reduced for performance)
  }

  function stopFedPaymentLoop() {
    if (fedPaymentInterval) {
      clearInterval(fedPaymentInterval);
      fedPaymentInterval = null;
    }
  }

  async function createNewXlnomy() {
    if (!requireLiveMode('create xlnomy')) return;
    if (!newXlnomyName.trim()) {
      lastAction = ' Enter a name for the xlnomy';
      return;
    }

    // Limit to 9 jurisdictions (3×3 grid)
    if ($isolatedEnv?.jReplicas && $isolatedEnv.jReplicas.size >= 9) {
      lastAction = ' Maximum 9 jurisdictions (3×3 grid full)';
      return;
    }

    loading = true;
    lastAction = `Creating jurisdiction "${newXlnomyName.toLowerCase()}"...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Step 1: Import J-machine
      const isBrowserVM = newXlnomyEvmType === 'browservm';
      await ingressRuntimeInput(XLN, {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: newXlnomyName,
            chainId: isBrowserVM ? 31337 : 1, // BrowserVM uses 31337 to match View.svelte
            ticker: 'ETH',
            rpcs: isBrowserVM ? [] : [newXlnomyRpcUrl],
          }
        }],
        entityInputs: []
      });

      // Step 2: Process the queued importReplica transactions
      await ingressRuntimeInput(XLN, {
        runtimeTxs: [],
        entityInputs: []
      });

      // Success message
      const createdName = newXlnomyName.toLowerCase();
      lastAction = ` xlnomy "${createdName}" created!`;

      // Close modal and advance to next number
      showCreateXlnomyModal = false;

      // Extract number from xlnomyN format
      const match = newXlnomyName.match(/Testnet(\d+)/i);
      if (match && match[1]) {
        const num = parseInt(match[1]);
        newXlnomyName = `Testnet${num + 1}`;
      } else {
        newXlnomyName = 'Testnet';
      }

      publishCurrentEnv();
    } catch (err: any) {
      lastAction = ` ${err.message}`;
      console.error('[Architect] Xlnomy creation error:', err);
    } finally {
      loading = false;
    }
  }

  async function switchXlnomy(name: string) {
    if (!$isolatedEnv || name === $isolatedEnv.activeJurisdiction) return;

    loading = true;
    lastAction = `Switching to "${name}"...`;

    try {
      if (!$isolatedEnv.jReplicas?.has(name)) {
        lastAction = ` Xlnomy "${name}" not found`;
        return;
      }
      $isolatedEnv.activeJurisdiction = name;
      lastAction = ` Switched to "${name}"`;

      isolatedEnv.set($isolatedEnv);
    } catch (err: any) {
      lastAction = ` ${err.message}`;
    } finally {
      loading = false;
    }
  }

  /** Create new entity with custom name */
  async function createEntity() {
    if (!requireLiveMode('create entity')) return;
    if (!newEntityName.trim()) {
      lastAction = ' Enter entity name';
      return;
    }

    if (!$isolatedEnv?.activeJurisdiction) {
      lastAction = ' Create Xlnomy first';
      return;
    }

    loading = true;
    lastAction = `Creating entity "${newEntityName}"...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Generate signerId from xlnomy name + entity name
      const signerId = `${$isolatedEnv.activeJurisdiction.toLowerCase()}_${newEntityName.toLowerCase()}`;

      // Generate entityId (hash-based for lazy entities)
      const encoder = new TextEncoder();
      const data = encoder.encode(`${$isolatedEnv.activeJurisdiction}:${newEntityName}:${Date.now()}`);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      const entityId = '0x' + hashHex; // 32 bytes = 64 hex chars (bytes32)

      // Random position in 3D space
      const position = {
        x: Math.random() * 400 - 200,
        y: Math.random() * 100,
        z: Math.random() * 400 - 200
      };

      // Create entity via importReplica RuntimeTx
      await ingressRuntimeInput(XLN, {
        runtimeTxs: [{
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: $isolatedEnv.activeJurisdiction
            },
            isProposer: true,
            position
          }
        }],
        entityInputs: []
      });

      lastAction = ` Created "${newEntityName}"`;

      // Auto-advance to next common name for fast creation
      const names = ['alice', 'bob', 'charlie', 'dave', 'eve', 'frank', 'grace', 'heidi'];
      const currentIndex = names.indexOf(newEntityName.toLowerCase());
      newEntityName = currentIndex >= 0 && currentIndex < names.length - 1
        ? (names[currentIndex + 1] || 'entity')
        : 'entity'; // Fallback

      publishCurrentEnv();
      panelBridge.emit('entity:created', { entityId, type: 'manual' });
    } catch (err: any) {
      lastAction = ` ${err.message}`;
      console.error('[Architect] Create entity error:', err);
    } finally {
      loading = false;
    }
  }

</script>

<div class="architect-panel">
  <div class="header">
    <h3> Architect</h3>
  </div>

  <div class="mode-selector">
    <select bind:value={currentMode} class="mode-dropdown">
      <option value="economy">Economy</option>
    </select>
  </div>

  <div class="mode-content">
    {#if currentMode === 'economy'}
      <h4>Economy Mode</h4>

      {#if !envReady}
        <div class="status loading">
          ⏳ Initializing XLN environment...
        </div>
      {:else}
        <div class="preset-system">
          <div class="scenarios-header">
            <h5>Scenarios</h5>
            <button class="reset-btn" on:click={resetScenario} disabled={loading} title="Clear current scenario">
              Reset
            </button>
          </div>
          <div class="preset-list">
            <button class="preset-item recommended" on:click={startAHBTutorial} disabled={loading}>
              <span class="icon">ahb</span>
              <div class="info">
                <strong>Alice-Hub-Bob</strong>
                <p>Auto-play tutorial · Bilateral consensus</p>
              </div>
            </button>

            <button class="preset-item" on:click={startHTLCTutorial} disabled={loading}>
              <span class="icon">🔒</span>
              <div class="info">
                <strong>HTLC Payments</strong>
                <p>Hash-locked · Multi-hop routing</p>
              </div>
            </button>

            <button class="preset-item" on:click={startSwapTutorial} disabled={loading}>
              <span class="icon">⇄</span>
              <div class="info">
                <strong>Token Swaps</strong>
                <p>Bilateral · Partial fills</p>
              </div>
            </button>

            <button class="preset-item" on:click={runSwapMarket} disabled={loading}>
              <span class="icon">💱</span>
              <div class="info">
                <strong>Swap Market</strong>
                <p>8 users · 3 orderbooks · Realistic trading</p>
              </div>
            </button>

            <button class="preset-item" on:click={runRapidFire} disabled={loading}>
              <span class="icon">⚡</span>
              <div class="info">
                <strong>Rapid Fire</strong>
                <p>200 payments · Stress test · 1600 tx/s</p>
              </div>
            </button>

            <button class="preset-item" on:click={startGridScenario} disabled={loading}>
              <span class="icon">2³</span>
              <div class="info">
                <strong>Grid Scalability</strong>
                <p>8 nodes (2×2×2) · Broadcast vs Hubs</p>
              </div>
            </button>

            <button class="preset-item" on:click={startSettleScenario} disabled={loading}>
              <span class="icon">⚖️</span>
              <div class="info">
                <strong>Settlement</strong>
                <p>Bilateral · Holds · On-chain commit</p>
              </div>
            </button>

            <button class="preset-item" on:click={() => runPreset('empty')} disabled={loading}>
              <span class="icon">□</span>
              <div class="info">
                <strong>Empty J-Machine</strong>
                <p>Clean slate · Manual exploration</p>
              </div>
            </button>

            <button class="preset-item" on:click={createHub} disabled={loading}>
              <span class="icon">3×3</span>
              <div class="info">
                <strong>Grid 3×3 Hub</strong>
                <p>9 entities · Pinnacle topology</p>
              </div>
            </button>
          </div>
        </div>

        {#if $isolatedHistory && $isolatedHistory.length > 0}
          <div class="scenario-code-section">
            <h5>Scenario Code (Frame {$isolatedTimeIndex >= 0 ? $isolatedTimeIndex : 'LIVE'})</h5>
            <textarea
              bind:this={scenarioCodeTextarea}
              class="scenario-code-textarea"
              readonly
              spellcheck="false"
            >{scenarioCode}</textarea>
          </div>
        {/if}

        <div class="action-section">
          <h5>Jurisdiction (EVM Instance)</h5>

          <button class="action-btn create-xlnomy-btn" on:click={() => showCreateXlnomyModal = true}>
            + Create Jurisdiction Here
          </button>

          {#if jurisdictions?.length > 0}
            <div class="xlnomy-selector">
              <label for="xlnomy-switch">Switch to:</label>
              <select id="xlnomy-switch" bind:value={activeJurisdiction} on:change={(e) => switchXlnomy(e.currentTarget.value)}>
                {#each jurisdictions as name}
                  <option value={name}>{name}</option>
                {/each}
              </select>
            </div>
          {/if}

          <p class="help-text">Isolated EVM with J-Machine + Depository. Jurisdictions run inside.</p>
        </div>

        <div class="action-section">
          <h5>Entity Registration</h5>
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={numberedEntities} />
            <span>Numbered Entities (on-chain via EntityProvider.sol)</span>
          </label>
          <p class="help-text">
            {#if numberedEntities}
               Numbered: Entities registered on blockchain (slower, sequential numbers)
            {:else}
               Lazy: In-browser only entities (faster, hash-based IDs, no gas)
            {/if}
          </p>
        </div>

        <div class="action-section banker-demo">
          <h5> Banker Demo (Step-by-Step)</h5>

          <button class="demo-btn step-1" on:click={createHub} disabled={loading || entityIds.length > 0}>
             Step 1: Create 3×3 Hub
          </button>
          <p class="step-help">9 entities at y=320 (pinnacle hub)</p>

          <button class="demo-btn step-2" on:click={fundAllEntities} disabled={loading || entityIds.length === 0}>
             Step 2: Fund All ($1M each)
          </button>
          <p class="step-help">Mint reserves to all 9 entities</p>

          <button class="demo-btn step-3" on:click={sendRandomPayment} disabled={loading || entityIds.length < 2}>
             Step 3: Random Payment
          </button>
          <p class="step-help">Send one R2R payment (click multiple times)</p>

          <button class="demo-btn quick-action" on:click={send20PercentTransfer} disabled={loading || entityIds.length < 2}>
             Quick: 20% Transfer
          </button>
          <p class="step-help">Send 20% of balance from random entity</p>

          <button class="demo-btn stress-test" on:click={scaleStressTest} disabled={loading || !activeJurisdiction || entityIds.length > 20}>
             Scale Test: +100 Entities
          </button>
          <p class="step-help">Prove scalability - watch FPS stay 60+ with 100 banks!</p>

          <button class="demo-btn step-4" on:click={resetDemo} disabled={loading}>
             Reset Demo
          </button>
          <p class="step-help">Clear xlnomy and start over</p>
        </div>

        <div class="action-section">
          <h5> Mint Reserves</h5>
          <div class="form-group">
            <label for="mint-entity">Entity:</label>
            <select id="mint-entity" bind:value={selectedEntityForMint} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="mint-amount">Amount:</label>
            <input id="mint-amount" type="text" bind:value={mintAmount} placeholder="1000000" />
          </div>
          <button class="action-btn" on:click={mintReservesToEntity} disabled={loading || !selectedEntityForMint}>
             Mint to Reserve
          </button>
          <p class="help-text">Deposit tokens to entity reserve (triggers J-Machine)</p>
        </div>

        <div class="action-section">
          <h5> Reserve-to-Reserve (R2R)</h5>
          <div class="form-group">
            <label for="r2r-from">From Entity:</label>
            <select id="r2r-from" bind:value={r2rFromEntity} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="r2r-to">To Entity:</label>
            <select id="r2r-to" bind:value={r2rToEntity} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="r2r-amount">Amount:</label>
            <input id="r2r-amount" type="text" bind:value={r2rAmount} placeholder="500000" />
          </div>
          <button class="action-btn" on:click={sendR2RTransaction} disabled={loading || !r2rFromEntity || !r2rToEntity}>
             Send R2R Transaction
          </button>
          <p class="help-text">Send reserve-to-reserve payment (shows broadcast ripple)</p>
        </div>

        <div class="action-section">
          <h5>VR Mode</h5>
          <button class="action-btn" on:click={() => panelBridge.emit('vr:toggle', {})}>
             Enter VR
          </button>
          <p class="help-text">Quest 3 / WebXR headsets</p>
        </div>

        <div class="action-section">
          <h5>Broadcast Visualization</h5>
          <label class="checkbox-label">
            <input type="checkbox" checked on:change={(e) => panelBridge.emit('broadcast:toggle', { enabled: e.currentTarget.checked })} />
            Enable J-Machine Broadcast
          </label>
          <p class="help-text">Show O(n) broadcast from J-Machine to all entities</p>

          <h5 style="margin-top: 16px;">Broadcast Style</h5>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="raycast" checked on:change={() => panelBridge.emit('broadcast:style', { style: 'raycast' })} />
            Ray-Cast (shows each individual broadcast)
          </label>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="wave" on:change={() => panelBridge.emit('broadcast:style', { style: 'wave' })} />
            Expanding Wave (organic propagation)
          </label>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="particles" on:change={() => panelBridge.emit('broadcast:style', { style: 'particles' })} />
            Particle Swarm (flies to each entity)
          </label>
        </div>

        {#if lastAction}
          <div class="status" class:loading>
            {lastAction}
          </div>
        {/if}
      {/if}

    {:else if currentMode === 'solvency'}
      <h4>Solvency Monitor</h4>
      <div class="solvency-embed">
        <SolvencyPanel {isolatedEnv} />
      </div>

    {:else if currentMode === 'build'}
      <h4>Build Mode</h4>

      {#if !envReady}
        <div class="status loading">
          ⏳ Initializing XLN environment...
        </div>
      {:else if !$isolatedEnv?.activeJurisdiction}
        <div class="status">
          ⚠️ Create an Xlnomy first (Economy mode)
        </div>
      {:else}
        <div class="action-section">
          <h5>Create Entity</h5>
          <div class="form-group">
            <label for="entity-name">Entity Name:</label>
            <input
              id="entity-name"
              type="text"
              bind:value={newEntityName}
              placeholder="alice"
              on:keydown={(e) => e.key === 'Enter' && createEntity()}
            />
          </div>
          <button class="action-btn" on:click={createEntity} disabled={loading || !newEntityName.trim()}>
             Create Entity
          </button>
          <p class="help-text">Entities appear as dots in 3D space</p>
        </div>

        <div class="action-section">
          <h5>Entities in {$isolatedEnv.activeJurisdiction}</h5>
          {#if entityIds.length === 0}
            <p class="help-text">No entities yet. Create alice and bob to start!</p>
          {:else}
            <ul class="entity-list">
              {#each entityIds as entityId}
                <li>{shortAddress(entityId)}</li>
              {/each}
            </ul>
          {/if}
        </div>

        {#if lastAction}
          <div class="status" class:loading>
            {lastAction}
          </div>
        {/if}
      {/if}
    {:else}
      <h4>{currentMode.charAt(0).toUpperCase() + currentMode.slice(1)} Mode</h4>
      <p>Coming soon...</p>
    {/if}
  </div>
</div>

{#if showCreateXlnomyModal}
  <div class="modal-overlay">
    <div class="modal">
      <h3>Create New Xlnomy</h3>

      <div class="form-group">
        <label for="xlnomy-name">Name:</label>
        <input id="xlnomy-name" type="text" bind:value={newXlnomyName} />
      </div>

      <div class="form-group">
        <span class="form-label">EVM Type:</span>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="browservm" />
            <span>BrowserVM (Simnet)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="reth" />
            <span>Reth (RPC)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="erigon" />
            <span>Erigon (RPC)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="monad" />
            <span>Monad (RPC)</span>
          </label>
        </div>
      </div>

      {#if newXlnomyEvmType !== 'browservm'}
        <div class="form-group">
          <label for="xlnomy-rpc">RPC URL:</label>
          <input id="xlnomy-rpc" type="text" bind:value={newXlnomyRpcUrl} placeholder="http://localhost:8545" />
        </div>
      {/if}

      <div class="form-group">
        <label for="xlnomy-blocktime">Block Time (ms):</label>
        <input id="xlnomy-blocktime" type="text" bind:value={newXlnomyBlockTime} placeholder="1000" />
      </div>

      <div class="modal-actions">
        <button class="action-btn secondary" on:click={() => showCreateXlnomyModal = false}>Cancel</button>
        <button class="action-btn" on:click={createNewXlnomy}>Create</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .architect-panel {
    width: 100%;
    height: 100%;
    background: #1e1e1e;
    color: #ccc;
    display: flex;
    flex-direction: column;
  }

  .header {
    padding: 12px;
    background: #2d2d30;
    border-bottom: 2px solid #007acc;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header h3 {
    margin: 0;
    font-size: 14px;
  }

  /* Scenario Code Section */
  .scenario-code-section {
    padding: 12px;
    background: #1a1a1a;
    border-top: 1px solid #3e3e3e;
    border-bottom: 1px solid #3e3e3e;
  }

  .scenario-code-section h5 {
    margin: 0 0 8px 0;
    font-size: 12px;
    color: #00ff41;
    font-family: 'Monaco', 'Menlo', monospace;
  }

  .scenario-code-textarea {
    width: 100%;
    height: 300px;
    padding: 12px;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 4px;
    color: #9cdcfe;
    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
    font-size: 11px;
    line-height: 18px;
    resize: vertical;
    white-space: pre;
    overflow-x: auto;
    overflow-y: scroll;
    box-sizing: border-box;
  }

  .scenario-code-textarea:focus {
    outline: 1px solid #007acc;
  }

  .mode-selector {
    padding: 8px;
    background: #252526;
    border-bottom: 1px solid #3e3e3e;
  }

  .mode-dropdown {
    width: 100%;
    padding: 8px 12px;
    background: #2d2d30;
    border: 1px solid #3e3e3e;
    color: #fff;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23ccc' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 28px;
  }

  .mode-dropdown:hover {
    background-color: #37373d;
    border-color: #007acc;
  }

  .mode-dropdown:focus {
    outline: none;
    border-color: #0e639c;
    box-shadow: 0 0 0 1px #0e639c;
  }

  .mode-dropdown option {
    background: #2d2d30;
    color: #fff;
    padding: 8px;
  }

  .mode-content {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }

  .mode-content h4 {
    margin: 0 0 12px 0;
    color: #fff;
    font-size: 13px;
  }

  .mode-content p {
    margin: 8px 0;
    font-size: 12px;
    color: #8b949e;
  }

  .action-section {
    margin-bottom: 24px;
    padding: 12px;
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
  }

  .action-section h5 {
    margin: 0 0 12px 0;
    font-size: 12px;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .action-btn {
    width: 100%;
    padding: 12px 16px;
    background: #0e639c;
    border: none;
    color: white;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 8px;
  }

  .action-btn:hover:not(:disabled) {
    background: #1177bb;
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-btn.secondary {
    background: #2d2d30;
    border: 1px solid #3e3e3e;
  }

  .action-btn.secondary:hover:not(:disabled) {
    background: #37373d;
    border-color: #007acc;
  }

  .help-text {
    margin: 4px 0 0 0;
    font-size: 11px;
    color: #6e7681;
    font-style: italic;
  }

  .status {
    margin-top: 16px;
    padding: 12px;
    background: #1a3a1a;
    border-left: 3px solid #28a745;
    color: #7ee087;
    font-size: 12px;
    border-radius: 4px;
  }

  .status.loading {
    background: #1a2a3a;
    border-left-color: #007acc;
    color: #79c0ff;
  }

  .checkbox-label, .radio-label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    font-size: 12px;
    color: #ccc;
    cursor: pointer;
  }

  .checkbox-label:hover, .radio-label:hover {
    color: #fff;
  }

  .checkbox-label input[type="checkbox"],
  .radio-label input[type="radio"] {
    cursor: pointer;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-group label, .form-label {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .form-group select,
  .form-group input[type="text"] {
    width: 100%;
    padding: 8px 12px;
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    color: #ccc;
    border-radius: 4px;
    font-size: 12px;
    font-family: monospace;
  }

  .form-group select:focus,
  .form-group input[type="text"]:focus {
    outline: none;
    border-color: #007acc;
  }

  .form-group select:disabled,
  .form-group input[type="text"]:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .checkbox-label span {
    font-weight: 500;
  }

  .create-xlnomy-btn {
    width: 100%;
    padding: 16px !important;
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 16px;
    background: linear-gradient(135deg, #00ff41 0%, #00cc33 100%) !important;
    color: #000 !important;
  }

  .create-xlnomy-btn:hover {
    background: linear-gradient(135deg, #00ff55 0%, #00dd44 100%) !important;
    transform: translateY(-1px);
  }

  .xlnomy-selector {
    display: flex;
    gap: 8px;
    flex-direction: column;
    margin-bottom: 12px;
  }

  .xlnomy-selector label {
    font-size: 11px;
    color: #888;
    margin-bottom: 4px;
  }

  .xlnomy-selector select {
    width: 100%;
    padding: 8px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #fff;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  }

  .modal {
    background: #2d2d30;
    border: 1px solid #007acc;
    border-radius: 8px;
    padding: 24px;
    max-width: 500px;
    width: 90%;
  }

  .modal h3 {
    margin: 0 0 20px 0;
    color: #fff;
    font-size: 16px;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .modal-actions {
    display: flex;
    gap: 12px;
    margin-top: 24px;
  }

  .modal-actions .action-btn {
    flex: 1;
  }

  .entity-list {
    list-style: none;
    padding: 0;
    margin: 8px 0;
    max-height: 200px;
    overflow-y: auto;
  }

  .entity-list li {
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    margin-bottom: 4px;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    color: #8be9fd;
  }

  /* ============================================ */
  /* 3-LEVEL PRESET SYSTEM (Game UI) */
  /* ============================================ */
  .preset-system {
    margin-bottom: 32px;
  }

  .preset-system h5 {
    font-size: 16px;
    color: #00d9ff;
    margin-bottom: 20px;
    font-weight: 700;
  }

  .scenarios-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .scenarios-header h5 {
    margin: 0;
  }

  .reset-btn {
    background: rgba(255, 80, 80, 0.2);
    border: 1px solid rgba(255, 80, 80, 0.4);
    border-radius: 6px;
    padding: 6px 12px;
    color: #ff5050;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .reset-btn:hover:not(:disabled) {
    background: rgba(255, 80, 80, 0.3);
    border-color: rgba(255, 80, 80, 0.6);
    transform: translateY(-1px);
  }

  .reset-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .preset-list {
    background: rgba(0, 0, 0, 0.3);
    border-left: 3px solid rgba(0, 217, 255, 0.3);
    border-radius: 8px;
    padding: 12px;
    margin: -8px 0 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .preset-item {
    background: rgba(0, 20, 40, 0.5);
    border: 1px solid rgba(0, 122, 204, 0.25);
    border-radius: 8px;
    padding: 14px 16px;
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    gap: 14px;
    text-align: left;
  }

  .preset-item:hover:not(:disabled) {
    background: rgba(0, 40, 80, 0.7);
    border-color: rgba(0, 217, 255, 0.5);
    transform: translateX(4px);
  }

  .preset-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .preset-item .icon {
    font-size: 20px;
    font-weight: 700;
    color: #00d9ff;
    background: rgba(0, 217, 255, 0.1);
    width: 44px;
    height: 44px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: 2px solid rgba(0, 217, 255, 0.3);
  }

  .preset-item .info strong {
    display: block;
    font-size: 15px;
    color: #ffffff;
    margin-bottom: 2px;
  }

  .preset-item .info p {
    margin: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.6);
  }

  /* Recommended scenario - AHB glow effect */
  .preset-item.recommended {
    border: 2px solid #00ff88;
    box-shadow: 0 0 15px rgba(0, 255, 136, 0.4), inset 0 0 10px rgba(0, 255, 136, 0.1);
    animation: recommendedPulse 2s ease-in-out infinite;
  }

  @keyframes recommendedPulse {
    0%, 100% { box-shadow: 0 0 15px rgba(0, 255, 136, 0.4), inset 0 0 10px rgba(0, 255, 136, 0.1); }
    50% { box-shadow: 0 0 25px rgba(0, 255, 136, 0.6), inset 0 0 15px rgba(0, 255, 136, 0.2); }
  }

  .banker-demo {
    background: rgba(0, 255, 65, 0.05);
    border: 2px solid rgba(0, 255, 65, 0.3);
    border-radius: 8px;
    padding: 16px;
  }

  .demo-btn {
    width: 100%;
    padding: 14px;
    font-size: 15px;
    font-weight: 700;
    margin-bottom: 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .demo-btn.quick-action {
    background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%);
    border: none;
    color: #000;
    font-weight: 600;
  }

  .demo-btn.quick-action:hover:not(:disabled) {
    background: linear-gradient(135deg, #FFED4E 0%, #FFB84D 100%);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(255, 215, 0, 0.5);
  }

  .demo-btn.step-1 {
    background: linear-gradient(135deg, #007acc 0%, #005a9e 100%);
    border: none;
    color: #fff;
  }

  .demo-btn.step-1:hover:not(:disabled) {
    background: linear-gradient(135deg, #0095ff 0%, #007acc 100%);
    transform: translateY(-1px);
  }

  .demo-btn.step-2 {
    background: linear-gradient(135deg, #00cc33 0%, #009922 100%);
    border: none;
    color: #fff;
  }

  .demo-btn.step-2:hover:not(:disabled) {
    background: linear-gradient(135deg, #00ff41 0%, #00cc33 100%);
    transform: translateY(-1px);
  }

  .demo-btn.step-3 {
    background: linear-gradient(135deg, #ff9500 0%, #cc7700 100%);
    border: none;
    color: #fff;
  }

  .demo-btn.step-3:hover:not(:disabled) {
    background: linear-gradient(135deg, #ffaa00 0%, #ff9500 100%);
    transform: translateY(-1px);
  }

  .demo-btn.step-4 {
    background: rgba(255, 70, 70, 0.2);
    border: 1px solid #ff4646;
    color: #ff4646;
  }

  .demo-btn.step-4:hover:not(:disabled) {
    background: rgba(255, 70, 70, 0.3);
  }

  .demo-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none !important;
  }

  .step-help {
    font-size: 11px;
    color: #888;
    margin: 0 0 12px 0;
    font-style: italic;
  }
</style>
