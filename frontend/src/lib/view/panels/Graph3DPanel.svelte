<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get, type Writable } from 'svelte/store';
  import * as THREE from 'three';
  import type { OrbitControls as OrbitControlsType } from 'three/examples/jsm/controls/OrbitControls.js';

  // Visual effects system
  // import VisualDemoPanel from '../Views/VisualDemoPanel.svelte'; // TODO: Move to view/
  // import AdminPanel from '../Admin/AdminPanel.svelte'; // TODO: Move to view/
  // import VRScenarioBuilder from '../VR/VRScenarioBuilder.svelte'; // TODO: Move to view/

  // Network3D managers
  import { EntityManager } from '$lib/network3d/EntityManager';
  import { AccountActivityVisualizer } from '$lib/network3d/AccountActivityVisualizer';
  import { createAccountBars } from '$lib/network3d/AccountBarRenderer';

  // Panel communication
  import { panelBridge } from '../utils/panelBridge';

  // Props - REQUIRED for /view isolation (dead props removed)
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;
  export let isolatedTimeIndex: Writable<number>;

  // Time-travel aware: Read from history[timeIndex] when scrubbing, else live state
  $: env = (() => {
    const timeIdx = $isolatedTimeIndex;
    const hist = $isolatedHistory;
    if (timeIdx >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIdx, hist.length - 1);
      return hist[idx];  // Historical frame
    }
    return $isolatedEnv;  // Live state
  })();

  // Extract replicas from env (replaces $replicas)
  $: replicas = env?.replicas || new Map();

  // XLN runtime interface
  interface XLNRuntime {
    deriveDelta: (delta: { [tokenId: number]: bigint }, isLeft: boolean) => DerivedAccountData;
    getTokenInfo: (tokenId: number) => { symbol: string; decimals: number } | undefined;
    getEntityShortId: (entityId: string) => string;
    executeScenario: (env: unknown, scenario: unknown) => Promise<{ success: boolean; framesGenerated: number; errors?: string[] }>;
    process: (env: unknown, inputs: unknown[]) => Promise<void>;
    parseScenario: (text: string) => { errors: unknown[]; scenario: unknown };
  }

  // XLN runtime functions (loaded dynamically, no global store)
  let XLN: XLNRuntime | null = null;

  // Mock functions for features we're not using in /view
  const debug = {
    warn: (...args: unknown[]) => console.warn('[Graph3D]', ...args),
    error: (...args: unknown[]) => console.error('[Graph3D]', ...args)
  };
  const getThemeColors = (theme: string) => ({
    background: 0x222222, // Lighter gray for debugging
    entity: 0x007acc,
    connection: 0x444444,
    entityColor: '#007acc',
    entityEmissive: '#003366',
    connectionColor: '#444444'
  });
  const settings = { theme: 'dark', portfolioScale: 5000 };
  const effectOperations = {
    clear: () => {},
    enqueue: (...args: unknown[]) => {},
    process: (...args: unknown[]) => {}
  };
  const createRenderer = async (mode: string, options: THREE.WebGLRendererParameters) => {
    // WebGPU requires Three.js r163+ with WebGPURenderer
    // For now, always use WebGL (WebGPU support needs package upgrade)
    if (mode === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu) {
      console.warn('[Graph3D] WebGPU requested but requires Three.js r163+. Using WebGL for now.');
    }
    return new THREE.WebGLRenderer(options);
  };
  type RendererMode = 'webgl' | 'webgpu';

  // VR/Effects stubs (not used in /view isolated mode)
  class RippleEffect {
    constructor(...args: unknown[]) {}
  }
  class SpatialHash {
    cellSize: number;
    constructor(cellSize: number) {
      this.cellSize = cellSize;
    }
    clear() {}
    update(entityIdOrEntities: string | EntityData[], position?: THREE.Vector3) {}
  }
  class GestureManager {
    private callbacks: ((event: { type: string; entityId: string }) => void)[] = [];
    on(callback: (event: { type: string; entityId: string }) => void) {
      this.callbacks.push(callback);
    }
    clear() {
      this.callbacks = [];
    }
    updateEntity(entityId: string, position: THREE.Vector3, timestamp: number) {}
  }
  interface VRHammerEvent {
    fromEntityId: string;
    toEntityId: string;
  }
  class VRHammer {
    constructor() {}
    attachToController(controller: THREE.XRTargetRaySpace) {}
    onAccountHit(callback: (event: VRHammerEvent) => void) {}
    update(connections: ConnectionData[]) {}
  }

  // OrbitControls class (loaded dynamically in onMount)
  let OrbitControls: typeof OrbitControlsType;

  // TypeScript interfaces for type safety
  interface EntityData {
    id: string;
    position: THREE.Vector3;
    mesh: THREE.Mesh;
    label?: THREE.Sprite; // Label sprite that follows entity
    profile?: any;
    isHub?: boolean; // Hub entity (gets pulsing glow animation)
    pulsePhase?: number;
    lastActivity?: number;
    isPinned?: boolean;  // User has manually positioned this entity
    isHovered?: boolean; // Mouse is over this entity
    isDragging?: boolean; // Currently being dragged
    activityRing?: THREE.Mesh | null; // Activity indicator ring
    hubConnectedIds?: Set<string>; // PERF: Cache of connected entity IDs for hubs
    baseScale?: number; // Base scale from reserves (before pulse animation)
  }

  interface FrameActivity {
    activeEntities: Set<string>;
    incomingFlows: Map<string, string[]>; // entityId -> source entity IDs
    outgoingFlows: Map<string, string[]>; // entityId -> destination entity IDs
  }

  interface ConnectionData {
    from: string;
    to: string;
    line: THREE.Line;
    progressBars?: THREE.Group | undefined;
  }

  interface DerivedAccountData {
    delta: number;
    totalCapacity: number;
    ownCreditLimit: number;
    peerCreditLimit: number;
    inCapacity: number;
    outCapacity: number;
    collateral: number;
    // 7-region visualization fields
    outOwnCredit: number;      // our unused credit
    inCollateral: number;      // our collateral
    outPeerCredit: number;     // their used credit
    inOwnCredit: number;       // our used credit
    outCollateral: number;     // their collateral
    inPeerCredit: number;      // their unused credit
  }

  interface BirdViewSettings {
    barsMode: 'close' | 'spread';
    selectedTokenId: number;
    viewMode: '2d' | '3d';
    entityMode: 'sphere' | 'identicon';
    wasLastOpened: boolean;
    rotationX: number; // 0-10000 (0 = stopped, 10000 = fast rotation around X-axis)
    rotationY: number; // 0-10000 (0 = stopped, 10000 = fast rotation around Y-axis)
    rotationZ: number; // 0-10000 (0 = stopped, 10000 = fast rotation around Z-axis)
    camera?: {
      position: {x: number, y: number, z: number};
      target: {x: number, y: number, z: number};
      zoom: number;
    } | undefined;
  }

  let container: HTMLDivElement;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let renderer: THREE.WebGLRenderer;
  let controls: any;
  let raycaster: THREE.Raycaster;
  let mouse: THREE.Vector2;

  // Network3D managers
  let entityManager: EntityManager;
  let activityVisualizer: AccountActivityVisualizer;

  // Visual effects system
let spatialHash: SpatialHash;
let gestureManager: GestureManager;
let vrHammer: VRHammer | null = null;
  let entityMeshMap = new Map<string, THREE.Object3D | undefined>();
  let lastJEventId: string | null = null;

  // J-Machines (one per xlnomy) - broadcast visualization
  let jMachines: Map<string, THREE.Group> = new Map(); // xlnomy name → J-Machine mesh

  // Active J-Machine (for backward compatibility with broadcast functions)
  $: jMachine = env?.activeXlnomy ? jMachines.get(env.activeXlnomy) || null : null;

  let jMachineTxBoxes: THREE.Mesh[] = []; // Yellow tx cubes inside octahedron
  let jMachineCapacity = 3; // Max txs before broadcast (lowered to show O(n) problem)
  let broadcastEnabled = true;
  let broadcastStyle: 'raycast' | 'wave' | 'particles' = 'raycast';
  let broadcastAnimations: THREE.Object3D[] = []; // Active broadcast visuals

  // Network data with proper typing (legacy - will migrate to managers)
  let entities: EntityData[] = [];
  let connections: ConnectionData[] = [];

  // Transaction particles with directional metadata
  let particles: Array<{
    mesh: THREE.Mesh;
    connectionIndex: number;
    progress: number;
    speed: number;
    type: string;
    amount?: bigint;
    direction?: 'incoming' | 'outgoing';
  }> = [];

  // Frame activity tracking
  let currentFrameActivity: FrameActivity = {
    activeEntities: new Set(),
    incomingFlows: new Map(),
    outgoingFlows: new Map()
  };

  // Connection index map for O(1) lookups
  let connectionIndexMap: Map<string, number> = new Map();

  // Animation frame and hover state
  let animationId: number | null;
  let clock = new THREE.Clock();
  let hoveredObject: any = null;
  let tooltip = { visible: false, x: 0, y: 0, content: '' };

  // Dual tooltip for connections (showing both perspectives)
  let dualTooltip = {
    visible: false,
    x: 0,
    y: 0,
    leftContent: '',
    rightContent: '',
    leftEntity: '',
    rightEntity: ''
  };

  // Drag state
  let draggedEntity: EntityData | null = null;
  let dragPlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // Plane for 3D dragging
  let dragOffset: THREE.Vector3 = new THREE.Vector3();
  let isDragging: boolean = false;
  let justDragged: boolean = false; // Flag to prevent click after drag

  /**
   * ============================================================
   * FUNCTION INDEX - NetworkTopology.svelte (5842 lines)
   * ============================================================
   *
   * Use this index for efficient editing with offset reads:
   * 1. Find function in index → note line range
   * 2. Read file offset=START limit=LENGTH
   * 3. Edit only that section
   *
   * Saves ~55k tokens per edit (read 100 lines instead of 5842)
   *
   * SETTINGS & PERSISTENCE (164-270)
   *   loadBirdViewSettings       164-210
   *   saveBirdViewSettings       212-229
   *   saveEntityPositions        231-247
   *   getTokenSymbol             267-270
   *
   * UTILITY FUNCTIONS (396-399, 2926-2995, 3602-3667)
   *   logActivity                396-399
   *   updateAvailableTokens      2926-2961
   *   getEntitySizeForToken      2963-2995
   *   getEntityBalanceInfo       3602-3630
   *   formatFinancialAmount      3636-3654
   *   getEntityShortName         3659-3667
   *   getDualConnectionAccountInfo 3673-3766
   *
   * VR CONTROLLERS (681-748, 840-865)
   *   setupVRControllers         681-710
   *   onVRSelectStart            715-740
   *   onVRSelectEnd              742-748
   *   handleJEventRipple         840-865
   *
   * NETWORK DATA & LAYOUT (867-1218)
   *   updateNetworkData          867-1005   (138 lines - COMPLEX)
   *   clearNetwork               1007-1032
   *   applyForceDirectedLayout   1043-1182  (139 lines - COMPLEX)
   *   applySimpleRadialLayout    1187-1218
   *
   * ENTITY & CONNECTION RENDERING (1220-1616)
   *   createEntityNode           1220-1314  (94 lines)
   *   createConnections          1316-1369
   *   buildConnectionIndexMap    1371-1379
   *   createTransactionParticles 1381-1466  (85 lines)
   *   createDirectionalLightning 1468-1518
   *   createBroadcastRipple      1520-1576
   *   updateConnectionsForEntity 1583-1616
   *
   * ACCOUNT BARS - RCPAN VISUALIZATION (1618-1861)
   *   createConnectionLine       1618-1650
   *   createAccountBarsForConnection 1652-1733  (81 lines)
   *   getAccountTokenDelta       1739-1745
   *   deriveEntry                1747-1781
   *   createEntityLabel          1790-1830
   *   updateEntityLabels         1832-1861
   *
   * ANIMATION LOOP & EFFECTS (1863-2333)
   *   animate                    1863-2093  (230 lines - CORE LOOP)
   *   applyCollisionRepulsion    2099-2174  (75 lines)
   *   animateParticles           2176-2227
   *   animateEntityPulses        2229-2326  (97 lines)
   *   triggerEntityActivity      2328-2333
   *
   * COLLISION & PHYSICS (2336-2444)
   *   enforceSpacingConstraints  2336-2444  (108 lines)
   *
   * MOUSE INTERACTION (2446-2755)
   *   onMouseDown                2446-2495
   *   onMouseUp                  2497-2529
   *   onMouseMove                2531-2651  (120 lines)
   *   onMouseOut                 2653-2666
   *   onMouseClick               2668-2705
   *   onMouseDoubleClick         2707-2738
   *   handleResizeStart          2741-2744
   *   handleResizeMove           2746-2751
   *   handleResizeEnd            2753-2755
   *
   * TOUCH INTERACTION (2758-2849)
   *   onTouchStart               2758-2801
   *   onTouchMove                2803-2821
   *   onTouchEnd                 2823-2849
   *
   * ROUTE MANAGEMENT (2851-3068)
   *   highlightRoutePath         2851-2876
   *   clearRouteHighlight        2878-2887
   *   update3DMode               2905-2924
   *   calculateAvailableRoutes   3002-3068
   *
   * PAYMENT JOBS & EFFECTS (3250-3335)
   *   cancelJob                  3250-3256
   *   createRipple               3258-3288
   *   updateRipples              3290-3313
   *   detectJurisdictionalEvents 3315-3335
   *
   * ASCII SCENARIO GENERATION (3439-3566)
   *   generateSliceURL           3439-3481
   *   generateASCIIScenario      3483-3566  (83 lines)
   *
   * WINDOW EVENTS (3768-3774)
   *   onWindowResize             3768-3774
   *
   * TEMPLATE SECTION (3777-4380) - 604 lines HTML
   * STYLE SECTION (4381-5842) - 1461 lines CSS
   * ============================================================
   * EDITING WORKFLOW:
   * ============================================================
   * Example: Edit applyForceDirectedLayout function
   *
   * Step 1: Find function in index above
   *   → Lines 1043-1182 (140 lines)
   *
   * Step 2: Read only that section
   *   Read file offset=1043 limit=140
   *
   * Step 3: Edit with exact old_string match
   *   Edit old_string="function applyForceDirectedLayout(...entire function...)"
   *
   * Saves: Read 140 lines instead of 5842 (97% reduction)
   * ============================================================
   */

  // Load saved bird view settings (including camera state)
  function loadBirdViewSettings(): BirdViewSettings {
    try {
      const saved = localStorage.getItem('xln-bird-view-settings');
      const parsed = saved ? JSON.parse(saved) : {
        barsMode: 'spread',
        selectedTokenId: 1, // Default to USDC
        viewMode: '3d',
        entityMode: 'sphere',
        wasLastOpened: false,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
        camera: undefined
      };
      // FINTECH-SAFETY: Ensure selectedTokenId is number, not string
      if (typeof parsed.selectedTokenId === 'string') {
        parsed.selectedTokenId = Number(parsed.selectedTokenId);
      }
      // Backward compatibility: convert old rotationSpeed to rotationY
      if (parsed.rotationSpeed !== undefined) {
        parsed.rotationY = parsed.rotationSpeed;
        delete parsed.rotationSpeed;
      }
      // Backward compatibility: convert old autoRotate boolean to rotationY
      if (parsed.autoRotate !== undefined && parsed.rotationY === undefined) {
        parsed.rotationY = parsed.autoRotate ? 3000 : 0;
        delete parsed.autoRotate;
      }
      // Provide defaults for new fields if missing
      if (parsed.rotationX === undefined) parsed.rotationX = 0;
      if (parsed.rotationY === undefined) parsed.rotationY = 0;
      if (parsed.rotationZ === undefined) parsed.rotationZ = 0;
      return parsed;
    } catch {
      return {
        barsMode: 'spread',
        selectedTokenId: 1, // Default to USDC
        viewMode: '3d',
        entityMode: 'sphere',
        wasLastOpened: false,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
        camera: undefined
      };
    }
  }

  function saveBirdViewSettings(wasOpened: boolean = true) {
    const settings: BirdViewSettings = {
      barsMode,
      selectedTokenId,
      viewMode,
      entityMode,
      wasLastOpened: wasOpened,
      rotationX,
      rotationY,
      rotationZ,
      camera: camera && controls ? {
        position: {x: camera.position.x, y: camera.position.y, z: camera.position.z},
        target: {x: controls.target.x, y: controls.target.y, z: controls.target.z},
        zoom: camera.zoom
      } : undefined
    };
    localStorage.setItem('xln-bird-view-settings', JSON.stringify(settings));
  }

  function saveEntityPositions() {
    try {
      const data: Record<string, {x: number, y: number, z: number}> = {};

      entities.forEach(entity => {
        data[entity.id] = {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z
        };
      });

      localStorage.setItem('xln-entity-positions', JSON.stringify(data));
    } catch (err) {
      debug.warn('Failed to save entity positions:', err);
    }
  }

  // Topology control state with persistence
  const savedSettings = loadBirdViewSettings();
  let barsMode: 'close' | 'spread' = savedSettings.barsMode;
  let selectedTokenId = savedSettings.selectedTokenId;
  let viewMode: '2d' | '3d' = savedSettings.viewMode;
  let entityMode: 'sphere' | 'identicon' = savedSettings.entityMode;
  let rotationX: number = savedSettings.rotationX; // 0-10000 (0 = stopped, 10000 = fast)
  let rotationY: number = savedSettings.rotationY; // 0-10000 (0 = stopped, 10000 = fast)
  let rotationZ: number = savedSettings.rotationZ; // 0-10000 (0 = stopped, 10000 = fast)
  let availableTokens: number[] = []; // Will be populated from actual token data
  let showPanel: boolean = true; // Mobile-friendly panel toggle - start visible
  // Settings (managed by SettingsPanel, updated via panelBridge)
  // Settings (managed by SettingsPanel, updated via panelBridge)
  let rendererMode: RendererMode = 'webgl';
  let labelScale: number = 2.0;
  let lightningSpeed: number = 100;
  let forceLayoutEnabled: boolean = true;
  let gridSize: number = 300;
  let gridDivisions: number = 60;
  let gridOpacity: number = 0.4;
  let gridColor: string = '#00ff41';
  let cameraDistance: number = 500;
  let cameraTarget: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  let gridHelper: THREE.GridHelper | null = null;
  let resizeDebounceTimer: number | null = null;

  // Helper to get token symbol using xlnFunctions
  function getTokenSymbol(tokenId: number): string {
    const tokenInfo = XLN?.getTokenInfo?.(tokenId);
    return tokenInfo?.symbol || `TKN${tokenId}`;
  }

  // Quick payment form state
  let paymentFrom: string = '';
  let paymentTo: string = '';
  let paymentAmount: string = '200000';
  let paymentTPS: number = 0; // 0-100 TPS (0 = once, 0.1 = every 10s, 100 = max)

  // Auto-select entities when entities list changes
  $: if (entities.length >= 2 && !paymentFrom && !paymentTo) {
    const firstEntity = entities[0];
    const secondEntity = entities[1];
    if (firstEntity && secondEntity) {
      paymentFrom = firstEntity.id;
      paymentTo = secondEntity.id;
    }
  }

  // Calculate routes whenever from/to changes
  $: if (paymentFrom && paymentTo && paymentFrom !== paymentTo) {
    calculateAvailableRoutes(paymentFrom, paymentTo);
  } else {
    availableRoutes = [];
    selectedRouteIndex = 0;
  }

  // Highlight selected route path
  $: if (availableRoutes.length > 0 && selectedRouteIndex >= 0) {
    highlightRoutePath(availableRoutes[selectedRouteIndex]);
  } else {
    clearRouteHighlight();
  }

  // Update 3D scene background when theme changes
  $: if (scene && settings.theme) {
    const themeColors = getThemeColors(settings.theme);
    scene.background = new THREE.Color(themeColors.background);
  }

  // Active payment jobs
  interface PaymentJob {
    id: string;
    from: string;
    to: string;
    amount: string;
    tps: number;
    sentCount: number;
    startedAt: number;
    intervalId?: number;
  }

  // Scenario state
  let selectedScenarioFile: string = '';
  let isLoadingScenario: boolean = false;
  let scenarioSteps: Array<{timestamp: number; title: string; description: string; actions: any[]}> = [];
  let activeJobs: PaymentJob[] = [];

  // Auto-load and parse scenario when selected
  $: if (selectedScenarioFile) {
    loadScenarioSteps(selectedScenarioFile);
  }

  // ===== WATCH FOR J-EVENTS (auto-ripple on settlements) =====
  $: if (env?.lastJEvent) {
    handleJEventRipple(env.lastJEvent);
  }

  // ===== CREATE J-MACHINES FOR EACH XLNOMY =====
  // CRITICAL: Always read from $isolatedEnv (live state), not time-travel env
  // Xlnomies Map exists on live state only, not on individual historical frames
  $: if ($isolatedEnv?.xlnomies && scene) {
    // Remove J-Machines that no longer exist
    const currentXlnomies = new Set($isolatedEnv.xlnomies.keys());
    for (const [name, mesh] of jMachines.entries()) {
      if (!currentXlnomies.has(name)) {
        scene.remove(mesh);
        jMachines.delete(name);
        console.log(`[Graph3D] Removed J-Machine: ${name}`);
      }
    }

    // Create new J-Machines
    $isolatedEnv.xlnomies.forEach((xlnomy: any, name: string) => {
      if (!jMachines.has(name)) {
        console.log(`[Graph3D] Creating J-Machine for xlnomy: ${name} at position`, xlnomy.jMachine.position);
        const jMachine = createJMachine(25, xlnomy.jMachine.position, name);
        scene.add(jMachine);
        jMachines.set(name, jMachine);
        console.log(`[Graph3D] ✅ J-Machine created, scene now has ${scene.children.length} objects`);
      }
    });
  }

  // ===== PROCESS ACCOUNT ACTIVITY LIGHTNING (on new frame) =====
  $: if (activityVisualizer && env?.runtimeInput && entityMeshMap) {
    activityVisualizer.processFrame(env.runtimeInput, entityMeshMap);
  }

  // ===== ADD TXS TO J-MACHINE (broadcast simulation) + R2R ANIMATION =====
  $: if (jMachine && env?.runtimeInput?.entityInputs) {
    // For each entity input, check for reserve-to-reserve transactions
    env.runtimeInput.entityInputs.forEach((entityInput: any) => {
      const txs = entityInput?.input?.txs || [];
      txs.forEach((tx: any) => {
        // Check if it's a reserve-related transaction (R2R)
        if (tx.kind === 'payFromReserve' || tx.kind === 'payToReserve' || tx.kind === 'settleToReserve') {
          console.log(`[J-Machine] Adding tx ${tx.kind} from ${entityInput.entityId?.slice(0, 8)}...`);

          // Shoot ray from entity → J-Machine (incoming tx)
          shootRayToJMachine(entityInput.entityId);

          addTxToJMachine(entityInput.entityId);

          // R2R animation: particle flies from source to target
          if (tx.kind === 'payFromReserve' && tx.targetEntityId) {
            animateR2RTransfer(entityInput.entityId, tx.targetEntityId, tx.amount);
          }
        }
      });
    });
  }

  // ===== UPDATE SPATIAL HASH (when entities move) =====
  $: if (spatialHash && entities.length > 0) {
    entities.forEach(entity => {
      spatialHash.update(entity.id, entity.position);
      entityMeshMap.set(entity.id, entity.mesh);
    });
  }

  async function loadScenarioSteps(filename: string) {
    try {
      const response = await fetch(`/worlds/${filename}`);
      if (!response.ok) return;

      const text = await response.text();
      const parsed: typeof scenarioSteps = [];
      const sections = text.split('===').filter(s => s.trim());

      for (const section of sections) {
        const lines = section.trim().split('\n');
        let timestamp = 0;
        let title = '';
        let description = '';
        const actions: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('t=')) timestamp = parseInt(trimmed.slice(2));
          else if (trimmed.startsWith('title:')) title = trimmed.slice(6).trim();
          else if (trimmed.startsWith('description:')) description = trimmed.slice(12).trim();
          else if (trimmed && !trimmed.startsWith('#') && !trimmed.match(/^[A-Z]/)) {
            actions.push(trimmed);
          }
        }

        if (title) {
          parsed.push({ timestamp, title, description, actions });
        }
      }

      scenarioSteps = parsed;
      console.log(`📜 Loaded ${parsed.length} scenario steps`);
    } catch (error) {
      console.error('Failed to load scenario steps:', error);
      scenarioSteps = [];
    }
  }

  // Live command builder state
  let commandAction: string = '';
  let commandText: string = 'payRandom count=10 amount=100000 minHops=2 maxHops=4';

  // Live activity log
  let activityLog: string[] = [];

  function logActivity(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    activityLog = [...activityLog.slice(-100), `[${timestamp}] ${message}`];
  }

  // Performance metrics
  let perfMetrics = {
    fps: 0,
    renderTime: 0,
    entityCount: 0,
    connectionCount: 0,
    lastFrameTime: 0,
    avgFrameTime: 0,
  };
  let frameTimeSamples: number[] = [];
  let lastPerfUpdate = 0;

  // Track logged entities to only log ONCE on first draw
  let loggedGridPositions = new Set<string>();

  // PERF: Cache entity sizes to avoid O(n²) reactive store lookups
  let entitySizeCache = new Map<string, number>();

  // Slice & export state
  let sliceStart: number = 0;
  let sliceEnd: number = 0;
  let exportUrl: string = '';

  // ASCII formation tool state
  let asciiText: string = '';
  let asciiScale: number = 100;
  let asciiScenario: string = '';

  // VR state
  let isVRSupported: boolean = false;
  let isVRActive: boolean = false;
  let passthroughEnabled: boolean = false;

  // Visual effects toggles
  let lightningEnabled: boolean = false; // Disabled by default (performance)

  // Ripple effects for balance changes
  interface Ripple {
    mesh: THREE.Mesh;
    startTime: number;
    duration: number;
    maxRadius: number;
  }
  let activeRipples: Ripple[] = [];

  // Payment route selection state
  let availableRoutes: Array<{
    from: string;
    to: string;
    path: string[];
    type: 'direct' | 'multihop';
    description: string;
    cost: number;
    hops: number;
  }> = [];
  let selectedRouteIndex: number = 0;

  // Real-time activity ticker
  let recentActivity: Array<{
    id: string;
    message: string;
    timestamp: number;
    type: 'payment' | 'credit' | 'settlement' | 'j-event' | 'commit';
  }> = [];

  onMount(() => {
    const initAndSetup = async () => {
      // Load XLN runtime functions
      try {
        const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
        XLN = await import(/* @vite-ignore */ runtimeUrl);
        console.log('[Graph3D] XLN runtime loaded');
      } catch (err) {
        console.error('[Graph3D] Failed to load XLN runtime:', err);
      }

      // Check VR support (WebXR API for Quest 3/Oculus)
      // CRITICAL: Must check BOTH xr existence AND isSessionSupported
      // WebXR requires HTTPS in production (works on localhost HTTP for dev)
      if ('xr' in navigator && (navigator as any).xr) {
        try {
          // Oculus Quest browsers support 'immersive-vr'
          const vrSupported = await (navigator as any).xr.isSessionSupported('immersive-vr');
          isVRSupported = vrSupported === true;
          console.log('🥽 WebXR Detection:', {
            hasNavigatorXR: true,
            isSessionSupported: isVRSupported,
            isSecureContext: window.isSecureContext,
            protocol: window.location.protocol,
            userAgent: navigator.userAgent.slice(0, 100)
          });

          if (!isVRSupported && !window.isSecureContext) {
            console.warn('⚠️ WebXR requires HTTPS in production. Use self-signed cert or ngrok for testing.');
          }
        } catch (err) {
          console.log('🥽 VR Support check failed:', err);
          isVRSupported = false;
        }
      } else {
        console.log('🥽 WebXR not available:', {
          hasNavigatorXR: 'xr' in navigator,
          navigatorXRValue: (navigator as any).xr,
          isSecureContext: window.isSecureContext
        });
        isVRSupported = false;
      }

      await initThreeJS();
      // updateNetworkData() is called automatically by reactive statement: $: if ($isolatedEnv && scene)
      animate();
    };

    initAndSetup().catch(error => {
      throw new Error(`FINTECH-SAFETY: Failed to initialize 3D topology: ${error.message}`);
    });

    // Listen for VR toggle events from ArchitectPanel
    const handleVRToggle = () => {
      if (isVRActive) {
        exitVR();
      } else {
        enterVR();
      }
    };
    panelBridge.on('vr:toggle', handleVRToggle);

    // Broadcast controls from Architect panel
    const handleBroadcastToggle = (event: any) => {
      broadcastEnabled = event.enabled;
      console.log('[Broadcast] Enabled:', broadcastEnabled);
    };
    const handleBroadcastStyle = (event: any) => {
      broadcastStyle = event.style;
      console.log('[Broadcast] Style changed to:', broadcastStyle);
    };
    panelBridge.on('broadcast:toggle', handleBroadcastToggle);
    panelBridge.on('broadcast:style', handleBroadcastStyle);

    // Settings updates from SettingsPanel
    const handleSettingsUpdate = (event: any) => {
      const { key, value } = event;
      console.log(`[Graph3D] Settings update: ${key} =`, value);

      if (key === 'gridSize') gridSize = value;
      else if (key === 'gridDivisions') gridDivisions = value;
      else if (key === 'gridOpacity') gridOpacity = value;
      else if (key === 'gridColor') gridColor = value;
      else if (key === 'cameraDistance') cameraDistance = value;
      else if (key === 'cameraTarget') {
        cameraTarget = value;
        if (controls) {
          controls.target.set(value.x, value.y, value.z);
          controls.update();
        }
      }
      else if (key === 'entityLabelScale') labelScale = value;
      else if (key === 'lightningSpeed') lightningSpeed = value;
      else if (key === 'rendererMode') rendererMode = value;
      else if (key === 'forceLayoutEnabled') forceLayoutEnabled = value;

      // Recreate scene for grid changes
      if (['gridSize', 'gridDivisions', 'gridOpacity', 'gridColor'].includes(key)) {
        recreateGrid();
      }
    };

    const handleSettingsReset = () => {
      console.log('[Graph3D] Resetting to default settings');
      gridSize = 300;
      gridDivisions = 60;
      gridOpacity = 0.4;
      gridColor = '#00ff41';
      cameraDistance = 500;
      cameraTarget = { x: 0, y: 0, z: 0 };
      labelScale = 2.0;
      lightningSpeed = 100;
      rendererMode = 'webgl';
      forceLayoutEnabled = true;

      if (controls) {
        controls.target.set(0, 0, 0);
        controls.update();
      }
      recreateGrid();
    };

    const handleCameraFocus = (event: any) => {
      const { target } = event;
      if (controls) {
        cameraTarget = target;
        controls.target.set(target.x, target.y, target.z);
        controls.update();
        console.log('[Graph3D] Camera focused on:', target);
      }
    };

    panelBridge.on('settings:update', handleSettingsUpdate);
    panelBridge.on('settings:reset', handleSettingsReset);
    panelBridge.on('camera:focus', handleCameraFocus);

    const unsubscribe1 = isolatedEnv.subscribe(updateNetworkData);
    return () => {
      unsubscribe1();
      panelBridge.off('vr:toggle', handleVRToggle);
      panelBridge.off('broadcast:toggle', handleBroadcastToggle);
      panelBridge.off('broadcast:style', handleBroadcastStyle);
      panelBridge.off('settings:update', handleSettingsUpdate);
      panelBridge.off('settings:reset', handleSettingsReset);
      panelBridge.off('camera:focus', handleCameraFocus);
    };
  });

  // Reactive update when isolated env changes
  // PERF FIX: Only update when replica count changes (not on every state mutation)
  let lastReplicaCount = 0;
  $: if ($isolatedEnv && scene) {
    const currentCount = $isolatedEnv.replicas?.size || 0;
    if (currentCount !== lastReplicaCount) {
      lastReplicaCount = currentCount;
      updateNetworkData();
    }
  }

  let resizeObserver: ResizeObserver | null = null;

  onDestroy(() => {
    // Cleanup resize observer
    if (resizeObserver && container) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null as any;
    }
    if (renderer) {
      renderer.dispose();
      renderer = null as any;
    }
    if (scene) {
      scene = null as any;
    }
    if (camera) {
      camera = null as any;
    }
    if (controls) {
      if (typeof controls.dispose === 'function') {
        controls.dispose();
      }
      controls = null;
    }

    // Clean up visual effects
    if (gestureManager) {
      gestureManager.clear();
    }
    if (spatialHash) {
      spatialHash.clear();
    }
    effectOperations.clear();
    entityMeshMap.clear();

    // Clean up managers
    if (entityManager) {
      entityManager.clear();
    }
    if (activityVisualizer) {
      activityVisualizer.clearAll();
    }
  });

  /**
   * Create grid floor centered at origin (large enough to never clip)
   */
  function createGrid() {
    if (!scene) return;

    // Fixed large grid (±1000px) to prevent clipping on zoom
    const fixedSize = 2000; // Diameter = 2000, radius = 1000
    const divisions = 200; // 10px per division

    gridHelper = new THREE.GridHelper(fixedSize, divisions,
      gridColor,  // Center line
      gridColor   // Grid lines (same color, controlled by opacity)
    );
    gridHelper.material.opacity = gridOpacity;
    gridHelper.material.transparent = true;
    gridHelper.position.set(0, -50, 0); // Centered at origin, below entities
    scene.add(gridHelper);

    console.log(`[Graph3D] Grid created: ±1000px, ${divisions} divisions, opacity ${gridOpacity}`);
  }

  /**
   * Recreate grid when settings change (RAF scheduled to prevent blinking)
   */
  function recreateGrid() {
    requestAnimationFrame(() => {
      if (!scene || !gridHelper) return;

      // Remove old grid
      scene.remove(gridHelper);
      gridHelper.geometry.dispose();
      (gridHelper.material as THREE.Material).dispose();

      // Create new grid with updated settings
      createGrid();
    });
  }

  /**
   * Create J-Machine octahedron at (0, 100, 0) - elevated above entity grid (L1 layer)
   * Visual: EVM/Ethereum-style diamond with purple/blue gradient, vertically stretched 1.6x
   */
  function createJMachine(
    size: number = 25,
    position: { x: number; y: number; z: number } = { x: 0, y: 100, z: 0 },
    name: string = 'J-MACHINE'
  ): THREE.Group {
    const group = new THREE.Group();
    group.position.set(position.x, position.y, position.z); // Position from xlnomy config

    // Store xlnomy name for click handling
    group.userData = {
      type: 'jMachine',
      xlnomyName: name,
      position
    };

    // Octahedron geometry (8 faces) - Ethereum diamond shape
    const octahedronGeometry = new THREE.OctahedronGeometry(size, 0);

    // EVM-style purple/blue gradient material
    const octahedronMaterial = new THREE.MeshPhongMaterial({
      color: 0x8b7fb8, // Ethereum purple
      emissive: 0x6a5a8b, // Brighter purple glow
      transparent: true,
      opacity: 0.8, // More visible (was 0.4)
      wireframe: false,
      side: THREE.DoubleSide,
      shininess: 100
    });

    const octahedron = new THREE.Mesh(octahedronGeometry, octahedronMaterial);
    // Vertically stretch to match Ethereum logo proportions (diamond is taller than wide)
    octahedron.scale.set(1, 1.6, 1);
    group.add(octahedron);

    // Wireframe edges for Ethereum diamond aesthetic
    const edgesGeometry = new THREE.EdgesGeometry(octahedronGeometry);
    const edgesMaterial = new THREE.LineBasicMaterial({
      color: 0xb8a4d9, // Lighter purple for edges
      linewidth: 3
    });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    group.add(edges);

    // Inner glow effect (smaller octahedron)
    const innerGeometry = new THREE.OctahedronGeometry(size * 0.7, 0);
    const innerMaterial = new THREE.MeshBasicMaterial({
      color: 0x9a8ac4, // Brighter purple
      transparent: true,
      opacity: 0.5, // More visible (was 0.2)
      wireframe: true
    });
    const innerGlow = new THREE.Mesh(innerGeometry, innerMaterial);
    innerGlow.scale.set(1, 1.6, 1); // Match outer octahedron stretch
    group.add(innerGlow);

    // Add label with xlnomy name
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) {
      canvas.width = 256;
      canvas.height = 64;
      context.fillStyle = '#b8a4d9';
      context.font = 'bold 32px monospace';
      context.textAlign = 'center';
      context.fillText(name.toLowerCase(), 128, 40); // Lowercase for consistency
    }

    const texture = new THREE.CanvasTexture(canvas);
    const labelMaterial = new THREE.SpriteMaterial({ map: texture });
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(25, 6, 1);
    label.position.set(0, size * 1.6 + 15, 0); // Above vertically-stretched octahedron (accounting for 1.6x stretch)
    group.add(label);

    return group;
  }

  /**
   * Add a yellow transaction cube to J-Machine
   * Returns the mesh so we can animate it flying from entity → J-Machine
   */
  function addTxToJMachine(fromEntityId: string): THREE.Mesh | null {
    if (!jMachine || !scene) return null;

    // Create yellow cube (transaction)
    const txGeometry = new THREE.BoxGeometry(2, 2, 2);
    const txMaterial = new THREE.MeshPhongMaterial({
      color: 0xffff00, // Yellow
      emissive: 0x888800,
      transparent: true,
      opacity: 0.9
    });
    const txCube = new THREE.Mesh(txGeometry, txMaterial);

    // Position randomly inside octahedron (sphere packing)
    const radius = 8; // Inside the 15-unit octahedron
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    txCube.position.set(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi)
    );

    jMachine.add(txCube);
    jMachineTxBoxes.push(txCube);

    // Check capacity - broadcast when full
    if (jMachineTxBoxes.length >= jMachineCapacity) {
      triggerBroadcast();
    }

    return txCube;
  }

  /**
   * Shoot green ray from entity → J-Machine (incoming transaction)
   * Fast, bright green beam showing value flowing into L1
   */
  function shootRayToJMachine(entityId: string) {
    if (!jMachine || !scene) return;

    // Find entity position
    const entity = entities.find(e => e.id === entityId);
    if (!entity) return;

    // Create green ray from entity → J-Machine
    const points = [
      entity.position.clone(),
      new THREE.Vector3(0, 100, 0) // J-Machine center (elevated L1 layer)
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x00ff88, // Bright green (incoming money)
      linewidth: 3,
      transparent: true,
      opacity: 1.0
    });
    const ray = new THREE.Line(geometry, material);
    scene.add(ray);

    // Quick fade out (300ms - fast transaction submission)
    const fadeStart = Date.now();
    const fadeInterval = setInterval(() => {
      const elapsed = Date.now() - fadeStart;
      const progress = elapsed / 300;

      if (progress >= 1) {
        scene.remove(ray);
        clearInterval(fadeInterval);
      } else {
        material.opacity = 1.0 - progress;
      }
    }, 16); // 60fps
  }

  /**
   * Trigger broadcast animation when J-Machine is full
   * Clears txs and sends rays/waves to all entities
   */
  function triggerBroadcast() {
    if (!broadcastEnabled || !jMachine || !scene) return;

    console.log(`[Broadcast] J-Machine full, broadcasting (${broadcastStyle}) to ${entities.length} entities...`);

    // Clear all tx cubes
    jMachineTxBoxes.forEach(txCube => {
      if (jMachine) jMachine.remove(txCube);
    });
    jMachineTxBoxes = [];

    // Trigger broadcast animation based on style
    if (broadcastStyle === 'raycast') {
      broadcastRaycast();
    } else if (broadcastStyle === 'wave') {
      broadcastWave();
    } else if (broadcastStyle === 'particles') {
      broadcastParticles();
    }
  }

  /**
   * Ray-cast broadcast: Thick bright rays shoot from J-Machine to all entities (O(n) distribution)
   * VC-MODE: Dramatic visualization showing J-Machine broadcasting to entire network
   */
  function broadcastRaycast() {
    if (!jMachine || !scene) return;

    console.log(`[Broadcast] Shooting rays to ${entities.length} entities (O(n) broadcast)...`);

    entities.forEach((entity, i) => {
      // Create thick bright ray from J-Machine → entity
      const points = [
        new THREE.Vector3(0, 100, 0), // J-Machine center (elevated L1 layer)
        entity.position.clone()
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: 0xff00ff, // Bright magenta (broadcast = expensive O(n))
        linewidth: 5, // Thicker for VC visibility
        transparent: true,
        opacity: 1.0
      });
      const line = new THREE.Line(geometry, material);
      scene.add(line);
      broadcastAnimations.push(line);

      // Slow fade out (1500ms) to emphasize O(n) cost
      const fadeStart = Date.now();
      const fadeInterval = setInterval(() => {
        const elapsed = Date.now() - fadeStart;
        const progress = elapsed / 1500;

        if (progress >= 1) {
          scene.remove(line);
          broadcastAnimations = broadcastAnimations.filter(a => a !== line);
          clearInterval(fadeInterval);
        } else {
          material.opacity = 1.0 - progress;
        }
      }, 16); // 60fps
    });
  }

  /**
   * Wave broadcast: Expanding sphere from J-Machine
   */
  function broadcastWave() {
    if (!jMachine || !scene) return;

    const sphereGeometry = new THREE.SphereGeometry(1, 16, 16);
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0xb8a4d9, // Purple to match EVM theme
      transparent: true,
      opacity: 0.3,
      wireframe: true
    });
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere.position.set(0, 100, 0); // Elevated J-Machine L1 layer position
    scene.add(sphere);
    broadcastAnimations.push(sphere);

    // Animate expansion
    let startTime = Date.now();
    const animateWave = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / 2000, 1);

      const scale = 1 + progress * 100;
      sphere.scale.set(scale, scale, scale);
      sphereMaterial.opacity = 0.3 * (1 - progress);

      if (progress < 1) {
        requestAnimationFrame(animateWave);
      } else {
        scene.remove(sphere);
        broadcastAnimations = broadcastAnimations.filter(a => a !== sphere);
      }
    };
    animateWave();
  }

  /**
   * Particle broadcast: Particles fly from J-Machine to each entity
   */
  function broadcastParticles() {
    if (!jMachine || !scene) return;

    entities.forEach((entity) => {
      // Create particle (small sphere)
      const particleGeometry = new THREE.SphereGeometry(0.5, 8, 8);
      const particleMaterial = new THREE.MeshBasicMaterial({
        color: 0xb8a4d9, // Purple to match EVM theme
        transparent: true,
        opacity: 0.8
      });
      const particle = new THREE.Mesh(particleGeometry, particleMaterial);
      particle.position.set(0, 100, 0); // Start at elevated J-Machine L1 layer
      scene.add(particle);
      broadcastAnimations.push(particle);

      // Animate flight to entity
      const startTime = Date.now();
      const duration = 1500;
      const jMachinePos = new THREE.Vector3(0, 100, 0);
      const animateParticle = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Lerp from (0, 100, 0) to entity position
        particle.position.lerpVectors(jMachinePos, entity.position, progress);

        if (progress < 1) {
          requestAnimationFrame(animateParticle);
        } else {
          scene.remove(particle);
          broadcastAnimations = broadcastAnimations.filter(a => a !== particle);
        }
      };
      animateParticle();
    });
  }

  /**
   * Animate R2R transfer: particle flies from source to target entity
   */
  function animateR2RTransfer(fromEntityId: string, toEntityId: string, amount: bigint) {
    if (!scene) return;

    // Find source and target entities
    const fromEntity = entities.find(e => e.id === fromEntityId);
    const toEntity = entities.find(e => e.id === toEntityId);

    if (!fromEntity || !toEntity) {
      console.warn(`[R2R Animation] Entities not found: ${fromEntityId.slice(0,8)} → ${toEntityId.slice(0,8)}`);
      return;
    }

    // Create gold particle (represents reserves moving)
    const particleGeometry = new THREE.SphereGeometry(0.3, 16, 16);
    const particleMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd700, // Gold
      transparent: true,
      opacity: 0.9
    });
    const particle = new THREE.Mesh(particleGeometry, particleMaterial);
    particle.position.copy(fromEntity.position);
    scene.add(particle);

    console.log(`[R2R Animation] ${fromEntityId.slice(0,8)} → ${toEntityId.slice(0,8)}: ${amount} tokens`);

    // Animate particle movement
    const startTime = Date.now();
    const duration = 1000; // 1 second flight time

    const animateParticle = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Lerp from source to target
      particle.position.lerpVectors(fromEntity.position, toEntity.position, progress);

      // Pulsing effect
      const pulse = 1 + 0.3 * Math.sin(progress * Math.PI * 4);
      particle.scale.setScalar(pulse);

      if (progress < 1) {
        requestAnimationFrame(animateParticle);
      } else {
        // Reached target - remove particle
        scene.remove(particle);
        particleGeometry.dispose();
        particleMaterial.dispose();
      }
    };
    animateParticle();
  }

  async function initThreeJS() {
    // Guard against multiple initializations
    if (renderer || scene) {
      console.warn('[Graph3D] Already initialized, skipping');
      return;
    }

    // Clear container to ensure clean slate
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    // Load OrbitControls dynamically
    try {
      const { OrbitControls: OC } = await import('three/examples/jsm/controls/OrbitControls.js');
      OrbitControls = OC;
    } catch (error) {
      debug.warn('OrbitControls not available:', error);
    }

    // Scene setup
    scene = new THREE.Scene();

    // Set background from theme
    const themeColors = getThemeColors(settings.theme);
    scene.background = new THREE.Color(themeColors.background);

    // Matrix-style 3D grid floor centered at origin (0,0,0)
    // Grid creation moved to createGrid() function for settings updates
    createGrid();

    // Camera setup - use container dimensions
    const containerWidth = container.clientWidth || window.innerWidth;
    const containerHeight = container.clientHeight || window.innerHeight;

    console.log('[Graph3D] Container dimensions:', {
      clientWidth: container.clientWidth,
      clientHeight: container.clientHeight,
      offsetWidth: container.offsetWidth,
      offsetHeight: container.offsetHeight,
      finalWidth: containerWidth,
      finalHeight: containerHeight
    });

    camera = new THREE.PerspectiveCamera(
      75,
      containerWidth / containerHeight,
      0.1,
      20000 // Far plane: large enough to see full grid at any zoom
    );
    camera.position.set(200, 0, 100); // Position camera to look at grid center (200, 0, 0)

    // Renderer setup with VR support
    renderer = await createRenderer(rendererMode, { antialias: true });
    renderer.xr.enabled = true;  // Enable XR separately
    renderer.setSize(containerWidth, containerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Debug: Expose to window for inspection
    if (typeof window !== 'undefined') {
      (window as any).__debugScene = scene;
      (window as any).__debugCamera = camera;
      (window as any).__debugRenderer = renderer;
    }

    // OrbitControls setup
    if (OrbitControls) {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.enableZoom = true;
      controls.enableRotate = true;
      controls.enablePan = true;

      // Set default target from settings (grid center)
      controls.target.set(cameraTarget.x, cameraTarget.y, cameraTarget.z);

      // Restore saved camera state if available
      if (savedSettings.camera) {
        const cam = savedSettings.camera;
        camera.position.set(cam.position.x, cam.position.y, cam.position.z);
        controls.target.set(cam.target.x, cam.target.y, cam.target.z);
        camera.zoom = cam.zoom;
        camera.updateProjectionMatrix();
        controls.update();
      } else {
        // First time: update controls to apply default target
        controls.update();
      }

      // CRITICAL: Save camera state after manual user movements (rotate/pan/zoom)
      controls.addEventListener('end', () => {
        saveBirdViewSettings();
      });
    }

    // Raycaster for mouse interaction
    raycaster = new THREE.Raycaster();
    // Increase line threshold so connections can be hovered from further away
    // Default is 1, we increase to 5 for better UX (hover activates ~5 units from line)
    raycaster.params.Line = { threshold: 5 };
    mouse = new THREE.Vector2();

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(200, 50, 50); // Position light above grid center
    scene.add(directionalLight);

    // J-Machines are now created reactively based on env.xlnomies (see reactive statement above)

    // Mouse events
    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('mouseup', onMouseUp);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseout', onMouseOut);
    renderer.domElement.addEventListener('click', onMouseClick);
    renderer.domElement.addEventListener('dblclick', onMouseDoubleClick);

    // Touch events for mobile (iPhone support)
    renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
    renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
    renderer.domElement.addEventListener('touchend', onTouchEnd);

    // Handle window AND panel resize (Dockview)
    window.addEventListener('resize', onWindowResize);

    // Watch for Dockview panel resize (debounced to prevent blinking)
    resizeObserver = new ResizeObserver(() => {
      // Debounce: Only resize after 100ms of no changes
      if (resizeDebounceTimer) {
        clearTimeout(resizeDebounceTimer);
      }
      resizeDebounceTimer = window.setTimeout(() => {
        requestAnimationFrame(() => {
          onWindowResize();
        });
      }, 50); // 50ms debounce
    });
    resizeObserver.observe(container);

    // Setup VR controllers if VR supported
    if (isVRSupported && renderer) {
      setupVRControllers();
    }

    // ===== INITIALIZE MANAGERS =====
    entityManager = new EntityManager(scene);
    activityVisualizer = new AccountActivityVisualizer(scene);
    spatialHash = new SpatialHash(100);
    gestureManager = new GestureManager();
    vrHammer = new VRHammer();

    // Register shake-to-rebalance callback
    gestureManager.on((event: { type: string; entityId: string }) => {
      if (event.type === 'shake-rebalance') {
        console.log('🤝 SHAKE REBALANCE TRIGGERED:', event.entityId);
        handleRebalanceGesture(event.entityId);
      }
    });

    console.log('✅ Network3D managers initialized');
  }

  /**
   * Setup VR controllers for Quest 3
   */
  function setupVRControllers() {
    if (!renderer || !scene) return;

    // Controller 1 (right hand) - HAMMER attached here
    const controller1 = renderer.xr.getController(0);
    controller1.addEventListener('selectstart', onVRSelectStart);
    controller1.addEventListener('selectend', onVRSelectEnd);
    scene.add(controller1);

    // Attach hammer to right controller
    if (vrHammer) {
      vrHammer.attachToController(controller1);
      vrHammer.onAccountHit((event) => {
        console.log(`⚖️ DISPUTE: ${event.fromEntityId} ↔ ${event.toEntityId}`);
        // Find and break the connection visually
        const conn = connections.find(c =>
          (c.from === event.fromEntityId && c.to === event.toEntityId) ||
          (c.from === event.toEntityId && c.to === event.fromEntityId)
        );
        if (conn) {
          // Make connection red and break visual
          const material = conn.line.material as THREE.LineDashedMaterial;
          material.color.setHex(0xff0000);
          material.opacity = 0.8;
          // Remove bars to show "broken" state
          if (conn.progressBars) {
            scene.remove(conn.progressBars);
            conn.progressBars = undefined;
          }
        }
      });
    }

    // Controller 2 (left hand)
    const controller2 = renderer.xr.getController(1);
    controller2.addEventListener('selectstart', onVRSelectStart);
    controller2.addEventListener('selectend', onVRSelectEnd);
    scene.add(controller2);

    // Add visual ray for pointing
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -5)
    ]);
    const material = new THREE.LineBasicMaterial({ color: 0x00ffff, opacity: 0.8, transparent: true });

    const ray1 = new THREE.Line(geometry, material);
    const ray2 = new THREE.Line(geometry, material.clone());

    controller1.add(ray1);
    controller2.add(ray2);

    console.log('🥽 VR Controllers initialized');
  }

  let vrGrabbedEntity: any = null;
  let vrGrabController: any = null;

  function onVRSelectStart(event: any) {
    const controller = event.target;

    // Raycast from controller
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(controller.matrixWorld);

    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const intersects = raycaster.intersectObjects(entities.map(e => e.mesh));

    if (intersects.length > 0) {
      const intersected = intersects[0]?.object;
      if (!intersected) return;
      const entity = entities.find(e => e.mesh === intersected);

      if (entity) {
        vrGrabbedEntity = entity;
        vrGrabController = controller;
        entity.isPinned = true; // Pin while dragging
        console.log('🥽 Grabbed entity:', entity.id);
      }
    }
  }

  function onVRSelectEnd() {
    if (vrGrabbedEntity) {
      console.log('🥽 Released entity:', vrGrabbedEntity.id);
      vrGrabbedEntity = null;
      vrGrabController = null;
    }
  }

  /**
   * Enter VR mode (Quest 3)
   */
  async function enterVR() {
    if (!renderer || !isVRSupported) {
      debug.error('VR not supported on this device');
      return;
    }

    try {
      const sessionInit: any = {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
      };

      // Add passthrough if enabled
      if (passthroughEnabled) {
        sessionInit.optionalFeatures.push('layers');
      }

      const session = await (navigator as any).xr.requestSession('immersive-vr', sessionInit);

      await renderer.xr.setSession(session);
      isVRActive = true;

      // Switch to VR animation loop
      renderer.setAnimationLoop(animate);

      console.log('🥽 Entered VR mode');

      // Listen for session end
      session.addEventListener('end', () => {
        isVRActive = false;
        // Return to regular animation loop
        renderer.setAnimationLoop(null);
        animate();
        console.log('🥽 Exited VR mode');
      });

    } catch (error) {
      console.error('Failed to enter VR:', error);
      debug.error('VR session failed: ' + (error as Error).message);
    }
  }

  /**
   * Exit VR mode
   */
  async function exitVR() {
    if (renderer?.xr?.getSession) {
      const session = await renderer.xr.getSession();
      if (session) {
        await session.end();
      }
    }
  }

  // ===== VISUAL EFFECTS HANDLERS =====

  /**
   * Handle shake-to-rebalance gesture
   */
  async function handleRebalanceGesture(entityId: string) {
    try {
      console.log(`🔄 Initiating automatic rebalance for entity: ${entityId}`);

      // TODO: Implement hub rebalance coordination (Phase 3 of docs/next.md)
      console.log('⚠️ Rebalance coordination not yet implemented');

      // Visual feedback ripple
      if (spatialHash) {
        const entity = entities.find(e => e.id === entityId);
        if (entity) {
          const ripple = new RippleEffect(
            `rebalance-${Date.now()}`,
            entity.position.clone(),
            500n,
            entityId,
            spatialHash
          );
          effectOperations.enqueue(ripple);
        }
      }
    } catch (error) {
      console.error('❌ Rebalance gesture failed:', error);
    }
  }

  /**
   * Handle j-event ripple effects (gas-weighted)
   */
  function handleJEventRipple(jEvent: any) {
    if (!spatialHash || !jEvent) return;

    // Deduplicate events
    const eventId = `${jEvent.type}-${jEvent.blockNumber}-${jEvent.transactionHash}`;
    if (lastJEventId === eventId) return;
    lastJEventId = eventId;

    const entity = entities.find(e => e.id === jEvent.entityId || jEvent.from === e.id);
    if (!entity) return;

    // Gas-weighted intensity
    let gasUsed = 100n;
    if (jEvent.type === 'TransferReserveToCollateral') gasUsed = 500n;
    if (jEvent.type === 'ProcessBatch') gasUsed = BigInt(Math.min((jEvent.data?.batchSize || 1) * 100, 1000));
    if (jEvent.type === 'Dispute') gasUsed = 200n;
    if (jEvent.type === 'Settlement') gasUsed = 300n;

    effectOperations.enqueue(new RippleEffect(
      `jevent-${eventId}`,
      entity.position.clone(),
      gasUsed,
      entity.id,
      spatialHash
    ));
  }

  function updateNetworkData() {
    if (!scene) return;

    const timeIndex = $isolatedTimeIndex;

    // Update available tokens
    updateAvailableTokens();

    // Use time-aware data sources (isolated env if provided, otherwise global)
    let entityData: any[] = [];
    let currentReplicas = $isolatedEnv?.replicas || new Map();

    console.log('[Graph3D] Replicas check:', {
      hasIsolatedEnv: !!isolatedEnv,
      isolatedEnvValue: $isolatedEnv,
      replicasSize: currentReplicas?.size || 0,
      source: 'isolated'
    });

    // Always use replicas (ground truth)
    if (currentReplicas && currentReplicas.size > 0) {
      const replicaEntries = Array.from(currentReplicas.entries());

      // Extract unique entity IDs from replica keys with fail-fast validation
      const uniqueEntityIds = new Set<string>();
      for (let i = 0; i < replicaEntries.length; i++) {
        const entry = replicaEntries[i];
        if (!entry || !Array.isArray(entry) || entry.length < 2) {
          throw new Error('FINTECH-SAFETY: Invalid replica entry structure');
        }

        const key = entry[0];
        if (typeof key !== 'string') {
          throw new Error('FINTECH-SAFETY: Replica key must be string');
        }

        const parts = key.split(':');
        const entityId = parts[0];
        if (!entityId) {
          throw new Error('FINTECH-SAFETY: Invalid replica key format - missing entity ID');
        }
        uniqueEntityIds.add(entityId);
      }

      entityData = Array.from(uniqueEntityIds).map(entityId => ({
        entityId,
        capabilities: ['consensus'],
        metadata: { name: entityId.slice(0, 8) + '...' }
      }));
    }

    console.log('[Graph3D] entityData created:', entityData.length, 'entities');

    // NO DEMO DATA - only show what actually exists
    if (entityData.length === 0) {
      debug.warn(`⚠️ No entity data found at frame ${timeIndex} - nothing to display`);
      clearNetwork(); // Clear stale geometry before returning
      return; // Don't create fake entities
    }


    // Build connection and capacity maps for force-directed layout (always active)
    const connectionMap = new Map<string, Set<string>>();
    const capacityMap = new Map<string, number>();

    // Build connection map from replicas
    if (currentReplicas.size > 0) {
      for (const [replicaKey, replica] of currentReplicas.entries()) {
        const [entityId] = replicaKey.split(':');
        const entityAccounts = replica.state?.accounts;

        if (entityAccounts && entityAccounts.size > 0) {
          if (!connectionMap.has(entityId)) {
            connectionMap.set(entityId, new Set());
          }

          for (const [counterpartyId, accountData] of entityAccounts.entries()) {
            connectionMap.get(entityId)?.add(counterpartyId);

            // Calculate total capacity for this connection
            const accountTokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
            if (accountTokenDelta) {
              const derived = XLN?.deriveDelta(accountTokenDelta, entityId < counterpartyId);
              if (!derived) continue;
              const capacityKey = [entityId, counterpartyId].sort().join('-');
              capacityMap.set(capacityKey, Number(derived.totalCapacity));
            }
          }
        }
      }
    }

    // Calculate connection degrees and find top-3 hubs
    const connectionDegrees = new Map<string, number>();
    entityData.forEach(profile => {
      const degree = connectionMap.get(profile.entityId)?.size || 0;
      connectionDegrees.set(profile.entityId, degree);
    });

    // Find top-3 hubs (most connected entities)
    const sortedByDegree = [...connectionDegrees.entries()].sort((a, b) => b[1] - a[1]);
    const top3Hubs = new Set(sortedByDegree.slice(0, 3).map(([id]) => id));


    // Clear and rebuild - simple and reliable
    clearNetwork();

    // Try to load saved positions first
    let savedPositions: Map<string, THREE.Vector3> | null = null;
    try {
      const saved = localStorage.getItem('xln-entity-positions');
      if (saved) {
        const parsed = JSON.parse(saved);
        savedPositions = new Map();
        Object.entries(parsed).forEach(([id, pos]: [string, any]) => {
          savedPositions!.set(id, new THREE.Vector3(pos.x, pos.y, pos.z));
        });
      }
    } catch (err) {
      debug.warn('Failed to load saved positions:', err);
    }

    // Use saved positions if all entities have saved positions, otherwise use H-layout
    const allEntitiesHaveSavedPositions = savedPositions && entityData.every(p => savedPositions!.has(p.entityId));
    const forceLayoutPositions = allEntitiesHaveSavedPositions && savedPositions
      ? savedPositions
      : applyForceDirectedLayout(entityData, connectionMap, capacityMap);

    // Create entity nodes
    console.log('[Graph3D] About to create', entityData.length, 'entity nodes');
    entityData.forEach((profile, index) => {
      const isHub = top3Hubs.has(profile.entityId);
      console.log('[Graph3D] Creating entity node for', profile.entityId);
      createEntityNode(profile, index, entityData.length, forceLayoutPositions, isHub);
    });

    // Save positions after creating entities (for persistence)
    if (!allEntitiesHaveSavedPositions) {
      saveEntityPositions();
    }

    // Create connections between entities that have accounts
    createConnections();

    // Create transaction flow particles (also tracks activity)
    createTransactionParticles();

    // Don't enforce spacing constraints - they break the H-shape
    // enforceSpacingConstraints();
  }

  function clearNetwork() {
    // Remove entity meshes AND labels
    entities.forEach(entity => {
      scene.remove(entity.mesh);
      // CRITICAL: Remove labels to prevent orphaned sprites accumulating
      if (entity.label) {
        scene.remove(entity.label);
      }
    });
    entities = [];

    // Remove connection lines and progress bars
    connections.forEach(connection => {
      scene.remove(connection.line);
      if (connection.progressBars) {
        scene.remove(connection.progressBars);
      }
    });
    connections = [];

    // Remove particles
    particles.forEach(particle => {
      scene.remove(particle.mesh);
    });
    particles = [];
  }

  /**
   * State-of-the-art Force-Directed Graph Layout
   * Uses Fruchterman-Reingold algorithm with capacity-weighted springs
   *
   * Physics model:
   * - Repulsion: All nodes repel each other (prevents overlap)
   * - Attraction: Connected nodes attract via springs (weighted by capacity)
   * - Cooling: Temperature decreases over iterations for stability
   */
  function applyForceDirectedLayout(profiles: any[], connectionMap: Map<string, Set<string>>, capacityMap: Map<string, number>) {
    const positions = new Map<string, THREE.Vector3>();

    // If force layout disabled, use simple radial
    if (!forceLayoutEnabled) {
      return applySimpleRadialLayout(profiles, connectionMap);
    }

    // Detect hubs for initial positioning
    const connectionCounts = new Map<string, number>();
    profiles.forEach(profile => {
      const connections = connectionMap.get(profile.entityId);
      connectionCounts.set(profile.entityId, connections?.size || 0);
    });

    // Initialize positions (random with bias for hubs toward center)
    const nodePositions = new Map<string, {x: number, y: number}>();
    profiles.forEach((profile, index) => {
      const degree = connectionCounts.get(profile.entityId) || 0;
      const isHub = degree > 2;

      // Hubs near center, leaves spread out
      const radius = isHub ? 10 : 30 + Math.random() * 20;
      const angle = (index / profiles.length) * Math.PI * 2;
      nodePositions.set(profile.entityId, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius
      });
    });

    // Fruchterman-Reingold algorithm parameters
    const width = 100;
    const height = 100;
    const area = width * height;
    const k = Math.sqrt(area / profiles.length); // Optimal distance
    const iterations = 100;
    let temperature = width / 10; // Initial temperature (cooling schedule)
    const coolingFactor = 0.95;

    // Force calculations
    const repulsionForce = (dist: number) => (k * k) / dist;
    const attractionForce = (dist: number, capacity: number) => {
      // Weight attraction by capacity (bigger capacity = stronger spring)
      const weight = Math.max(0.1, Math.log10(capacity + 1));
      return (dist * dist * weight) / k;
    };

    // Iterative force simulation
    for (let iter = 0; iter < iterations; iter++) {
      const displacement = new Map<string, {x: number, y: number}>();

      // Initialize displacements
      profiles.forEach(p => {
        displacement.set(p.entityId, {x: 0, y: 0});
      });

      // Calculate repulsive forces (all pairs)
      for (let i = 0; i < profiles.length; i++) {
        for (let j = i + 1; j < profiles.length; j++) {
          const v = profiles[i];
          const u = profiles[j];
          if (!v || !u) continue;

          const vPos = nodePositions.get(v.entityId)!;
          const uPos = nodePositions.get(u.entityId)!;

          const dx = vPos.x - uPos.x;
          const dy = vPos.y - uPos.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01; // Avoid division by zero

          const force = repulsionForce(dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const vDisp = displacement.get(v.entityId)!;
          const uDisp = displacement.get(u.entityId)!;
          vDisp.x += fx;
          vDisp.y += fy;
          uDisp.x -= fx;
          uDisp.y -= fy;
        }
      }

      // Calculate attractive forces (connected pairs)
      for (const [entityId, neighbors] of connectionMap.entries()) {
        const vPos = nodePositions.get(entityId);
        if (!vPos) continue;

        for (const neighborId of neighbors) {
          const uPos = nodePositions.get(neighborId);
          if (!uPos) continue;

          const dx = vPos.x - uPos.x;
          const dy = vPos.y - uPos.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;

          // Get capacity for this connection
          const capacityKey = [entityId, neighborId].sort().join('-');
          const capacity = capacityMap.get(capacityKey) || 1;

          const force = attractionForce(dist, Number(capacity));
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const vDisp = displacement.get(entityId)!;
          vDisp.x -= fx;
          vDisp.y -= fy;
        }
      }

      // Apply displacements with cooling
      profiles.forEach(profile => {
        const pos = nodePositions.get(profile.entityId)!;
        const disp = displacement.get(profile.entityId)!;

        const dispLength = Math.sqrt(disp.x * disp.x + disp.y * disp.y) || 0.01;
        const cappedDisp = Math.min(dispLength, temperature);

        pos.x += (disp.x / dispLength) * cappedDisp;
        pos.y += (disp.y / dispLength) * cappedDisp;

        // Keep within bounds
        const halfWidth = width / 2;
        const halfHeight = height / 2;
        pos.x = Math.max(-halfWidth, Math.min(halfWidth, pos.x));
        pos.y = Math.max(-halfHeight, Math.min(halfHeight, pos.y));
      });

      // Cool down
      temperature *= coolingFactor;
    }

    // Convert to 3D positions
    profiles.forEach(profile => {
      const pos2d = nodePositions.get(profile.entityId)!;
      positions.set(profile.entityId, new THREE.Vector3(pos2d.x, pos2d.y, 0));
    });

    return positions;
  }

  /**
   * Simple radial layout (fallback when force layout disabled)
   */
  function applySimpleRadialLayout(profiles: any[], connectionMap: Map<string, Set<string>>) {
    const positions = new Map<string, THREE.Vector3>();

    const connectionCounts = new Map<string, number>();
    profiles.forEach(profile => {
      const connections = connectionMap.get(profile.entityId);
      connectionCounts.set(profile.entityId, connections?.size || 0);
    });

    const sorted = [...profiles].sort((a, b) => {
      const countA = connectionCounts.get(a.entityId) || 0;
      const countB = connectionCounts.get(b.entityId) || 0;
      if (countB !== countA) return countB - countA;
      return a.entityId.localeCompare(b.entityId);
    });

    // Radial layout
    const baseRadius = 5;
    const maxRadius = 50;
    const angleStep = (Math.PI * 2) / profiles.length;

    sorted.forEach((profile, index) => {
      const degree = connectionCounts.get(profile.entityId) || 0;
      const radius = degree > 0 ? Math.max(baseRadius, maxRadius / (degree + 1)) : maxRadius;
      const angle = index * angleStep;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      positions.set(profile.entityId, new THREE.Vector3(x, y, 0));
    });

    return positions;
  }

  function createEntityNode(profile: any, index: number, total: number, forceLayoutPositions: Map<string, THREE.Vector3>, isHub: boolean) {
    // Position entities: replica position > gossip position > force layout > radial fallback
    let x: number, y: number, z: number;

    // Priority 1: Check replica position (from importReplica serverTx)
    const currentReplicas = $isolatedEnv?.replicas || new Map();
    const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(profile.entityId + ':'));
    const replica = replicaKey ? currentReplicas.get(replicaKey) : null;

    // Check if this is Federal Reserve
    const isFed = replica?.signerId?.includes('_fed') || false;

    // DEBUG: Log replica lookup details
    console.log('[Graph3D] 🔍 Replica lookup for', profile.entityId.slice(0,10), ':', {
      replicaKey,
      hasReplica: !!replica,
      hasPosition: !!replica?.position,
      position: replica?.position,
      allReplicaKeys: Array.from(currentReplicas.keys())
    });

    if (replica?.position) {
      x = replica.position.x;
      y = replica.position.y;
      z = replica.position.z;
      console.log('[Graph3D] ✅ Position extracted:', { entityId: profile.entityId.slice(0,10), x, y, z });
      // Only log ONCE on first draw
      if (!loggedGridPositions.has(profile.entityId)) {
        loggedGridPositions.add(profile.entityId);
        logActivity(`📍 ${profile.entityId.slice(0,10)} @ (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
      }
    } else if (profile.metadata?.position) {
      // Priority 2: Check gossip profile position
      x = profile.metadata.position.x;
      y = profile.metadata.position.y;
      z = profile.metadata.position.z;
      // Only log ONCE on first draw
      if (!loggedGridPositions.has(profile.entityId)) {
        loggedGridPositions.add(profile.entityId);
        logActivity(`📍 ${profile.entityId.slice(0,10)} @ (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
      }
    } else if (forceLayoutPositions.has(profile.entityId) && forceLayoutEnabled) {
      // Priority 3: Use computed force-directed position (only if enabled)
      const pos = forceLayoutPositions.get(profile.entityId)!;
      x = pos.x;
      y = pos.y;
      z = pos.z;
    } else {
      // Priority 4: Fallback to radial layout
      const radius = 30;
      const angle = (index / total) * Math.PI * 2;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
      z = 0;
    }

    // Calculate entity size based on type
    let entitySize = getEntitySizeForToken(profile.entityId, selectedTokenId);

    // Federal Reserve is 3x larger
    if (isFed) {
      entitySize = entitySize * 3;
    }

    // Create entity geometry
    const geometry = new THREE.SphereGeometry(entitySize, 32, 32);

    // Colors: Purple for Fed, green for banks
    let baseColor: number, emissiveColor: number, emissiveIntensity: number;

    if (isFed) {
      baseColor = 0x8b7fb8;      // Ethereum purple (matches J-Machine)
      emissiveColor = 0x9a8ac4;  // Bright purple glow
      emissiveIntensity = 2.0;   // Very bright
    } else {
      const themeColors = getThemeColors(settings.theme);
      baseColor = parseInt(themeColors.entityColor.replace('#', '0x'));
      emissiveColor = parseInt(themeColors.entityEmissive.replace('#', '0x'));
      emissiveIntensity = isHub ? 1.5 : 0.1;
    }

    const material = new THREE.MeshLambertMaterial({
      color: baseColor,
      emissive: emissiveColor,
      emissiveIntensity: emissiveIntensity,
      transparent: true,
      opacity: isFed ? 1.0 : 0.9
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);

    // Add purple glow ring for Fed
    if (isFed) {
      const glowGeometry = new THREE.RingGeometry(entitySize * 1.2, entitySize * 1.5, 32);
      const glowMaterial = new THREE.MeshBasicMaterial({
        color: 0x8b7fb8,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide
      });
      const glowRing = new THREE.Mesh(glowGeometry, glowMaterial);
      glowRing.rotation.x = Math.PI / 2; // Horizontal ring
      mesh.add(glowRing);

      // Store for animation
      mesh.userData['glowRing'] = glowRing;
    }

    // GRID-POS-E removed - already logged in GRID-POS-D above

    // Store material for animation (hubs will pulse)
    mesh.userData['isHub'] = isHub;
    mesh.userData['baseMaterial'] = material;

    if (isHub) {
      // Add lightning particles for hubs
      const lightningGroup = new THREE.Group();
      mesh.add(lightningGroup);
      mesh.userData['lightningGroup'] = lightningGroup;
    }

    scene.add(mesh);

    // Add entity name label (returns sprite to store with entity)
    const labelSprite = createEntityLabel(profile.entityId);

    entities.push({
      id: profile.entityId,
      position: new THREE.Vector3(x, y, z),
      mesh,
      label: labelSprite, // Store label with entity for dynamic positioning
      profile,
      isHub, // Store hub status for pulse animation
      pulsePhase: Math.random() * Math.PI * 2, // Random start phase for pulse
      lastActivity: 0
    });
  }

  function createConnections() {
    const processedConnections = new Set<string>();
    const currentReplicas = replicas;


    // Method 1: Real connections from time-aware replicas
    if (currentReplicas.size > 0) {
      for (const [replicaKey, replica] of currentReplicas.entries()) {
        const [entityId] = replicaKey.split(':');
        const entityAccounts = replica.state?.accounts;


        if (!entityAccounts || !entityId) continue;

        for (const accountKey of entityAccounts.keys()) {
          // Account key is just the counterparty ID (not counterpartyId:tokenId)
          const counterpartyId = String(accountKey);

          if (!counterpartyId) continue;

          // Create connection key (sorted to avoid duplicates)
          const connectionKey = [entityId, counterpartyId].sort().join('<->');
          if (processedConnections.has(connectionKey)) continue;
          processedConnections.add(connectionKey);

          // Find entity positions
          const fromEntity = entities.find(e => e.id === entityId);
          const toEntity = entities.find(e => e.id === counterpartyId);

          if (fromEntity && toEntity) {
            createConnectionLine(fromEntity, toEntity, entityId, counterpartyId, replica);
          } else {
            debug.warn(`🔗 Missing entity for connection: ${entityId} ↔ ${counterpartyId}`);
          }
        }
      }
    }

    // NO DEMO CONNECTIONS - only show real bilateral accounts

    // Build connection index map for O(1) lookups
    buildConnectionIndexMap();

    // PERF: Cache hub connections to avoid O(n × c) nested iteration
    entities.forEach(entity => {
      if (entity.isHub) {
        entity.hubConnectedIds = new Set(
          connections
            .filter(c => c.from === entity.id || c.to === entity.id)
            .map(c => c.from === entity.id ? c.to : c.from)
        );
      }
    });
  }

  function buildConnectionIndexMap() {
    connectionIndexMap.clear();
    connections.forEach((conn, index) => {
      const key1 = `${conn.from}->${conn.to}`;
      const key2 = `${conn.to}->${conn.from}`;
      connectionIndexMap.set(key1, index);
      connectionIndexMap.set(key2, index);
    });
  }

  function createTransactionParticles() {
    // Reset activity tracking
    currentFrameActivity = {
      activeEntities: new Set(),
      incomingFlows: new Map(),
      outgoingFlows: new Map()
    };

    const timeIndex = $isolatedTimeIndex;

    if (!($isolatedTimeIndex === -1) && $isolatedEnv?.history && timeIndex >= 0) {
      const currentFrame = $isolatedEnv.history[timeIndex];

      if (currentFrame?.serverInput?.entityInputs) {
        currentFrame.serverInput.entityInputs.forEach((entityInput: any) => {
          const processingEntityId = entityInput.entityId;
          currentFrameActivity.activeEntities.add(processingEntityId);

          if (entityInput.entityTxs) {
            entityInput.entityTxs.forEach((tx: any) => {
              if (tx.type === 'accountInput' && tx.data) {
                const fromEntityId = tx.data.fromEntityId;
                const toEntityId = tx.data.toEntityId;

                // Create BOTH incoming and outgoing particles for bilateral visibility
                // Outgoing: from sender's perspective
                if (!currentFrameActivity.outgoingFlows.has(fromEntityId)) {
                  currentFrameActivity.outgoingFlows.set(fromEntityId, []);
                }
                currentFrameActivity.outgoingFlows.get(fromEntityId)!.push(toEntityId);
                createDirectionalLightning(fromEntityId, toEntityId, 'outgoing', tx.data.accountTx);

                // Incoming: from receiver's perspective (same particle, different tracking)
                if (!currentFrameActivity.incomingFlows.has(toEntityId)) {
                  currentFrameActivity.incomingFlows.set(toEntityId, []);
                }
                currentFrameActivity.incomingFlows.get(toEntityId)!.push(fromEntityId);

                triggerEntityActivity(fromEntityId);
                triggerEntityActivity(toEntityId);
              } else if (['deposit_collateral', 'reserve_to_collateral', 'deposit_reserve', 'withdraw_reserve'].includes(tx.type)) {
                createBroadcastRipple(processingEntityId, tx.type);
              }
            });
          }
        });
      }
    } else if (($isolatedTimeIndex === -1) && $isolatedEnv?.serverInput?.entityInputs) {
      // Live mode - same logic
      $isolatedEnv.serverInput.entityInputs.forEach((entityInput: any) => {
        const processingEntityId = entityInput.entityId;
        currentFrameActivity.activeEntities.add(processingEntityId);

        if (entityInput.entityTxs) {
          entityInput.entityTxs.forEach((tx: any) => {
            if (tx.type === 'accountInput' && tx.data) {
              const fromEntityId = tx.data.fromEntityId;
              const toEntityId = tx.data.toEntityId;

              // Create BOTH incoming and outgoing particles for bilateral visibility
              // Outgoing: from sender's perspective
              if (!currentFrameActivity.outgoingFlows.has(fromEntityId)) {
                currentFrameActivity.outgoingFlows.set(fromEntityId, []);
              }
              currentFrameActivity.outgoingFlows.get(fromEntityId)!.push(toEntityId);
              createDirectionalLightning(fromEntityId, toEntityId, 'outgoing', tx.data.accountTx);

              // Incoming: from receiver's perspective (same particle, different tracking)
              if (!currentFrameActivity.incomingFlows.has(toEntityId)) {
                currentFrameActivity.incomingFlows.set(toEntityId, []);
              }
              currentFrameActivity.incomingFlows.get(toEntityId)!.push(fromEntityId);

              triggerEntityActivity(fromEntityId);
              triggerEntityActivity(toEntityId);
            } else if (['deposit_collateral', 'reserve_to_collateral', 'deposit_reserve', 'withdraw_reserve'].includes(tx.type)) {
              createBroadcastRipple(processingEntityId, tx.type);
            }
          });
        }
      });
    }
  }

  function createDirectionalLightning(
    fromEntityId: string,
    toEntityId: string,
    direction: 'incoming' | 'outgoing',
    accountTx: any
  ) {
    // O(1) connection lookup
    const key = `${fromEntityId}->${toEntityId}`;
    const connectionIndex = connectionIndexMap.get(key) ??
                            connectionIndexMap.get(`${toEntityId}->${fromEntityId}`) ??
                            -1;

    if (connectionIndex === -1) return;

    const connection = connections[connectionIndex];
    if (!connection) return;

    // Get connection geometry
    const positions = connection.line.geometry.getAttribute('position');
    const start = new THREE.Vector3().fromBufferAttribute(positions, 0);
    const end = new THREE.Vector3().fromBufferAttribute(positions, 1);
    const boltLength = start.distanceTo(end);
    const boltDirection = new THREE.Vector3().subVectors(end, start).normalize();

    // LOGARITHMIC SCALING: 1px = $1 visual rule (same as bars)
    // Extract amount from payment
    const paymentAmount = accountTx?.data?.amount ? Number(accountTx.data.amount) : 0;
    const amountUSD = paymentAmount / 1e18; // Convert from wei to tokens

    // Log scaling for perceptual accuracy
    let radius = 0.08; // Default for non-payments
    if (amountUSD > 0) {
      radius = Math.log10(amountUSD) * 0.08; // $1k=0.24, $1M=0.48, $1B=0.72
      radius = Math.max(0.05, Math.min(radius, 0.8)); // Clamp 0.05-0.8
    }

    // FAT CYLINDER BOLT (not sphere)
    const geometry = new THREE.CylinderGeometry(radius, radius, boltLength, 16);

    // GRADIENT MATERIAL: bright cyan (source) → dim blue (dest)
    const material = new THREE.MeshLambertMaterial({
      color: 0x00ccff, // Bright cyan
      transparent: true,
      opacity: 0.95,
      emissive: 0x00ccff,
      emissiveIntensity: 2.0 // Very bright for electric feel
    });

    const bolt = new THREE.Mesh(geometry, material);

    // Position at connection start
    const midpoint = start.clone().lerp(end, 0.5);
    bolt.position.copy(midpoint);

    // Orient cylinder along connection direction
    const axis = new THREE.Vector3(0, 1, 0); // Cylinder default axis
    bolt.quaternion.setFromUnitVectors(axis, boltDirection);

    scene.add(bolt);

    particles.push({
      mesh: bolt,
      connectionIndex,
      progress: 0,
      speed: 0.02, // Full 3-phase cycle in ~2.5s
      type: accountTx?.type || 'unknown',
      amount: accountTx?.data?.amount,
      direction
    });
  }

  function createBroadcastRipple(entityId: string, txType: string) {
    // Find entity by ID
    const entity = entities.find(e => e.id === entityId);
    if (!entity) {
      return;
    }

    // Create expanding ring/sphere for broadcast visualization
    const startRadius = 0.5;
    const expandSpeed = 0.05;

    // Ring color based on tx type
    let color = 0x00ffff; // Cyan default
    switch (txType) {
      case 'deposit_collateral':
      case 'reserve_to_collateral':
        color = 0x00ff88; // Bright green - entity growing (reserve → collateral)
        break;
      case 'deposit_reserve':
        color = 0x00ff00; // Green - money coming in
        break;
      case 'withdraw_reserve':
        color = 0xff0000; // Red - money going out
        break;
      case 'credit_from_reserve':
        color = 0xffaa00; // Orange - credit from reserve
        break;
      case 'debit_to_reserve':
        color = 0xff44ff; // Magenta - debit to reserve
        break;
    }

    // Create ring geometry (torus for 3D, circle for 2D)
    const geometry = new THREE.TorusGeometry(startRadius, 0.05, 16, 32);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    });
    const ripple = new THREE.Mesh(geometry, material);

    // Position at entity location
    ripple.position.copy(entity.position);

    // Orient ring flat (perpendicular to camera view)
    ripple.rotation.x = Math.PI / 2;

    scene.add(ripple);

    // Add to particles array for animation (reuse particles system)
    particles.push({
      mesh: ripple,
      connectionIndex: -1, // -1 indicates broadcast ripple (not connection-based)
      progress: 0,
      speed: expandSpeed,
      type: `ripple_${txType}`,
      amount: 0n // No amount for ripples
    });

  }


  /**
   * PERF: Update only connections touching a specific entity (during drag)
   * Avoids full rebuild - just updates BufferGeometry positions
   */
  function updateConnectionsForEntity(entityId: string) {
    connections.forEach(conn => {
      if (conn.from === entityId || conn.to === entityId) {
        const fromEntity = entities.find(e => e.id === conn.from);
        const toEntity = entities.find(e => e.id === conn.to);
        if (fromEntity && toEntity) {
          // Update line geometry positions (no recreate)
          const posAttr = conn.line.geometry.getAttribute('position');
          if (posAttr && posAttr.array) {
            const positions = posAttr.array as Float32Array;
            positions[0] = fromEntity.position.x;
            positions[1] = fromEntity.position.y;
            positions[2] = fromEntity.position.z;
            positions[3] = toEntity.position.x;
            positions[4] = toEntity.position.y;
            positions[5] = toEntity.position.z;
            posAttr.needsUpdate = true;
            conn.line.computeLineDistances();
          }

          // Update progress bars position/rotation
          if (conn.progressBars) {
            const midpoint = new THREE.Vector3(
              (fromEntity.position.x + toEntity.position.x) / 2,
              (fromEntity.position.y + toEntity.position.y) / 2,
              (fromEntity.position.z + toEntity.position.z) / 2
            );
            conn.progressBars.position.copy(midpoint);
            conn.progressBars.lookAt(toEntity.position);
          }
        }
      }
    });
  }

  function createConnectionLine(fromEntity: any, toEntity: any, fromId: string, toId: string, replica: any) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      fromEntity.position,
      toEntity.position
    ]);

    // Check if either entity is Federal Reserve
    const currentReplicas = $isolatedEnv?.replicas || new Map();
    const fromReplicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(fromId + ':'));
    const toReplicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(toId + ':'));
    const fromReplicaData = fromReplicaKey ? currentReplicas.get(fromReplicaKey) : null;
    const toReplicaData = toReplicaKey ? currentReplicas.get(toReplicaKey) : null;

    const isFedConnection =
      fromReplicaData?.signerId?.includes('_fed') ||
      toReplicaData?.signerId?.includes('_fed');

    // Gold thick lines for Fed connections (credit lines), normal for others
    let connectionColor: number, opacity: number, linewidth: number, dashSize: number, gapSize: number;

    if (isFedConnection) {
      connectionColor = 0xffd700;  // Gold color for Fed credit lines
      opacity = 0.8;
      linewidth = 4;
      dashSize = 1.0;  // Longer dashes
      gapSize = 0.5;   // Smaller gaps (more continuous)
    } else {
      const themeColors = getThemeColors(settings.theme);
      connectionColor = parseInt(themeColors.connectionColor.replace('#', '0x'));
      opacity = 0.5;
      linewidth = 2;
      dashSize = 0.3;
      gapSize = 0.3;
    }

    const material = new THREE.LineDashedMaterial({
      color: connectionColor,
      opacity: opacity,
      transparent: true,
      linewidth: linewidth,
      dashSize: dashSize,
      gapSize: gapSize
    });

    const line = new THREE.Line(geometry, material);
    line.computeLineDistances(); // Required for dashed lines
    scene.add(line);

    // Create account capacity bars
    const accountBars = createAccountBarsForConnection(fromEntity, toEntity, fromId, toId, replica);

    connections.push({
      from: fromId,
      to: toId,
      line,
      progressBars: accountBars
    });
  }

  function createAccountBarsForConnection(fromEntity: any, toEntity: any, fromId: string, toId: string, _replica: any) {
    // Get current replicas to find the account
    const currentReplicas = replicas;

    // Find the replica that actually contains this account
    let accountData: any = null;

    // Read accounts THE SAME WAY as EntityPanel - key is just counterpartyId!
    const fromReplica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(fromId + ':'));

    if (fromReplica?.[1]?.state?.accounts) {
      // Account key is just the counterparty ID, not counterpartyId:tokenId
      const accountKey = toId;
      accountData = fromReplica[1].state.accounts.get(accountKey);
    }

    // Try reverse direction if not found
    if (!accountData) {
      const toReplica = Array.from(currentReplicas.entries() as [string, any][])
        .find(([key]) => key.startsWith(toId + ':'));

      if (toReplica?.[1]?.state?.accounts) {
        const reverseAccountKey = fromId;
        accountData = toReplica[1].state.accounts.get(reverseAccountKey);
      }
    }

    // NO BARS if no real account data
    if (!accountData) {
      const group = new THREE.Group();
      scene.add(group);
      return group;
    }

    // FINTECH-SAFETY: Get available tokens for THIS specific connection
    if (!accountData.deltas) {
      const group = new THREE.Group();
      scene.add(group);
      return group;
    }

    const availableTokens = Array.from(accountData.deltas.keys() as IterableIterator<number>).sort((a, b) => a - b);

    if (availableTokens.length === 0) {
      const group = new THREE.Group();
      scene.add(group);
      return group;
    }

    // Use single source of truth for delta access
    let tokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
    let displayTokenId = selectedTokenId;

    // FINTECH-GRADE: If selected token doesn't exist, use first available (same logic as tooltip)
    if (!tokenDelta && availableTokens.length > 0) {
      displayTokenId = availableTokens[0]!;
      tokenDelta = getAccountTokenDelta(accountData, displayTokenId);
    }

    if (!tokenDelta) {
      // This should never happen after fallback, but fail-fast
      throw new Error(`FINTECH-SAFETY: Token ${displayTokenId} not found despite being in availableTokens: ${availableTokens}`);
    }

    // Derive account data using REAL token delta
    const derived = deriveEntry(tokenDelta, fromId < toId); // left entity is lexicographically smaller

    // Delegate rendering to AccountBarRenderer
    return createAccountBars(
      scene,
      fromEntity,
      toEntity,
      derived,
      {
        barsMode,
        portfolioScale: settings.portfolioScale || 5000,
        selectedTokenId: displayTokenId
      },
      getEntitySizeForToken
    );
  }

  /**
   * SINGLE SOURCE OF TRUTH: Get token delta from account with type safety
   * Used by both tooltip and progress bars to ensure consistent data access
   */
  function getAccountTokenDelta(accountData: any, tokenId: number): any | null {
    if (!accountData?.deltas) {
      return null;
    }
    // Type-safe access: both tokenId and Map key are guaranteed numbers
    return accountData.deltas.get(tokenId) ?? null;
  }

  function deriveEntry(tokenDelta: any, isLeft: boolean): DerivedAccountData {
    // Use REAL deriveDelta function from xlnFunctions - NO MANUAL CALCULATION!
    if (!XLN?.deriveDelta) {
      throw new Error('FINTECH-SAFETY: xlnFunctions.deriveDelta not available');
    }

    if (!tokenDelta) {
      throw new Error('FINTECH-SAFETY: Cannot derive from null token delta');
    }


    // Use the SAME deriveDelta function as AccountPanel
    const derived = XLN?.deriveDelta(tokenDelta, isLeft);
    if (!derived) {
      return { delta: 0, totalCapacity: 0, ownCreditLimit: 0, peerCreditLimit: 0, inCapacity: 0, outCapacity: 0, collateral: 0, outOwnCredit: 0, inCollateral: 0, outPeerCredit: 0, inOwnCredit: 0, outCollateral: 0, inPeerCredit: 0 };
    }

    // Convert BigInt to numbers for 3D visualization - USE REAL FIELD NAMES!
    const result: DerivedAccountData = {
      delta: Number(derived.delta),
      totalCapacity: Number(derived.totalCapacity || 0n),
      ownCreditLimit: Number(derived.ownCreditLimit || 0n),
      peerCreditLimit: Number(derived.peerCreditLimit || 0n),
      inCapacity: Number(derived.inCapacity || 0n),
      outCapacity: Number(derived.outCapacity || 0n),
      collateral: Number(derived.collateral || 0n),
      // 7-region visualization
      outOwnCredit: Number(derived.outOwnCredit || 0n),
      inCollateral: Number(derived.inCollateral || 0n),
      outPeerCredit: Number(derived.outPeerCredit || 0n),
      inOwnCredit: Number(derived.inOwnCredit || 0n),
      outCollateral: Number(derived.outCollateral || 0n),
      inPeerCredit: Number(derived.inPeerCredit || 0n)
    };

    return result;
  }

  // Deleted: createChannelBars and createDeltaSeparator moved to AccountBarRenderer.ts

  // Bar labels removed per user request - shown only on hover tooltips
  // function createBarLabel(group: THREE.Group, position: THREE.Vector3, value: number, _barType: string) {
  //   ...
  // }

  function createEntityLabel(entityId: string): THREE.Sprite {
    // Create canvas for entity name - minimalist, no background, square aspect ratio to avoid skewing
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    // Use square canvas to prevent skewing (128x128 for clean rendering)
    canvas.width = 128;
    canvas.height = 128;

    // Get short entity name (just number, no prefix)
    const entityName = getEntityShortName(entityId);

    // NO background - transparent (user requirement: black background is ugly)
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Text styling - bright green with dark outline for contrast
    context.font = `bold ${32 * labelScale}px sans-serif`; // Dynamic: 32px * labelScale
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // Draw dark outline for contrast (visible on any background)
    context.strokeStyle = '#000000';
    context.lineWidth = 4;
    context.strokeText(entityName, 64, 64);

    // Draw bright green text on top
    context.fillStyle = '#00ff88';
    context.fillText(entityName, 64, 64);

    // Create sprite with texture
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // Always visible on top
      sizeAttenuation: true // Scale with distance for better depth perception
    });
    const sprite = new THREE.Sprite(spriteMaterial);

    // Sprite scale proportional to labelScale: 1.5 * labelScale
    sprite.scale.set(1.5 * labelScale, 1.5 * labelScale, 1);

    scene.add(sprite);
    return sprite; // Return sprite to store with entity
  }

  function updateEntityLabels() {
    // Update all entity labels to stay on top of spheres (neat, minimalist, always attached)
    // FIRST PRINCIPLE: Labels must never disconnect - every entity must have a visible label
    if (!camera) return;

    entities.forEach(entity => {
      if (!entity.label) {
        // Defensive: If label is missing, recreate it (should never happen but fail-safe)
        debug.warn(`⚠️ Entity ${entity.id.slice(-4)} missing label - recreating`);
        entity.label = createEntityLabel(entity.id);
      }

      // PERF: Use .parent check instead of scene.children.includes() (O(1) vs O(400+))
      if (!entity.label.parent) {
        scene.add(entity.label);
      }

      // Position label above the entity sphere (attached to entity position)
      const entitySize = getEntitySizeForToken(entity.id, selectedTokenId);
      entity.label.position.set(
        entity.position.x,
        entity.position.y + entitySize + 0.8, // Slightly above sphere
        entity.position.z
      );

      // CRITICAL: Sprites must always face camera for readable text
      // Explicitly update rotation quaternion to face camera (billboard effect)
      entity.label.quaternion.copy(camera.quaternion);
    });
  }

  let animateCallCount = 0;
  function animate() {
    // VR uses setAnimationLoop, don't double-call requestAnimationFrame
    if (!renderer?.xr?.isPresenting) {
      animationId = requestAnimationFrame(animate);
    }

    // Debug log every 60 frames
    if (animateCallCount++ % 60 === 0) {
      console.log('[Graph3D] animate() called, frame:', animateCallCount, 'renderer:', !!renderer, 'camera:', !!camera, 'scene children:', scene?.children?.length);
    }

    // ===== PROCESS VISUAL EFFECTS QUEUE =====
    if (scene && spatialHash && entityMeshMap) {
      const deltaTime = clock.getDelta() * 1000; // to milliseconds
      effectOperations.process(scene, entityMeshMap, deltaTime, 10);

      // ===== UPDATE ACCOUNT ACTIVITY LIGHTNING =====
      activityVisualizer?.update(deltaTime);
    }

    // Update VR grabbed entity position
    if (vrGrabbedEntity && vrGrabController) {
      const controllerPos = new THREE.Vector3();
      controllerPos.setFromMatrixPosition(vrGrabController.matrixWorld);

      vrGrabbedEntity.mesh.position.copy(controllerPos);
      vrGrabbedEntity.position.copy(controllerPos);

      // ===== UPDATE GESTURE DETECTOR =====
      if (gestureManager) {
        gestureManager.updateEntity(vrGrabbedEntity.id, vrGrabbedEntity.position, Date.now());
      }

      // Update label position
      if (vrGrabbedEntity.label) {
        vrGrabbedEntity.label.position.copy(controllerPos);
        vrGrabbedEntity.label.position.y += 3;
      }
    }

    // ===== UPDATE VR HAMMER (hit detection) =====
    if (isVRActive && vrHammer) {
      vrHammer.update(connections);
    }

    // Pulse animation for hubs AND Fed entities (24/7 always-on effect)
    const time = Date.now() * 0.001; // Convert to seconds
    entities.forEach(entity => {
      // Fed glow ring animation (rotating + pulsing)
      if (entity.mesh.userData['glowRing']) {
        const glowRing = entity.mesh.userData['glowRing'] as THREE.Mesh;
        glowRing.rotation.z = time * 0.5; // Slow rotation
        const pulseMaterial = glowRing.material as THREE.MeshBasicMaterial;
        pulseMaterial.opacity = 0.2 + Math.sin(time * 2) * 0.15; // Pulse 0.05-0.35
      }

      if (entity.isHub && entity.mesh.material && entity.pulsePhase !== undefined) {
        // Aurora borealis effect: multi-frequency pulsing with color shift
        const material = entity.mesh.material as THREE.MeshLambertMaterial;

        // Primary slow pulse (breathing)
        const slowPulse = Math.sin(time * 0.8 + entity.pulsePhase);
        // Secondary fast shimmer
        const fastShimmer = Math.sin(time * 3.5 + entity.pulsePhase * 0.7);
        // Tertiary ultra-slow wave
        const wave = Math.sin(time * 0.3 + entity.pulsePhase * 1.3);

        // Combine frequencies for aurora-like complexity
        const pulseIntensity = 2.0 + 1.5 * slowPulse + 0.5 * fastShimmer + 0.3 * wave;
        material.emissiveIntensity = pulseIntensity;

        // Color shift: cyan → green → cyan (polar lights)
        const colorShift = (slowPulse + 1) * 0.5; // 0 to 1
        const r = 0;
        const g = Math.floor(255 * (0.8 + 0.2 * colorShift));
        const b = Math.floor(255 * (0.5 + 0.5 * (1 - colorShift)));
        material.emissive.setRGB(r / 255, g / 255, b / 255);

        // Lightning bolts from hub to connected entities
        const lightningGroup = entity.mesh.userData['lightningGroup'];
        if (lightningEnabled && lightningGroup) {
          // Clear old lightning every 150ms (faster refresh for more chaos)
          if (Math.floor(time * 6.67) !== Math.floor((time - 0.016) * 6.67)) {
            while (lightningGroup.children.length > 0) {
              const child = lightningGroup.children[0];
              if (child.geometry) child.geometry.dispose();
              if (child.material) (child.material as any).dispose();
              lightningGroup.remove(child);
            }

            // PERF: Use cached hub connections instead of nested filter+some
            const connectedEntities = entity.hubConnectedIds
              ? entities.filter(e => entity.hubConnectedIds!.has(e.id))
              : [];

            // Fire lightning to 1-3 random connected entities
            const targetCount = Math.min(3, connectedEntities.length);
            const shuffled = [...connectedEntities].sort(() => Math.random() - 0.5);
            const targets = shuffled.slice(0, targetCount);

            targets.forEach(target => {
              // Calculate relative position
              const hubPos = entity.mesh.position;
              const targetPos = target.mesh.position;

              const relX = targetPos.x - hubPos.x;
              const relY = targetPos.y - hubPos.y;
              const relZ = targetPos.z - hubPos.z;

              // Create jagged lightning path
              const points: THREE.Vector3[] = [];
              points.push(new THREE.Vector3(0, 0, 0));

              const segments = 8; // More segments = more jagged
              for (let s = 1; s < segments; s++) {
                const t = s / segments;
                const jitterScale = 1.5; // Higher = more chaos
                const jitterX = (Math.random() - 0.5) * jitterScale;
                const jitterY = (Math.random() - 0.5) * jitterScale;
                const jitterZ = (Math.random() - 0.5) * jitterScale;

                points.push(new THREE.Vector3(
                  relX * t + jitterX,
                  relY * t + jitterY,
                  relZ * t + jitterZ
                ));
              }
              points.push(new THREE.Vector3(relX, relY, relZ));

              const geometry = new THREE.BufferGeometry().setFromPoints(points);
              const material = new THREE.LineBasicMaterial({
                color: 0x00ffff,
                opacity: 0.7 + Math.random() * 0.3,
                transparent: true,
                linewidth: 3
              });

              const lightning = new THREE.Line(geometry, material);
              lightningGroup.add(lightning);
            });
          }
        }
      }
    });

    // Auto-rotate (adjustable speed from slider 0-10000 per axis)
    if ((rotationX > 0 || rotationY > 0 || rotationZ > 0) && controls) {
      // Map slider value (0-10000) to rotation angle
      // 1000 = Earth-like slow rotation (~0.001 rad/frame = 1 rotation per ~100 seconds)
      // 10000 = Fast rotation (~0.01 rad/frame = 1 rotation per ~10 seconds)
      const maxRotationSpeed = 0.01; // Maximum rotation speed at slider = 10000

      const currentPosition = camera.position.clone();
      const target = controls.target.clone();
      const offset = currentPosition.sub(target);

      let newOffset = offset.clone();

      // Apply X-axis rotation (pitch - rotating around horizontal axis)
      if (rotationX > 0) {
        const angleX = (rotationX / 10000) * maxRotationSpeed;
        const newY = newOffset.y * Math.cos(angleX) - newOffset.z * Math.sin(angleX);
        const newZ = newOffset.y * Math.sin(angleX) + newOffset.z * Math.cos(angleX);
        newOffset.y = newY;
        newOffset.z = newZ;
      }

      // Apply Y-axis rotation (yaw - rotating around vertical axis)
      if (rotationY > 0) {
        const angleY = (rotationY / 10000) * maxRotationSpeed;
        const newX = newOffset.x * Math.cos(angleY) - newOffset.z * Math.sin(angleY);
        const newZ = newOffset.x * Math.sin(angleY) + newOffset.z * Math.cos(angleY);
        newOffset.x = newX;
        newOffset.z = newZ;
      }

      // Apply Z-axis rotation (roll - rotating around depth axis)
      if (rotationZ > 0) {
        const angleZ = (rotationZ / 10000) * maxRotationSpeed;
        const newX = newOffset.x * Math.cos(angleZ) - newOffset.y * Math.sin(angleZ);
        const newY = newOffset.x * Math.sin(angleZ) + newOffset.y * Math.cos(angleZ);
        newOffset.x = newX;
        newOffset.y = newY;
      }

      camera.position.x = target.x + newOffset.x;
      camera.position.y = target.y + newOffset.y;
      camera.position.z = target.z + newOffset.z;
      camera.lookAt(target);

      // Save camera state periodically during auto-rotation (not every frame)
      if (Math.random() < 0.01) { // ~1% chance per frame = every few seconds
        saveBirdViewSettings();
      }
    }

    // Update controls
    if (controls) {
      controls.update();
    } else {
      // Fallback rotation if no controls
      if (scene) {
        scene.rotation.y += 0.002;
      }
    }

    // Continuous auto-repulsion when entities intersect in space
    applyCollisionRepulsion();

    // Update entity label positions (always on top of sphere)
    updateEntityLabels();

    // Animate transaction particles
    animateParticles();

    // Animate entity pulses
    animateEntityPulses();

    // Update balance change ripples
    updateRipples();

    // Detect jurisdictional events (j-events) and create ripples (throttled)
    if (Math.random() < 0.05) { // Check ~5% of frames = 3 times per second at 60fps
      detectJurisdictionalEvents();
    }

    if (renderer && camera) {
      const renderStartTime = performance.now();
      renderer.render(scene, camera);
      const renderEndTime = performance.now();

      // Performance metrics update (every 500ms)
      const frameTime = renderEndTime - renderStartTime;
      frameTimeSamples.push(frameTime);
      if (frameTimeSamples.length > 60) frameTimeSamples.shift();

      if (renderEndTime - lastPerfUpdate > 500) {
        perfMetrics = {
          fps: Math.round(1000 / (frameTimeSamples.reduce((a, b) => a + b, 0) / frameTimeSamples.length)),
          renderTime: Math.round(frameTime * 100) / 100,
          entityCount: entities.length,
          connectionCount: connections.length,
          lastFrameTime: Math.round(frameTime * 100) / 100,
          avgFrameTime: Math.round((frameTimeSamples.reduce((a, b) => a + b, 0) / frameTimeSamples.length) * 100) / 100,
        };
        lastPerfUpdate = renderEndTime;
      }
    }
  }

  // Throttle connection rebuilding (expensive operation)
  let lastConnectionRebuild = 0;
  let needsConnectionRebuild = false;

  function applyCollisionRepulsion() {
    // PERF: Skip expensive O(n²) collision checks during drag
    if (isDragging) return;

    // First principle: entities must never overlap in 3D space
    // Check all pairs and push apart if they're too close (sphere intersection)

    let anyMoved = false;

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entityA = entities[i];
        const entityB = entities[j];
        if (!entityA || !entityB) continue;

        // Calculate entity radii (approximate as sphere radius)
        const radiusA = getEntitySizeForToken(entityA.id, selectedTokenId);
        const radiusB = getEntitySizeForToken(entityB.id, selectedTokenId);

        // Current distance between centers
        const distance = entityA.position.distanceTo(entityB.position);

        // Minimum allowed distance (surfaces just touching)
        const minDistance = radiusA + radiusB;

        // If overlapping, push apart
        if (distance < minDistance && distance > 0.01) {
          const overlap = minDistance - distance;
          const direction = new THREE.Vector3().subVectors(entityB.position, entityA.position).normalize();

          // Push force proportional to overlap (spring-like)
          const pushStrength = overlap * 0.5; // Gentle continuous push

          // If neither pinned, push both equally
          if (!entityA.isPinned && !entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushStrength / 2));
            entityB.position.add(direction.clone().multiplyScalar(pushStrength / 2));
            entityA.mesh.position.copy(entityA.position);
            entityB.mesh.position.copy(entityB.position);
            anyMoved = true;
          }
          // If A pinned, push B only
          else if (entityA.isPinned && !entityB.isPinned) {
            entityB.position.add(direction.clone().multiplyScalar(pushStrength));
            entityB.mesh.position.copy(entityB.position);
            anyMoved = true;
          }
          // If B pinned, push A only
          else if (!entityA.isPinned && entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushStrength));
            entityA.mesh.position.copy(entityA.position);
            anyMoved = true;
          }
        }
      }
    }

    // Rebuild connections if entities moved (but throttle to avoid performance hit)
    if (anyMoved) {
      needsConnectionRebuild = true;
    }

    const now = Date.now();
    if (needsConnectionRebuild && (now - lastConnectionRebuild > 100)) { // Max 10 fps for rebuilds
      connections.forEach(connection => {
        scene.remove(connection.line);
        if (connection.progressBars) {
          scene.remove(connection.progressBars);
        }
      });
      connections = [];
      createConnections();
      needsConnectionRebuild = false;
      lastConnectionRebuild = now;
    }
  }

  function animateParticles() {
    particles.forEach((particle, index) => {
      // Update progress
      particle.progress += particle.speed;

      // 3-PHASE LIGHTNING: incoming (0%-45%) → entity flash (45%-55%) → outgoing (55%-100%)
      const maxProgress = 1.0;

      // Remove particle when complete
      if (particle.progress >= maxProgress) {
        scene.remove(particle.mesh);
        particles.splice(index, 1);
        return;
      }

      // Broadcast ripple animation (connectionIndex === -1)
      if (particle.connectionIndex === -1) {
        const startRadius = 0.5;
        const maxRadius = 5.0;
        const currentRadius = startRadius + (maxRadius - startRadius) * particle.progress;
        particle.mesh.scale.setScalar(currentRadius / startRadius);

        const material = particle.mesh.material as THREE.MeshLambertMaterial;
        material.opacity = 0.8 * (1 - particle.progress);
        return;
      }

      // 3-PHASE LIGHTNING BOLT animation
      const connection = connections[particle.connectionIndex];
      if (!connection) return;

      const material = particle.mesh.material as THREE.MeshLambertMaterial;

      // PHASE 1: Strike Formation (0% → 45%) - bolt grows from source
      if (particle.progress < 0.45) {
        const phase1Progress = particle.progress / 0.45; // 0 to 1

        // Bolt grows from 0 to full length
        particle.mesh.scale.y = phase1Progress;

        // Fade in with bright emissive
        const fadeIn = Math.min(1, phase1Progress * 3);
        material.opacity = 0.95 * fadeIn;
        material.emissiveIntensity = 2.5 * fadeIn;

        // Gradient: bright cyan at source
        material.color.setHex(0x00ffff);
      }
      // PHASE 2: Entity Flash (45% → 55%) - maximum intensity at entity
      else if (particle.progress < 0.55) {
        const phase2Progress = (particle.progress - 0.45) / 0.1; // 0 to 1

        // Full bolt visible
        particle.mesh.scale.y = 1.0;

        // EXPLOSIVE FLASH
        material.opacity = 1.0;
        material.emissiveIntensity = 4.0 * Math.sin(phase2Progress * Math.PI); // Peak at midpoint

        // Ultra bright white-blue during flash
        const flashBrightness = Math.sin(phase2Progress * Math.PI);
        material.color.setRGB(
          flashBrightness * 0.5,
          flashBrightness,
          1.0
        );
      }
      // PHASE 3: Dissipation (55% → 100%) - bolt fades to destination color
      else {
        const phase3Progress = (particle.progress - 0.55) / 0.45; // 0 to 1

        // Bolt stays full length
        particle.mesh.scale.y = 1.0;

        // Fade out
        const fadeOut = Math.max(0, 1 - phase3Progress);
        material.opacity = 0.9 * fadeOut;
        material.emissiveIntensity = 2.0 * fadeOut;

        // Gradient: dim blue at destination
        const dimFactor = 1 - phase3Progress * 0.5;
        material.color.setRGB(0, 0.6 * dimFactor, 1.0 * dimFactor);
      }
    });
  }

  function animateEntityPulses() {
    const currentTime = Date.now();

    entities.forEach((entity) => {
      if (!entity.mesh) return;

      const entityId = entity.id;
      const timeSinceActivity = currentTime - (entity.lastActivity || 0);
      const isActive = timeSinceActivity < 2000;

      const material = entity.mesh.material as THREE.MeshLambertMaterial;
      if (!material?.emissive) {
        throw new Error('FINTECH-SAFETY: Entity material missing emissive property');
      }

      // Calculate base size from reserves (planet size = reserve balance)
      const baseSize = getEntitySizeForToken(entityId, selectedTokenId);
      entity.baseScale = baseSize; // Store for reference

      if (isActive) {
        // Check activity direction
        const hasIncoming = currentFrameActivity.incomingFlows.has(entityId);
        const hasOutgoing = currentFrameActivity.outgoingFlows.has(entityId);

        entity.pulsePhase = (entity.pulsePhase || 0) + 0.12;
        const pulseIntensity = Math.max(0, 1 - timeSinceActivity / 2000);
        const pulseFactor = 1 + pulseIntensity * 0.5 * Math.sin(entity.pulsePhase);
        // Apply pulse on top of base size from reserves
        entity.mesh.scale.setScalar(baseSize * pulseFactor);

        // Color-coded glow based on direction
        let glowR = 0, glowG = 0, glowB = 0;

        if (hasIncoming && hasOutgoing) {
          // BOTH: Cyan (processing hub)
          glowR = 0;
          glowG = 0.8;
          glowB = 1;
        } else if (hasIncoming) {
          // INCOMING: Blue (receiving)
          glowR = 0;
          glowG = 0.4;
          glowB = 1;
        } else if (hasOutgoing) {
          // OUTGOING: Orange (sending)
          glowR = 1;
          glowG = 0.6;
          glowB = 0;
        } else {
          // Active but no flows (generic activity)
          glowR = 0;
          glowG = 1;
          glowB = 0;
        }

        const glowIntensity = pulseIntensity * 0.6;
        material.emissive.setRGB(glowR * glowIntensity, glowG * glowIntensity, glowB * glowIntensity);

        // Add activity ring if not present
        if (!entity.activityRing) {
          const ringGeometry = new THREE.TorusGeometry(0.4, 0.06, 16, 32);
          const ringMaterial = new THREE.MeshLambertMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.6,
            emissive: 0x00ff00
          });
          entity.activityRing = new THREE.Mesh(ringGeometry, ringMaterial);
          entity.activityRing.rotation.x = Math.PI / 2;
          entity.mesh.add(entity.activityRing);
        }

        // Update ring color and animation
        const ringMaterial = entity.activityRing.material as THREE.MeshLambertMaterial;
        if (hasIncoming && hasOutgoing) {
          ringMaterial.color.setHex(0x00ffff);
          ringMaterial.emissive.setHex(0x00ffff);
        } else if (hasIncoming) {
          ringMaterial.color.setHex(0x0088ff);
          ringMaterial.emissive.setHex(0x0088ff);
        } else if (hasOutgoing) {
          ringMaterial.color.setHex(0xff8800);
          ringMaterial.emissive.setHex(0xff8800);
        }

        const ringPulse = 1 + 0.3 * Math.sin(entity.pulsePhase * 1.5);
        entity.activityRing.scale.setScalar(ringPulse);
        ringMaterial.opacity = 0.6 * pulseIntensity;
      } else {
        // Inactive: use base size from reserves (no pulse)
        entity.mesh.scale.setScalar(baseSize);
        material.emissive.setRGB(0, 0.1, 0);

        // Remove activity ring (use property deletion for optional type)
        if (entity.activityRing) {
          entity.mesh.remove(entity.activityRing);
          entity.activityRing.geometry.dispose();
          (entity.activityRing.material as THREE.Material).dispose();
          entity.activityRing = null;
        }
      }
    });
  }

  function triggerEntityActivity(entityId: string) {
    const entity = entities.find(e => e.id === entityId);
    if (entity) {
      entity.lastActivity = Date.now();
    }
  }


  function enforceSpacingConstraints() {
    // Check all entity pairs and push them apart if bars would pierce or entities intersect
    // Run multiple iterations to ensure full separation (user requirement: no intersections)
    let anyAdjusted = true;
    let iterations = 0;
    const maxIterations = 10; // Prevent infinite loop

    while (anyAdjusted && iterations < maxIterations) {
      anyAdjusted = false;
      iterations++;

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entityA = entities[i];
        const entityB = entities[j];
        if (!entityA || !entityB) continue;

        // Check if these entities have an account connection
        const connection = connections.find(c =>
          (c.from === entityA.id && c.to === entityB.id) ||
          (c.from === entityB.id && c.to === entityA.id)
        );

        if (!connection) continue;

        // Calculate required spacing based on bars
        const entityASizeData = getEntitySizeForToken(entityA.id, selectedTokenId);
        const entityBSizeData = getEntitySizeForToken(entityB.id, selectedTokenId);

        // Get account data to calculate bar length
        const currentReplicas = replicas;
        let totalBarsLength = 0;

        const fromReplica = Array.from(currentReplicas.entries() as [string, any][])
          .find(([key]) => key.startsWith(entityA.id + ':'));

        if (fromReplica?.[1]?.state?.accounts) {
          const accountData = fromReplica[1].state.accounts.get(entityB.id);
          if (accountData) {
            const tokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
            if (tokenDelta) {
              const derived = XLN?.deriveDelta(tokenDelta, entityA.id < entityB.id);
              if (!derived) continue;

              const globalScale = settings.portfolioScale || 5000;
              const decimals = 18;
              const tokensToVisualUnits = 0.00001;
              const barScale = (tokensToVisualUnits / Math.pow(10, decimals)) * (globalScale / 5000);

              totalBarsLength = (Number(derived.peerCreditLimit) + Number(derived.collateral) + Number(derived.ownCreditLimit)) * barScale;
            }
          }
        }

        // Minimum required distance based on mode (visual units, not pixels)
        const minGapSpread = 2; // Spread mode: small gap in middle
        const minGapClose = 1; // Close mode: small gap on each side

        const requiredGap = barsMode === 'spread' ? minGapSpread : (2 * minGapClose);
        const minDistance = entityASizeData + entityBSizeData + totalBarsLength + requiredGap;

        // Current distance
        const currentDistance = entityA.position.distanceTo(entityB.position);

        // If too close, push entities apart (prioritize non-pinned entities)
        if (currentDistance < minDistance) {
          const pushDistance = minDistance - currentDistance;
          const direction = new THREE.Vector3().subVectors(entityB.position, entityA.position).normalize();

          // Mark that we made an adjustment (need another iteration)
          anyAdjusted = true;

          // If neither is pinned, push both apart equally
          if (!entityA.isPinned && !entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushDistance / 2));
            entityB.position.add(direction.clone().multiplyScalar(pushDistance / 2));
            entityA.mesh.position.copy(entityA.position);
            entityB.mesh.position.copy(entityB.position);
          }
          // If A is pinned, push B away
          else if (entityA.isPinned && !entityB.isPinned) {
            entityB.position.add(direction.clone().multiplyScalar(pushDistance));
            entityB.mesh.position.copy(entityB.position);
          }
          // If B is pinned, push A away
          else if (!entityA.isPinned && entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushDistance));
            entityA.mesh.position.copy(entityA.position);
          }
          // If both pinned, show warning (can't fix)
          else {
            debug.warn(`⚠️ Both entities pinned but too close: ${entityA.id.slice(-4)} ↔ ${entityB.id.slice(-4)}`);
          }
        }
      }
    }
    } // End while loop

    if (iterations > 1) {
    }

    // Rebuild connections after adjustments (bars need to be repositioned)
    connections.forEach(connection => {
      scene.remove(connection.line);
      if (connection.progressBars) {
        scene.remove(connection.progressBars);
      }
    });
    connections = [];
    createConnections();
  }

  function onMouseDown(event: MouseEvent) {
    // Prevent default to avoid text selection
    event.preventDefault();

    // Calculate mouse position
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update raycaster
    raycaster.setFromCamera(mouse, camera);

    // Check for entity intersections
    const entityMeshes = entities.map(e => e.mesh);
    const intersects = raycaster.intersectObjects(entityMeshes);

    if (intersects.length > 0) {
      const intersectedObject = intersects[0]?.object;
      if (!intersectedObject) return;

      const entity = entities.find(e => e.mesh === intersectedObject);
      if (!entity) return;

      // Disable orbit controls during drag
      if (controls) {
        controls.enabled = false;
      }

      // Start dragging
      isDragging = true;
      draggedEntity = entity;
      entity.isDragging = true;

      // Setup drag plane at entity's z position for 3D dragging
      dragPlane.setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()).normalize(),
        entity.position
      );

      // Calculate offset between mouse ray intersection and entity position
      const intersection = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, intersection);
      dragOffset.subVectors(entity.position, intersection);

      // Visual feedback: brighten entity
      if (entity.mesh.material instanceof THREE.MeshLambertMaterial) {
        entity.mesh.material.emissive.setHex(0x00ff88);
      }
    }
  }

  function onMouseUp(_event: MouseEvent) {
    if (draggedEntity && isDragging) {
      // Mark entity as pinned (user has manually positioned it)
      draggedEntity.isPinned = true;
      draggedEntity.isDragging = false;

      // Reset visual feedback
      if (draggedEntity.mesh.material instanceof THREE.MeshLambertMaterial) {
        draggedEntity.mesh.material.emissive.setHex(0x002200);
      }

      // Check if entity violates spacing constraints after drag
      enforceSpacingConstraints();

      // Save positions after drag (persistence)
      saveEntityPositions();

      draggedEntity = null;
      isDragging = false;

      // Set flag to prevent click event from triggering camera refocus
      justDragged = true;
      setTimeout(() => {
        justDragged = false;
      }, 100); // Clear flag after 100ms
    }

    // Re-enable orbit controls WITHOUT refocusing
    if (controls) {
      controls.enabled = true;
      // Don't call controls.update() here - prevents annoying refocus
    }
  }

  function onMouseMove(event: MouseEvent) {
    // Calculate mouse position in normalized device coordinates
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update the raycaster with the camera and mouse position
    raycaster.setFromCamera(mouse, camera);

    // Handle dragging
    if (isDragging && draggedEntity) {
      const intersection = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, intersection);

      // Apply offset and update entity position
      draggedEntity.position.copy(intersection.add(dragOffset));
      draggedEntity.mesh.position.copy(draggedEntity.position);

      // PERF: Only update affected connections (not full rebuild)
      updateConnectionsForEntity(draggedEntity.id);

      return; // Skip hover logic while dragging
    }

    // Check for intersections with entities
    const entityMeshes = entities.map(e => e.mesh);
    const entityIntersects = raycaster.intersectObjects(entityMeshes);

    // Check for intersections with connection lines
    const connectionLines = connections.map(c => c.line);
    const lineIntersects = raycaster.intersectObjects(connectionLines);

    if (entityIntersects.length > 0) {
      const intersectedObject = entityIntersects[0]?.object;
      if (!intersectedObject) {
        throw new Error('FINTECH-SAFETY: No intersected object found');
      }
      const entity = entities.find(e => e.mesh === intersectedObject);

      if (!entity) {
        // Might be lightning bolt or other non-entity object - skip silently
        tooltip.visible = false;
        dualTooltip.visible = false;
        return;
      }

      if (hoveredObject !== intersectedObject) {
        hoveredObject = intersectedObject;

        // Show concise entity tooltip - just balances
        const balanceInfo = getEntityBalanceInfo(entity.id);
        tooltip = {
          visible: true,
          x: event.clientX,
          y: event.clientY,
          content: balanceInfo || 'No reserves'
        };

        // Highlight entity with type safety
        const mesh = intersectedObject as THREE.Mesh;
        const material = mesh.material as THREE.MeshLambertMaterial;
        if (!material?.emissive) {
          throw new Error('FINTECH-SAFETY: Entity material missing emissive property');
        }
        material.emissive.setHex(0x444400);
      }
    } else if (lineIntersects.length > 0) {
      const intersectedLine = lineIntersects[0]?.object;
      if (!intersectedLine) {
        throw new Error('FINTECH-SAFETY: No intersected line found');
      }
      const connection = connections.find(c => c.line === intersectedLine);

      if (!connection) {
        throw new Error('FINTECH-SAFETY: Connection not found for intersected line');
      }

      if (hoveredObject !== intersectedLine) {
        hoveredObject = intersectedLine;

        // Show dual connection tooltips (both perspectives)
        const dualInfo = getDualConnectionAccountInfo(connection.from, connection.to);
        dualTooltip = {
          visible: true,
          x: event.clientX,
          y: event.clientY,
          leftContent: dualInfo.left,
          rightContent: dualInfo.right,
          leftEntity: dualInfo.leftEntity,
          rightEntity: dualInfo.rightEntity
        };

        // Hide single tooltip (not used for connections anymore)
        tooltip.visible = false;

        // Highlight connection with type safety
        const lineMesh = intersectedLine as THREE.Line;
        const lineMaterial = lineMesh.material as THREE.LineDashedMaterial;
        if (!lineMaterial?.color) {
          throw new Error('FINTECH-SAFETY: Connection material missing color property');
        }
        lineMaterial.color.setHex(0xffff00);
      }
    } else {
      if (hoveredObject) {
        // Reset highlight safely
        try {
          if (hoveredObject.material?.emissive?.setHex) {
            hoveredObject.material.emissive.setHex(0x002200);
          } else if (hoveredObject.material?.color?.setHex) {
            hoveredObject.material.color.setHex(0x00ff44);
          }
        } catch (e) {
          debug.warn('Failed to reset highlight:', e);
        }
        hoveredObject = null;
        tooltip.visible = false;
        dualTooltip.visible = false;
      }
    }
  }

  function onMouseOut() {
    if (hoveredObject) {
      try {
        if (hoveredObject.material?.emissive?.setHex) {
          hoveredObject.material.emissive.setHex(0x002200);
        }
      } catch (e) {
        debug.warn('Failed to reset highlight on mouse out:', e);
      }
      hoveredObject = null;
    }
    tooltip.visible = false;
    dualTooltip.visible = false;
  }

  function onMouseClick(event: MouseEvent) {
    // Don't trigger click actions if user just finished dragging
    if (justDragged) {
      return;
    }

    // Calculate mouse position
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update raycaster
    raycaster.setFromCamera(mouse, camera);

    // Check for J-Machine intersections FIRST (higher priority than entities)
    const jMachineObjects: THREE.Object3D[] = [];
    jMachines.forEach(group => {
      group.children.forEach(child => jMachineObjects.push(child));
    });
    const jMachineIntersects = raycaster.intersectObjects(jMachineObjects);

    if (jMachineIntersects.length > 0 && jMachineIntersects[0]) {
      // Find which J-Machine was clicked
      const clickedMesh = jMachineIntersects[0].object;
      let clickedJMachine: THREE.Group | null = null;

      jMachines.forEach((group) => {
        if (group.children.includes(clickedMesh)) {
          clickedJMachine = group;
        }
      });

      if (clickedJMachine && (clickedJMachine as any).userData && (clickedJMachine as any).userData.type === 'jMachine') {
        const pos = (clickedJMachine as any).userData.position as { x: number; y: number; z: number };
        const name = (clickedJMachine as any).userData.xlnomyName as string;
        console.log(`[Graph3D] J-Machine clicked: ${name} at`, pos);

        // Focus camera on this J-Machine
        if (controls && pos) {
          cameraTarget = pos;
          controls.target.set(pos.x, pos.y, pos.z);
          controls.update();
          console.log(`[Graph3D] ✅ Camera now rotates around ${name}`);
        }
        return; // Don't process entity clicks
      }
    }

    // Check for entity intersections
    const entityMeshes = entities.map(e => e.mesh);
    const intersects = raycaster.intersectObjects(entityMeshes);

    if (intersects.length > 0) {
      const intersectedObject = intersects[0]?.object;
      if (!intersectedObject) {
        throw new Error('FINTECH-SAFETY: No intersected object in click');
      }
      const entity = entities.find(e => e.mesh === intersectedObject);

      if (!entity) {
        // Clicked on lightning or other non-entity - ignore
        return;
      }

      // Trigger activity animation
      triggerEntityActivity(entity.id);

      // DISABLED: Center camera on entity (user doesn't want ANY refocusing)
      // centerCameraOnEntity(entity);

    }
  }

  function onMouseDoubleClick(event: MouseEvent) {
    // Calculate mouse position
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update raycaster
    raycaster.setFromCamera(mouse, camera);

    // Check for entity intersections
    const entityMeshes = entities.map(e => e.mesh);
    const intersects = raycaster.intersectObjects(entityMeshes);

    if (intersects.length > 0) {
      const intersectedObject = intersects[0]?.object;
      if (!intersectedObject) {
        throw new Error('FINTECH-SAFETY: No intersected object in double-click');
      }
      const entity = entities.find(e => e.mesh === intersectedObject);

      if (!entity) {
        throw new Error('FINTECH-SAFETY: Entity not found for double-clicked object');
      }

      // Switch to normal panel view and focus this entity

      // Save bird view as closed
      saveBirdViewSettings(false);

      // TODO: Switch to panels view and focus specific entity
    }
  }

  // Touch event handlers for iPhone/mobile support
  function onTouchStart(event: TouchEvent) {
    event.preventDefault();

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((touch!.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((touch!.clientY - rect.top) / rect.height) * 2 + 1;

      // Simulate mousedown
      raycaster.setFromCamera(mouse, camera);
      const entityMeshes = entities.map(e => e.mesh);
      const intersects = raycaster.intersectObjects(entityMeshes);

      if (intersects.length > 0) {
        const intersectedObject = intersects[0]?.object;
        if (!intersectedObject) return;

        const entity = entities.find(e => e.mesh === intersectedObject);
        if (!entity) return;

        if (controls) {
          controls.enabled = false;
        }

        isDragging = true;
        draggedEntity = entity;
        entity.isDragging = true;

        dragPlane.setFromNormalAndCoplanarPoint(
          camera.getWorldDirection(new THREE.Vector3()).normalize(),
          entity.position
        );

        const intersection = new THREE.Vector3();
        raycaster.ray.intersectPlane(dragPlane, intersection);
        dragOffset.subVectors(entity.position, intersection);

        if (entity.mesh.material instanceof THREE.MeshLambertMaterial) {
          entity.mesh.material.emissive.setHex(0x00ff88);
        }
      }
    }
  }

  function onTouchMove(event: TouchEvent) {
    event.preventDefault();

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((touch!.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((touch!.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      if (isDragging && draggedEntity) {
        const intersection = new THREE.Vector3();
        raycaster.ray.intersectPlane(dragPlane, intersection);
        draggedEntity.position.copy(intersection.add(dragOffset));
        draggedEntity.mesh.position.copy(draggedEntity.position);
      }
    }
  }

  function onTouchEnd(event: TouchEvent) {
    event.preventDefault();

    if (draggedEntity && isDragging) {
      draggedEntity.isPinned = true;
      draggedEntity.isDragging = false;

      if (draggedEntity.mesh.material instanceof THREE.MeshLambertMaterial) {
        draggedEntity.mesh.material.emissive.setHex(0x002200);
      }

      enforceSpacingConstraints();
      saveEntityPositions();

      draggedEntity = null;
      isDragging = false;

      justDragged = true;
      setTimeout(() => {
        justDragged = false;
      }, 100);
    }

    if (controls) {
      controls.enabled = true;
    }
  }

  function highlightRoutePath(route: typeof availableRoutes[0] | undefined) {
    if (!route) {
      clearRouteHighlight();
      return;
    }

    // Reset all connections to default opacity
    clearRouteHighlight();

    // Highlight connections in the route path
    for (let i = 0; i < route.path.length - 1; i++) {
      const from = route.path[i];
      const to = route.path[i + 1];
      if (!from || !to) continue;

      const connection = connections.find(c =>
        (c.from === from && c.to === to) || (c.from === to && c.to === from)
      );

      if (connection) {
        const lineMaterial = connection.line.material as THREE.LineDashedMaterial;
        lineMaterial.opacity = 0.8; // Bright highlight
        lineMaterial.color.setHex(0x00ff88); // Green for selected route
      }
    }
  }

  function clearRouteHighlight() {
    const themeColors = getThemeColors(settings.theme);
    const connectionColor = parseInt(themeColors.connectionColor.replace('#', '0x'));

    connections.forEach(connection => {
      const lineMaterial = connection.line.material as THREE.LineDashedMaterial;
      lineMaterial.opacity = 0.3; // Default opacity
      lineMaterial.color.setHex(connectionColor); // Theme color
    });
  }


  // Helper to log frame commits (currently unused, will be called from frame processing)
  // function logFrameCommit(entity1: string, entity2: string, frameId: number) {
  //   const e1 = getEntityShortName(entity1);
  //   const e2 = getEntityShortName(entity2);
  //   recentActivity.unshift({
  //     id: `commit-${Date.now()}-${Math.random()}`,
  //     message: `✅ ${e1} ⟷ ${e2}: frame ${frameId} committed`,
  //     timestamp: Date.now(),
  //     type: 'commit'
  //   });
  //   if (recentActivity.length > 30) {
  //     recentActivity = recentActivity.slice(0, 30);
  //   }
  // }

  function update3DMode() {
    if (!camera) return;

    if (viewMode === '2d') {
      // Switch to orthographic 2D view
      camera.position.set(0, 0, 30);
      camera.lookAt(0, 0, 0);
      if (controls) {
        controls.enableRotate = false;
        controls.enablePan = true;
      }
    } else {
      // Switch to 3D perspective view
      camera.position.set(0, 0, 25);
      if (controls) {
        controls.enableRotate = true;
        controls.enablePan = true;
      }
    }
  }

  function updateAvailableTokens() {
    const currentReplicas = replicas;
    const tokenSet = new Set<number>();

    // Collect all available token IDs from reserves
    for (const [_, replica] of currentReplicas.entries()) {
      if (!replica?.state?.reserves) continue;

      // FINTECH-SAFETY: reserves is Map<string, bigint>, so tokenId key is string
      replica.state.reserves.forEach((_: bigint, tokenIdStr: string) => {
        const tokenId = Number(tokenIdStr);
        if (!isNaN(tokenId)) {
          tokenSet.add(tokenId);
        }
      });
    }

    availableTokens = Array.from(tokenSet).sort((a, b) => a - b);

    // USDC (token 1) is always available
    if (!availableTokens.includes(1)) {
      availableTokens.push(1);
      availableTokens.sort((a, b) => a - b);
    }

    // Default to token 1 (USDC) if nothing selected
    if (availableTokens.length === 0) {
      availableTokens = [1];
      selectedTokenId = 1;
    } else if (!availableTokens.includes(selectedTokenId) && ($isolatedTimeIndex === -1)) {
      // Only auto-switch in LIVE mode - during playback, keep user's selection
      // Always prefer USDC (token 1)
      selectedTokenId = availableTokens.includes(1) ? 1 : availableTokens[0]!;
      saveBirdViewSettings();
    }
  }

  function getEntitySizeForToken(entityId: string, tokenId: number): number {
    // PERF: Check cache first (eliminates O(n²) reactive store lookups)
    const cacheKey = `${entityId}:${tokenId}`;
    if (entitySizeCache.has(cacheKey)) {
      return entitySizeCache.get(cacheKey)!;
    }

    const currentReplicas = replicas;
    let replica: any = null;

    // PERF: Direct iteration instead of Array.from + find
    for (const [key, value] of currentReplicas) {
      if (key.startsWith(entityId + ':')) {
        replica = value;
        break;
      }
    }

    if (!replica?.state?.reserves) {
      const defaultSize = 0.5;
      entitySizeCache.set(cacheKey, defaultSize);
      return defaultSize;
    }

    const reserves = replica.state.reserves;
    const tokenAmount = reserves.get(String(tokenId)) || 0n;

    // VC-MODE: Dramatic scaling - reserve changes must be visually obvious
    // 1M reserves → size 3.0, 500k → 1.75, 0 → 0.5 (58% size change for 50% reserve change)
    const scaleFactor = Number(tokenAmount) / 1_000_000; // 1.0 for 1M, 0.5 for 500k
    const size = Math.max(0.5, Math.min(4.0, 0.5 + scaleFactor * 2.5));

    // Cache the result
    entitySizeCache.set(cacheKey, size);
    return size;
  }

  // PERF: Clear cache when replicas change
  $: if (replicas) {
    entitySizeCache.clear();
  }

  function calculateAvailableRoutes(from: string, to: string) {
    if (!env) {
      availableRoutes = [];
      return;
    }

    const routes: typeof availableRoutes = [];

    // Check for direct account
    const fromReplicaEntry = Array.from(env.replicas.entries() as [string, any][]).find(([k]) => k.startsWith(from + ':'));
    const fromReplica = fromReplicaEntry?.[1];
    if (fromReplica?.state?.accounts?.has(to)) {
      routes.push({
        from,
        to,
        path: [from, to],
        type: 'direct',
        description: `Direct: ${getEntityShortName(from)} → ${getEntityShortName(to)}`,
        cost: 0,
        hops: 1
      });
    }

    // Find multi-hop routes (simple BFS for now)
    const queue: Array<{current: string; path: string[]}> = [{current: from, path: [from]}];
    const visited = new Set<string>([from]);
    const maxHops = 10;

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const {current, path} = item;
      if (path.length > maxHops) continue;

      const currentReplicaEntry = Array.from(env.replicas.entries() as [string, any][]).find(([k]) => k.startsWith(current + ':'));
      const currentReplica = currentReplicaEntry?.[1];
      if (!currentReplica?.state?.accounts) continue;

      for (const [neighbor] of currentReplica.state.accounts.entries()) {
        const neighborStr = String(neighbor);
        if (neighborStr === to && path.length > 1) {
          // Found a route!
          const fullPath = [...path, to];
          routes.push({
            from,
            to,
            path: fullPath,
            type: 'multihop',
            description: fullPath.map(id => getEntityShortName(id)).join(' → '),
            cost: fullPath.length - 1, // Simple cost = hop count
            hops: fullPath.length - 1
          });
        } else if (!visited.has(neighborStr) && neighborStr !== to) {
          visited.add(neighborStr);
          queue.push({current: neighborStr, path: [...path, neighborStr]});
        }
      }
    }

    // Sort by hops (prefer fewer hops)
    routes.sort((a, b) => a.hops - b.hops);

    availableRoutes = routes;
    selectedRouteIndex = 0;
  }

  async function sendPayment() {
    try {

      if (!paymentFrom || !paymentTo) {
        debug.error('❌ Missing from/to entities');
        alert('Please select from and to entities');
        return;
      }
      if (paymentFrom === paymentTo) {
        debug.error('❌ Same entity selected');
        alert('Cannot send payment to same entity');
        return;
      }

      // Use selected route if available
      const selectedRoute = availableRoutes[selectedRouteIndex];
      if (!selectedRoute) {
        alert('No route available for this payment');
        return;
      }


      // Ensure we're in LIVE mode for payments
      if (!($isolatedTimeIndex === -1)) {
        isolatedTimeIndex.set(-1)  // Go to live;
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for mode switch
      }

      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const job: PaymentJob = {
        id: jobId,
        from: paymentFrom,
        to: paymentTo,
        amount: paymentAmount,
        tps: paymentTPS,
        sentCount: 0,
        startedAt: Date.now()
      };


      if (paymentTPS === 0) {
        // Send once immediately
        await executeSinglePayment(job);
      } else {
        // Create recurring job
        const intervalMs = 1000 / paymentTPS; // Convert TPS to milliseconds
        const intervalId = window.setInterval(async () => {
          await executeSinglePayment(job);
          job.sentCount++;
        }, intervalMs);

        job.intervalId = intervalId;
        activeJobs = [...activeJobs, job];
      }
    } catch (error) {
      debug.error('🔥 CRITICAL ERROR in sendPayment:', error);
      debug.error('Stack:', error instanceof Error ? error.stack : 'No stack');
      alert(`Payment failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function executeSinglePayment(job: PaymentJob) {
    try {
      // XLN already loaded in onMount
      if (!XLN) {
        throw new Error('XLN runtime not loaded');
      }

      if (!env) {
        throw new Error('XLN environment not available');
      }

      // Debug logging

      // Step 1: Find routes (copy from PaymentPanel findRoutes logic)
      // Find our replica to check for direct account
      let ourReplica: any = null;
      for (const key of env.replicas.keys()) {
        if (key.startsWith(job.from + ':')) {
          ourReplica = env.replicas.get(key);
          break;
        }
      }

      if (!ourReplica) {
        throw new Error(`No replica found for entity ${getEntityShortName(job.from)} (${job.from})`);
      }

      // Multi-hop routing: Backend will find route if no direct account exists
      const hasDirectAccount = ourReplica?.state?.accounts?.has(job.to);
      if (!hasDirectAccount) {
        console.log(`🔀 No direct account from ${getEntityShortName(job.from)} to ${getEntityShortName(job.to)} - backend will find multi-hop route`);
      }

      // Convert amount to BigInt with decimals (copy from PaymentPanel)
      const decimals = 18;
      const amountStr = String(job.amount);
      const amountParts = amountStr.split('.');
      const wholePart = BigInt(amountParts[0] || 0);
      const decimalPart = amountParts[1] || '';
      const paddedDecimal = decimalPart.padEnd(decimals, '0').slice(0, decimals);
      const amountInSmallestUnit = wholePart * BigInt(10 ** decimals) + BigInt(paddedDecimal || 0);


      // Build route object from selected route (multi-hop support)
      const selectedRoute = availableRoutes[selectedRouteIndex];
      if (!selectedRoute) {
        throw new Error('No route selected');
      }

      const routePath = selectedRoute.path;

      // VALIDATE route construction
      if (!routePath || routePath.length < 2) {
        throw new Error(`Invalid route: expected at least 2 entities, got ${routePath?.length || 0}`);
      }
      if (routePath[0] !== job.from || routePath[routePath.length - 1] !== job.to) {
        throw new Error(`Route mismatch: expected ${job.from} → ${job.to}, got ${routePath[0]} → ${routePath[routePath.length - 1]}`);
      }

      // Step 2: Find signerId (copy from PaymentPanel)
      let signerId = 's1'; // default
      for (const key of env.replicas.keys()) {
        if (key.startsWith(job.from + ':')) {
          signerId = key.split(':')[1] || 's1';
          break;
        }
      }

      // Step 3: Send payment (copy EXACT structure from PaymentPanel)
      const paymentInput = {
        entityId: job.from,
        signerId,
        entityTxs: [{
          type: 'directPayment' as const,
          data: {
            targetEntityId: job.to,
            tokenId: selectedTokenId,
            amount: amountInSmallestUnit, // Use the converted amount
            route: routePath,  // Path array
            description: `Bird view payment: ${job.amount}`,
          },
        }],
      };


      // Trigger visual feedback BEFORE processing
      triggerEntityActivity(job.from);
      triggerEntityActivity(job.to);

      // Process the payment (COPY EXACT CALL from PaymentPanel)
      await XLN.process(env, [paymentInput]);

      // Add to activity ticker AFTER successful processing
      recentActivity = [{
        id: `tx-${Date.now()}`,
        message: `${getEntityShortName(job.from)} → ${getEntityShortName(job.to)}: ${job.amount}`,
        timestamp: Date.now(),
        type: 'payment' as 'payment'
      }, ...recentActivity].slice(0, 10);


    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug.error('❌ Payment failed:', error); // Log full error object
      debug.error('❌ Error message:', errorMsg);
      debug.error('❌ Stack trace:', error instanceof Error ? error.stack : 'No stack');

      // Show error to user
      alert(`Payment failed: ${errorMsg}`);

      // If it's a recurring job, cancel it on error
      if (job.intervalId) {
        cancelJob(job.id);
      }
    }
  }

  function cancelJob(jobId: string) {
    const job = activeJobs.find(j => j.id === jobId);
    if (job?.intervalId) {
      clearInterval(job.intervalId);
    }
    activeJobs = activeJobs.filter(j => j.id !== jobId);
  }

  function createRipple(entityId: string) {
    const entity = entities.find(e => e.id === entityId);
    if (!entity || !scene) return;

    const rippleGeometry = new THREE.RingGeometry(0.1, 0.2, 32);
    const rippleMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    });

    const rippleMesh = new THREE.Mesh(rippleGeometry, rippleMaterial);
    rippleMesh.position.copy(entity.position);

    // Random rotation for variety
    rippleMesh.rotation.x = Math.random() * Math.PI;
    rippleMesh.rotation.y = Math.random() * Math.PI;
    rippleMesh.rotation.z = Math.random() * Math.PI;

    scene.add(rippleMesh);

    const ripple: Ripple = {
      mesh: rippleMesh,
      startTime: Date.now(),
      duration: 1500, // 1.5 seconds
      maxRadius: 5.0  // Expand to 5 units
    };

    activeRipples.push(ripple);
  }

  function updateRipples() {
    const now = Date.now();
    activeRipples = activeRipples.filter(ripple => {
      const elapsed = now - ripple.startTime;
      const progress = Math.min(elapsed / ripple.duration, 1);

      if (progress >= 1) {
        // Remove completed ripple
        scene.remove(ripple.mesh);
        ripple.mesh.geometry.dispose();
        (ripple.mesh.material as THREE.Material).dispose();
        return false;
      }

      // Animate ripple expansion and fade
      const scale = 0.1 + progress * ripple.maxRadius;
      ripple.mesh.scale.set(scale, scale, 1);

      const material = ripple.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = 0.8 * (1 - progress); // Fade out

      return true;
    });
  }

  function detectJurisdictionalEvents() {
    if (!env) return;

    // Check the current server frame for jurisdictional events (j-events)
    const currentFrame = env.serverState?.history?.[env.serverState.history.length - 1];
    if (!currentFrame) return;

    // Look for entityFrames that contain j-events (reserve/collateral updates)
    const entityFrames = currentFrame.entityFrames;
    if (!entityFrames || !(entityFrames instanceof Map)) return;

    entityFrames.forEach((entityFrame: any, entityId: string) => {
      // Check if this entity frame has j-events (transactions that modify reserves/collateral)
      const jEvents = entityFrame.jEvents;
      if (jEvents && jEvents.length > 0) {
        // This entity experienced a jurisdictional event - create ripple
        createRipple(entityId);
      }
    });
  }


  async function executeScenario() {
    if (!selectedScenarioFile) {
      debug.warn('No scenario selected');
      return;
    }

    isLoadingScenario = true;

    try {
      // Fetch scenario file
      const response = await fetch(`/worlds/${selectedScenarioFile}`);
      if (!response.ok) {
        throw new Error(`Failed to load scenario: ${response.statusText}`);
      }

      const scenarioText = await response.text();
      console.log(`Loaded scenario: ${selectedScenarioFile}`);

      // Import XLN server module
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Parse scenario
      const parsed = XLN?.parseScenario(scenarioText);

      if (parsed.errors.length > 0) {
        console.error('Scenario parse errors:', parsed.errors);
        debug.error('Scenario has errors - check console');
        return;
      }

      console.log(`Executing scenario with ${parsed.scenario.events.length} events`);

      // Execute scenario
      const result = await XLN?.executeScenario($isolatedEnv, parsed.scenario);

      if (result.success) {
        console.log(`Scenario executed: ${result.framesGenerated} frames generated`);

        // Go to start of new frames to watch scenario unfold
        // timeOperations removed 0);
      } else {
        console.error('Scenario execution errors:', result.errors);
        debug.error('Scenario execution failed - check console');
      }
    } catch (error) {
      console.error('Failed to execute scenario:', error);
      debug.error('Scenario failed: ' + (error as Error).message);
    } finally {
      isLoadingScenario = false;
    }
  }

  async function executeLiveCommand() {
    if (!commandText.trim()) {
      debug.warn('No command entered');
      return;
    }

    try {
      // Ensure LIVE mode
      if (!($isolatedTimeIndex === -1)) {
        isolatedTimeIndex.set(-1)  // Go to live;
      }

      console.log(`🎬 Executing live command: ${commandText}`);

      // Clear logged positions if this is a grid command (for fresh logs)
      if (commandText.trim().startsWith('grid')) {
        loggedGridPositions.clear();
      }

      // Parse as single-line scenario
      const scenarioText = `SEED live-${Date.now()}\n\n0: Live Command\n${commandText}`;

      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      const parsed = XLN?.parseScenario(scenarioText);

      if (parsed.errors.length > 0) {
        console.error('Command parse errors:', parsed.errors);
        debug.error('Invalid command syntax');
        return;
      }

      // Execute command
      const result = await XLN?.executeScenario($isolatedEnv, parsed.scenario);

      if (result.success) {
        console.log(`✅ Live command executed`);
        commandText = ''; // Clear input
      } else {
        debug.error('Command execution failed');
      }
    } catch (error) {
      console.error('Failed to execute command:', error);
      debug.error('Command failed: ' + (error as Error).message);
    }
  }

  function generateSliceURL() {
    const currentHistory = get(isolatedHistory);
    const start = Math.max(0, sliceStart);
    const end = Math.min(currentHistory.length - 1, sliceEnd);

    if (start >= end) {
      debug.warn('Invalid slice range');
      return;
    }

    // Build complete scenario from sliced frames
    const scenarioLines: string[] = [];
    scenarioLines.push(`SEED slice-${Date.now()}`);
    scenarioLines.push('');

    // Extract narrative and actions from each frame
    for (let i = start; i <= end; i++) {
      const frame = currentHistory[i];
      if (!frame) continue;

      const timestamp = i - start; // Relative time from slice start

      if (frame.title || frame.narrative) {
        scenarioLines.push(`${timestamp}: ${frame.title || 'Frame ' + i}`);
        if (frame.narrative) {
          scenarioLines.push(frame.narrative);
        }
        scenarioLines.push('');
        scenarioLines.push('===');
        scenarioLines.push('');
      }
    }

    // Encode complete scenario as base64
    const scenarioText = scenarioLines.join('\n');
    const base64Scenario = btoa(scenarioText);

    // Build URL with encoded scenario and loop suggestion
    const baseUrl = window.location.origin;
    exportUrl = `${baseUrl}/?s=${base64Scenario}&loop=${start}:${end}`;

    console.log(`📋 Generated slice URL: frames ${start}-${end}, scenario ${scenarioText.length} chars`);
  }

  function generateASCIIScenario() {
    if (!asciiText.trim()) {
      debug.warn('No ASCII text entered');
      return;
    }

    // Parse ASCII grid
    const textLines = asciiText.split('\n');
    const positions: Array<{x: number; y: number; char: string}> = [];

    textLines.forEach((line, y) => {
      [...line].forEach((char, x) => {
        if (char !== ' ' && char.trim().length > 0) {
          positions.push({ x, y, char });
        }
      });
    });

    if (positions.length === 0) {
      debug.warn('No entities found in ASCII text');
      return;
    }

    // Center the formation
    const centerX = positions.reduce((sum, p) => sum + p.x, 0) / positions.length;
    const centerY = positions.reduce((sum, p) => sum + p.y, 0) / positions.length;

    // Convert to world coordinates
    const entityPositions = positions.map((p, i) => ({
      id: i + 1,
      x: (p.x - centerX) * asciiScale,
      y: (centerY - p.y) * asciiScale, // Flip Y for screen coords
      z: 0
    }));

    // Generate connections (connect adjacent entities)
    const connections: Array<{from: number; to: number}> = [];
    entityPositions.forEach((p1, i) => {
      entityPositions.forEach((p2, j) => {
        if (i >= j) return;

        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const distance = Math.sqrt(dx*dx + dy*dy);

        // Connect if distance ≈ 1 grid unit (with tolerance)
        if (distance < asciiScale * 1.5) {
          connections.push({ from: p1.id, to: p2.id });
        }
      });
    });

    // Build scenario text
    const scenarioLines: string[] = [];
    scenarioLines.push(`SEED ascii-${Date.now()}`);
    scenarioLines.push('');
    scenarioLines.push('0: ASCII Formation');
    scenarioLines.push(`${entityPositions.length} entities form the pattern`);
    scenarioLines.push(`import 1..${entityPositions.length}`);
    scenarioLines.push('');
    scenarioLines.push('===');
    scenarioLines.push('');
    scenarioLines.push('1: Position Entities');
    scenarioLines.push('Entities placed in ASCII grid pattern');

    // Add position data as VIEW param
    const posStr = entityPositions
      .map(p => `${p.id}:${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z}`)
      .join(';');
    scenarioLines.push(`VIEW entity_positions="${posStr}"`);
    scenarioLines.push('');
    scenarioLines.push('===');
    scenarioLines.push('');
    scenarioLines.push('2: Link Structure');
    scenarioLines.push(`${connections.length} connections form the shape`);

    connections.forEach(c => {
      scenarioLines.push(`${c.from} openAccount ${c.to}`);
    });

    asciiScenario = scenarioLines.join('\n');

    console.log(`🎨 Generated ASCII scenario: ${entityPositions.length} entities, ${connections.length} connections`);
  }

  async function executeASCIIScenario() {
    if (!asciiScenario) {
      debug.warn('No ASCII scenario generated');
      return;
    }

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      const parsed = XLN?.parseScenario(asciiScenario);

      if (parsed.errors.length > 0) {
        console.error('ASCII scenario parse errors:', parsed.errors);
        debug.error('Failed to parse generated scenario');
        return;
      }

      const result = await XLN?.executeScenario($isolatedEnv, parsed.scenario);

      if (result.success) {
        console.log(`✅ ASCII formation executed: ${result.framesGenerated} frames`);
        // timeOperations removed 0);
        asciiText = ''; // Clear input
        asciiScenario = ''; // Clear output
      } else {
        debug.error('ASCII formation failed');
      }
    } catch (error) {
      console.error('Failed to execute ASCII formation:', error);
      debug.error('Formation failed: ' + (error as Error).message);
    }
  }

  function getEntityBalanceInfo(entityId: string): string {
    const currentReplicas = replicas;
    const replica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(entityId + ':'));

    if (!replica?.[1]?.state?.reserves) {
      return "  Reserves loading...";
    }

    const reserves = replica[1].state.reserves;
    const balanceLines: string[] = [];

    if (reserves.size === 0) {
      return "  No token reserves";
    }

    // Show all tokens, highlight selected one
    // FINTECH-SAFETY: reserves is Map<string, bigint>, so tokenId key is string
    reserves.forEach((amount: bigint, tokenIdStr: string) => {
      const tokenId = Number(tokenIdStr);
      if (isNaN(tokenId)) return; // Skip invalid token IDs

      const formattedAmount = (Number(amount) / 1000).toFixed(2);
      const marker = tokenId === selectedTokenId ? '▸ ' : '  ';
      balanceLines.push(`${marker}${getTokenSymbol(tokenId)}: ${formattedAmount}k`);
    });

    return balanceLines.join('\n');
  }

  /**
   * Format financial amounts using same logic as EntityPanel
   * Example: 1500000000000000000n → "1.5"
   */
  function formatFinancialAmount(amount: bigint, decimals: number = 18): string {
    if (amount === 0n) return '0';

    const isNegative = amount < 0n;
    const absoluteAmount = isNegative ? -amount : amount;

    const divisor = BigInt(10 ** decimals);
    const wholePart = absoluteAmount / divisor;
    const fractionalPart = absoluteAmount % divisor;

    if (fractionalPart === 0n) {
      return `${isNegative ? '-' : ''}${wholePart.toLocaleString()}`;
    }

    const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
    const trimmed = fractionalStr.replace(/0+$/, ''); // Remove trailing zeros
    const formatted = trimmed.slice(0, 4); // Max 4 decimal places for readability
    return `${isNegative ? '-' : ''}${wholePart.toLocaleString()}.${formatted}`;
  }

  /**
   * Get entity short name (just ID, clean - no prefix)
   */
  function getEntityShortName(entityId: string): string {
    if (!XLN?.getEntityShortId) return entityId.slice(-4);
    try {
      return XLN?.getEntityShortId(entityId); // Just ID, clean - no "#" or "Entity" prefix
    } catch {
      return entityId.slice(-4);
    }
  }

  /**
   * Get dual perspective account info (for connection hover tooltips)
   * Shows both left and right entity's view of the same account
   */
  function getDualConnectionAccountInfo(entityA: string, entityB: string): { left: string, right: string, leftEntity: string, rightEntity: string } {
    const currentReplicas = replicas;

    // Determine canonical ordering (left is always smaller ID)
    const isALeft = entityA < entityB;
    const leftId = isALeft ? entityA : entityB;
    const rightId = isALeft ? entityB : entityA;

    // Find account data by checking BOTH replicas (same logic as createProgressBars)
    let accountData: any = null;

    // Try left entity's replica first
    const leftReplica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(leftId + ':'));

    if (leftReplica?.[1]?.state?.accounts) {
      // Account key is the counterparty ID
      accountData = leftReplica[1].state.accounts.get(rightId);
    }

    // Try right entity's replica if not found
    if (!accountData) {
      const rightReplica = Array.from(currentReplicas.entries() as [string, any][])
        .find(([key]) => key.startsWith(rightId + ':'));

      if (rightReplica?.[1]?.state?.accounts) {
        accountData = rightReplica[1].state.accounts.get(leftId);
      }
    }

    if (!accountData) {
      return {
        left: "No account",
        right: "No account",
        leftEntity: getEntityShortName(leftId),
        rightEntity: getEntityShortName(rightId)
      };
    }

    // Get available tokens for this connection
    const availableTokens = accountData.deltas ? Array.from(accountData.deltas.keys() as IterableIterator<number>).sort((a, b) => a - b) : [];

    if (availableTokens.length === 0) {
      return {
        left: "No tokens",
        right: "No tokens",
        leftEntity: getEntityShortName(leftId),
        rightEntity: getEntityShortName(rightId)
      };
    }

    // Get token delta (use selected or fallback to first available)
    let tokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
    let displayTokenId = selectedTokenId;

    if (!tokenDelta && availableTokens.length > 0) {
      displayTokenId = availableTokens[0]!;
      tokenDelta = getAccountTokenDelta(accountData, displayTokenId);
    }

    if (!tokenDelta) {
      throw new Error(`FINTECH-SAFETY: Token ${displayTokenId} not found despite being in availableTokens`);
    }

    // Derive data for BOTH perspectives
    const leftDerived = deriveEntry(tokenDelta, true);  // Left entity's view
    const rightDerived = deriveEntry(tokenDelta, false); // Right entity's view

    // Format left entity's view
    const leftCollateral = formatFinancialAmount(BigInt(Math.floor(leftDerived.collateral)));
    const leftNet = formatFinancialAmount(BigInt(Math.floor(leftDerived.delta)));
    const leftPeerCredit = formatFinancialAmount(BigInt(Math.floor(leftDerived.peerCreditLimit)));
    const leftOwnCredit = formatFinancialAmount(BigInt(Math.floor(leftDerived.ownCreditLimit)));

    // Format right entity's view
    const rightCollateral = formatFinancialAmount(BigInt(Math.floor(rightDerived.collateral)));
    const rightNet = formatFinancialAmount(BigInt(Math.floor(rightDerived.delta)));
    const rightPeerCredit = formatFinancialAmount(BigInt(Math.floor(rightDerived.peerCreditLimit)));
    const rightOwnCredit = formatFinancialAmount(BigInt(Math.floor(rightDerived.ownCreditLimit)));

    const leftName = getEntityShortName(leftId);
    const rightName = getEntityShortName(rightId);

    // Build concise tooltip content - just the numbers
    const leftContent = `Their Credit: ${leftPeerCredit}\nCollateral: ${leftCollateral}\nOur Credit: ${leftOwnCredit}\nNet: ${leftNet}`;
    const rightContent = `Our Credit: ${rightOwnCredit}\nCollateral: ${rightCollateral}\nTheir Credit: ${rightPeerCredit}\nNet: ${rightNet}`;

    return {
      left: leftContent,
      right: rightContent,
      leftEntity: leftName,
      rightEntity: rightName
    };
  }

  function onWindowResize() {
    if (!camera || !renderer || !container) return;

    const containerWidth = container.clientWidth || window.innerWidth;
    const containerHeight = container.clientHeight || window.innerHeight;

    camera.aspect = containerWidth / containerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(containerWidth, containerHeight);
  }

</script>

<!-- Graph3D Panel - Pure 3D rendering (no sidebar) -->
<div bind:this={container} class="graph3d-panel"></div>

<style>
  .graph3d-panel {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
    background: #000;
  }

  :global(.graph3d-panel canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
