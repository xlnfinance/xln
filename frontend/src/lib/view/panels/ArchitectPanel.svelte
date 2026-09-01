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
  import { onDestroy } from 'svelte';
  import { panelBridge } from '../utils/panelBridge';
  import ahbScenarioCode from '../../../../../core/scenarios/consensus/ahb.ts?raw';
  import { shortAddress } from '$lib/utils/format';
  import { getXLN, submitRuntimeInput } from '$lib/stores/xlnStore';
  import type { EnvSnapshot, RuntimeInput, RuntimeReplica, XLNModule } from '@xln/core/api/public/runtime-module';
  import type { EntityReplica } from '@xln/core/entity/types';
  import type { JurisdictionConfig } from '@xln/core/protocol/config/jurisdiction-config';
  import type { JAdapter } from '@xln/core/jurisdiction/adapter';
  import { defaultAccountDisputeConfigForRoleEvidence } from '@xln/core/account/config/dispute-config';
  import { computeAddress, hexlify } from 'ethers';
  import { activeRuntimeEntry as activeRuntimeStore } from '$lib/stores/runtimeStore';
  import { activeRuntime as activeVaultRuntime } from '$lib/stores/vault/vaultStore';
  import SolvencyPanel from './solvency/SolvencyPanel.svelte';
  import {
    getArchitectErrorMessage as errorMessage,
    getArchitectFrameLabel,
    getArchitectLiveModeBlockMessage,
    getArchitectScenarioScrollTop,
    getNextArchitectEntityName,
    getNextArchitectJurisdictionName,
    listArchitectEntityIds,
    type ArchitectMode,
  } from '../../../../packages/runtime-client/src/architect-panel-view';

  // Receive isolated env as props (passed from View.svelte) - REQUIRED
  export let runtimeFrameEnv: Writable<RuntimeReplica | null>;
  export let runtimeFrameHistory: Writable<EnvSnapshot[]>;
  export let runtimeFrameTimeIndex: Writable<number>;
  export let runtimeFrameIsLive: Writable<boolean>;

  type ArchitectRuntimeInput = {
    runtimeTxs: unknown[];
    entityInputs: unknown[];
    jInputs?: unknown[];
    timestamp?: number;
  };

  let currentMode: ArchitectMode = 'economy';
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

  // Xlnomy state
  let showCreateXlnomyModal = false;
  let newXlnomyName = 'Testnet';
  let newXlnomyEvmType: 'browservm' | 'reth' | 'erigon' | 'monad' = 'browservm';
  let newXlnomyRpcUrl = 'http://localhost:8545';
  let newXlnomyBlockTime = '1000';

  // Get available Xlnomies from env
  $: jurisdictions = $runtimeFrameEnv?.state.jReplicas ? Array.from($runtimeFrameEnv.state.jReplicas.keys()) : [];
  $: activeJurisdiction = $runtimeFrameEnv?.activeJurisdiction || '';

  // Check if env is ready
  $: envReady = $runtimeFrameEnv !== null && $runtimeFrameEnv !== undefined;

  // CRITICAL: mutations are only valid against the active live runtime frame.
  $: isLiveActionFrame = Boolean($runtimeFrameIsLive) && $runtimeFrameTimeIndex === -1;

  let cachedXLN: XLNModule | null = null;

  /**
   * Materialize the bilateral response clocks before signing openAccount.
   * The clocks depend on both committed entity roles, so guessing a missing role
   * here would silently sign a different dispute agreement on the two replicas.
   */
  function openAccountData(sourceEntityId: string, targetEntityId: string) {
    const replicas: EntityReplica[] = Array.from(
      $runtimeFrameEnv?.state?.eReplicas?.values?.() ?? [],
    );
    const source = replicas.find(replica => replica?.state?.entityId === sourceEntityId);
    const target = replicas.find(replica => replica?.state?.entityId === targetEntityId);
    if (typeof source?.state?.profile?.isHub !== 'boolean' || typeof target?.state?.profile?.isHub !== 'boolean') {
      throw new Error(`ACCOUNT_DISPUTE_PARTY_ROLE_UNAVAILABLE:${sourceEntityId}:${targetEntityId}`);
    }
    return {
      targetEntityId,
      disputeConfig: defaultAccountDisputeConfigForRoleEvidence(
        { entityId: sourceEntityId, isHub: source.state.profile.isHub, source: 'committed-profile' },
        { entityId: targetEntityId, isHub: target.state.profile.isHub, source: 'committed-profile' },
        new Map([
          [sourceEntityId.toLowerCase(), source.state.profile.isHub],
          [targetEntityId.toLowerCase(), target.state.profile.isHub],
        ]),
      ),
    };
  }

  async function getJAdapterFromEnv(): Promise<JAdapter | null> {
    if (!$runtimeFrameEnv) return null;
    const xln = cachedXLN ?? await getXLN();
    cachedXLN = xln;
    return xln.getActiveJAdapter?.($runtimeFrameEnv) ?? null;
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
    input: ArchitectRuntimeInput,
    action = 'runtime action'
  ): Promise<void> {
    if (!requireLiveMode(action)) {
      throw new Error(`${action} requires LIVE mode`);
    }
    const nextEnv = await submitRuntimeInput(input as RuntimeInput);
    if (nextEnv) {
      runtimeFrameEnv.set(nextEnv);
      // A live Runtime has no resident history; preserve only an explicitly
      // owned browser trace already selected by the user.
      runtimeFrameHistory.set($runtimeFrameHistory ?? []);
    }
  }

  /** Guard function - blocks mutations when viewing history */
  function requireLiveMode(action: string): boolean {
    if (!isLiveActionFrame) {
      lastAction = getArchitectLiveModeBlockMessage(action);
      console.warn('[Architect] Blocked mutation outside live mode:', action);
      return false;
    }
    return true;
  }

  function publishCurrentEnv(frames: EnvSnapshot[] = $runtimeFrameHistory ?? []): void {
    runtimeFrameIsLive.set(true);
    runtimeFrameTimeIndex.set(-1);
    runtimeFrameHistory.set(frames);
    runtimeFrameEnv.set($runtimeFrameEnv);
  }

  function clearDemoRuntimeState(message: string): boolean {
    if (!requireLiveMode('reset demo')) return false;
    if (!$runtimeFrameEnv?.state.eReplicas) {
      lastAction = 'No demo runtime state to reset';
      return false;
    }
    stopFedPaymentLoop();
    $runtimeFrameEnv.state.eReplicas.clear();
    publishCurrentEnv([]);
    lastAction = message;
    return true;
  }

  async function recordScenarioRun(
    xln: XLNModule,
    env: RuntimeReplica,
    run: (target: RuntimeReplica) => Promise<RuntimeReplica | void>,
  ): Promise<{ env: RuntimeReplica; frames: EnvSnapshot[] }> {
    return xln.recordRuntimeScenario(env, run);
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

    if ($runtimeFrameEnv?.runtimeSeed !== undefined && $runtimeFrameEnv?.runtimeSeed !== null) {
      return $runtimeFrameEnv.runtimeSeed;
    }

    return null;
  }

  function ensureScenarioEnv(XLN: XLNModule, label: string): RuntimeReplica {
    let seed = resolveRuntimeSeed();
    if (seed === null || seed === undefined) {
      seed = DEMO_RUNTIME_SEED;
      console.warn(`[${label}] No runtime seed found; using demo seed.`);
    }
    const env = $runtimeFrameEnv ?? XLN.createEmptyEnv(seed ?? null);
    if (!$runtimeFrameEnv) runtimeFrameEnv.set(env);

    // Dev Lab executes against a detached projection only. It must never use
    // the live Runtime's WAL, adapters, P2P handles, or persistence controls.
    env.scenarioMode = true;
    env.scenarioJAdapterMode = 'browservm';
    env.runtimeConfig = {
      ...env.runtimeConfig,
      storage: { ...env.runtimeConfig?.storage, enabled: false },
    };
    if (env.infrastructure) {
      throw new Error(`${label}: detached scenario unexpectedly owns live infrastructure`);
    }

    if (seed !== null && seed !== undefined && env.runtimeSeed !== seed) {
      env.runtimeSeed = seed;
    }

    if (env.runtimeSeed === undefined || env.runtimeSeed === null) {
      throw new Error(`${label}: runtimeSeed missing - unlock vault or set XLN_RUNTIME_SEED`);
    }

    if (!env.state.eReplicas) {
      env.state.eReplicas = new Map();
    }

    runtimeFrameEnv.set(env);
    return env;
  }

  function requireRuntimeEnv(action: string): RuntimeReplica {
    const env = $runtimeFrameEnv;
    if (!env) throw new Error(`${action}: embedded runtime workspace is unavailable`);
    return env;
  }

  function requireActiveJurisdiction(env: RuntimeReplica): JurisdictionConfig {
    const name = env.activeJurisdiction;
    if (!name) throw new Error('ACTIVE_JURISDICTION_REQUIRED');
    const replica = env.state.jReplicas.get(name);
    if (!replica) throw new Error(`ACTIVE_JURISDICTION_REPLICA_MISSING:${name}`);
    const entityProviderAddress = replica.contracts?.entityProvider;
    const depositoryAddress = replica.contracts?.depository;
    if (!entityProviderAddress || !depositoryAddress) {
      throw new Error(`ACTIVE_JURISDICTION_CONTRACTS_MISSING:${name}`);
    }
    return {
      address: entityProviderAddress,
      name,
      entityProviderAddress,
      depositoryAddress,
      ...(replica.chainId === undefined ? {} : { chainId: replica.chainId }),
      ...(replica.blockTimeMs === undefined ? {} : { blockTimeMs: replica.blockTimeMs }),
      ...(replica.entityProviderDeploymentBlock === undefined
        ? {}
        : { entityProviderDeploymentBlock: replica.entityProviderDeploymentBlock }),
    };
  }

  // Get entity IDs for dropdowns (extract entityId from replica keys)
  let entityIds: string[] = [];
  $: entityIds = $runtimeFrameEnv?.state.eReplicas
    ? listArchitectEntityIds($runtimeFrameEnv.state.eReplicas.keys() as Iterable<string>)
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
    if (!selectedEntityForMint || !$runtimeFrameEnv) {
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
    } catch (err: unknown) {
      lastAction = ` ${errorMessage(err)}`;
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

    if (!$runtimeFrameEnv) {
      lastAction = '⚠️ Embedded runtime workspace is not available';
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
      // Debug: check reserves before R2R
      const amount = BigInt(r2rAmount);
      const fromReserve = await jadapter.getReserves(r2rFromEntity, 1);

      if (fromReserve < amount) {
        throw new Error(`Insufficient reserves: have ${fromReserve}, need ${amount}`);
      }

      const replicaKey = (Array.from($runtimeFrameEnv.state.eReplicas.keys()) as string[]).find((key) => key.startsWith(`${r2rFromEntity}:`));
      const replica = replicaKey ? $runtimeFrameEnv.state.eReplicas.get(replicaKey) : null;
      const signerId = replica?.signerId;
      if (!signerId) {
        throw new Error(`Missing signer for ${shortAddress(r2rFromEntity)}`);
      }
      await ingressRuntimeInput({
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
    } catch (err: unknown) {
      lastAction = `❌ ${errorMessage(err)}`;
      console.error('[Architect] R2R error:', err);
    } finally {
      loading = false;
    }
  }

  // ============================================================================
  // TUTORIAL SYSTEM - Autopilot Mode
  // ============================================================================

  // Scenario Code - shows actual scenarios/ahb.ts from /runtime (via Vite raw import)
  let scenarioCodeTextarea: HTMLTextAreaElement;
  const scenarioCode = ahbScenarioCode;

  // Scroll textarea to current frame when timeIndex changes
  $: if (scenarioCodeTextarea && $runtimeFrameTimeIndex >= 0) {
    scenarioCodeTextarea.scrollTop = getArchitectScenarioScrollTop(scenarioCode, $runtimeFrameTimeIndex);
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
    try {
      const XLN = await getXLN();

      // Ensure env exists with seed + eReplicas
      const env = ensureScenarioEnv(XLN, 'AHB');
      // CRITICAL: Clear old state BEFORE running demo
      env.state.eReplicas.clear();

      // Run the ACTUAL AHB scenario (same code as CLI)
      const recording = await recordScenarioRun(XLN, env, target => XLN.scenarios.ahb(target));
      const frames = recording.frames;

      publishCurrentEnv(frames);

      lastAction = `AHB: ${frames.length} frames loaded. Use TimeMachine to navigate.`;

      // NO autopilot - user controls historical frames via TimeMachine.
      // Keep the workspace LIVE on the scenario's final runtime env by default.
    } catch (err: unknown) {
      // CRITICAL: Still update history with frames created before error
      lastAction = `❌ ${errorMessage(err)}`;
      console.error('[Tutorial] AHB error:', err);
    } finally {
      loading = false;
      ahbRunning = false; // Reset guard
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
      const env = ensureScenarioEnv(XLN, 'Swap');
      env.state.eReplicas.clear();
      const recording = await recordScenarioRun(XLN, env, target => XLN.scenarios.swap(target));
      const frames = recording.frames;
      publishCurrentEnv(frames);
      lastAction = `Swap: ${frames.length} frames loaded.`;
    } catch (err: unknown) {
      lastAction = `❌ ${errorMessage(err)}`;
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
      const XLN = await getXLN();

      const env = ensureScenarioEnv(XLN, 'Swap Market');
      env.state.eReplicas.clear();
      const runSwapMarketScenario = XLN.scenarios.swapMarket;
      if (!runSwapMarketScenario) throw new Error('Swap Market scenario is unavailable');
      const recording = await recordScenarioRun(XLN, env, runSwapMarketScenario);
      const frames = recording.frames;
      publishCurrentEnv(frames);

      lastAction = `Swap Market: ${frames.length} frames`;
    } catch (err: unknown) {
      lastAction = `❌ ${errorMessage(err)}`;
    } finally {
      loading = false;
    }
  }

  /** Start Rapid Fire stress test */
  async function runRapidFire() {
    if (!requireLiveMode('run rapid-fire')) return;
    loading = true;
    try {
      const XLN = await getXLN();

      const env = ensureScenarioEnv(XLN, 'Rapid Fire');
      env.state.eReplicas.clear();
      const runRapidFireScenario = XLN.scenarios.rapidFire;
      if (!runRapidFireScenario) throw new Error('Rapid Fire scenario is unavailable');
      const recording = await recordScenarioRun(XLN, env, runRapidFireScenario);
      const frames = recording.frames;
      publishCurrentEnv(frames);

      lastAction = `Rapid Fire: ${frames.length} frames`;
    } catch (err: unknown) {
      lastAction = `❌ ${errorMessage(err)}`;
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
      runtimeFrameEnv.set(freshEnv);

      // Reset UI state
      runtimeFrameHistory.set([]);
      runtimeFrameTimeIndex.set(-1);
      runtimeFrameIsLive.set(true);
      lastAction = 'Reset complete - ready for new scenario';
    } catch (err: unknown) {
      console.error('[Reset] Error:', err);
      lastAction = `❌ Reset failed: ${errorMessage(err)}`;
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
    try {
      const XLN = await getXLN();

      const env = ensureScenarioEnv(XLN, 'Grid');

      // Clear old state BEFORE running demo
      env.state.eReplicas.clear();
      env.state.jReplicas?.clear();

      // Run the grid scenario
      const recording = await recordScenarioRun(XLN, env, target => XLN.scenarios.grid(target));
      const frames = recording.frames;
      publishCurrentEnv(frames);
      lastAction = 'Grid Scalability scenario loaded';
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'message' in err) {
        lastAction = `❌ ${errorMessage(err)}`;
      } else {
        lastAction = `❌ ${err}`;
      }
      console.error('[Grid] Error:', err);
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
    try {
      const XLN = await getXLN();

      const env = ensureScenarioEnv(XLN, 'Settle');

      // Clear old state BEFORE running demo
      env.state.eReplicas.clear();
      env.state.jReplicas?.clear();

      // Run the settle scenario
      const recording = await recordScenarioRun(XLN, env, target => XLN.scenarios.settle(target));
      const frames = recording.frames;
      publishCurrentEnv(frames);
      lastAction = 'Settlement Workspace scenario loaded';
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'message' in err) {
        lastAction = `❌ ${errorMessage(err)}`;
      } else {
        lastAction = `❌ ${err}`;
      }
      console.error('[Settle] Error:', err);
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
      const XLN = await getXLN();

      // Auto-create default jurisdiction if none exists
      if (!$runtimeFrameEnv?.activeJurisdiction) {
        lastAction = 'Connecting to testnet...';

        // Auto-import testnet (prod anvil) - shared J-machine
        await ingressRuntimeInput({
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
        await ingressRuntimeInput({
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

      const env = requireRuntimeEnv('create hub');
      const jurisdiction = requireActiveJurisdiction(env);
      const xlnomy = env.state.jReplicas.get(jurisdiction.name);
      if (!xlnomy) throw new Error('Active xlnomy not found');

      const jPos = xlnomy.position;

      // Create 9 entities in 3×3 grid at y=320
      const entities = [];
      for (let i = 0; i < 9; i++) {
        const row = Math.floor(i / 3);
        const col = i % 3;
        const x = jPos.x + (col - 1) * 40;
        const z = jPos.z + (row - 1) * 40;
        const y = jPos.y + 20; // y=320

        const entitySeed = resolveRuntimeSeed();
        if (!entitySeed) throw new Error('ENTITY_IMPORT_RUNTIME_SEED_REQUIRED');
        const signerId = computeAddress(hexlify(XLN.deriveSignerKeySync(entitySeed, `architect-hub-${i}`))).toLowerCase();
        const entityId = XLN.generateLazyEntityId([signerId], 1n);

        entities.push(XLN.importEntity({
          entityId,
          signerId,
          entitySeed,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction
            },
            isProposer: true,
            position: { x, y, z }
          }
        }));
      }

      // Import all entities
      await ingressRuntimeInput({
        runtimeTxs: entities,
        entityInputs: []
      });

      lastAction = ` Created 3×3 hub (9 entities at y=320)`;

      publishCurrentEnv();
    } catch (err: unknown) {
      lastAction = ` ${errorMessage(err)}`;
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
    } catch (err: unknown) {
      lastAction = ` ${errorMessage(err)}`;
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
      const env = requireRuntimeEnv('send payment');

      // Pick 2 random different entities
      const from = entityIds[Math.floor(Math.random() * entityIds.length)];
      let to = entityIds[Math.floor(Math.random() * entityIds.length)];
      while (to === from && entityIds.length > 1) {
        to = entityIds[Math.floor(Math.random() * entityIds.length)];
      }

      const fromReplicaKey = (Array.from(env.state.eReplicas.keys()) as string[]).find(k => k.startsWith(from + ':'));
      const fromReplica = fromReplicaKey ? env.state.eReplicas.get(fromReplicaKey) : null;

      if (!fromReplica || !from || !to) {
        throw new Error('Entity not found');
      }

      lastAction = `Sending payment ${from.slice(0, 8)} → ${to.slice(0, 8)}...`;

      // Check if account exists
      const hasAccount = fromReplica.state?.accounts?.has(to);

      // Open account if needed
      if (!hasAccount) {
        await ingressRuntimeInput({ runtimeTxs: [], entityInputs: [{
          entityId: from,
          signerId: fromReplica.signerId,
          entityTxs: [{
            type: 'openAccount',
            data: openAccountData(from, to)
          }]
        }] }, 'send payment');
      }

      // Send payment
      const amount = Math.floor(Math.random() * 100000) + 10000; // 10K-110K
      await ingressRuntimeInput({ runtimeTxs: [], entityInputs: [{
        entityId: from,
        signerId: fromReplica.signerId,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: to,
            tokenId: 1,
            amount: BigInt(amount),
            route: [from, to],
            deliveryMode: 'direct',
            description: 'Random banker demo payment'
          }
        }]
      }] }, 'send payment');

      lastAction = ` Payment: ${shortAddress(from)} → ${shortAddress(to)} ($${(amount/1000).toFixed(0)}K)`;

      publishCurrentEnv();
    } catch (err: unknown) {
      lastAction = ` ${errorMessage(err)}`;
      console.error('[Architect] Random payment error:', err);
    } finally {
      loading = false;
    }
  }

  /** Quick Action: Send 20% of balance to random entity */
  async function send20PercentTransfer() {
    if (!requireLiveMode('send transfer')) return;
    if (!$runtimeFrameEnv || entityIds.length < 2) {
      lastAction = ' Need at least 2 entities';
      return;
    }

    loading = true;

    try {
      const env = requireRuntimeEnv('send transfer');

      // Pick random sender with reserves > 0
      const entitiesWithReserves = entityIds.filter(id => {
        const key = (Array.from(env.state.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
        const replica = key ? env.state.eReplicas.get(key) : null;
        const reserves = replica?.state?.reserves?.get(0) || 0n;
        return BigInt(reserves) > 0n;
      });

      if (entitiesWithReserves.length === 0) {
        lastAction = ' No entities have reserves';
        loading = false;
        return;
      }

      const from = entitiesWithReserves[Math.floor(Math.random() * entitiesWithReserves.length)];
      const fromReplicaKey = (Array.from(env.state.eReplicas.keys()) as string[]).find(k => k.startsWith(from + ':'));
      const fromReplica = fromReplicaKey ? env.state.eReplicas.get(fromReplicaKey) : null;

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

      if (!from || !to || to === from) {
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
          entityTxs: [{ type: 'openAccount', data: openAccountData(from, to) }]
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
            deliveryMode: 'direct',
            description: '20% balance transfer'
          }
        }]
      });

      await ingressRuntimeInput({ runtimeTxs: [], entityInputs: txBatch }, 'send transfer');

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
    if (!$runtimeFrameEnv?.activeJurisdiction) {
      lastAction = ' Create jurisdiction first';
      return;
    }

    loading = true;
    lastAction = 'Creating 100 entities... (FPS test)';

    try {
      const XLN = await getXLN();
      const env = requireRuntimeEnv('scale stress test');
      const jurisdiction = requireActiveJurisdiction(env);
      const xlnomy = env.state.jReplicas.get(jurisdiction.name);
      if (!xlnomy) throw new Error('Active xlnomy not found');

      // Create 100 entities in 10x10 grid
      const runtimeTxs = [];
      const entitySeed = resolveRuntimeSeed();
      if (!entitySeed) throw new Error('ENTITY_IMPORT_RUNTIME_SEED_REQUIRED');

      for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
          const x = (col - 4.5) * 40; // Spread across 400px
          const z = (row - 4.5) * 40;
          const y = 50; // Same height

          const label = `scale-test-bank-${row}-${col}`;
          const signerId = computeAddress(hexlify(XLN.deriveSignerKeySync(entitySeed, label))).toLowerCase();
          const entityId = XLN.generateLazyEntityId([signerId], 1n);
          runtimeTxs.push(XLN.importEntity({
            entityId, signerId, entitySeed,
            data: {
              isProposer: true,
              config: { mode: 'proposer-based', threshold: 1n, validators: [signerId], shares: { [signerId]: 1n }, jurisdiction },
              profileName: label,
              position: { x, y, z },
            },
          }));
        }
      }

      // Batch create all 100 entities in ONE frame
      await ingressRuntimeInput({ runtimeTxs, entityInputs: [] }, 'scale stress test');

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
    clearDemoRuntimeState('Demo reset complete - ready for new topology');
  }

  let fedPaymentInterval: ReturnType<typeof setInterval> | null = null;
  /** VR/topology payment loop. */
  async function startFedPaymentLoop() {
    if (!requireLiveMode('Fed payment loop')) return;
    if (fedPaymentInterval) clearInterval(fedPaymentInterval);
    const env = requireRuntimeEnv('Fed payment loop');

    const bankEntityIds = entityIds.filter(id => {
      const key = (Array.from(env.state.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? env.state.eReplicas.get(key) : null;
      return replica?.signerId && !replica.signerId.includes('_fed');
    });

    const fedId = entityIds.find(id => {
      const key = (Array.from(env.state.eReplicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? env.state.eReplicas.get(key) : null;
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
        const currentEnv = requireRuntimeEnv('Fed payment loop');

        tick++;
        const action = tick % 4; // 4-step cycle

        if (action === 0) {
          // Fed lends to random bank
          const bank = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          const amount = Math.floor(Math.random() * 500000) + 100000; // $100K-$600K

          const fedKey = (Array.from(currentEnv.state.eReplicas.keys()) as string[]).find(k => k.startsWith(fedId + ':'));
          const fedReplica = fedKey ? currentEnv.state.eReplicas.get(fedKey) : null;

          if (fedReplica) {
            await ingressRuntimeInput({ runtimeTxs: [], entityInputs: [{
              entityId: fedId,
              signerId: fedReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: bank,
                  tokenId: 1,
                  amount: BigInt(amount),
                  route: [fedId, bank],
                  deliveryMode: 'direct',
                  description: `Fed discount window lending`
                }
              }]
            }] }, 'Fed payment loop');
          }
        } else if (action === 1) {
          // Random bank borrows from Fed (reverse direction)
          const bank = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          const amount = Math.floor(Math.random() * 300000) + 50000; // $50K-$350K

          const bankKey = (Array.from(currentEnv.state.eReplicas.keys()) as string[]).find(k => k.startsWith(bank + ':'));
          const bankReplica = bankKey ? currentEnv.state.eReplicas.get(bankKey) : null;

          if (bankReplica) {
            await ingressRuntimeInput({ runtimeTxs: [], entityInputs: [{
              entityId: bank,
              signerId: bankReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: fedId,
                  tokenId: 1,
                  amount: BigInt(amount),
                  route: [bank, fedId],
                  deliveryMode: 'direct',
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

          const fromKey = (Array.from(currentEnv.state.eReplicas.keys()) as string[]).find(k => k.startsWith(from + ':'));
          const fromReplica = fromKey ? currentEnv.state.eReplicas.get(fromKey) : null;

          if (fromReplica) {
            // Check if account exists
            const hasAccount = fromReplica.state?.accounts?.has(to);

            if (!hasAccount) {
              // Open account first
              await ingressRuntimeInput({ runtimeTxs: [], entityInputs: [{
                entityId: from,
                signerId: fromReplica.signerId,
                entityTxs: [{
                  type: 'openAccount',
                  data: openAccountData(from, to)
                }]
              }] }, 'Fed payment loop');
            }

            // Send payment
            await ingressRuntimeInput({ runtimeTxs: [], entityInputs: [{
              entityId: from,
              signerId: fromReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: to,
                  tokenId: 1,
                  amount: BigInt(amount),
                  route: [from, to],
                  deliveryMode: 'direct',
                  description: `Interbank settlement`
                }
              }]
            }] }, 'Fed payment loop');
          }
        }

        publishCurrentEnv();

      } catch (err: unknown) {
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
    if ($runtimeFrameEnv?.state.jReplicas && $runtimeFrameEnv.state.jReplicas.size >= 9) {
      lastAction = ' Maximum 9 jurisdictions (3×3 grid full)';
      return;
    }

    loading = true;
    lastAction = `Creating jurisdiction "${newXlnomyName.toLowerCase()}"...`;

    try {
      // Step 1: Import J-machine
      const isBrowserVM = newXlnomyEvmType === 'browservm';
      await ingressRuntimeInput({
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
      await ingressRuntimeInput({
        runtimeTxs: [],
        entityInputs: []
      });

      // Success message
      const createdName = newXlnomyName.toLowerCase();
      lastAction = ` xlnomy "${createdName}" created!`;

      // Close modal and advance to next number
      showCreateXlnomyModal = false;

      newXlnomyName = getNextArchitectJurisdictionName(newXlnomyName);

      publishCurrentEnv();
    } catch (err: unknown) {
      lastAction = ` ${errorMessage(err)}`;
      console.error('[Architect] Xlnomy creation error:', err);
    } finally {
      loading = false;
    }
  }

  async function switchXlnomy(name: string) {
    if (!$runtimeFrameEnv || name === $runtimeFrameEnv.activeJurisdiction) return;

    loading = true;
    lastAction = `Switching to "${name}"...`;

    try {
      if (!$runtimeFrameEnv.state.jReplicas?.has(name)) {
        lastAction = ` Xlnomy "${name}" not found`;
        return;
      }
      $runtimeFrameEnv.activeJurisdiction = name;
      lastAction = ` Switched to "${name}"`;

      runtimeFrameEnv.set($runtimeFrameEnv);
    } catch (err: unknown) {
      lastAction = ` ${errorMessage(err)}`;
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

    if (!$runtimeFrameEnv?.activeJurisdiction) {
      lastAction = ' Create Xlnomy first';
      return;
    }

    loading = true;
    lastAction = `Creating entity "${newEntityName}"...`;

    try {
      const XLN = await getXLN();
      const env = requireRuntimeEnv('create entity');
      const jurisdiction = requireActiveJurisdiction(env);

      // Generate signerId from xlnomy name + entity name
      const entitySeed = resolveRuntimeSeed();
      if (!entitySeed) throw new Error('ENTITY_IMPORT_RUNTIME_SEED_REQUIRED');
      const signerId = computeAddress(hexlify(XLN.deriveSignerKeySync(entitySeed, `architect-${newEntityName}`))).toLowerCase();
      const entityId = XLN.generateLazyEntityId([signerId], 1n);

      // Random position in 3D space
      const position = {
        x: Math.random() * 400 - 200,
        y: Math.random() * 100,
        z: Math.random() * 400 - 200
      };

      // Create entity via importReplica RuntimeTx
      await ingressRuntimeInput({
        runtimeTxs: [XLN.importEntity({
          entityId,
          signerId,
          entitySeed,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction
            },
            isProposer: true,
            position
          }
        })],
        entityInputs: []
      });

      lastAction = ` Created "${newEntityName}"`;

      newEntityName = getNextArchitectEntityName(newEntityName);

      publishCurrentEnv();
    } catch (err: unknown) {
      lastAction = ` ${errorMessage(err)}`;
      console.error('[Architect] Create entity error:', err);
    } finally {
      loading = false;
    }
  }

</script>

<div class="architect-panel" data-testid="architect-panel">
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

        {#if $runtimeFrameHistory && $runtimeFrameHistory.length > 0}
          <div class="scenario-code-section">
            <h5>Scenario Code (Frame {getArchitectFrameLabel($runtimeFrameTimeIndex)})</h5>
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
        <SolvencyPanel {runtimeFrameEnv} />
      </div>

    {:else if currentMode === 'build'}
      <h4>Build Mode</h4>

      {#if !envReady}
        <div class="status loading">
          ⏳ Initializing XLN environment...
        </div>
      {:else if !$runtimeFrameEnv?.activeJurisdiction}
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
          <h5>Entities in {$runtimeFrameEnv.activeJurisdiction}</h5>
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
