<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get, type Writable } from 'svelte/store';
  import * as THREE from 'three';
  import type { OrbitControls as OrbitControlsType } from 'three/examples/jsm/controls/OrbitControls.js';

  // VR Hand tracking
  import { VRHandTrackingController, type GrabbableEntity } from '../utils/vrHandTracking';

  // Visual effects system
  // import VisualDemoPanel from '../Views/VisualDemoPanel.svelte'; // TODO: Move to view/
  // import AdminPanel from '../Admin/AdminPanel.svelte'; // TODO: Move to view/
  // import VRScenarioBuilder from '../VR/VRScenarioBuilder.svelte'; // TODO: Move to view/

  // Network3D managers
  import { EntityManager } from '$lib/network3d/EntityManager';
  import { createAccountBars } from '$lib/network3d/AccountBarRenderer';

  // Panel communication
  import { panelBridge } from '../utils/panelBridge';
  import { PerformanceMonitor, type PerfMetrics } from '../utils/perfMonitor';
  import { entityPositions, type RelativeEntityPosition } from '$lib/stores/xlnStore';
  import VRControlsHUD from '../components/VRControlsHUD.svelte';
  import { HandGesturePaymentController } from '../utils/handGesturePayments';
  import EntityMiniPanel from '../components/EntityMiniPanel.svelte';

  // Mini panel state for entity click
  let showMiniPanel = false;
  let miniPanelEntityId = '';
  let miniPanelEntityName = '';
  let miniPanelPosition = { x: 0, y: 0 };

  // Props - REQUIRED for /view isolation (dead props removed)
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;
  export let isolatedTimeIndex: Writable<number>;

  // Time-travel aware: Read from history[timeIndex] when scrubbing, else live state
  $: env = (() => {
    const timeIdx = $isolatedTimeIndex;
    const historyFrames = $isolatedHistory;
    if (timeIdx >= 0 && historyFrames && historyFrames.length > 0) {
      const idx = Math.min(timeIdx, historyFrames.length - 1);
      return historyFrames[idx];  // Historical frame
    }
    return $isolatedEnv;  // Live state
  })();

  // Extract replicas from env (replaces $replicas)
  $: replicas = env?.eReplicas || new Map();

  // Derive activeJurisdiction: from env.activeJurisdiction OR first jReplica name (for time-travel)
  // EnvSnapshot stores jReplicas[] but not activeJurisdiction - we derive it
  $: activeJurisdictionName = env?.activeJurisdiction
    || (env?.jReplicas?.length > 0 ? env.jReplicas[0].name : null)
    || (Array.isArray(env?.jReplicas) && env.jReplicas[0]?.name)
    || null;

  // Derive jurisdictions data for 3D rendering (properly tracks env changes)
  $: jurisdictionsData = (() => {
    if (!env?.jReplicas) return [];

    let jReplicaValues: any[] = [];
    if (env.jReplicas instanceof Map) {
      jReplicaValues = Array.from(env.jReplicas.values());
    } else if (Array.isArray(env.jReplicas)) {
      jReplicaValues = env.jReplicas;
    } else if (typeof env.jReplicas === 'object') {
      jReplicaValues = Object.values(env.jReplicas);
    }

    return jReplicaValues.map((jr: any) => ({
      name: jr.name,
      jMachine: {
        position: jr.position || { x: 0, y: 600, z: 0 },
        capacity: 3,
        jHeight: Number(jr.blockNumber || 0n),
        mempool: jr.mempool || []
      }
    }));
  })();

  /**
   * Get time-aware replicas - computes directly from stores to avoid stale reactive variable
   * Use this in functions called during store subscription callbacks where reactive vars may be stale
   */
  function getTimeAwareReplicas(): Map<string, any> {
    const timeIndex = get(isolatedTimeIndex);
    const hist = get(isolatedHistory);
    if (timeIndex >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIndex, hist.length - 1);
      return hist[idx]?.eReplicas || new Map();
    }
    return get(isolatedEnv)?.eReplicas || new Map();
  }

  /**
   * Get reserve values from reserves object (handles both Map and plain Object formats)
   * Maps serialize to plain objects when passed through postMessage/JSON
   */
  function getReserveValues(reserves: Map<string, bigint> | Record<string, unknown> | undefined): bigint[] {
    if (!reserves) return [];
    // If it's a Map, use .values()
    if (reserves instanceof Map) {
      return Array.from(reserves.values());
    }
    // If it's a plain object (serialized Map), use Object.values()
    if (typeof reserves === 'object') {
      return Object.values(reserves).map((v: unknown) => {
        // Handle string representations of BigInt (e.g., "5000000000000000000000000n")
        if (typeof v === 'string') {
          const numStr = v.replace(/n$/, '');
          return BigInt(numStr);
        }
        return BigInt(v as bigint);
      });
    }
    return [];
  }

  /**
   * Get total reserves from replica state (handles both Map and Object formats)
   */
  function getTotalReserves(replica: any): bigint {
    const values = getReserveValues(replica?.state?.reserves);
    let total = 0n;
    for (const amount of values) {
      total += amount;
    }
    return total;
  }

  /**
   * Get single reserve value by key (handles both Map and serialized Object)
   */
  function getReserveValue(reserves: Map<string, bigint> | Record<string, unknown> | undefined, key: string): bigint {
    if (!reserves) return 0n;
    if (reserves instanceof Map) {
      // Try both string and number keys (Map may have number keys in some cases)
      return reserves.get(key) || (reserves as Map<any, bigint>).get(Number(key)) || 0n;
    }
    if (typeof reserves === 'object') {
      const v = (reserves as Record<string, unknown>)[key];
      if (v === undefined || v === null) return 0n;
      if (typeof v === 'string') {
        return BigInt(v.replace(/n$/, ''));
      }
      return BigInt(v as bigint);
    }
    return 0n;
  }

  // J-block history entry interface
  interface JBlockHistoryEntry {
    blockNumber: bigint;
    container: THREE.Group;
    txCubes: THREE.Object3D[];
    yOffset: number;
  }

  // XLN runtime interface
  interface XLNRuntime {
    deriveDelta: (delta: { [tokenId: number]: bigint }, isLeft: boolean) => DerivedAccountData;
    getTokenInfo: (tokenId: number) => { symbol: string; decimals: number } | undefined;
    getEntityShortId: (entityId: string) => string;
    isLeft: (myEntityId: string, counterpartyEntityId: string) => boolean;
    executeScenario: (env: unknown, scenario: unknown) => Promise<{ success: boolean; framesGenerated: number; errors?: string[] }>;
    process: (env: unknown, inputs: unknown[]) => Promise<void>;
    parseScenario: (text: string) => { errors: unknown[]; scenario: unknown };
    classifyBilateralState: (myAccount: unknown, peerCurrentHeight: number | undefined, isLeft: boolean) => { state: string; isLeftEntity: boolean; shouldRollback: boolean; pendingHeight: number | null; mempoolCount: number };
    getAccountBarVisual: (leftState: unknown, rightState: unknown) => { glowColor: string | null; glowSide: string | null; glowIntensity: number; isDashed: boolean; pulseSpeed: number };
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
  const settings = { theme: 'dark', portfolioScale: 5000, dollarsPerPx: 30000 };
  const effectOperations = {
    clear: () => {},
    enqueue: (...args: unknown[]) => {},
    process: (...args: unknown[]) => {}
  };
  const createRenderer = async (mode: string, options: THREE.WebGLRendererParameters) => {
    if (mode === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        // @ts-ignore - WebGPURenderer not in main Three.js types but exists in r180
        const { default: WebGPURenderer } = await import('three/src/renderers/webgpu/WebGPURenderer.js');
        const renderer = new WebGPURenderer({ antialias: options.antialias });
        await renderer.init();
        return renderer;
      } catch (err) {
        // WebGPU fallback to WebGL (silent)
      }
    }
    return new THREE.WebGLRenderer(options);
  };
  type RendererMode = 'webgl' | 'webgpu';

  /**
   * Dispose Three.js Object3D and all its children, geometry, and materials
   * Prevents GPU memory leaks by properly releasing all resources
   */
  function disposeObject3D(obj: THREE.Object3D): void {
    obj.traverse((child: any) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mat = child.material;
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else {
          mat.dispose();
        }
      }
    });
  }

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
    // NOTE: Entity sizes stored globally in lockedEntitySizes Map, not per-entity
    // NOTE: reserveLabel removed - too noisy
    mempoolIndicator?: THREE.Sprite; // Mempool count indicator
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
    mempoolBoxes?: { leftBox: THREE.Group; rightBox: THREE.Group } | null | undefined;
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
  let renderer: THREE.WebGLRenderer | any; // WebGPURenderer fallback
  let controls: any;
  let raycaster: THREE.Raycaster;
  let mouse: THREE.Vector2;

  // Network3D managers
  let entityManager: EntityManager;

  // Visual effects system
let spatialHash: SpatialHash;
let gestureManager: GestureManager;
let vrHammer: VRHammer | null = null;
  let entityMeshMap = new Map<string, THREE.Object3D | undefined>();
  let lastJEventId: string | null = null;

  // J-Machines (one per jurisdiction) - broadcast visualization
  let jMachines: Map<string, THREE.Group> = new Map(); // jurisdiction name → J-Machine mesh

  // Active J-Machine - derived from activeJurisdictionName (handles time-travel)
  $: jMachine = activeJurisdictionName ? jMachines.get(activeJurisdictionName) || null : null;

  let jMachineTxBoxes: (THREE.Group | THREE.Mesh)[] = []; // Yellow tx cubes inside J-Machine (current mempool)
  let jBlockHistory: JBlockHistoryEntry[] = []; // Last 3 committed blocks stacked above J-machine
  let jMachineCapacity = 3; // Max txs before broadcast (lowered to show O(n) problem)
  let broadcastEnabled = true;

  // J-Machine Auto-Proposer: Single-signer consensus simulation
  // J acts as super-entity that auto-proposes every N seconds
  let jAutoProposerInterval: ReturnType<typeof setInterval> | null = null;
  let jProposalIntervalMs = 1000; // 1 second default - configurable
  let jLastProposalTime = 0; // Track last proposal timestamp
  let jAutoProposerEnabled = true; // Enable/disable auto-proposer
  let lastAnimatedFrameIndex = -1; // Track which frame we last animated (to avoid re-animating)

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

  // Active animations tracking
  let entityInputStrikes: Array<{
    line: THREE.Line;
    startTime: number;
    duration: number;
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
  let activeBroadcastSpheres: Array<{ sphere: THREE.Mesh; animationId: number }> = [];
  let hoveredObject: any = null;
  // NOTE: hoveredEntity removed - reserve labels were removed
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
  let hasMoved: boolean = false; // Track if actual movement occurred during drag
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
        barsMode: 'close',  // Center mode by default
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
        barsMode: 'close',  // Center mode by default
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
  let gridColor: string = '#ffffff'; // White for better contrast with 3x3 grid
  let autoRotate: boolean = false;
  let autoRotateSpeed: number = 0.5; // RPM
  let showFpsOverlay: boolean = false; // Controlled by settings
  let cameraDistance: number = 500;
  let cameraTarget: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  let gridHelper: THREE.GridHelper | null = null;
  let resizeDebounceTimer: number | null = null;
  let gridPulseIntensity: number = 0; // 0-1, animates on J-Machine broadcasts

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

  // ===== CREATE J-MACHINES FOR EACH JURISDICTION =====
  // Time-aware: Uses jurisdictionsData which properly tracks env/history changes
  $: if (scene && jurisdictionsData) {
    // Use pre-computed jurisdictionsData (tracks env reactively)
    const jurisdictionsArray = jurisdictionsData;

    // Remove J-Machines that no longer exist
    const currentJurisdictionNames = new Set(jurisdictionsArray.map(x => x.name));
    for (const [name, mesh] of jMachines.entries()) {
      if (!currentJurisdictionNames.has(name)) {
        scene.remove(mesh);
        jMachines.delete(name);
      }
    }

    // Create new J-Machines
    jurisdictionsArray.forEach((jurisdiction) => {
      if (!jMachines.has(jurisdiction.name)) {
        const jMachineGroup = createJMachine(12, jurisdiction.jMachine.position, jurisdiction.name, jurisdiction.jMachine.jHeight); // 2x smaller for Fed Chair UX
        scene.add(jMachineGroup);
        jMachines.set(jurisdiction.name, jMachineGroup);
      }
    });

    // Update J-Machine labels with current time-sliced jHeight (reactive to time machine)
    jurisdictionsArray.forEach((jurisdiction) => {
      const jMachineGroup = jMachines.get(jurisdiction.name);
      if (jMachineGroup) {
        // Find the label sprite (last child added in createJMachine)
        const label = jMachineGroup.children.find((child: any) => child.isSprite) as THREE.Sprite | undefined;
        if (label && label.material && label.material.map) {
          // Recreate label texture with updated jHeight
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (context) {
            canvas.width = 256;
            canvas.height = 64;
            context.fillStyle = '#66ccff';
            context.font = 'bold 28px monospace';
            context.textAlign = 'center';
            const shortName = jurisdiction.name.split(' ')[0].substring(0, 8);
            context.fillText(`${shortName} (#${jurisdiction.jMachine.jHeight})`, 128, 40);

            // Update texture
            const texture = new THREE.CanvasTexture(canvas);
            label.material.map = texture;
            label.material.needsUpdate = true;
          }
        }
      }
    });

    // Sync J mempool visual: show tx cubes based on actual mempool contents from snapshot
    const activeJurisdiction = jurisdictionsArray.find(x => x.name === activeJurisdictionName);
    const activeJMachine = activeJurisdiction ? jMachines.get(activeJurisdiction.name) : undefined;
    if (activeJurisdiction && activeJMachine) {
      // Read mempool size directly from jReplica snapshot (canonical source of truth)
      const mempoolSize = activeJurisdiction.jMachine.mempool?.length || 0;

      // Get PREVIOUS frame for broadcast detection
      const timeIdx = $isolatedTimeIndex;
      const historyFrames = $isolatedHistory;
      let prevMempoolSize = 0;
      let prevFrame = null;
      if (historyFrames && historyFrames.length > 0) {
        const prevFrameIdx = timeIdx === -1 ? historyFrames.length - 2 : timeIdx - 1;
        if (prevFrameIdx >= 0 && prevFrameIdx < historyFrames.length) {
          prevFrame = historyFrames[prevFrameIdx];
          const prevJReplicas = prevFrame?.jReplicas;
          if (prevJReplicas) {
            const prevJReplicaArr = Array.isArray(prevJReplicas) ? prevJReplicas : Array.from(prevJReplicas.values());
            const prevJR = prevJReplicaArr.find((jr: any) => jr.name === activeJurisdiction.name);
            prevMempoolSize = prevJR?.mempool?.length || 0;
          }
        }
      }

      // DUMB PIPE: Always clear and recreate mempool cubes from current jReplica state
      // Clear old cubes
      jMachineTxBoxes.forEach(cube => {
        if (cube && activeJMachine) {
          activeJMachine.remove(cube);
          disposeObject3D(cube);
        }
      });
      jMachineTxBoxes = [];

      // Render current mempool (dumb pipe - just show state)
      const mempool = activeJurisdiction.jMachine.mempool || [];
      const currentJHeight = activeJurisdiction.jMachine.jHeight || 0;
      const nextBlockHeight = Number(currentJHeight) + 1;

      mempool.forEach((tx: any, txIndex: number) => {
        const txCube = createMempoolTxCube(txIndex, tx, nextBlockHeight);
        activeJMachine.add(txCube);
        jMachineTxBoxes.push(txCube);
      });

      // BROADCAST DETECTION: jHeight increased (canonical signal for block finalization)
      if (prevFrame) {
        const prevJReplica = prevFrame.jReplicas?.find((jr: any) => jr.name === activeJurisdiction.name);
        const prevJHeight = Number(prevJReplica?.jHeight || 0);
        const currJHeightNum = Number(currentJHeight);

        if (currJHeightNum > prevJHeight && prevMempoolSize > 0) {
          const blockNumber = BigInt(currJHeightNum);
          const prevMempool = prevJReplica?.mempool || [];

          // Create block using shared function (DRY)
          const { container: blockContainer, txCubes } = createBlockContainer(
            blockNumber,
            prevMempool,
            activeJMachine.position,
            15 // Initial yOffset for new block
          );

          // Stack existing blocks upward
          const blockSpacing = 15;
          jBlockHistory.forEach(block => {
            block.yOffset += blockSpacing;
            block.container.position.y = activeJMachine.position.y + block.yOffset;
          });

          // Position new block above J-machine
          blockContainer.position.copy(activeJMachine.position);
          blockContainer.position.y += blockSpacing;
          scene.add(blockContainer);

          jBlockHistory.push({
            blockNumber,
            container: blockContainer,
            txCubes,
            yOffset: blockSpacing
          });

          // Keep only last 3 blocks
          while (jBlockHistory.length > 3) {
            const oldBlock = jBlockHistory.shift();
            if (oldBlock) {
              scene.remove(oldBlock.container);
              disposeObject3D(oldBlock.container);
            }
          }

          // Broadcast effect
          createProportionalBroadcast(activeJMachine.position, prevMempoolSize);
        }
      }

      // TIME-TRAVEL: Reconstruct blockchain from runtime history (dumb pipe - just read state)
      // Iterate backward to find block boundaries (jHeight changes)
      const currentHeightNum = Number(currentJHeight);
      const runtimeHistory = $isolatedHistory || [];

      if (runtimeHistory.length > 0 && currentHeightNum > 0) {
        // Find last 3 committed blocks (heights N-1, N-2, N-3 where N = current)
        // For each height, find LAST frame at that height and read its mempool
        const blockBoundaries: Array<{ blockNum: number; txs: any[] }> = [];

        for (let targetHeight = currentHeightNum - 1; targetHeight >= Math.max(0, currentHeightNum - 3); targetHeight--) {
          // Walk backward to find LAST frame at or below targetHeight (handles jHeight jumps)
          const maxFrameIdx = $isolatedTimeIndex >= 0 ? Math.min($isolatedTimeIndex, runtimeHistory.length - 1) : runtimeHistory.length - 1;
          let foundFrame = null;
          let foundIdx = -1;
          let foundHeight = -1;

          for (let frameIdx = maxFrameIdx; frameIdx >= 0; frameIdx--) {
            const frame = runtimeHistory[frameIdx];
            const frameJReplica = frame?.jReplicas?.find((jr: any) => jr.name === activeJurisdiction.name);
            const frameJHeight = Number(frameJReplica?.jHeight || frameJReplica?.blockNumber || 0);

            // Find closest frame <= targetHeight (handles skipped heights)
            if (frameJHeight <= targetHeight && frameJHeight > 0) {
              foundFrame = frameJReplica;
              foundIdx = frameIdx;
              foundHeight = frameJHeight;
              break;
            }
          }

          if (foundFrame) {
            const txs = foundFrame.mempool || [];

            blockBoundaries.push({
              blockNum: foundHeight + 1,
              txs: txs.slice(0, 9)
            });
          } else {
          }
        }

        // Only rebuild if block boundaries changed
        const expectedBlocks = blockBoundaries.length;
        if (jBlockHistory.length !== expectedBlocks ||
            (jBlockHistory[0] && Number(jBlockHistory[0].blockNumber) !== blockBoundaries[0]?.blockNum)) {

          // Clear old blocks
          jBlockHistory.forEach(block => {
            scene.remove(block.container);
            disposeObject3D(block.container);
          });
          jBlockHistory = [];

          // Render blocks (oldest first for proper stacking)
          blockBoundaries.reverse().forEach((boundary, idx) => {
            const blockNum = BigInt(boundary.blockNum);
            const yOffset = (blockBoundaries.length - idx) * 15; // Stack upward

            // Create block using shared function (DRY)
            const { container: blockContainer, txCubes } = createBlockContainer(
              blockNum,
              boundary.txs,
              activeJMachine.position,
              yOffset
            );

            scene.add(blockContainer);

            jBlockHistory.push({
              blockNumber: blockNum,
              container: blockContainer,
              txCubes,
              yOffset
            });
          });
        }
      }
    }
  }

  // Create a tx cube for mempool visualization with label
  // Cubes STACK INSIDE the J-machine cube container (like Tetris)
  // J-Machine size is 12x12x12, so cubes must be small enough to fit
  function createMempoolTxCube(index: number, tx?: any, blockHeight?: number): THREE.Group {
    const group = new THREE.Group();

    const cubeSize = 1.5; // Small tx cubes - fit 3x3 grid inside J-Machine (size=12)
    const geometry = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
    const material = new THREE.MeshLambertMaterial({
      color: 0xffcc00, // Bright yellow for pending tx
      transparent: true,
      opacity: 0.95,
      emissive: 0xffaa00,
      emissiveIntensity: 0.8
    });
    const cube = new THREE.Mesh(geometry, material);
    group.add(cube);

    // Position cubes in a 3x3 grid INSIDE the J-machine cube (size=12, half=6)
    // Grid: 3x3 base, stacking up
    const gridSize = 3;
    const spacing = 2.5; // Space between cubes (fits 3 cubes in ~7.5 width)
    const xIndex = index % gridSize;
    const zIndex = Math.floor(index / gridSize) % gridSize;
    const yIndex = Math.floor(index / (gridSize * gridSize));

    // Center the grid inside the cube (offset from center)
    const halfGrid = (gridSize - 1) * spacing / 2;
    group.position.set(
      -halfGrid + xIndex * spacing,
      -4 + yIndex * spacing, // Start near bottom of cube (-6 + 2 buffer)
      -halfGrid + zIndex * spacing
    );

    // Add text label below cube (if tx data available)
    if (tx) {
      const label = formatMempoolTxLabel(tx, blockHeight);
      const labelSprite = createTxLabelSprite(label);
      labelSprite.position.set(0, -(cubeSize + 0.3), 0); // Below the cube
      group.add(labelSprite);
    }

    return group;
  }

  // Format mempool tx into detailed label with batch contents
  function formatMempoolTxLabel(tx: any, blockHeight?: number): string {
    if (!tx) return 'batch';

    // If it's a batch with data, show detailed contents
    if (tx.type === 'batch' && tx.data?.batch) {
      const batch = tx.data.batch;
      const parts: string[] = [];

      // R2R operations (neutral - white)
      const r2rCount = batch.reserveToReserve?.length || 0;
      if (r2rCount > 0) parts.push(`${r2rCount}R2R`);

      // R2C operations (deposits - green)
      const r2cCount = batch.reserveToCollateral?.length || 0;
      if (r2cCount > 0) parts.push(`+${r2cCount}R2C`);

      // Settlements (red/green based on diffs)
      const settlements = batch.settlements || [];
      let withdrawals = 0; // Red (collateral out)
      let deposits = 0; // Green (collateral in)

      for (const settle of settlements) {
        for (const diff of settle.diffs || []) {
          if (diff.collateralDiff < 0) withdrawals++;
          if (diff.collateralDiff > 0) deposits++;
        }
      }

      if (withdrawals > 0) parts.push(`-${withdrawals}W`); // W=withdrawal (red)
      if (deposits > 0) parts.push(`+${deposits}D`); // D=deposit (green)

      const summary = parts.join(' ') || 'empty';
      const fromEntity = tx.entityId?.slice(-1) || '?';
      return `E${fromEntity}: ${summary}`;
    }

    // Legacy format
    const blockPrefix = blockHeight !== undefined ? `#${blockHeight} ` : '';
    const type = (tx.type || 'tx').toUpperCase();
    const from = tx.from?.slice(-1) || '?';
    const to = tx.to?.slice(-1) || '?';
    const amount = tx.amount ? `$${Number(tx.amount / (10n ** 18n) / 1_000_000n)}M` : '';
    return `${blockPrefix}${type}: ${from}→${to} ${amount}`.trim();
  }

  // Create text sprite for tx label with dual-color support for mixed W/D
  function createTxLabelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 48;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = 'bold 14px monospace';
    ctx.textBaseline = 'middle';

    // Check if text has BOTH withdrawals and deposits
    const hasWithdrawals = text.includes('-') && text.includes('W');
    const hasDeposits = text.includes('+') && text.includes('D');

    if (hasWithdrawals && hasDeposits) {
      // Dual-color: Split text and render each part separately
      // Example: "E2: -1W +1D" → "E2: " (yellow) + "-1W" (red) + " " + "+1D" (green)
      const parts = text.split(/(\-\d+W|\+\d+D)/g).filter(p => p);

      ctx.textAlign = 'left';
      let x = 10; // Start position

      for (const part of parts) {
        if (part.match(/\-\d+W/)) {
          ctx.fillStyle = '#ff4444'; // Red for withdrawals
        } else if (part.match(/\+\d+D/)) {
          ctx.fillStyle = '#00ff88'; // Green for deposits
        } else {
          ctx.fillStyle = '#ffcc00'; // Yellow for entity/neutral
        }

        ctx.fillText(part, x, 24);
        x += ctx.measureText(part).width;
      }
    } else {
      // Single color (existing logic)
      ctx.textAlign = 'center';

      if (hasDeposits) {
        ctx.fillStyle = '#00ff88'; // Green
      } else if (hasWithdrawals) {
        ctx.fillStyle = '#ff4444'; // Red
      } else {
        ctx.fillStyle = '#ffcc00'; // Yellow
      }

      ctx.fillText(text, 128, 24);
    }

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(3, 0.75, 1); // Wide and short
    return sprite;
  }

  // Animation speed multiplier (1.0 = normal, higher = faster)
  // Connected to TimeMachine speed via panelBridge
  let animationSpeed = 1.0;

  // Create J-block broadcast effect when mempool clears
  // Expanding wireframe sphere from J-Machine - radio wave to entire universe
  /**
   * Create blockchain block container (DRY - used in live + time-travel)
   */
  function createBlockContainer(
    blockNum: bigint,
    txs: any[],
    jMachinePos: THREE.Vector3,
    yOffset: number
  ): { container: THREE.Group; txCubes: THREE.Object3D[] } {
    const blockContainer = new THREE.Group();
    blockContainer.userData['blockNumber'] = blockNum;
    blockContainer.position.copy(jMachinePos);
    blockContainer.position.y += yOffset;

    // J-mempool style box
    const blockSize = 12;
    const blockCubeGeo = new THREE.BoxGeometry(blockSize, blockSize, blockSize);
    const blockCubeMat = new THREE.MeshPhongMaterial({
      color: 0x4488aa,
      emissive: 0x224455,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      shininess: 100,
      depthWrite: false
    });
    const blockCube = new THREE.Mesh(blockCubeGeo, blockCubeMat);
    blockContainer.add(blockCube);

    // Cyan edges
    const blockEdgesGeo = new THREE.EdgesGeometry(blockCubeGeo);
    const blockEdgesMat = new THREE.LineBasicMaterial({ color: 0x66ccff, linewidth: 2 });
    const blockEdges = new THREE.LineSegments(blockEdgesGeo, blockEdgesMat);
    blockContainer.add(blockEdges);

    // Create TX cubes
    const txCubes: THREE.Object3D[] = [];
    txs.slice(0, 9).forEach((tx: any, txIdx: number) => {
      const txCube = createMempoolTxCube(txIdx, tx, Number(blockNum));
      blockContainer.add(txCube);
      txCubes.push(txCube);
    });

    return { container: blockContainer, txCubes };
  }

  /**
   * Proportional broadcast effect: sphere intensity based on TX count
   * More TXs = bigger, brighter, longer duration effect
   */
  function createProportionalBroadcast(jMachinePos: THREE.Vector3, txCount: number) {
    if (!scene || txCount === 0) return;

    // Intensity based on TX count (1 TX = minimal, 5+ TXs = max effect)
    const intensity = Math.min(txCount / 5, 1.0);
    const maxScale = 30 + intensity * 70; // 30-100 scale based on TX count
    const duration = 800 + intensity * 700; // 800-1500ms based on TX count

    const sphereGeometry = new THREE.SphereGeometry(1, 32, 32);
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0x44ffaa,
      transparent: true,
      opacity: 0.3 + intensity * 0.3, // 0.3-0.6 opacity
      side: THREE.DoubleSide
    });
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    sphere.position.copy(jMachinePos);
    scene.add(sphere);

    const startTime = performance.now();
    let rafId: number;

    function animateExpand() {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out quad
      const eased = 1 - Math.pow(1 - progress, 2);

      const scale = 1 + eased * maxScale;
      sphere.scale.set(scale, scale, scale);
      sphereMaterial.opacity = (0.3 + intensity * 0.3) * (1 - progress);

      if (progress < 1) {
        rafId = requestAnimationFrame(animateExpand);
      } else {
        // Animation complete - cleanup
        scene.remove(sphere);
        sphereGeometry.dispose();
        sphereMaterial.dispose();
        // Remove from tracking
        activeBroadcastSpheres = activeBroadcastSpheres.filter(s => s.sphere !== sphere);
      }
    }

    rafId = requestAnimationFrame(animateExpand);
    // Track sphere for cleanup on destroy
    activeBroadcastSpheres.push({ sphere, animationId: rafId });
  }

  // ===== ADD TXS TO J-MACHINE (broadcast simulation) + R2R ANIMATION =====
  // CRITICAL: Watch HISTORY frames, not env.runtimeInput (which is cleared after processing)
  // Only animate in LIVE mode - historical playback should show static state
  $: if (jMachine && $isolatedTimeIndex === -1) {
    const historyFrames = $isolatedHistory;
    const currentLen = historyFrames?.length || 0;

    // Animate any NEW frames we haven't processed yet
    if (currentLen > lastAnimatedFrameIndex + 1) {
      for (let i = lastAnimatedFrameIndex + 1; i < currentLen; i++) {
        const frame = historyFrames[i];
        const entityInputs = frame?.runtimeInput?.entityInputs || [];

        entityInputs.forEach((entityInput: any) => {
          // Support both old format (input.txs) and new format (entityTxs)
          const txs = entityInput?.entityTxs || entityInput?.input?.txs || [];
          txs.forEach((tx: any) => {
            // Check if it's a reserve-related transaction (R2R)
            const txKind = tx.kind || tx.type;
            if (txKind === 'payFromReserve' || txKind === 'payToReserve' || txKind === 'settleToReserve') {

              addTxToJMachine(entityInput.entityId);

              // R2R animation: particle flies from source to target
              const targetId = tx.targetEntityId || tx.data?.targetEntityId;
              const amount = tx.amount || tx.data?.amount;
              if (txKind === 'payFromReserve' && targetId) {
                // animateR2RTransfer deleted - instant state change
              }
            }
          });
        });
      }
      lastAnimatedFrameIndex = currentLen - 1;
    }
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

  // entitySizeCache removed - now using frame-locked entitySizesAtFrame

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

  // Hand tracking controller (Vision Pro + Quest)
  let handTrackingController: VRHandTrackingController | null = null;

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
        } catch (err) {
          isVRSupported = false;
        }
      } else {
        isVRSupported = false;
      }

      await initThreeJS();
      // updateNetworkData() is called automatically by reactive statement: $: if ($isolatedEnv && scene)
      animate();

      // Start J auto-proposer (1-second instant consensus simulation)
      startJAutoProposer();
    };

    initAndSetup().catch(error => {
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
    };
    panelBridge.on('broadcast:toggle', handleBroadcastToggle);

    // Settings updates from SettingsPanel
    const handleSettingsUpdate = (event: any) => {
      const { key, value } = event;

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
      else if (key === 'autoRotate') autoRotate = value;
      else if (key === 'autoRotateSpeed') autoRotateSpeed = value;
      else if (key === 'showFpsOverlay') showFpsOverlay = value;

      // Recreate scene for grid changes
      if (['gridSize', 'gridDivisions', 'gridOpacity', 'gridColor'].includes(key)) {
        recreateGrid();
      }
    };

    const handleSettingsReset = () => {
      gridSize = 300;
      gridDivisions = 60;
      gridOpacity = 0.4;
      gridColor = '#ffffff';
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
      }
    };

    const handlePlaybackSpeed = (newSpeed: number) => {
      animationSpeed = newSpeed;
    };
    panelBridge.on('settings:update', handleSettingsUpdate);
    panelBridge.on('settings:reset', handleSettingsReset);
    panelBridge.on('camera:focus', handleCameraFocus);
    panelBridge.on('playback:speed', handlePlaybackSpeed);

    // FIXED: Single debounced update function to prevent multiple simultaneous calls
    let updateTimeout: ReturnType<typeof setTimeout> | null = null;
    const debouncedUpdate = () => {
      if (updateTimeout) clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        if (scene) updateNetworkData();
        updateTimeout = null;
      }, 16); // ~60fps max update rate
    };

    const unsubscribe1 = isolatedEnv.subscribe(debouncedUpdate);
    const unsubscribe2 = isolatedTimeIndex.subscribe(debouncedUpdate);
    const unsubscribe3 = isolatedHistory.subscribe(debouncedUpdate);

    // CRITICAL: Listen for scenario loaded event (from View.svelte after prepopulate)
    const handleScenarioLoaded = () => {
      if (scene) updateNetworkData();
    };
    panelBridge.on('scenario:loaded', handleScenarioLoaded);

    // CRITICAL: Initial render after scene ready (subscriptions fire but scene may not exist yet)
    if (scene) {
      updateNetworkData();
    }

    return () => {
      if (updateTimeout) clearTimeout(updateTimeout);
      unsubscribe1();
      unsubscribe2();
      unsubscribe3();
      panelBridge.off('scenario:loaded', handleScenarioLoaded);
      panelBridge.off('vr:toggle', handleVRToggle);
      panelBridge.off('broadcast:toggle', handleBroadcastToggle);
      panelBridge.off('settings:update', handleSettingsUpdate);
      panelBridge.off('settings:reset', handleSettingsReset);
      panelBridge.off('camera:focus', handleCameraFocus);
      panelBridge.off('playback:speed', handlePlaybackSpeed);
    };
  });

  // FIXED: Removed redundant reactive block - subscriptions handle updates
  // This was causing double/triple updates on every change
  // Subscriptions in onMount already handle all store changes

  let resizeObserver: ResizeObserver | null = null;

  onDestroy(() => {
    // Cleanup J auto-proposer timer
    if (jAutoProposerInterval) {
      clearInterval(jAutoProposerInterval);
      jAutoProposerInterval = null;
    }

    // Cleanup resize observer
    if (resizeObserver && container) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    // Cancel active broadcast animations
    activeBroadcastSpheres.forEach(({ sphere, animationId: rafId }) => {
      cancelAnimationFrame(rafId);
      if (scene) scene.remove(sphere);
      disposeObject3D(sphere);
    });
    activeBroadcastSpheres = [];

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

    // Clean up active animations (prevent memory leak)
    entityInputStrikes.forEach(strike => {
      if (strike.line && scene) {
        scene.remove(strike.line);
        strike.line.geometry.dispose();
        (strike.line.material as THREE.Material).dispose();
      }
    });
    entityInputStrikes = [];

    // Clean up managers
    if (entityManager) {
      entityManager.clear();
    }
  });

  /**
   * Create grid floor centered at origin (large enough to never clip)
   */
  function createGrid() {
    if (!scene) return;

    // Minimal grid: 3x3 divisions for jurisdiction grid
    const fixedSize = 2000; // Diameter = 2000, radius = 1000
    const divisions = 3; // 666px per division (3x3 perfect grid for jurisdictions)

    gridHelper = new THREE.GridHelper(fixedSize, divisions,
      gridColor,  // Center line
      gridColor   // Grid lines (same color, controlled by opacity)
    );
    gridHelper.material.opacity = gridOpacity;
    gridHelper.material.transparent = true;
    gridHelper.position.set(0, -50, 0); // Centered at origin, below entities
    scene.add(gridHelper);

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
   * Create J-Machine as TRANSLUCENT CUBE - mempool container for batching txs
   * Visual: Glass-like cube where you can see tx cubes stacking inside
   */
  function createJMachine(
    size: number = 25,
    position: { x: number; y: number; z: number } = { x: 0, y: 200, z: 0 },
    name: string = 'J-MACHINE',
    jHeight: number = 0
  ): THREE.Group {
    const group = new THREE.Group();
    group.position.set(position.x, position.y, position.z); // Position from jurisdiction config

    // Store jurisdiction name for click handling
    group.userData = {
      type: 'jMachine',
      jurisdictionName: name,
      position
    };

    // CUBE geometry - clear mempool container
    const cubeGeometry = new THREE.BoxGeometry(size, size, size);

    // Translucent glass material - see txs inside
    const cubeMaterial = new THREE.MeshPhongMaterial({
      color: 0x4488aa, // Teal-blue (distinct from entity blue)
      emissive: 0x224455,
      transparent: true,
      opacity: 0.15, // Very translucent - see inside
      side: THREE.DoubleSide,
      shininess: 100,
      depthWrite: false // Prevent z-fighting with inner objects
    });

    const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);
    group.add(cube);

    // Wireframe edges for cube visibility
    const edgesGeometry = new THREE.EdgesGeometry(cubeGeometry);
    const edgesMaterial = new THREE.LineBasicMaterial({
      color: 0x66ccff, // Bright cyan edges
      linewidth: 2
    });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    group.add(edges);

    // Pure cube - no corner spheres

    // Add label with jurisdiction name + block height
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) {
      canvas.width = 256;
      canvas.height = 64;
      context.fillStyle = '#66ccff';
      context.font = 'bold 28px monospace';
      context.textAlign = 'center';
      // Format: "J1 (#123)" - short name + height
      const nameParts = (name ?? 'J').split(' ');
      const shortName = (nameParts[0] ?? 'J').substring(0, 8);
      context.fillText(`${shortName} (#${jHeight ?? 0})`, 128, 40);
    }

    const texture = new THREE.CanvasTexture(canvas);
    const labelMaterial = new THREE.SpriteMaterial({ map: texture });
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(25, 6, 1);
    label.position.set(0, -size / 2 - 8, 0); // Below cube (avoids overlap with blocks above)
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
   * Trigger broadcast animation when J-Machine is full
   * Clears txs from visual mempool
   */
  function triggerBroadcast() {
    if (!broadcastEnabled || !jMachine || !scene) return;


    // Clear all tx cubes
    jMachineTxBoxes.forEach(txCube => {
      if (jMachine) jMachine.remove(txCube);
    });
    jMachineTxBoxes = [];
  }

  /**
   * Animate R2R transfer: No-op - J-Machine is the core
   * R2R transfers are J-layer operations, visualized by J-Machine mempool filling
   */
  // animateR2RTransfer deleted - TX appears directly in J-mempool, no flying cube

  /**
   * J-Machine Auto-Proposer: Single-signer consensus simulation
   *
   * J acts as a "super entity" that auto-proposes on a timer.
   * When mempool has txs and timer fires:
   * 1. Trigger broadcast rays to all entities
   * 2. Clear visual mempool cubes
   * 3. Clear runtime mempool (via XLN.clearJMempool if available)
   *
   * This simulates instant J consensus without batching delays.
   */
  function startJAutoProposer() {
    if (jAutoProposerInterval) {
      clearInterval(jAutoProposerInterval);
    }

    jLastProposalTime = Date.now();

    jAutoProposerInterval = setInterval(() => {
      if (!jAutoProposerEnabled || !jMachine || !scene) return;

      // Check if there are txs in visual mempool
      if (jMachineTxBoxes.length === 0) return;

      const now = Date.now();
      jLastProposalTime = now;

      // Trigger broadcast animation with rays
      triggerBroadcast();

      // Try to clear runtime mempool if XLN exposes it
      // @ts-ignore - XLN may have clearJMempool method
      if (typeof window !== 'undefined' && (window as any).XLN?.clearJMempool) {
        (window as any).XLN.clearJMempool();
      }

      // Grid pulse effect on broadcast
      gridPulseIntensity = 1.0;
    }, jProposalIntervalMs);
  }

  function stopJAutoProposer() {
    if (jAutoProposerInterval) {
      clearInterval(jAutoProposerInterval);
      jAutoProposerInterval = null;
    }
  }

  async function initThreeJS() {
    // Guard against multiple initializations
    if (renderer || scene) {
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

    camera = new THREE.PerspectiveCamera(
      75,
      containerWidth / containerHeight,
      0.01, // Near plane: zoom extremely close
      100000 // Far plane: see objects at extreme distances
    );
    camera.position.set(0.41, 572.94, 38.32); // AHB top-down view
    // NOTE: controls.target set later after OrbitControls is created

    // Renderer setup with VR support
    renderer = await createRenderer(rendererMode, { antialias: false }); // Disabled for performance
    renderer.xr.enabled = true;  // Enable XR separately
    renderer.setSize(containerWidth, containerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // Cap at 1.5 for performance
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

      // CRITICAL: screenSpacePanning = true for intuitive right-click pan
      // Default is false which makes panning move along camera's local axes
      controls.screenSpacePanning = true;

      // FREE CAMERA - no zoom limits (game-like movement)
      controls.minDistance = 0; // No minimum - zoom into anything
      controls.maxDistance = Infinity; // No maximum - zoom out as far as you want

      // CRITICAL: Disable keyboard events so arrow keys work for TimeMachine
      // OrbitControls uses arrow keys for panning by default
      controls.keys = { LEFT: '', UP: '', RIGHT: '', BOTTOM: '' };

      // Set default target (lookAt point) for AHB view
      controls.target.set(-37, 511, -243);
      controls.update();

      // Emit camera updates for Settings panel live display
      controls.addEventListener('change', () => {
        panelBridge.emit('camera:update', {
          position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
          distance: camera.position.distanceTo(controls.target),
        });
      });
      controls.addEventListener('start', () => {
      });
      controls.addEventListener('end', () => {
      });

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

    // Lights (enhanced for AR passthrough visibility)
    const ambientLight = new THREE.AmbientLight(0x606060, 1.2); // Brighter for AR
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(200, 50, 50); // Position light above grid center
    scene.add(directionalLight);

    // Rim light (makes entities pop against real-world background in AR)
    const rimLight = new THREE.DirectionalLight(0x00ff88, 0.4);
    rimLight.position.set(-200, 30, -50); // Opposite side
    scene.add(rimLight);

    // J-Machines are now created reactively based on env.jReplicas (see reactive statement above)

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
    spatialHash = new SpatialHash(100);
    gestureManager = new GestureManager();
    vrHammer = new VRHammer();

    // Register shake-to-rebalance callback
    gestureManager.on((event: { type: string; entityId: string }) => {
      if (event.type === 'shake-rebalance') {
        handleRebalanceGesture(event.entityId);
      }
    });

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

  }

  /**
   * Initialize VR hand tracking controller
   */
  function initHandTracking(): void {
    if (!renderer || !scene) return;

    // Track grabbed entities for visual feedback
    const grabbedEntities = new Map<string, { originalScale: THREE.Vector3; originalEmissive: number }>();

    handTrackingController = new VRHandTrackingController(
      renderer as THREE.WebGLRenderer,
      scene,
      {
        onGrab: (entityId, handedness) => {
          const entity = entities.find(e => e.id === entityId);
          if (!entity) return;

          entity.isPinned = true;

          // Store original values for reset
          grabbedEntities.set(entityId, {
            originalScale: entity.mesh.scale.clone(),
            originalEmissive: (entity.mesh.material as THREE.MeshLambertMaterial)?.emissiveIntensity || 0
          });

          // Visual feedback: scale up and glow
          entity.mesh.scale.multiplyScalar(1.3);
          if (entity.mesh.material) {
            const mat = entity.mesh.material as THREE.MeshLambertMaterial;
            mat.emissiveIntensity = (mat.emissiveIntensity || 0) + 0.5;
          }

        },

        onRelease: (entityId, targetEntityId, handedness) => {
          const entity = entities.find(e => e.id === entityId);
          if (!entity) return;

          // Restore visual state
          const original = grabbedEntities.get(entityId);
          if (original) {
            entity.mesh.scale.copy(original.originalScale);
            if (entity.mesh.material) {
              const mat = entity.mesh.material as THREE.MeshLambertMaterial;
              mat.emissiveIntensity = original.originalEmissive;
            }
            grabbedEntities.delete(entityId);
          }

          // Trigger payment if released on another entity
          if (targetEntityId) {
            panelBridge.emit('vr:hand-payment', {
              from: entityId,
              to: targetEntityId
            });
          }

        },

        onHover: (entityId, handedness) => {
          // Optional: Add hover highlight effect
          // Could emit event or directly modify entity appearance
        }
      }
    );

    handTrackingController.init();
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
      }
    }
  }

  function onVRSelectEnd() {
    if (vrGrabbedEntity) {
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
        optionalFeatures: [
          'local-floor',
          'bounded-floor',
          'hand-tracking',
          'layers', // Vision Pro AR passthrough
          'dom-overlay', // Better UI integration
          'anchors' // Physical world anchoring
        ],
        requiredFeatures: [] // Keep it compatible
      };

      const session = await (navigator as any).xr.requestSession('immersive-vr', sessionInit);

      await renderer.xr.setSession(session);
      isVRActive = true;

      // Setup hand tracking (Vision Pro passthrough vs Quest mesh)
      initHandTracking();

      // Vision Pro: Enable passthrough (transparent background = see real world)
      scene.background = null; // Transparent = passthrough mode

      // Vision Pro optimization: Position scene for table-top AR
      if (scene) {
        // Scale down for comfortable AR viewing (entities appear table-sized)
        scene.scale.setScalar(0.01); // 1/100 scale = table-sized economy
        scene.position.set(0, -0.5, -1); // Position on table in front of user
      }

      // Create floating welcome panel
      const createWelcomePanel = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 512;
        const ctx = canvas.getContext('2d')!;

        // Gradient background
        const gradient = ctx.createLinearGradient(0, 0, 0, 512);
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0.95)');
        gradient.addColorStop(1, 'rgba(10, 30, 50, 0.95)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 1024, 512);

        // Glowing border
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 6;
        ctx.shadowColor = '#00ffff';
        ctx.shadowBlur = 20;
        ctx.strokeRect(3, 3, 1018, 506);
        ctx.shadowBlur = 0;

        // Title
        ctx.fillStyle = '#00ffff';
        ctx.font = 'bold 56px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('🏦 XLN FINANCIAL NETWORK', 512, 80);

        // Subtitle
        ctx.fillStyle = '#ffffff';
        ctx.font = '28px monospace';
        ctx.fillText('Cross-Jurisdictional Settlement System', 512, 130);

        // Instructions
        ctx.font = 'bold 32px monospace';
        ctx.fillStyle = '#4fd18b';
        ctx.fillText(' GREEN NUMBERS = Bank Reserves', 512, 200);

        ctx.fillStyle = '#00ff41';
        ctx.fillText('🔵 BLUE LINES = Open Accounts', 512, 250);

        ctx.fillStyle = '#ffff00';
        ctx.fillText('🟡 YELLOW DOTS = Payments Flowing', 512, 300);

        // Bottom instruction
        ctx.fillStyle = '#888888';
        ctx.font = '24px monospace';
        ctx.fillText('Payments auto-starting in 3 seconds...', 512, 380);

        ctx.fillStyle = '#aaaaaa';
        ctx.font = 'italic 20px monospace';
        ctx.fillText('(Tap outside panel or wait 10s to dismiss)', 512, 420);

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 1.0,
          side: THREE.DoubleSide
        });
        const geometry = new THREE.PlaneGeometry(1.2, 0.6);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(0, 0.2, -0.8); // In front of user at eye level
        scene.add(mesh);

        // Auto-dismiss after 10 seconds
        setTimeout(() => {
          scene.remove(mesh);
          mesh.geometry.dispose();
          mesh.material.map?.dispose();
          mesh.material.dispose();
        }, 10000);

        return mesh;
      };

      const welcomePanel = createWelcomePanel();

      // Auto-start payment demo after 3 seconds in VR
      setTimeout(() => {
        panelBridge.emit('auto-demo:start', {});
      }, 3000);

      // Switch to VR animation loop
      renderer.setAnimationLoop(animate);


      // Listen for session end
      session.addEventListener('end', () => {
        isVRActive = false;

        // Cleanup welcome panel (if still exists)
        if (welcomePanel && scene) {
          scene.remove(welcomePanel);
          welcomePanel.geometry.dispose();
          welcomePanel.material.map?.dispose();
          welcomePanel.material.dispose();
        }

        // Restore scene background
        scene.background = new THREE.Color(0x0a0a0a);

        // Reset scene transform (restore normal desktop view)
        if (scene) {
          scene.scale.setScalar(1);
          scene.position.set(0, 0, 0);
        }

        // Return to regular animation loop
        renderer.setAnimationLoop(null);
        animate();
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

      // TODO: Implement hub rebalance coordination (Phase 3 of docs/next.md)

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

  /**
   * Auto-fit camera to show all entities (fixes zooming issues for spread-out scenarios)
   */
  function fitCameraToEntities() {
    if (!camera || !controls || entities.length === 0) return;

    // Calculate bounding box of all entities
    const box = new THREE.Box3();
    entities.forEach(entity => {
      box.expandByPoint(entity.position);
    });

    // Get center and size
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    // Calculate max dimension
    const maxDim = Math.max(size.x, size.y, size.z);

    // Camera distance = 1.5x max dimension (gives nice view with padding)
    const distance = Math.max(maxDim * 1.5, 50); // Min 50 units away

    // Position camera above and behind center
    camera.position.set(
      center.x,
      center.y + distance * 0.7,  // Above
      center.z + distance * 0.7   // Behind
    );

    // Look at center
    controls.target.copy(center);
    controls.update();
  }

  function updateNetworkData() {
    if (!scene) return;

    const timeIndex = $isolatedTimeIndex;

    // Update available tokens
    updateAvailableTokens();

    // CRITICAL: Compute time-aware env directly here (subscriptions fire before reactive statements)
    // This ensures we always read the correct historical frame
    const computedEnv = (() => {
      const hist = get(isolatedHistory);
      if (timeIndex >= 0 && hist && hist.length > 0) {
        const idx = Math.min(timeIndex, hist.length - 1);
        return hist[idx];  // Historical frame
      }
      return get(isolatedEnv);  // Live state
    })();

    // Use time-aware data sources
    let entityData: any[] = [];
    // Read replicas from computed env, not reactive variable
    let currentReplicas = computedEnv?.eReplicas || new Map();


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

      // Helper to get entity name from gossip profiles (time-aware)
      const getNameFromEnv = (entityId: string): string => {
        if (!computedEnv?.gossip) return '';
        const profiles = typeof computedEnv.gossip.getProfiles === 'function'
          ? computedEnv.gossip.getProfiles()
          : (computedEnv.gossip.profiles || []);
        const profile = profiles.find((p: any) => p.entityId === entityId);
        return profile?.metadata?.name || '';
      };

      entityData = Array.from(uniqueEntityIds).map(entityId => {
        // Prefer gossip name, fallback to entity number (like #1, #2), last resort hex slice
        const gossipName = getNameFromEnv(entityId);
        const shortId = XLN?.getEntityShortId?.(entityId) || entityId.slice(0, 8);
        const displayName = gossipName || (shortId.match(/^\d+$/) ? `Entity #${shortId}` : shortId + '...');

        return {
          entityId,
          capabilities: ['consensus'],
          metadata: { name: displayName }
        };
      });
    }

    // FIXED: Removed excessive console.log

    // NO DEMO DATA - only show what actually exists
    if (entityData.length === 0) {
      debug.warn(`⚠️ No entity data found at frame ${timeIndex} - clearing network`);
      clearNetwork(); // Proper clear - entities will be recreated on next frame with data
      return;
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


    // Reconciliation pattern: diff entities instead of clear/rebuild
    // This prevents GPU memory churn and preserves user-dragged positions
    const currentEntityIds = new Set(entities.map(e => e.id));
    const newEntityIds = new Set(entityData.map(e => e.entityId));

    // Find entities to remove (exist now, not in new data)
    const toRemove = entities.filter(e => !newEntityIds.has(e.id));

    // Find entities to add (in new data, don't exist now)
    const toAdd = entityData.filter(e => !currentEntityIds.has(e.entityId));

    // Remove stale entities with proper disposal
    toRemove.forEach(entity => {
      scene.remove(entity.mesh);
      if (entity.mesh.geometry) entity.mesh.geometry.dispose();
      if (entity.mesh.material) {
        const mat = entity.mesh.material;
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else {
          mat.dispose();
        }
      }
      if (entity.label) {
        scene.remove(entity.label);
        if (entity.label.geometry) entity.label.geometry.dispose();
        if (entity.label.material) entity.label.material.dispose();
      }
    });
    entities = entities.filter(e => newEntityIds.has(e.id));

    // Also reconcile connections - remove those involving removed entities
    const removedIds = new Set(toRemove.map(e => e.id));
    if (removedIds.size > 0) {
      const staleConnections = connections.filter(c => removedIds.has(c.from) || removedIds.has(c.to));
      staleConnections.forEach(connection => {
        scene.remove(connection.line);
        if (connection.line.geometry) connection.line.geometry.dispose();
        if (connection.line.material) {
          const mat = connection.line.material;
          if (Array.isArray(mat)) {
            mat.forEach(m => m.dispose());
          } else {
            mat.dispose();
          }
        }
        if (connection.progressBars) scene.remove(connection.progressBars);
        if (connection.mempoolBoxes) {
          const { leftBox, rightBox } = connection.mempoolBoxes;
          [leftBox, rightBox].forEach(box => {
            if (!box) return;
            scene.remove(box);
            disposeObject3D(box);
          });
        }
      });
      connections = connections.filter(c => !removedIds.has(c.from) && !removedIds.has(c.to));
    }

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

    // Update existing entities in-place (profile, isHub status, scale)
    const entityMap = new Map(entities.map(e => [e.id, e]));
    entityData.forEach(profile => {
      const existing = entityMap.get(profile.entityId);
      if (existing) {
        // Update profile data
        existing.profile = profile;
        existing.isHub = top3Hubs.has(profile.entityId);
        existing.mesh.userData['isHub'] = existing.isHub;

        // SIZE IS FIXED AT CREATION - never recalculate!
        // Size was set when entity was first created, don't touch it
        // This prevents size jumps when reserves change during R2R transfers

        // Update hub cache
        if (existing.isHub && !existing.hubConnectedIds) {
          existing.hubConnectedIds = new Set();
        } else if (!existing.isHub && existing.hubConnectedIds) {
          delete existing.hubConnectedIds;
        }
      }
    });

    // Create ONLY NEW entity nodes (reconciliation - skip existing)
    toAdd.forEach((profile, index) => {
      const isHub = top3Hubs.has(profile.entityId);
      // Pass currentReplicas to avoid stale reactive variable during time-travel
      createEntityNode(profile, index, entityData.length, forceLayoutPositions, isHub, currentReplicas);
    });

    // Save positions after creating entities (for persistence)
    if (!allEntitiesHaveSavedPositions) {
      saveEntityPositions();
    }

    // Auto-fit camera disabled - user controls camera position
    // fitCameraToEntities() can be called manually if needed

    // CRITICAL: Clear ALL connections and rebuild from current frame's accounts
    // This ensures time-travel shows correct account bars for each frame
    // (Connections don't need position preservation like entities do)
    if (connections.length > 0) {
      connections.forEach(connection => {
        scene.remove(connection.line);
        if (connection.line.geometry) connection.line.geometry.dispose();
        if (connection.line.material) {
          const mat = connection.line.material;
          if (Array.isArray(mat)) {
            mat.forEach(m => m.dispose());
          } else {
            mat.dispose();
          }
        }
        if (connection.progressBars) {
          scene.remove(connection.progressBars);
          disposeObject3D(connection.progressBars);
        }
        if (connection.mempoolBoxes) {
          const { leftBox, rightBox } = connection.mempoolBoxes;
          [leftBox, rightBox].forEach(box => {
            if (!box) return;
            scene.remove(box);
            disposeObject3D(box);
          });
        }
      });
      connections = [];
    }

    // Create connections between entities that have accounts (from current frame)
    createConnections();

    // Create transaction flow particles (also tracks activity)
    createTransactionParticles();

    // Don't enforce spacing constraints - they break the H-shape
    // enforceSpacingConstraints();
  }

  function clearNetwork() {
    // Remove entity meshes AND labels - PROPERLY DISPOSE to prevent memory leaks
    entities.forEach(entity => {
      scene.remove(entity.mesh);
      // Dispose geometry and material to free GPU memory
      if (entity.mesh.geometry) entity.mesh.geometry.dispose();
      if (entity.mesh.material) {
        if (Array.isArray(entity.mesh.material)) {
          entity.mesh.material.forEach(m => m.dispose());
        } else {
          entity.mesh.material.dispose();
        }
      }
      // CRITICAL: Remove labels to prevent orphaned sprites accumulating
      if (entity.label) {
        scene.remove(entity.label);
        if (entity.label.geometry) entity.label.geometry.dispose();
        if (entity.label.material) entity.label.material.dispose();
      }
    });
    entities = [];

    // Remove connection lines and progress bars - dispose materials
    connections.forEach(connection => {
      scene.remove(connection.line);
      if (connection.line.geometry) connection.line.geometry.dispose();
      if (connection.line.material) {
        const mat = connection.line.material;
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else {
          mat.dispose();
        }
      }
      if (connection.progressBars) {
        scene.remove(connection.progressBars);
      }
      // Remove mempool boxes - dispose geometry and materials
      if (connection.mempoolBoxes) {
        const { leftBox, rightBox } = connection.mempoolBoxes;
        [leftBox, rightBox].forEach(box => {
          if (!box) return;
          scene.remove(box);
          disposeObject3D(box);
        });
      }
    });
    connections = [];

    // Remove J-block history (blockchain visualization)
    jBlockHistory.forEach(block => {
      scene.remove(block.container);
      disposeObject3D(block.container);
    });
    jBlockHistory = [];

    // Remove particles - dispose materials
    particles.forEach(particle => {
      scene.remove(particle.mesh);
      if (particle.mesh.geometry) particle.mesh.geometry.dispose();
      if (particle.mesh.material) {
        const mat = particle.mesh.material;
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else {
          mat.dispose();
        }
      }
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

  function createEntityNode(
    profile: any,
    index: number,
    total: number,
    forceLayoutPositions: Map<string, THREE.Vector3>,
    isHub: boolean,
    passedReplicas?: Map<string, any>  // Time-aware replicas passed from updateNetworkData
  ) {
    // Position entities: replica position > gossip position > force layout > radial fallback
    let x: number, y: number, z: number;

    // Use passed replicas (time-aware) or compute fresh from stores
    const currentReplicas = passedReplicas || getTimeAwareReplicas();
    const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(profile.entityId + ':'));
    const replica = replicaKey ? currentReplicas.get(replicaKey) : null;

    // Check if this is Federal Reserve
    const isFed = replica?.signerId?.includes('_fed') || false;

    // Priority 0: Check entityPositions store (persists across time-travel)
    // Positions are RELATIVE to j-machine - compute world position by adding j-machine position
    const persistedPosition = $entityPositions.get(profile.entityId);

    // Helper: Get j-machine position for a jurisdiction name
    const getJMachinePosition = (jurisdictionName: string): { x: number; y: number; z: number } | null => {
      // First check env.jReplicas (works for both Map and Array)
      if (env?.jReplicas) {
        if (env.jReplicas instanceof Map) {
          const jr = env.jReplicas.get(jurisdictionName);
          if (jr?.position) return jr.position;
        } else if (Array.isArray(env.jReplicas)) {
          const jr = env.jReplicas.find((x: any) => x.name === jurisdictionName);
          if (jr?.position) return jr.position;
        }
      }
      // Fallback: Check jMachines mesh positions (already created in scene)
      const jMesh = jMachines.get(jurisdictionName);
      if (jMesh) return { x: jMesh.position.x, y: jMesh.position.y, z: jMesh.position.z };
      return null;
    };

    if (persistedPosition) {
      // PRIORITY 0: Use persisted position from entityPositions store (survives time-travel)
      // Position is RELATIVE to j-machine - compute world position
      const jMachinePos = getJMachinePosition(persistedPosition.jurisdiction);
      if (jMachinePos) {
        // World position = j-machine position + relative offset
        x = jMachinePos.x + persistedPosition.x;
        y = jMachinePos.y + persistedPosition.y;
        z = jMachinePos.z + persistedPosition.z;
      } else {
        // Fallback: use relative position as absolute (j-machine not found)
        x = persistedPosition.x;
        y = persistedPosition.y;
        z = persistedPosition.z;
      }
      if (!loggedGridPositions.has(profile.entityId)) {
        loggedGridPositions.add(profile.entityId);
        logActivity(`📍 ${profile.entityId.slice(0,10)} @ (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}) [relative to ${persistedPosition.jurisdiction}]`);
      }
    } else if (replica?.position) {
      // Replica position is also RELATIVE to j-machine - compute world position
      const replicaJurisdiction = replica.position.jurisdiction || replica.position.xlnomy || env?.activeJurisdiction || 'default';
      const jMachinePos = getJMachinePosition(replicaJurisdiction);
      if (jMachinePos) {
        x = jMachinePos.x + replica.position.x;
        y = jMachinePos.y + replica.position.y;
        z = jMachinePos.z + replica.position.z;
      } else {
        // Fallback: use as absolute
        x = replica.position.x;
        y = replica.position.y;
        z = replica.position.z;
      }
      // Only log ONCE on first draw
      if (!loggedGridPositions.has(profile.entityId)) {
        loggedGridPositions.add(profile.entityId);
        logActivity(`📍 ${profile.entityId.slice(0,10)} @ (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}) [relative to ${replicaJurisdiction}]`);
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

    // UNIT SPHERE: Geometry is always radius=1.0
    // Scale alone controls visual size (set in applyPulseAnimation from current frame reserves)
    const geometry = new THREE.SphereGeometry(1.0, 32, 32);

    // Colors: Purple for Fed, BLUE for entities (distinct from green J-Machine)
    let baseColor: number, emissiveColor: number, emissiveIntensity: number;

    if (isFed) {
      baseColor = 0x8b7fb8;      // Ethereum purple (matches J-Machine)
      emissiveColor = 0x9a8ac4;  // Bright purple glow
      emissiveIntensity = 2.0;   // Very bright
    } else {
      // Blue entities - distinct from green J-Machine
      baseColor = 0x0077cc;       // Blue
      emissiveColor = 0x003366;   // Dark blue glow
      emissiveIntensity = isHub ? 1.5 : 0.3;
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

    // Add purple glow ring for Fed (unit geometry - scales with mesh)
    if (isFed) {
      const glowGeometry = new THREE.RingGeometry(1.2, 1.5, 32);
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
    mesh.userData['isFed'] = isFed; // Used to skip color updates for Fed (always purple)
    mesh.userData['baseMaterial'] = material;

    if (isHub) {
      // Add lightning particles for hubs
      const lightningGroup = new THREE.Group();
      mesh.add(lightningGroup);
      mesh.userData['lightningGroup'] = lightningGroup;
    }

    scene.add(mesh);

    // Add entity name label AS CHILD of mesh (auto-moves with entity!)
    const labelSprite = createEntityLabel(profile.entityId);
    labelSprite.position.set(0, 1.8, 0); // Local position above unit sphere (scales with mesh)
    mesh.add(labelSprite); // Child of mesh = auto-sync position

    // NOTE: Reserve labels removed - too noisy, clutter the view

    entities.push({
      id: profile.entityId,
      position: new THREE.Vector3(x, y, z),
      mesh,
      label: labelSprite, // Entity name
      profile,
      isHub, // Store hub status for pulse animation
      pulsePhase: Math.random() * Math.PI * 2, // Random start phase for pulse
      lastActivity: 0
      // Size is calculated from reserves in applyPulseAnimation (pure function)
    });
  }

  function createConnections() {
    const processedConnections = new Set<string>();
    const currentReplicas = getTimeAwareReplicas();


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

    // CRITICAL: Clear existing particles to prevent stale visuals during time-travel
    particles.forEach(particle => {
      scene.remove(particle.mesh);
      if (particle.mesh.geometry) particle.mesh.geometry.dispose();
      if (particle.mesh.material) {
        const mat = particle.mesh.material;
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else {
          mat.dispose();
        }
      }
    });
    particles = [];

    const timeIndex = $isolatedTimeIndex;

    if (!($isolatedTimeIndex === -1) && $isolatedHistory && timeIndex >= 0) {
      const currentFrame = $isolatedHistory[timeIndex];

      // Support both serverInput (older format) and runtimeInput (AHB demo format)
      const entityInputs = currentFrame?.serverInput?.entityInputs || currentFrame?.runtimeInput?.entityInputs || [];

      if (entityInputs.length > 0) {
        entityInputs.forEach((entityInput: any) => {
          const processingEntityId = entityInput.entityId;
          currentFrameActivity.activeEntities.add(processingEntityId);

          if (entityInput.entityTxs) {
            entityInput.entityTxs.forEach((tx: any) => {
              if (tx.type === 'accountInput' && tx.data) {
                const fromEntityId = tx.data.fromEntityId;
                const toEntityId = tx.data.toEntityId;

                // Entity input strike animation (bilateral messaging)
                triggerEntityInputStrike(fromEntityId, toEntityId);

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
              } else if (tx.type === 'payFromReserve' || tx.kind === 'payFromReserve') {
                // R2R (Reserve-to-Reserve) transaction visualization during time-machine playback
                const fromEntityId = processingEntityId;
                // Support both tx.targetEntityId (old) and tx.data.targetEntityId (new format)
                const toEntityId = tx.targetEntityId || tx.data?.targetEntityId;
                const amount = tx.amount || tx.data?.amount || 0n;
                if (toEntityId) {
                  // Add tx cube to J-Machine mempool
                  addTxToJMachine(fromEntityId);
                  // R2R animation deleted - instant state change
                  // Trigger activity visuals
                  triggerEntityActivity(fromEntityId);
                  triggerEntityActivity(toEntityId);
                }
              }
            });
          }
        });
      }
    } else if (($isolatedTimeIndex === -1) && $isolatedEnv?.runtimeInput?.entityInputs) {
      // Live mode - same logic
      $isolatedEnv.runtimeInput.entityInputs.forEach((entityInput: any) => {
        const processingEntityId = entityInput.entityId;
        currentFrameActivity.activeEntities.add(processingEntityId);

        if (entityInput.entityTxs) {
          entityInput.entityTxs.forEach((tx: any) => {
            if (tx.type === 'accountInput' && tx.data) {
              const fromEntityId = tx.data.fromEntityId;
              const toEntityId = tx.data.toEntityId;

              // Entity input strike animation (bilateral messaging)
              triggerEntityInputStrike(fromEntityId, toEntityId);

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
            } else if (tx.type === 'payFromReserve' || tx.kind === 'payFromReserve') {
              // R2R (Reserve-to-Reserve) transaction visualization in live mode
              const fromEntityId = processingEntityId;
              const toEntityId = tx.targetEntityId;
              if (toEntityId) {
                // Add tx cube to J-Machine mempool
                addTxToJMachine(fromEntityId);
                // R2R animation deleted - instant state change
                // Trigger activity visuals
                triggerEntityActivity(fromEntityId);
                triggerEntityActivity(toEntityId);
              }
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

    // Color based on amount (Strange Attractors style spectrum)
    let color = 0x00ccff; // Default cyan
    let emissiveColor = 0x00ccff;
    if (amountUSD > 0) {
      if (amountUSD < 1000) {
        // Tiny: Blue
        color = 0x0088ff;
        emissiveColor = 0x0088ff;
      } else if (amountUSD < 100000) {
        // Small: Cyan
        color = 0x00ccff;
        emissiveColor = 0x00ccff;
      } else if (amountUSD < 1000000) {
        // Medium: Green
        color = 0x00ff88;
        emissiveColor = 0x00ff88;
      } else if (amountUSD < 10000000) {
        // Large: Yellow
        color = 0xffff00;
        emissiveColor = 0xffff00;
      } else {
        // Huge: Red
        color = 0xff4444;
        emissiveColor = 0xff4444;
      }
    }

    // FAT CYLINDER BOLT (not sphere)
    const geometry = new THREE.CylinderGeometry(radius, radius, boltLength, 16);

    // GRADIENT MATERIAL with amount-based color
    const material = new THREE.MeshLambertMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      emissive: emissiveColor,
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

    // Trigger grid pulse (visualize O(n) broadcast)
    gridPulseIntensity = 1.0;

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

          // Recreate progress bars (positions changed, need full rebuild)
          if (conn.progressBars) {
            scene.remove(conn.progressBars);

            // Remove old mempool boxes
            if (conn.mempoolBoxes) {
              scene.remove(conn.mempoolBoxes.leftBox);
              scene.remove(conn.mempoolBoxes.rightBox);
              // Dispose geometry and materials
              [conn.mempoolBoxes.leftBox, conn.mempoolBoxes.rightBox].forEach(box => {
                disposeObject3D(box);
              });
            }

            // Get time-aware replica data
            const currentReplicas = getTimeAwareReplicas();
            const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(k => k.startsWith(conn.from + ':') || k.startsWith(conn.to + ':'));
            const replica = replicaKey ? currentReplicas.get(replicaKey) : null;

            if (replica) {
              const { bars, mempoolBoxes } = createAccountBarsForConnection(fromEntity, toEntity, conn.from, conn.to, replica);
              conn.progressBars = bars;
              conn.mempoolBoxes = mempoolBoxes;
              // Add new mempool boxes to scene
              if (mempoolBoxes) {
                scene.add(mempoolBoxes.leftBox);
                scene.add(mempoolBoxes.rightBox);
              }
            }
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

    // Check if either entity is Federal Reserve (use time-aware replicas)
    const currentReplicas = getTimeAwareReplicas();
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

    // Create account capacity bars and mempool boxes
    const { bars: accountBars, mempoolBoxes } = createAccountBarsForConnection(fromEntity, toEntity, fromId, toId, replica);

    connections.push({
      from: fromId,
      to: toId,
      line,
      progressBars: accountBars,
      mempoolBoxes
    });
  }

  function createAccountBarsForConnection(fromEntity: any, toEntity: any, fromId: string, toId: string, _replica: any) {
    // Get current replicas to find the account
    const currentReplicas = getTimeAwareReplicas();

    // CANONICAL: Always use LEFT entity's account (smaller entityId)
    // This ensures deterministic rendering regardless of traversal order
    // Use runtime's isLeft for single source of truth
    const fromIsLeftEntity = XLN?.isLeft?.(fromId, toId) ?? (fromId < toId);
    const leftId = fromIsLeftEntity ? fromId : toId;
    const rightId = fromIsLeftEntity ? toId : fromId;

    let accountData: any = null;

    // CANONICAL ACCOUNT SELECTION: Use most recent finalized state (highest currentFrame.height)
    // This ensures visual solvency during bilateral consensus desync
    const leftReplica = [...currentReplicas.entries()]
      .find(([key]) => key.startsWith(leftId + ':'));
    const rightReplica = [...currentReplicas.entries()]
      .find(([key]) => key.startsWith(rightId + ':'));

    const leftAccount = leftReplica?.[1]?.state?.accounts?.get(rightId);
    const rightAccount = rightReplica?.[1]?.state?.accounts?.get(leftId);

    // Compare finalized heights - use HIGHER (most recent consensus state)
    // Store both for potential dual rendering (confirmed + pending)
    let confirmedAccount = null;
    let pendingAccount = null;

    if (leftAccount && rightAccount) {
      const leftHeight = leftAccount.currentFrame?.height ?? 0;
      const rightHeight = rightAccount.currentFrame?.height ?? 0;

      if (leftHeight > rightHeight) {
        accountData = leftAccount; // Primary render (highest)
        confirmedAccount = rightAccount; // Lower height (confirmed)
        pendingAccount = leftAccount; // Higher height (pending signature)
      } else if (rightHeight > leftHeight) {
        accountData = rightAccount;
        confirmedAccount = leftAccount;
        pendingAccount = rightAccount;
      } else {
        // Same height - synced, use LEFT (canonical tiebreaker)
        accountData = leftAccount;
        confirmedAccount = leftAccount; // Both synced
        pendingAccount = null; // No pending state
      }
    } else {
      // Fallback if only one side has account
      accountData = leftAccount || rightAccount;
      confirmedAccount = accountData;
      pendingAccount = null;
    }

    // TODO: Future enhancement - render both confirmed (solid) and pending (translucent) bars
    // when pendingAccount !== null for visual desync indication

    // Always show current state - use confirmedAccount as fallback (last committed proof)
    if (!accountData) {
      accountData = confirmedAccount; // Use last committed state
    }

    // NO BARS if account doesn't exist at all (not opened yet)
    if (!accountData || !accountData.deltas) {
      const group = new THREE.Group();
      scene.add(group);
      return { bars: group, mempoolBoxes: null };
    }

    const availableTokens = Array.from(accountData.deltas.keys() as IterableIterator<number>).sort((a, b) => a - b);

    if (availableTokens.length === 0) {
      const group = new THREE.Group();
      scene.add(group);
      return { bars: group, mempoolBoxes: null };
    }

    // Bilateral consensus state classification
    const leftEntityAccount = fromIsLeftEntity ? confirmedAccount : pendingAccount;
    const rightEntityAccount = fromIsLeftEntity ? pendingAccount : confirmedAccount;
    const leftEntityHeight = leftEntityAccount?.currentFrame?.height ?? 0;
    const rightEntityHeight = rightEntityAccount?.currentFrame?.height ?? 0;

    if (!XLN?.classifyBilateralState) {
    }

    const leftConsensusState = XLN?.classifyBilateralState?.(leftEntityAccount, rightEntityHeight, true);
    const rightConsensusState = XLN?.classifyBilateralState?.(rightEntityAccount, leftEntityHeight, false);
    const barVisual = leftConsensusState && rightConsensusState
      ? XLN?.getAccountBarVisual?.(leftConsensusState, rightConsensusState)
      : null;

    // Check for active dispute on this account
    const activeDispute = accountData.activeDispute;
    const hasDispute = !!activeDispute;

    const bars = createAccountBars(
      scene,
      fromEntity,
      toEntity,
      accountData.deltas,  // Pass full deltas map for multi-token rendering
      fromIsLeftEntity,
      {
        barsMode,
        portfolioScale: settings.portfolioScale || 5000,
        desyncDetected: (leftConsensusState?.state !== 'committed' || rightConsensusState?.state !== 'committed'),
        bilateralState: barVisual, // NEW: Pass consensus state for visual effects
        dispute: hasDispute ? {
          startedByLeft: activeDispute.startedByLeft,
          disputeTimeout: activeDispute.disputeTimeout,
          initialDisputeNonce: activeDispute.initialDisputeNonce,
        } : null
      },
      getEntitySizeForToken,
      XLN  // Pass XLN runtime functions for deriveDelta
    );

    // Create mempool boxes (one per entity side) - pass BOTH accounts
    const mempoolBoxes = createAccountMempoolBoxes(
      scene,
      fromEntity,
      toEntity,
      leftAccount,
      rightAccount,
      fromIsLeftEntity,
      getEntitySizeForToken
    );

    // Add boxes to scene for rendering
    if (mempoolBoxes) {
      scene.add(mempoolBoxes.leftBox);
      scene.add(mempoolBoxes.rightBox);
    }

    return { bars, mempoolBoxes };
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

  /**
   * Create account mempool visualization boxes (one per entity side)
   * Small boxes aligned with account bar direction
   */
  function createAccountMempoolBoxes(
    scene: THREE.Scene,
    fromEntity: any,
    toEntity: any,
    leftAccount: any,
    rightAccount: any,
    fromIsLeft: boolean,
    getEntitySizeForToken: (entityId: string, tokenId: number) => number
  ): { leftBox: THREE.Group; rightBox: THREE.Group } | null {
    if (!leftAccount && !rightAccount) return null;

    const direction = new THREE.Vector3().subVectors(toEntity.position, fromEntity.position);
    const normalizedDirection = direction.normalize();

    // Get sync states for colors (GREEN = synced, RED = desynced)
    const leftState = leftAccount ? XLN?.classifyBilateralState?.(leftAccount, 0, true) : null;
    const rightState = rightAccount ? XLN?.classifyBilateralState?.(rightAccount, 0, false) : null;

    // Each entity has its OWN mempool and pendingFrame (bilateral, not shared)
    const leftMempoolTxs = leftAccount?.mempool || [];
    const leftPendingTxs = leftAccount?.pendingFrame?.accountTxs || [];
    const rightMempoolTxs = rightAccount?.mempool || [];
    const rightPendingTxs = rightAccount?.pendingFrame?.accountTxs || [];

    // Box border color based on sync state
    const leftBoxColor = leftState?.state === 'committed' ? 0x00ff88 : 0xff4444;
    const rightBoxColor = rightState?.state === 'committed' ? 0x00ff88 : 0xff4444;

    const leftBox = createMempoolBox(leftBoxColor, leftMempoolTxs, leftPendingTxs, normalizedDirection);
    const rightBox = createMempoolBox(rightBoxColor, rightMempoolTxs, rightPendingTxs, normalizedDirection);

    // Position boxes EXACTLY where bars start (matches AccountBarRenderer positioning)
    const fromEntitySize = getEntitySizeForToken(fromEntity.id, 1);
    const toEntitySize = getEntitySizeForToken(toEntity.id, 1);
    const barRadius = 0.08 * 2.5; // 0.2
    const safeGap = 0.2;
    const boxDepth = 0.4; // Match box depth above (wider box for gray+blue)

    // Calculate bar start positions (EXACT same formula as AccountBarRenderer:338-339)
    const fromBarStartPos = fromEntity.position.clone().add(
      normalizedDirection.clone().multiplyScalar(fromEntitySize + barRadius + safeGap)
    );
    const toBarStartPos = toEntity.position.clone().sub(
      normalizedDirection.clone().multiplyScalar(toEntitySize + barRadius + safeGap)
    );

    // Position box front face AT bar start, extending backward (toward entity)
    leftBox.position.copy(fromBarStartPos).sub(
      normalizedDirection.clone().multiplyScalar(boxDepth/2)
    );

    rightBox.position.copy(toBarStartPos).add(
      normalizedDirection.clone().multiplyScalar(boxDepth/2)
    );

    // Don't add to scene here - caller will handle it for proper tracking
    return { leftBox, rightBox };
  }

  /**
   * Create single mempool box with TX cubes inside
   * Shows bilateral consensus flow: GRAY (mempool waiting) → BLUE (sent/pending) → Bars (committed)
   */
  function createMempoolBox(
    borderColor: number,
    mempoolTxs: any[],
    pendingTxs: any[],
    direction: THREE.Vector3
  ): THREE.Group {
    const group = new THREE.Group();

    // Box dimensions - wider to fit GRAY + BLUE cubes inside
    const width = 1.6;   // Wide enough for 2 rows of cubes
    const height = 0.8;
    const depth = 0.4;   // Thicker to clearly separate gray/blue zones

    // Container box (border shows sync state: green=synced, red=desynced)
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const material = new THREE.MeshPhongMaterial({
      color: borderColor,
      emissive: new THREE.Color(borderColor).multiplyScalar(0.3),
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      shininess: 60,
      depthWrite: false
    });
    const cube = new THREE.Mesh(geometry, material);
    group.add(cube);

    // Wireframe edges
    const edgesGeometry = new THREE.EdgesGeometry(geometry);
    const edgesMaterial = new THREE.LineBasicMaterial({
      color: borderColor,
      linewidth: 1,
      transparent: true,
      opacity: 0.6
    });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    group.add(edges);

    // TX cubes layout: show both mempool (gray) and pending (blue)
    const txSize = 0.18;  // Tiny to fit in 0.8 width box
    const spacing = 0.35; // Tight spacing

    // GRAY cubes (mempool - waiting to be sent)
    // Position toward back (toward entity, Z negative)
    mempoolTxs.slice(0, 2).forEach((tx, i) => {
      const txGeometry = new THREE.BoxGeometry(txSize, txSize, txSize);
      const txMaterial = new THREE.MeshLambertMaterial({
        color: 0x888888,  // Gray - waiting
        transparent: true,
        opacity: 0.7,
        emissive: 0x444444,
        emissiveIntensity: 0.3
      });
      const txCube = new THREE.Mesh(txGeometry, txMaterial);

      // Position in back half of box (closer to entity)
      const xOffset = i === 0 ? -spacing/2 : spacing/2;
      txCube.position.set(xOffset, 0, -depth/3);

      group.add(txCube);
    });

    // BLUE cubes (pendingFrame - sent, waiting for ACK)
    // Position toward front (toward bars, Z positive)
    pendingTxs.slice(0, 2).forEach((tx, i) => {
      const txGeometry = new THREE.BoxGeometry(txSize, txSize, txSize);
      const txMaterial = new THREE.MeshLambertMaterial({
        color: 0x00ccff,  // Blue - sent
        transparent: true,
        opacity: 0.95,
        emissive: 0x0088cc,
        emissiveIntensity: 0.7
      });
      const txCube = new THREE.Mesh(txGeometry, txMaterial);

      // Position in front half of box (closer to bars, but INSIDE box)
      const xOffset = i === 0 ? -spacing/2 : spacing/2;
      txCube.position.set(xOffset, 0, depth/6);  // depth/6 keeps it inside

      group.add(txCube);
    });

    // Rotate box to align with account bar direction
    // Box depth (Z-axis) should point along connection line
    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3(0, 0, 1);
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(forward, direction);
    group.quaternion.copy(quaternion);

    return group;
  }

  // Bar labels removed per user request - shown only on hover tooltips
  // function createBarLabel(group: THREE.Group, position: THREE.Vector3, value: number, _barType: string) {
  //   ...
  // }

  function createEntityLabel(entityId: string): THREE.Sprite {
    // Create canvas for entity name - extra wide for emoji + bank names
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    // Extra wide for emoji + name (512x128 for VR visibility)
    canvas.width = 512;
    canvas.height = 128;

    // Get short entity name (just number, no prefix)
    const entityName = getEntityShortName(entityId);

    // Check if this is a Fed entity (for flag rendering)
    // Use time-aware replicas
    const currentReplicas = getTimeAwareReplicas();
    const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(entityId + ':'));
    const replica = replicaKey ? currentReplicas.get(replicaKey) : null;

    let flag = '';
    if (replica?.signerId) {
      for (const [key, emoji] of FED_FLAGS) {
        if (replica.signerId.toLowerCase().includes(key)) {
          flag = emoji;
          break;
        }
      }
    }

    // Get reserve balance for display (merged into name label)
    let balanceStr = '';
    if (replica?.state?.reserves) {
      const totalReserves = getTotalReserves(replica);
      const reserveValue = Number(totalReserves) / 1e18;
      // Format: $5M (round millions), $1.2M, $500K, $0
      if (reserveValue >= 1000000) {
        const millions = reserveValue / 1000000;
        // Show clean "$5M" for round millions, "$1.2M" for fractional
        balanceStr = ` $${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
      } else if (reserveValue >= 1000) {
        balanceStr = ` $${(reserveValue / 1000).toFixed(0)}K`;
      } else if (reserveValue > 0) {
        balanceStr = ` $${reserveValue.toFixed(0)}`;
      } else {
        balanceStr = ' $0';
      }
    }

    // Combined label: "alice $0" or "Hub $1.2M"
    const labelText = entityName + balanceStr;

    // NO background - transparent (user requirement: black background is ugly)
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Draw flag above name if Fed
    if (flag) {
      context.font = `${48 * labelScale}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(flag, 256, 32); // Top half (centered at 512/2=256)

      // Draw name + balance below flag (smaller)
      context.font = `bold ${18 * labelScale}px sans-serif`;
      context.strokeStyle = '#000000';
      context.lineWidth = 3;
      context.strokeText(labelText, 256, 90);
      context.fillStyle = '#FFD700'; // Gold for Fed
      context.fillText(labelText, 256, 90);
    } else {
      // Regular entity: name + balance, centered
      context.font = `bold ${24 * labelScale}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      // Draw dark outline for contrast
      context.strokeStyle = '#000000';
      context.lineWidth = 3;
      context.strokeText(labelText, 256, 64);

      // Draw bright green text on top
      context.fillStyle = '#00ff88';
      context.fillText(labelText, 256, 64);
    }

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

    // Sprite scale proportional to labelScale: extra wide for emoji + names
    // Canvas is 512x128 (4:1 ratio), so scale X 4x wider than Y
    // In VR mode, scale up 3x for comfortable reading at table distance
    const vrMultiplier = isVRActive ? 3.0 : 1.0;
    const baseScale = 1.5 * labelScale * vrMultiplier;
    sprite.scale.set(baseScale * 4, baseScale, 1); // 4:1 aspect ratio for emoji + text

    // Don't add to scene here - will be added as child of mesh in createEntityNode
    return sprite;
  }

  // NOTE: createReserveLabel removed - reserve labels were too noisy

  // Create mempool indicator sprite (shows inbox/outbox tx counts)
  function createMempoolIndicator(entityId: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 128;
    canvas.height = 64;

    // Initial empty state - will be updated in updateMempoolIndicators
    context.clearRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      sizeAttenuation: true
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(1.0, 0.5, 1);
    sprite.userData['entityId'] = entityId;
    sprite.userData['canvas'] = canvas;
    sprite.userData['context'] = context;

    return sprite;
  }

  // Update mempool indicators for all entities
  function updateMempoolIndicators() {
    const currentReplicas = getTimeAwareReplicas();

    entities.forEach(entity => {
      // Get replica for this entity
      const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(
        k => k.startsWith(entity.id + ':')
      );
      const replica = replicaKey ? currentReplicas.get(replicaKey) : null;

      // Count entity mempool (outgoing txs waiting to be proposed)
      const entityMempoolCount = replica?.mempool?.length || 0;

      // Count account mempool (pending bilateral txs)
      let accountMempoolOut = 0;
      let accountMempoolIn = 0;
      if (replica?.state?.accounts) {
        for (const [counterpartyId, accountMachine] of replica.state.accounts) {
          const pending = accountMachine?.mempool?.length || 0;
          // This entity's pending outgoing txs
          accountMempoolOut += pending;
        }
      }

      // Check if other entities have txs targeting this entity (incoming)
      for (const [otherKey, otherReplica] of currentReplicas.entries()) {
        const [otherEntityId] = otherKey.split(':');
        if (otherEntityId === entity.id) continue;

        if (otherReplica?.state?.accounts) {
          const accountToUs = otherReplica.state.accounts.get(entity.id);
          if (accountToUs?.mempool?.length > 0) {
            accountMempoolIn += accountToUs.mempool.length;
          }
        }
      }

      const totalOut = entityMempoolCount + accountMempoolOut;
      const totalIn = accountMempoolIn;

      // Only show indicator if there's something in mempool
      if (totalOut === 0 && totalIn === 0) {
        if (entity.mempoolIndicator) {
          entity.mempoolIndicator.visible = false;
        }
        return;
      }

      // Create indicator if missing
      if (!entity.mempoolIndicator) {
        entity.mempoolIndicator = createMempoolIndicator(entity.id);
        const entitySize = getEntitySizeForToken(entity.id, selectedTokenId);
        entity.mempoolIndicator.position.set(entitySize + 0.5, 0, 0); // Right side of entity
        entity.mesh.add(entity.mempoolIndicator);
      }

      entity.mempoolIndicator.visible = true;

      // Update the canvas with new counts
      const canvas = entity.mempoolIndicator.userData['canvas'] as HTMLCanvasElement;
      const context = entity.mempoolIndicator.userData['context'] as CanvasRenderingContext2D;

      context.clearRect(0, 0, canvas.width, canvas.height);

      // Draw outbox (orange arrow up + count)
      if (totalOut > 0) {
        context.font = 'bold 24px sans-serif';
        context.textAlign = 'center';
        context.fillStyle = '#ff8800'; // Orange for outgoing
        context.fillText(`↑${totalOut}`, 32, 36);
      }

      // Draw inbox (cyan arrow down + count)
      if (totalIn > 0) {
        context.font = 'bold 24px sans-serif';
        context.textAlign = 'center';
        context.fillStyle = '#00ccff'; // Cyan for incoming
        context.fillText(`↓${totalIn}`, 96, 36);
      }

      // Update texture
      const texture = entity.mempoolIndicator.material.map as THREE.CanvasTexture;
      texture.needsUpdate = true;
    });
  }

  function updateEntityLabels() {
    // Update entity labels - name labels are now CHILDREN of mesh (auto-positioned!)
    if (!camera) return;

    // Use time-aware replicas
    const currentReplicas = getTimeAwareReplicas();

    // Check if time index changed - force label recreation to update reserve display
    const currentTimeIndex = get(isolatedTimeIndex);
    const forceRecreateLabels = currentTimeIndex !== lastLabelUpdateTimeIndex;
    if (forceRecreateLabels) {
      lastLabelUpdateTimeIndex = currentTimeIndex;
    }

    entities.forEach(entity => {
      // Recreate label if missing OR if time changed (reserve amounts may have changed)
      if (!entity.label || forceRecreateLabels) {
        // Dispose old label if exists
        if (entity.label) {
          entity.mesh.remove(entity.label);
          if (entity.label.material?.map) {
            entity.label.material.map.dispose();
          }
          entity.label.material?.dispose();
        }
        // Create new label with updated reserve amount
        entity.label = createEntityLabel(entity.id);
        const entitySize = getEntitySizeForToken(entity.id, selectedTokenId);
        entity.label.position.set(0, entitySize + 0.8, 0);
        entity.mesh.add(entity.label);
      }

      // Ensure label is child of mesh (migration from old scene-parented labels)
      if (entity.label.parent !== entity.mesh) {
        scene.remove(entity.label);
        const labelEntitySize = getEntitySizeForToken(entity.id, selectedTokenId);
        entity.label.position.set(0, labelEntitySize + 0.8, 0);
        entity.mesh.add(entity.label);
      }

      // Get current reserve from replica state for SELECTED token
      // Use getReserveValue() helper to handle both Map and serialized Object formats
      const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(
        (k: any) => k.startsWith(entity.id + ':')
      );
      const replica = replicaKey ? currentReplicas.get(replicaKey) : null;

      // Get reserves using helper that handles Map/Object serialization
      const reserveAmount = getReserveValue(replica?.state?.reserves, String(selectedTokenId));

      // UPDATE ENTITY COLOR only when time changes (not every frame!)
      if (forceRecreateLabels) {
        const material = entity.mesh.material as THREE.MeshLambertMaterial;
        if (material && !entity.mesh.userData['isFed']) { // Don't change Fed color
          // Force solid, no transparency
          material.transparent = false;
          material.opacity = 1.0;
          material.depthWrite = true;

          if (reserveAmount <= 0n) {
            // Grey for zero reserves
            material.color.setHex(0x666666);
            material.emissive.setHex(0x333333);
            material.emissiveIntensity = 0.1;
          } else {
            // GREEN - match collateral color EXACTLY (same as AccountBarRenderer.ts line 499)
            material.color.setHex(0x5cb85c);  // Collateral green
            // Emissive = color * 0.1 to match bar material
            const baseColor = new THREE.Color(0x5cb85c);
            material.emissive.copy(baseColor.multiplyScalar(0.1));
            material.emissiveIntensity = entity.isHub ? 0.2 : 0.1;  // Subtle glow
          }
        }
      }
    });
  }

  let animateCallCount = 0;
  let renderFps = 0;
  let frameTime = 0;
  const perfMonitor = new PerformanceMonitor((metrics: PerfMetrics) => {
    // Update local FPS display (clamp to avoid "Infinity")
    renderFps = Math.min(metrics.fps, 9999);
    frameTime = metrics.frameTime;
    // Emit FPS to panelBridge for TimeMachine display
    panelBridge.emit('renderFps', metrics.fps);
  });
  function animate() {
    perfMonitor.begin(); // Start FPS measurement

    // VR uses setAnimationLoop, don't double-call requestAnimationFrame
    if (!renderer?.xr?.isPresenting) {
      animationId = requestAnimationFrame(animate);
    }

    animateCallCount++;

    // ===== PROCESS VISUAL EFFECTS QUEUE =====
    if (scene && spatialHash && entityMeshMap) {
      const deltaTime = clock.getDelta() * 1000; // to milliseconds
      effectOperations.process(scene, entityMeshMap, deltaTime, 10);
    }

    // ===== ANIMATE ENTITY INPUT STRIKES =====
    animateEntityInputStrikes();

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

    // ===== UPDATE HAND TRACKING (Vision Pro + Quest) =====
    if (isVRActive && handTrackingController) {
      // Convert entities to GrabbableEntity format
      const grabbableEntities = entities.map(e => ({
        id: e.id,
        mesh: e.mesh as THREE.Mesh,
        position: e.position,
        isPinned: e.isPinned,
        label: e.label as THREE.Object3D | undefined
      })) as GrabbableEntity[];
      handTrackingController.update(grabbableEntities);
    }

    // PERF: Pulse animations disabled for 60 FPS target
    // Fed glow ring and hub aurora effects consume ~5-10 FPS
    // Uncomment below to re-enable visual effects
    /*
    const time = Date.now() * 0.001;
    entities.forEach(entity => {
      if (entity.mesh.userData['glowRing']) {
        const glowRing = entity.mesh.userData['glowRing'] as THREE.Mesh;
        glowRing.rotation.z = time * 0.5;
        const pulseMaterial = glowRing.material as THREE.MeshBasicMaterial;
        pulseMaterial.opacity = 0.2 + Math.sin(time * 2) * 0.15;
      }

      if (entity.isHub && entity.mesh.material && entity.pulsePhase !== undefined) {
        const material = entity.mesh.material as THREE.MeshLambertMaterial;
        const slowPulse = Math.sin(time * 0.8 + entity.pulsePhase);
        const fastShimmer = Math.sin(time * 3.5 + entity.pulsePhase * 0.7);
        const wave = Math.sin(time * 0.3 + entity.pulsePhase * 1.3);
        const pulseIntensity = 2.0 + 1.5 * slowPulse + 0.5 * fastShimmer + 0.3 * wave;
        material.emissiveIntensity = pulseIntensity;
        const colorShift = (slowPulse + 1) * 0.5;
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
    */ // End of disabled pulse animations

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

    // Auto-rotate camera (Strange Attractors style)
    if (autoRotate && controls && camera) {
      const radiansPerSecond = (autoRotateSpeed / 60) * (2 * Math.PI); // RPM to rad/s
      const radiansPerFrame = radiansPerSecond / 60; // Assuming 60 FPS

      const currentPos = camera.position.clone();
      const target = controls.target.clone();
      const offset = currentPos.sub(target);

      // Rotate around Y axis (horizontal orbit)
      const cos = Math.cos(radiansPerFrame);
      const sin = Math.sin(radiansPerFrame);
      const newX = offset.x * cos - offset.z * sin;
      const newZ = offset.x * sin + offset.z * cos;

      camera.position.x = target.x + newX;
      camera.position.z = target.z + newZ;
      camera.lookAt(target);
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

    // Update mempool indicators (show pending tx counts)
    updateMempoolIndicators();

    // Animate transaction particles
    animateParticles();

    // Animate entity pulses
    animateEntityPulses();

    // Animate grid pulse (on J-Machine broadcasts)
    if (gridPulseIntensity > 0 && gridHelper) {
      gridPulseIntensity *= 0.95; // Exponential decay
      if (gridPulseIntensity < 0.01) gridPulseIntensity = 0;

      // Pulse grid color toward bright green
      const baseMaterial = gridHelper.material as THREE.LineBasicMaterial;
      const pulseColor = new THREE.Color(gridColor).lerp(
        new THREE.Color(0x00ff88), // Bright green
        gridPulseIntensity
      );
      baseMaterial.color = pulseColor;
      baseMaterial.opacity = gridOpacity + (gridPulseIntensity * 0.3); // Brighten on pulse
    }

    // Update balance change ripples
    updateRipples();

    // Detect jurisdictional events (j-events) and create ripples (throttled)
    if (Math.random() < 0.05) { // Check ~5% of frames = 3 times per second at 60fps
      detectJurisdictionalEvents();
    }

    if (renderer && camera) {
      const renderStartTime = performance.now();
      renderer.render(scene, camera);
      perfMonitor.end(); // Complete FPS measurement

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

        // Calculate entity radii from locked global sizes
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
        if (connection.mempoolBoxes) {
          if (connection.mempoolBoxes.leftBox) {
            scene.remove(connection.mempoolBoxes.leftBox);
            disposeObject3D(connection.mempoolBoxes.leftBox);
          }
          if (connection.mempoolBoxes.rightBox) {
            scene.remove(connection.mempoolBoxes.rightBox);
            disposeObject3D(connection.mempoolBoxes.rightBox);
          }
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

      // DUMB PIPE: Calculate size directly from current reserves at render time
      let baseSize = getEntitySizeForToken(entityId, selectedTokenId);

      // Federal Reserve is 3x larger
      if (entity.mesh.userData['isFed']) {
        baseSize = baseSize * 3;
      }

      if (isActive) {
        // Check activity direction
        const hasIncoming = currentFrameActivity.incomingFlows.has(entityId);
        const hasOutgoing = currentFrameActivity.outgoingFlows.has(entityId);

        // Smooth size transitions - lerp toward target for visceral money flow
        const targetScale = baseSize;
        const currentScale = entity.mesh.scale.x;
        const lerpSpeed = 0.1; // Smooth but responsive
        const newScale = currentScale + (targetScale - currentScale) * lerpSpeed;
        entity.mesh.scale.setScalar(newScale);

        const pulseIntensity = Math.max(0, 1 - timeSinceActivity / 2000);

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

        // NO BOUNCING - ring stays static, opacity fades with activity
        entity.activityRing.scale.setScalar(1);
        ringMaterial.opacity = 0.6 * pulseIntensity;
      } else {
        // Inactive: smooth transition to base size (visceral money flow)
        const targetScale = baseSize;
        const currentScale = entity.mesh.scale.x;
        const lerpSpeed = 0.1;
        const newScale = currentScale + (targetScale - currentScale) * lerpSpeed;
        entity.mesh.scale.setScalar(newScale);

        // Color based on reserves: WHITE/LIGHT if $0, GREEN if has funds
        // Query actual reserves instead of relying on size threshold
        const hasReserves = checkEntityHasReserves(entityId);
        if (hasReserves) {
          material.color.setHex(0x00ff88); // Bright green - has funds
          material.emissive.setRGB(0, 0.15, 0.05);
        } else {
          material.color.setHex(0xcccccc); // Light white/grey - empty (visible)
          material.emissive.setRGB(0.1, 0.1, 0.1);
        }

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

  // Animate entity input strikes (bilateral messaging)
  function animateEntityInputStrikes() {
    if (!scene) return;

    const now = performance.now();

    for (let i = entityInputStrikes.length - 1; i >= 0; i--) {
      const strike = entityInputStrikes[i];
      if (!strike) continue;

      const elapsed = now - strike.startTime;
      const progress = Math.min(elapsed / strike.duration, 1.0);

      // Fade out opacity
      const material = strike.line.material as THREE.LineBasicMaterial;
      material.opacity = 1.0 - progress;

      // Animation complete
      if (progress >= 1.0) {
        // Clean up
        scene.remove(strike.line);
        strike.line.geometry.dispose();
        material.dispose();

        // Remove from array
        entityInputStrikes.splice(i, 1);
      }
    }
  }

  // Trigger entity input strike (called when bilateral message received)
  function triggerEntityInputStrike(fromEntityId: string, toEntityId: string) {
    if (!scene || fromEntityId === toEntityId) {
      if (fromEntityId === toEntityId) {
      }
      return;
    }

    const fromEntity = entities.find(e => e.id === fromEntityId);
    const toEntity = entities.find(e => e.id === toEntityId);

    if (!fromEntity || !toEntity) {
      return;
    }


    // Create thin cyan line
    const geometry = new THREE.BufferGeometry().setFromPoints([
      fromEntity.position.clone(),
      toEntity.position.clone()
    ]);

    const material = new THREE.LineBasicMaterial({
      color: 0x00ffff, // Cyan
      transparent: true,
      opacity: 1.0,
      linewidth: 2
    });

    const line = new THREE.Line(geometry, material);
    scene.add(line);

    entityInputStrikes.push({
      line,
      startTime: performance.now(),
      duration: 100 // 100ms flash
    });
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

        // Calculate required spacing based on locked global sizes
        const entityASizeData = getEntitySizeForToken(entityA.id, selectedTokenId);
        const entityBSizeData = getEntitySizeForToken(entityB.id, selectedTokenId);

        // Get account data to calculate bar length
        const currentReplicas = getTimeAwareReplicas();
        let totalBarsLength = 0;

        const fromReplica = [...currentReplicas.entries()]
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
      if (connection.mempoolBoxes) {
        if (connection.mempoolBoxes.leftBox) {
          scene.remove(connection.mempoolBoxes.leftBox);
          disposeObject3D(connection.mempoolBoxes.leftBox);
        }
        if (connection.mempoolBoxes.rightBox) {
          scene.remove(connection.mempoolBoxes.rightBox);
          disposeObject3D(connection.mempoolBoxes.rightBox);
        }
      }
    });
    connections = [];
    createConnections();
  }

  function onMouseDown(event: MouseEvent) {
    // Only handle left-click for entity dragging (button 0)
    // Let OrbitControls handle right-click (pan) and middle-click (zoom)
    if (event.button !== 0) return;

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

      // Only preventDefault when we're actually handling entity drag
      event.preventDefault();

      // Disable orbit controls during drag
      if (controls) {
        controls.enabled = false;
      }

      // Start dragging
      isDragging = true;
      hasMoved = false; // Reset movement flag for this drag
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
      // Mark entity as pinned only if actual movement occurred
      if (hasMoved) {
        draggedEntity.isPinned = true;
      }
      draggedEntity.isDragging = false;

      // Reset visual feedback
      if (draggedEntity.mesh.material instanceof THREE.MeshLambertMaterial) {
        draggedEntity.mesh.material.emissive.setHex(0x002200);
      }

      // Only process drag-related logic if actual movement occurred
      if (hasMoved) {
        // Check if entity violates spacing constraints after drag
        enforceSpacingConstraints();

        // Save positions after drag (persistence)
        saveEntityPositions();

        // Set flag to prevent click event from triggering camera refocus
        justDragged = true;
        setTimeout(() => {
          justDragged = false;
        }, 100); // Clear flag after 100ms
      }

      draggedEntity = null;
      isDragging = false;
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
      hasMoved = true; // Actual movement occurred
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
        const name = (clickedJMachine as any).userData.jurisdictionName as string;

        // Focus camera on this J-Machine
        if (controls && pos) {
          cameraTarget = pos;
          controls.target.set(pos.x, pos.y, pos.z);
          controls.update();
        }

        // Open Jurisdiction panel
        panelBridge.emit('openJurisdiction', { jurisdictionName: name });

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

      if (!entity || !entity.id) {
        // Clicked on lightning or other non-entity - ignore
        return;
      }

      // Trigger activity animation
      triggerEntityActivity(entity.id);

      // Get entity name and signerId for the clicked entity

      if (!entity.id) {
        console.error('[Graph3D] ❌ Entity has no ID!', entity);
        return;
      }

      const entityName = getEntityName(entity.id);
      const signerId = getSignerIdForEntity(entity.id);

      // Emit selection for other panels to react
      panelBridge.emit('entity:selected', { entityId: entity.id });

      // Directly open full entity panel (skip mini panel for faster UX)
      panelBridge.emit('openEntityOperations', {
        entityId: entity.id,
        entityName: entityName || entity.id.slice(0, 10),
        signerId: signerId || entity.id
      });

    } else {
      // Clicked on empty space - close mini panel
      showMiniPanel = false;
    }
  }

  // Get entity name from gossip/profile
  function getEntityName(entityId: string): string {
    if (!env?.gossip) return '';
    const profiles = typeof env.gossip.getProfiles === 'function' ? env.gossip.getProfiles() : (env.gossip.profiles || []);
    const profile = profiles.find((p: any) => p.entityId === entityId);
    return profile?.metadata?.name || '';
  }

  // Get signerId for an entity by looking up replica key in eReplicas
  function getSignerIdForEntity(entityId: string): string {
    const currentReplicas = getTimeAwareReplicas();
    // Find replica key that starts with this entityId
    for (const key of currentReplicas.keys() as IterableIterator<string>) {
      if (key.startsWith(entityId + ':')) {
        const signerId = key.slice(entityId.length + 1);
        return signerId;
      }
    }
    return entityId; // Fallback to entityId if no replica found
  }

  // Handle mini panel close
  function closeMiniPanel() {
    showMiniPanel = false;
  }

  // Handle mini panel actions
  function handleMiniPanelAction(event: CustomEvent) {
    const { type, entityId } = event.detail;
    // TODO: Open full operations panel or execute quick action
  }

  // Handle open full panel
  function handleOpenFullPanel(event: CustomEvent) {
    const { entityId, entityName, signerId } = event.detail;
    // Emit event to parent to open EntityOperationsPanel in Dockview
    // @ts-ignore - emit exists on panelBridge
    panelBridge.emit('openEntityOperations', { entityId, entityName, signerId: signerId || entityId });
    showMiniPanel = false;
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
        hasMoved = false; // Reset movement flag for this drag
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
        hasMoved = true; // Actual movement occurred
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
      // Mark entity as pinned only if actual movement occurred
      if (hasMoved) {
        draggedEntity.isPinned = true;
      }
      draggedEntity.isDragging = false;

      if (draggedEntity.mesh.material instanceof THREE.MeshLambertMaterial) {
        draggedEntity.mesh.material.emissive.setHex(0x002200);
      }

      // Only process drag-related logic if actual movement occurred
      if (hasMoved) {
        enforceSpacingConstraints();
        saveEntityPositions();

        justDragged = true;
        setTimeout(() => {
          justDragged = false;
        }, 100);
      }

      draggedEntity = null;
      isDragging = false;
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
    const currentReplicas = getTimeAwareReplicas();
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

  // ENTITY SIZING: PURE FUNCTION - NO STORAGE!
  // size = f(reserves, DOLLARS_PER_PX) - calculated at RENDER TIME from current frame's reserves
  //
  // VISUAL RATIO: How many USD = 1 visual unit of radius
  const DOLLARS_PER_PX = 500_000; // $500K = 1.0 radius
  const EMPTY_SIZE = 0.4;         // $0 entities - still visible
  const MIN_SIZE = 0.5;           // Minimum for funded entities
  const MAX_SIZE = 2.7;           // Cap for whales
  const VISUAL_POWER = 0.6;       // Scaling curve (0.5=sqrt, 0.33=cbrt)

  let lastLabelUpdateTimeIndex = -999; // Track for label updates on frame change

  function getEntitySizeForToken(entityId: string, _tokenId: number): number {
    // PURE FUNCTION: Always calculate from current time-aware reserves
    // No caching, no storage - just math
    const currentReplicas = getTimeAwareReplicas();

    // Find replica for this entity
    for (const [key, replica] of currentReplicas) {
      const replicaEntityId = key.split(':')[0] || key;
      if (replicaEntityId !== entityId) continue;

      if (!replica?.state?.reserves) {
        return EMPTY_SIZE;
      }

      const totalReserves = getTotalReserves(replica);
      const reserveValueUSD = Number(totalReserves) / 1e18;

      if (reserveValueUSD <= 0) {
        return EMPTY_SIZE;
      }

      // DETERMINISTIC: size = MIN_SIZE * (USD / DOLLARS_PER_PX) ^ VISUAL_POWER
      const ratio = Math.max(1, reserveValueUSD / DOLLARS_PER_PX);
      return Math.max(MIN_SIZE, Math.min(MIN_SIZE * Math.pow(ratio, VISUAL_POWER), MAX_SIZE));
    }

    return EMPTY_SIZE; // Entity not found in replicas
  }

  /** Check if entity has any reserves (for color determination) */
  function checkEntityHasReserves(entityId: string): boolean {
    const currentReplicas = getTimeAwareReplicas();  // Time-aware, not stale reactive
    for (const [key, value] of currentReplicas) {
      if (key.startsWith(entityId + ':')) {
        const replica = value as any;
        const reserveValues = getReserveValues(replica?.state?.reserves);
        for (const amount of reserveValues) {
          if (amount > 0n) return true;
        }
        return false;
      }
    }
    return false;
  }

  function calculateAvailableRoutes(from: string, to: string) {
    if (!env) {
      availableRoutes = [];
      return;
    }

    const routes: typeof availableRoutes = [];

    // Check for direct account
    const fromReplicaEntry = [...env.eReplicas.entries()].find(([k]) => k.startsWith(from + ':'));
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

      const currentReplicaEntry = [...env.eReplicas.entries()].find(([k]) => k.startsWith(current + ':'));
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
      for (const key of env.eReplicas.keys()) {
        if (key.startsWith(job.from + ':')) {
          ourReplica = env.eReplicas.get(key);
          break;
        }
      }

      if (!ourReplica) {
        throw new Error(`No replica found for entity ${getEntityShortName(job.from)} (${job.from})`);
      }

      // Multi-hop routing: Backend will find route if no direct account exists
      const hasDirectAccount = ourReplica?.state?.accounts?.has(job.to);
      if (!hasDirectAccount) {
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
      let signerId = '1'; // default
      for (const key of env.eReplicas.keys()) {
        if (key.startsWith(job.from + ':')) {
          signerId = key.split(':')[1] || '1';
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


      // Execute scenario
      const result = await XLN?.executeScenario($isolatedEnv, parsed.scenario);

      if (result.success) {

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
    const currentReplicas = getTimeAwareReplicas();
    const replica = [...currentReplicas.entries()]
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

  // REMOVED hardcoded bank names - override prepopulate names!
  const BANK_NAMES: string[] = [];

  // S&P 500 tickers (matches ArchitectPanel)
  const SP500_TICKERS = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
    'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS',
    'UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'TMO', 'MRK',
    'WMT', 'PG', 'KO', 'PEP', 'COST', 'HD', 'MCD', 'NKE',
    'XOM', 'CVX', 'BA', 'CAT', 'GE', 'MMM',
    'DIS', 'NFLX', 'CMCSA', 'T', 'VZ',
    'INTC', 'CSCO', 'ORCL', 'CRM', 'AMD'
  ];

  const FED_NAMES = new Map([
    ['federal_reserve', 'Federal Reserve'],
    ['ecb', 'European Central Bank'],
    ['boc', 'Bank of China'],
    ['boj', 'Bank of Japan'],
    ['boe', 'Bank of England'],
    ['snb', 'Swiss National Bank'],
    ['rbi', 'Reserve Bank of India'],
    ['cbr', 'Central Bank of Russia'],
    ['bundesbank', 'Bundesbank']
  ]);

  const FED_FLAGS = new Map([
    ['federal_reserve', ''],
    ['ecb', ''],
    ['boc', ''],
    ['boj', ''],
    ['boe', ''],
    ['snb', ''],
    ['rbi', ''],
    ['cbr', ''],
    ['bundesbank', '']
  ]);

  // AHB Demo entity names (entity IDs 1, 2, 3)
  // AHB entity names: EntityProvider reserves #1 for Foundation, so AHB uses #2, #3, #4
  const AHB_NAMES: Map<string, string> = new Map([
    ['2', 'Alice'],
    ['3', 'Hub'],
    ['4', 'Bob'],
  ]);

  /**
   * Get entity display name (realistic names for demo)
   */
  function getEntityShortName(entityId: string): string {
    // First check for AHB Demo names (entity IDs 1, 2, 3)
    const shortId = XLN?.getEntityShortId?.(entityId);
    if (shortId && AHB_NAMES.has(shortId)) {
      return AHB_NAMES.get(shortId)!;
    }

    // Check if it's a Fed entity (from replica signerId) - use time-aware replicas
    const currentReplicas = getTimeAwareReplicas();
    const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(entityId + ':'));
    const replica = replicaKey ? currentReplicas.get(replicaKey) : null;

    if (replica?.signerId) {
      // Check if S&P 500 ticker
      for (const ticker of SP500_TICKERS) {
        if (replica.signerId.includes(ticker)) {
          return ticker; // Show raw ticker (AAPL, MSFT, etc)
        }
      }

      // Check if Fed
      for (const [key, name] of FED_NAMES) {
        if (replica.signerId.toLowerCase().includes(key)) {
          return name;
        }
      }

      // Bank: use hash-based index to get consistent name
      const hash = entityId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const bankIndex = hash % BANK_NAMES.length;
      return BANK_NAMES[bankIndex] || entityId.slice(-4);
    }

    // Fallback to short ID
    return shortId || entityId.slice(-4);
  }

  /**
   * Get dual perspective account info (for connection hover tooltips)
   * Shows both left and right entity's view of the same account
   */
  function getDualConnectionAccountInfo(entityA: string, entityB: string): { left: string, right: string, leftEntity: string, rightEntity: string } {
    const currentReplicas = getTimeAwareReplicas();

    // Determine canonical ordering (left is always smaller ID)
    const isALeft = entityA < entityB;
    const leftId = isALeft ? entityA : entityB;
    const rightId = isALeft ? entityB : entityA;

    // Find account data by checking BOTH replicas (same logic as createProgressBars)
    let accountData: any = null;

    // Try left entity's replica first
    const leftReplica = [...currentReplicas.entries()]
      .find(([key]) => key.startsWith(leftId + ':'));

    if (leftReplica?.[1]?.state?.accounts) {
      // Account key is the counterparty ID
      accountData = leftReplica[1].state.accounts.get(rightId);
    }

    // Try right entity's replica if not found
    if (!accountData) {
      const rightReplica = [...currentReplicas.entries()]
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
<div class="graph3d-wrapper">
  <div bind:this={container} class="graph3d-panel"></div>

  <!-- Entity Mini Panel (on click) - TIME-TRAVEL AWARE -->
  {#if showMiniPanel}
    <EntityMiniPanel
      entityId={miniPanelEntityId}
      entityName={miniPanelEntityName}
      position={miniPanelPosition}
      {isolatedEnv}
      {isolatedHistory}
      {isolatedTimeIndex}
      on:close={closeMiniPanel}
      on:action={handleMiniPanelAction}
      on:openFull={handleOpenFullPanel}
    />
  {/if}
  <!-- FPS Overlay (outside container so canvas doesn't cover it) -->
  <!-- FPS + Network Stats Overlay - controlled by settings -->
  {#if showFpsOverlay}
  <div class="fps-overlay">
    <div class="fps-stat" class:fps-good={renderFps >= 55} class:fps-ok={renderFps >= 30 && renderFps < 55} class:fps-bad={renderFps < 30}>
      <span class="fps-label">Render FPS</span>
      <span class="fps-value">{renderFps.toFixed(1)}</span>
    </div>
    <div class="fps-stat-secondary">
      <span>{frameTime.toFixed(2)}ms/frame</span>
    </div>

    <div class="stats-divider"></div>

    <div class="network-stat">
      <span class="stat-label">Entities</span>
      <span class="stat-value">{entities.length}</span>
    </div>

    <div class="network-stat">
      <span class="stat-label">Connections</span>
      <span class="stat-value">{connections.length}</span>
    </div>

    <div class="network-stat">
      <span class="stat-label">Particles</span>
      <span class="stat-value">{particles.length}</span>
    </div>

    <button
      class="bars-mode-toggle"
      on:click={() => { barsMode = barsMode === 'close' ? 'spread' : 'close'; saveBirdViewSettings(); }}
      title="Toggle bars positioning: {barsMode === 'close' ? 'Center (close)' : 'Sides (spread)'}"
    >
      Bars: {barsMode === 'close' ? '⬌ Center' : '↔ Sides'}
    </button>
  </div>
  {/if}

  <!-- VR Controls HUD (for first-time Vision Pro users) -->
  <VRControlsHUD
    isVRActive={isVRActive}
    entityCount={entities.length}
    currentFPS={renderFps}
    onPaymentClick={() => {
      // Trigger random R2R payment
      if (entities.length >= 2) {
        const from = entities[Math.floor(Math.random() * entities.length)];
        const to = entities[Math.floor(Math.random() * entities.length)];
        if (from && to && from.id !== to.id) {
          panelBridge.emit('vr:payment', { from: from.id, to: to.id });
        }
      }
    }}
    onAutoRotateClick={() => {
      autoRotate = !autoRotate;
      panelBridge.emit('settings:update', { key: 'autoRotate', value: autoRotate });
    }}
    onExitVR={exitVR}
  />
</div>

<style>
  .graph3d-wrapper {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
    background: #000;
  }

  .graph3d-panel {
    width: 100%;
    height: 100%;
    position: absolute;
    top: 0;
    left: 0;
  }

  :global(.graph3d-panel canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .fps-overlay {
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid rgba(0, 255, 65, 0.3);
    border-radius: 6px;
    padding: 8px 12px;
    font-family: 'Courier New', monospace;
    pointer-events: none;
    z-index: 100;
  }

  .fps-stat {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
  }

  .fps-label {
    font-size: 11px;
    color: #888;
    text-transform: uppercase;
  }

  .fps-value {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }

  .fps-good .fps-value {
    color: #00ff41;
  }

  .fps-ok .fps-value {
    color: #ffaa00;
  }

  .fps-bad .fps-value {
    color: #ff4646;
  }

  .fps-stat-secondary {
    font-size: 10px;
    color: #666;
    text-align: right;
  }

  .stats-divider {
    height: 1px;
    background: rgba(0, 255, 65, 0.2);
    margin: 8px 0;
  }

  .network-stat {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .stat-label {
    font-size: 10px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .stat-value {
    font-size: 14px;
    font-weight: 700;
    color: #00ff88;
    font-family: 'Courier New', monospace;
  }
</style>
