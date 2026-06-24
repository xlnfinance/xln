<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get, type Writable } from 'svelte/store';
  import * as THREE from 'three';
  import type { OrbitControls as OrbitControlsType } from 'three/examples/jsm/controls/OrbitControls.js';
  import { VRHandTrackingController, type GrabbableEntity } from '../utils/vrHandTracking';
  import { EntityManager } from '$lib/network3d/EntityManager';
  import { createAccountBars } from '$lib/network3d/AccountBarRenderer';
  import { panelBridge } from '../utils/panelBridge';
  import { PerformanceMonitor, type PerfMetrics } from '../utils/perfMonitor';
  import { entityPositions, type RelativeEntityPosition } from '$lib/stores/xlnStore';
  import Graph3DViewport from '../components/Graph3DViewport.svelte';
  import { HandGesturePaymentController } from '../utils/handGesturePayments';
  import { compareStableText } from '$lib/utils/stableSort';
  import { createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
  import {
    buildGraphAvailableRoutes,
    formatGraphDualConnectionAccountInfoFromReplicas,
    formatGraphEntityBalanceInfo,
    formatGraphEntityShortNameFromReplicas,
    formatGraphMempoolTxLabel,
    formatGraphReserveBadge,
    getGraphEntityNameFromGossip,
    getGraphEntityFlag,
    getGraphSignerIdForEntity,
    graphEntityHasReserves,
    graphReserveValue,
    graphTotalReserves,
    parseGraphScenarioSteps,
    type GraphPaymentRoute,
  } from './graph3d-helpers';
  import {
    buildBirdViewSettings,
    readBirdViewSettings,
    writeBirdViewSettings,
    type BirdViewSettings,
  } from './graph3d-settings';
  import type {
    GraphConnectionData,
    GraphDerivedAccountData,
    GraphEntityData,
    GraphFrameActivity,
    GraphJBlockHistoryEntry,
    GraphPaymentJob,
    GraphRendererMode,
    GraphRipple,
    GraphXLNRuntime,
  } from './graph3d-types';
  let showMiniPanel = false;
  let miniPanelEntityId = '';
  let miniPanelEntityName = '';
  let miniPanelPosition = { x: 0, y: 0 };
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;
  export let isolatedTimeIndex: Writable<number>;
  export let isolatedIsLive: Writable<boolean>;
  export let graphInitSignal: Writable<boolean> | undefined = undefined;
  $: initEnabled = graphInitSignal ? $graphInitSignal : true;
  $: env = (() => {
    const timeIdx = $isolatedTimeIndex;
    const historyFrames = $isolatedHistory;
    if (timeIdx >= 0 && historyFrames && historyFrames.length > 0) {
      const idx = Math.min(timeIdx, historyFrames.length - 1);
      return historyFrames[idx];  // Historical frame
    }
    return $isolatedEnv;  // Live state
  })();
  $: replicas = env?.eReplicas || new Map();
  $: activeJurisdictionName = env?.activeJurisdiction
    || (env?.jReplicas ? (Array.from(env.jReplicas.values())[0] as { name?: string } | undefined)?.name ?? null : null)
    || null;
  $: jurisdictionsData = (() => {
    if (!env?.jReplicas) return [];
    const jReplicaValues = Array.from(env.jReplicas.values()) as any[];
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
  function getTimeAwareReplicas(): Map<string, any> {
    const timeIndex = get(isolatedTimeIndex);
    const hist = get(isolatedHistory);
    if (timeIndex >= 0 && hist && hist.length > 0) {
      const idx = Math.min(timeIndex, hist.length - 1);
      return hist[idx]?.eReplicas || new Map();
    }
    return get(isolatedEnv)?.eReplicas || new Map();
  }
  function getLiveEnvForAction(action: string): any {
    if (get(isolatedTimeIndex) !== -1 || !get(isolatedIsLive)) {
      throw new Error(`${action} requires LIVE mode. Switch to the current runtime state before acting.`);
    }
    const currentEnv = get(isolatedEnv);
    const liveEnv = unwrapLiveRuntimeEnv(currentEnv) ?? currentEnv;
    if (!liveEnv?.eReplicas || !(liveEnv.eReplicas instanceof Map)) {
      throw new Error(`${action} requires live runtime environment`);
    }
    return liveEnv;
  }
  let XLN: GraphXLNRuntime | null = null;
  const debug = {
    warn: (...args: unknown[]) => console.warn('[Graph3D]', ...args),
    error: (...args: unknown[]) => console.error('[Graph3D]', ...args)
  };
  const reportGraphInitError = (error: unknown) => {
    debug.error('Graph initialization failed:', error);
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
  const createRenderer = async (mode: string, options: THREE.WebGLRendererParameters) => {
    if (mode === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        const { default: WebGPURenderer } = await import('three/src/renderers/webgpu/WebGPURenderer.js');
        const renderer = new WebGPURenderer({ antialias: options.antialias });
        await renderer.init();
        return renderer;
      } catch (err) {
      }
    }
    try {
      return new THREE.WebGLRenderer(options);
    } catch (err) {
      console.error('[Graph3D] Renderer init failed:', err);
      return null;
    }
  };
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
  let OrbitControls: typeof OrbitControlsType;
  let container: HTMLDivElement;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let renderer: THREE.WebGLRenderer | any; // WebGPURenderer fallback
  let controls: any;
  let raycaster: THREE.Raycaster;
  let mouse: THREE.Vector2;
  let entityManager: EntityManager;
  let entityMeshMap = new Map<string, THREE.Object3D | undefined>();
  let jMachines: Map<string, THREE.Group> = new Map(); // jurisdiction name → J-Machine mesh
  $: jMachine = activeJurisdictionName ? jMachines.get(activeJurisdictionName) || null : null;
  let jMachineTxBoxes: (THREE.Group | THREE.Mesh)[] = []; // Yellow tx cubes inside J-Machine (current mempool)
  let jBlockHistory: GraphJBlockHistoryEntry[] = []; // Last 3 committed blocks stacked above J-machine
  let jMachineCapacity = 3; // Max txs before broadcast (lowered to show O(n) problem)
  let broadcastEnabled = true;
  let jAutoProposerInterval: ReturnType<typeof setInterval> | null = null;
  let jProposalIntervalMs = 1000; // 1 second default - configurable
  let jLastProposalTime = 0; // Track last proposal timestamp
  let jAutoProposerEnabled = true; // Enable/disable auto-proposer
  let lastAnimatedFrameIndex = -1; // Track which frame we last animated (to avoid re-animating)
  let entities: GraphEntityData[] = [];
  let connections: GraphConnectionData[] = [];
  let particles: Array<{
    mesh: THREE.Mesh;
    connectionIndex: number;
    progress: number;
    speed: number;
    type: string;
    amount?: bigint;
    direction?: 'incoming' | 'outgoing';
  }> = [];
  let entityInputStrikes: Array<{
    line: THREE.Line;
    startTime: number;
    duration: number;
  }> = [];
  let currentFrameActivity: GraphFrameActivity = {
    activeEntities: new Set(),
    incomingFlows: new Map(),
    outgoingFlows: new Map()
  };
  let connectionIndexMap: Map<string, number> = new Map();
  let animationId: number | null;
  let activeBroadcastSpheres: Array<{ sphere: THREE.Mesh; animationId: number }> = [];
  let hoveredObject: any = null;
  let tooltip = { visible: false, x: 0, y: 0, content: '' };
  let dualTooltip = {
    visible: false,
    x: 0,
    y: 0,
    leftContent: '',
    rightContent: '',
    leftEntity: '',
    rightEntity: ''
  };
  let draggedEntity: GraphEntityData | null = null;
  let dragPlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // Plane for 3D dragging
  let dragOffset: THREE.Vector3 = new THREE.Vector3();
  let isDragging: boolean = false;
  let hasMoved: boolean = false; // Track if actual movement occurred during drag
  let justDragged: boolean = false; // Flag to prevent click after drag
  function loadBirdViewSettings(): BirdViewSettings {
    return readBirdViewSettings(typeof localStorage === 'undefined' ? null : localStorage);
  }
  function saveBirdViewSettings(wasOpened: boolean = true) {
    const nextSettings = buildBirdViewSettings({
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
    });
    writeBirdViewSettings(typeof localStorage === 'undefined' ? null : localStorage, nextSettings);
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
  const savedSettings = loadBirdViewSettings();
  let barsMode: 'close' | 'spread' = savedSettings.barsMode;
  let selectedTokenId = savedSettings.selectedTokenId;
  let viewMode: '2d' | '3d' = savedSettings.viewMode;
  let entityMode: 'sphere' | 'identicon' = savedSettings.entityMode;
  let rotationX: number = savedSettings.rotationX; // 0-10000 (0 = stopped, 10000 = fast)
  let rotationY: number = savedSettings.rotationY; // 0-10000 (0 = stopped, 10000 = fast)
  let rotationZ: number = savedSettings.rotationZ; // 0-10000 (0 = stopped, 10000 = fast)
  let availableTokens: number[] = []; // Will be populated from actual token data
  let rendererMode: GraphRendererMode = 'webgl';
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
  function getTokenSymbol(tokenId: number): string {
    const tokenInfo = XLN?.getTokenInfo?.(tokenId);
    return tokenInfo?.symbol || `TKN${tokenId}`;
  }
  let paymentFrom: string = '';
  let paymentTo: string = '';
  let paymentAmount: string = '200000';
  let paymentTPS: number = 0; // 0-100 TPS (0 = once, 0.1 = every 10s, 100 = max)
  $: if (entities.length >= 2 && !paymentFrom && !paymentTo) {
    const firstEntity = entities[0];
    const secondEntity = entities[1];
    if (firstEntity && secondEntity) {
      paymentFrom = firstEntity.id;
      paymentTo = secondEntity.id;
    }
  }
  $: if (paymentFrom && paymentTo && paymentFrom !== paymentTo) {
    calculateAvailableRoutes(paymentFrom, paymentTo);
  } else {
    availableRoutes = [];
    selectedRouteIndex = 0;
  }
  $: if (availableRoutes.length > 0 && selectedRouteIndex >= 0) {
    highlightRoutePath(availableRoutes[selectedRouteIndex]);
  } else {
    clearRouteHighlight();
  }
  $: if (scene && settings.theme) {
    const themeColors = getThemeColors(settings.theme);
    scene.background = new THREE.Color(themeColors.background);
  }
  let selectedScenarioFile: string = '';
  let isLoadingScenario: boolean = false;
  let scenarioSteps: Array<{timestamp: number; title: string; description: string; actions: any[]}> = [];
  let activeJobs: GraphPaymentJob[] = [];
  $: if (selectedScenarioFile) {
    loadScenarioSteps(selectedScenarioFile);
  }
  $: if (scene && jurisdictionsData) {
    const jurisdictionsArray = jurisdictionsData;
    const currentJurisdictionNames = new Set(jurisdictionsArray.map(x => x.name));
    for (const [name, mesh] of jMachines.entries()) {
      if (!currentJurisdictionNames.has(name)) {
        scene.remove(mesh);
        jMachines.delete(name);
      }
    }
    jurisdictionsArray.forEach((jurisdiction) => {
      if (!jMachines.has(jurisdiction.name)) {
        const jMachineGroup = createJMachine(12, jurisdiction.jMachine.position, jurisdiction.name, jurisdiction.jMachine.jHeight); // 2x smaller for Fed Chair UX
        scene.add(jMachineGroup);
        jMachines.set(jurisdiction.name, jMachineGroup);
      }
    });
    jurisdictionsArray.forEach((jurisdiction) => {
      const jMachineGroup = jMachines.get(jurisdiction.name);
      if (jMachineGroup) {
        const label = jMachineGroup.children.find((child: any) => child.isSprite) as THREE.Sprite | undefined;
        if (label && label.material && label.material.map) {
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
            const texture = new THREE.CanvasTexture(canvas);
            label.material.map = texture;
            label.material.needsUpdate = true;
          }
        }
      }
    });
    const activeJurisdiction = jurisdictionsArray.find(x => x.name === activeJurisdictionName);
    const activeJMachine = activeJurisdiction ? jMachines.get(activeJurisdiction.name) : undefined;
    if (activeJurisdiction && activeJMachine) {
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
      jMachineTxBoxes.forEach(cube => {
        if (cube && activeJMachine) {
          activeJMachine.remove(cube);
          disposeObject3D(cube);
        }
      });
      jMachineTxBoxes = [];
      const mempool = activeJurisdiction.jMachine.mempool || [];
      const currentJHeight = activeJurisdiction.jMachine.jHeight || 0;
      const nextBlockHeight = Number(currentJHeight) + 1;
      mempool.forEach((tx: any, txIndex: number) => {
        const txCube = createMempoolTxCube(txIndex, tx, nextBlockHeight);
        activeJMachine.add(txCube);
        jMachineTxBoxes.push(txCube);
      });
      if (prevFrame) {
        const prevJReplica = prevFrame.jReplicas?.find((jr: any) => jr.name === activeJurisdiction.name);
        const prevJHeight = Number(prevJReplica?.jHeight || 0);
        const currJHeightNum = Number(currentJHeight);
        if (currJHeightNum > prevJHeight && prevMempoolSize > 0) {
          const blockNumber = BigInt(currJHeightNum);
          const prevMempool = prevJReplica?.mempool || [];
          const { container: blockContainer, txCubes } = createBlockContainer(
            blockNumber,
            prevMempool,
            activeJMachine.position,
            15 // Initial yOffset for new block
          );
          const blockSpacing = 15;
          jBlockHistory.forEach(block => {
            block.yOffset += blockSpacing;
            block.container.position.y = activeJMachine.position.y + block.yOffset;
          });
          blockContainer.position.copy(activeJMachine.position);
          blockContainer.position.y += blockSpacing;
          scene.add(blockContainer);
          jBlockHistory.push({
            blockNumber,
            container: blockContainer,
            txCubes,
            yOffset: blockSpacing
          });
          while (jBlockHistory.length > 3) {
            const oldBlock = jBlockHistory.shift();
            if (oldBlock) {
              scene.remove(oldBlock.container);
              disposeObject3D(oldBlock.container);
            }
          }
          createProportionalBroadcast(activeJMachine.position, prevMempoolSize);
        }
      }
      const currentHeightNum = Number(currentJHeight);
      const runtimeHistory = $isolatedHistory || [];
      if (runtimeHistory.length > 0 && currentHeightNum > 0) {
        const blockBoundaries: Array<{ blockNum: number; txs: any[] }> = [];
        for (let targetHeight = currentHeightNum - 1; targetHeight >= Math.max(0, currentHeightNum - 3); targetHeight--) {
          const maxFrameIdx = $isolatedTimeIndex >= 0 ? Math.min($isolatedTimeIndex, runtimeHistory.length - 1) : runtimeHistory.length - 1;
          let foundFrame = null;
          let foundIdx = -1;
          let foundHeight = -1;
          for (let frameIdx = maxFrameIdx; frameIdx >= 0; frameIdx--) {
            const frame = runtimeHistory[frameIdx];
            const frameJReplica = frame?.jReplicas?.find((jr: any) => jr.name === activeJurisdiction.name);
            const frameJHeight = Number(frameJReplica?.jHeight || frameJReplica?.blockNumber || 0);
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
        const expectedBlocks = blockBoundaries.length;
        if (jBlockHistory.length !== expectedBlocks ||
            (jBlockHistory[0] && Number(jBlockHistory[0].blockNumber) !== blockBoundaries[0]?.blockNum)) {
          jBlockHistory.forEach(block => {
            scene.remove(block.container);
            disposeObject3D(block.container);
          });
          jBlockHistory = [];
          blockBoundaries.reverse().forEach((boundary, idx) => {
            const blockNum = BigInt(boundary.blockNum);
            const yOffset = (blockBoundaries.length - idx) * 15; // Stack upward
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
    const gridSize = 3;
    const spacing = 2.5; // Space between cubes (fits 3 cubes in ~7.5 width)
    const xIndex = index % gridSize;
    const zIndex = Math.floor(index / gridSize) % gridSize;
    const yIndex = Math.floor(index / (gridSize * gridSize));
    const halfGrid = (gridSize - 1) * spacing / 2;
    group.position.set(
      -halfGrid + xIndex * spacing,
      -4 + yIndex * spacing, // Start near bottom of cube (-6 + 2 buffer)
      -halfGrid + zIndex * spacing
    );
    if (tx) {
      const label = formatGraphMempoolTxLabel(tx, blockHeight);
      const labelSprite = createTxLabelSprite(label);
      labelSprite.position.set(0, -(cubeSize + 0.3), 0); // Below the cube
      group.add(labelSprite);
    }
    return group;
  }
  function createTxLabelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 48;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 14px monospace';
    ctx.textBaseline = 'middle';
    const hasWithdrawals = text.includes('-') && text.includes('W');
    const hasDeposits = text.includes('+') && text.includes('D');
    if (hasWithdrawals && hasDeposits) {
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
  let animationSpeed = 1.0;
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
    const blockEdgesGeo = new THREE.EdgesGeometry(blockCubeGeo);
    const blockEdgesMat = new THREE.LineBasicMaterial({ color: 0x66ccff, linewidth: 2 });
    const blockEdges = new THREE.LineSegments(blockEdgesGeo, blockEdgesMat);
    blockContainer.add(blockEdges);
    const txCubes: THREE.Object3D[] = [];
    txs.slice(0, 9).forEach((tx: any, txIdx: number) => {
      const txCube = createMempoolTxCube(txIdx, tx, Number(blockNum));
      blockContainer.add(txCube);
      txCubes.push(txCube);
    });
    return { container: blockContainer, txCubes };
  }
  function createProportionalBroadcast(jMachinePos: THREE.Vector3, txCount: number) {
    if (!scene || txCount === 0) return;
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
      const eased = 1 - Math.pow(1 - progress, 2);
      const scale = 1 + eased * maxScale;
      sphere.scale.set(scale, scale, scale);
      sphereMaterial.opacity = (0.3 + intensity * 0.3) * (1 - progress);
      if (progress < 1) {
        rafId = requestAnimationFrame(animateExpand);
      } else {
        scene.remove(sphere);
        sphereGeometry.dispose();
        sphereMaterial.dispose();
        activeBroadcastSpheres = activeBroadcastSpheres.filter(s => s.sphere !== sphere);
      }
    }
    rafId = requestAnimationFrame(animateExpand);
    activeBroadcastSpheres.push({ sphere, animationId: rafId });
  }
  $: if (jMachine && $isolatedTimeIndex === -1) {
    const historyFrames = $isolatedHistory;
    const currentLen = historyFrames?.length || 0;
    if (currentLen > lastAnimatedFrameIndex + 1) {
      for (let i = lastAnimatedFrameIndex + 1; i < currentLen; i++) {
        const frame = historyFrames[i];
        const entityInputs = frame?.runtimeInput?.entityInputs || [];
        entityInputs.forEach((entityInput: any) => {
          const txs = entityInput?.entityTxs || entityInput?.input?.txs || [];
          txs.forEach((tx: any) => {
            const txKind = tx.kind || tx.type;
            if (txKind === 'payFromReserve' || txKind === 'payToReserve' || txKind === 'settleToReserve') {
              addTxToJMachine(entityInput.entityId);
              const targetId = tx.targetEntityId || tx.data?.targetEntityId;
              const amount = tx.amount || tx.data?.amount;
              if (txKind === 'payFromReserve' && targetId) {
              }
            }
          });
        });
      }
      lastAnimatedFrameIndex = currentLen - 1;
    }
  }
  $: if (entities.length > 0) {
    entities.forEach(entity => {
      entityMeshMap.set(entity.id, entity.mesh);
    });
  }
  async function loadScenarioSteps(filename: string) {
    try {
      const response = await fetch(`/worlds/${filename}`);
      if (!response.ok) return;
      const text = await response.text();
      scenarioSteps = parseGraphScenarioSteps(text);
    } catch (error) {
      console.error('Failed to load scenario steps:', error);
      scenarioSteps = [];
    }
  }
  let isVRSupported: boolean = false;
  let isVRActive: boolean = false;
  let handTrackingController: VRHandTrackingController | null = null;
  let activeRipples: GraphRipple[] = [];
  let availableRoutes: GraphPaymentRoute[] = [];
  let selectedRouteIndex: number = 0;
  let graphInitialized = false;
  let recentActivity: Array<{
    id: string;
    message: string;
    timestamp: number;
    type: 'payment' | 'credit' | 'settlement' | 'j-event' | 'commit';
  }> = [];
  async function initAndSetup() {
    if (graphInitialized) return;
    graphInitialized = true;
    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      XLN = await import(/* @vite-ignore */ runtimeUrl);
    } catch (err) {
      console.error('[Graph3D] Failed to load XLN runtime:', err);
    }
    if ('xr' in navigator && (navigator as any).xr) {
      try {
        const vrSupported = await (navigator as any).xr.isSessionSupported('immersive-vr');
        isVRSupported = vrSupported === true;
      } catch (err) {
        isVRSupported = false;
      }
    } else {
      isVRSupported = false;
    }
    await initThreeJS();
    animate();
    startJAutoProposer();
  }
  $: if (initEnabled && !graphInitialized) {
    initAndSetup().catch(reportGraphInitError);
  }
  onMount(() => {
    if (initEnabled) {
      initAndSetup().catch(reportGraphInitError);
    }
    const handleVRToggle = () => {
      if (isVRActive) {
        exitVR();
      } else {
        enterVR();
      }
    };
    panelBridge.on('vr:toggle', handleVRToggle);
    const handleBroadcastToggle = (event: any) => {
      broadcastEnabled = event.enabled;
    };
    panelBridge.on('broadcast:toggle', handleBroadcastToggle);
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
    const handleScenarioLoaded = () => {
      if (scene) updateNetworkData();
    };
    panelBridge.on('scenario:loaded', handleScenarioLoaded);
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
  let resizeObserver: ResizeObserver | null = null;
  onDestroy(() => {
    if (jAutoProposerInterval) {
      clearInterval(jAutoProposerInterval);
      jAutoProposerInterval = null;
    }
    if (resizeObserver && container) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
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
    entityMeshMap.clear();
    entityInputStrikes.forEach(strike => {
      if (strike.line && scene) {
        scene.remove(strike.line);
        strike.line.geometry.dispose();
        (strike.line.material as THREE.Material).dispose();
      }
    });
    entityInputStrikes = [];
    if (entityManager) {
      entityManager.clear();
    }
  });
  function createGrid() {
    if (!scene) return;
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
  function recreateGrid() {
    requestAnimationFrame(() => {
      if (!scene || !gridHelper) return;
      scene.remove(gridHelper);
      gridHelper.geometry.dispose();
      (gridHelper.material as THREE.Material).dispose();
      createGrid();
    });
  }
  function createJMachine(
    size: number = 25,
    position: { x: number; y: number; z: number } = { x: 0, y: 200, z: 0 },
    name: string = 'J-MACHINE',
    jHeight: number = 0
  ): THREE.Group {
    const group = new THREE.Group();
    group.position.set(position.x, position.y, position.z); // Position from jurisdiction config
    group.userData = {
      type: 'jMachine',
      jurisdictionName: name,
      position
    };
    const cubeGeometry = new THREE.BoxGeometry(size, size, size);
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
    const edgesGeometry = new THREE.EdgesGeometry(cubeGeometry);
    const edgesMaterial = new THREE.LineBasicMaterial({
      color: 0x66ccff, // Bright cyan edges
      linewidth: 2
    });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    group.add(edges);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) {
      canvas.width = 256;
      canvas.height = 64;
      context.fillStyle = '#66ccff';
      context.font = 'bold 28px monospace';
      context.textAlign = 'center';
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
  function addTxToJMachine(fromEntityId: string): THREE.Mesh | null {
    if (!jMachine || !scene) return null;
    const txGeometry = new THREE.BoxGeometry(2, 2, 2);
    const txMaterial = new THREE.MeshPhongMaterial({
      color: 0xffff00, // Yellow
      emissive: 0x888800,
      transparent: true,
      opacity: 0.9
    });
    const txCube = new THREE.Mesh(txGeometry, txMaterial);
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
    if (jMachineTxBoxes.length >= jMachineCapacity) {
      triggerBroadcast();
    }
    return txCube;
  }
  function triggerBroadcast() {
    if (!broadcastEnabled || !jMachine || !scene) return;
    jMachineTxBoxes.forEach(txCube => {
      if (jMachine) jMachine.remove(txCube);
    });
    jMachineTxBoxes = [];
  }
  function startJAutoProposer() {
    if (jAutoProposerInterval) {
      clearInterval(jAutoProposerInterval);
    }
    jLastProposalTime = Date.now();
    jAutoProposerInterval = setInterval(() => {
      if (!jAutoProposerEnabled || !jMachine || !scene) return;
      if (jMachineTxBoxes.length === 0) return;
      const now = Date.now();
      jLastProposalTime = now;
      triggerBroadcast();
      if (typeof window !== 'undefined' && (window as any).XLN?.clearJMempool) {
        (window as any).XLN.clearJMempool();
      }
      gridPulseIntensity = 1.0;
    }, jProposalIntervalMs);
  }
  async function initThreeJS() {
    if (renderer || scene) {
      return;
    }
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    try {
      const { OrbitControls: OC } = await import('three/examples/jsm/controls/OrbitControls.js');
      OrbitControls = OC;
    } catch (error) {
      debug.warn('OrbitControls not available:', error);
    }
    scene = new THREE.Scene();
    const themeColors = getThemeColors(settings.theme);
    scene.background = new THREE.Color(themeColors.background);
    createGrid();
    const containerWidth = container.clientWidth || window.innerWidth;
    const containerHeight = container.clientHeight || window.innerHeight;
    camera = new THREE.PerspectiveCamera(
      75,
      containerWidth / containerHeight,
      0.01, // Near plane: zoom extremely close
      100000 // Far plane: see objects at extreme distances
    );
    camera.position.set(0.41, 572.94, 38.32); // AHB top-down view
    renderer = await createRenderer(rendererMode, { antialias: false }); // Disabled for performance
    if (!renderer) {
      console.warn('[Graph3D] Renderer unavailable - skipping 3D init');
      return;
    }
    renderer.xr.enabled = !(typeof navigator !== 'undefined' && (navigator as any).webdriver);  // Keep XR off in automation
    renderer.setSize(containerWidth, containerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // Cap at 1.5 for performance
    container.appendChild(renderer.domElement);
    if (typeof window !== 'undefined') {
      (window as any).__debugScene = scene;
      (window as any).__debugCamera = camera;
      (window as any).__debugRenderer = renderer;
    }
    if (OrbitControls) {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.enableZoom = true;
      controls.enableRotate = true;
      controls.enablePan = true;
      controls.screenSpacePanning = true;
      controls.minDistance = 0; // No minimum - zoom into anything
      controls.maxDistance = Infinity; // No maximum - zoom out as far as you want
      controls.keys = { LEFT: '', UP: '', RIGHT: '', BOTTOM: '' };
      controls.target.set(-37, 511, -243);
      controls.update();
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
      controls.target.set(cameraTarget.x, cameraTarget.y, cameraTarget.z);
      if (savedSettings.camera) {
        const cam = savedSettings.camera;
        camera.position.set(cam.position.x, cam.position.y, cam.position.z);
        controls.target.set(cam.target.x, cam.target.y, cam.target.z);
        camera.zoom = cam.zoom;
        camera.updateProjectionMatrix();
        controls.update();
      } else {
        controls.update();
      }
      controls.addEventListener('end', () => {
        saveBirdViewSettings();
      });
    }
    raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 5 };
    mouse = new THREE.Vector2();
    const ambientLight = new THREE.AmbientLight(0x606060, 1.2); // Brighter for AR
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(200, 50, 50); // Position light above grid center
    scene.add(directionalLight);
    const rimLight = new THREE.DirectionalLight(0x00ff88, 0.4);
    rimLight.position.set(-200, 30, -50); // Opposite side
    scene.add(rimLight);
    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('mouseup', onMouseUp);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseout', onMouseOut);
    renderer.domElement.addEventListener('click', onMouseClick);
    renderer.domElement.addEventListener('dblclick', onMouseDoubleClick);
    renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
    renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
    renderer.domElement.addEventListener('touchend', onTouchEnd);
    window.addEventListener('resize', onWindowResize);
    resizeObserver = new ResizeObserver(() => {
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
    if (isVRSupported && renderer) {
      setupVRControllers();
    }
    entityManager = new EntityManager(scene);
  }
  function setupVRControllers() {
    if (!renderer || !scene) return;
    const controller1 = renderer.xr.getController(0);
    controller1.addEventListener('selectstart', onVRSelectStart);
    controller1.addEventListener('selectend', onVRSelectEnd);
    scene.add(controller1);
    const controller2 = renderer.xr.getController(1);
    controller2.addEventListener('selectstart', onVRSelectStart);
    controller2.addEventListener('selectend', onVRSelectEnd);
    scene.add(controller2);
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
  function initHandTracking(): void {
    if (!renderer || !scene) return;
    const grabbedEntities = new Map<string, { originalScale: THREE.Vector3; originalEmissive: number }>();
    handTrackingController = new VRHandTrackingController(
      renderer as THREE.WebGLRenderer,
      scene,
      {
        onGrab: (entityId, handedness) => {
          const entity = entities.find(e => e.id === entityId);
          if (!entity) return;
          entity.isPinned = true;
          grabbedEntities.set(entityId, {
            originalScale: entity.mesh.scale.clone(),
            originalEmissive: (entity.mesh.material as THREE.MeshLambertMaterial)?.emissiveIntensity || 0
          });
          entity.mesh.scale.multiplyScalar(1.3);
          if (entity.mesh.material) {
            const mat = entity.mesh.material as THREE.MeshLambertMaterial;
            mat.emissiveIntensity = (mat.emissiveIntensity || 0) + 0.5;
          }
        },
        onRelease: (entityId, targetEntityId, handedness) => {
          const entity = entities.find(e => e.id === entityId);
          if (!entity) return;
          const original = grabbedEntities.get(entityId);
          if (original) {
            entity.mesh.scale.copy(original.originalScale);
            if (entity.mesh.material) {
              const mat = entity.mesh.material as THREE.MeshLambertMaterial;
              mat.emissiveIntensity = original.originalEmissive;
            }
            grabbedEntities.delete(entityId);
          }
          if (targetEntityId) {
            panelBridge.emit('vr:hand-payment', {
              from: entityId,
              to: targetEntityId
            });
          }
        },
        onHover: (entityId, handedness) => {
        }
      }
    );
    handTrackingController.init();
  }
  let vrGrabbedEntity: any = null;
  let vrGrabController: any = null;
  function onVRSelectStart(event: any) {
    const controller = event.target;
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
      initHandTracking();
      scene.background = null; // Transparent = passthrough mode
      if (scene) {
        scene.scale.setScalar(0.01); // 1/100 scale = table-sized economy
        scene.position.set(0, -0.5, -1); // Position on table in front of user
      }
      const createWelcomePanel = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 512;
        const ctx = canvas.getContext('2d')!;
        const gradient = ctx.createLinearGradient(0, 0, 0, 512);
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0.95)');
        gradient.addColorStop(1, 'rgba(10, 30, 50, 0.95)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 1024, 512);
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 6;
        ctx.shadowColor = '#00ffff';
        ctx.shadowBlur = 20;
        ctx.strokeRect(3, 3, 1018, 506);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#00ffff';
        ctx.font = 'bold 56px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('🏦 XLN FINANCIAL NETWORK', 512, 80);
        ctx.fillStyle = '#ffffff';
        ctx.font = '28px monospace';
        ctx.fillText('Cross-Jurisdictional Settlement System', 512, 130);
        ctx.font = 'bold 32px monospace';
        ctx.fillStyle = '#4fd18b';
        ctx.fillText(' GREEN NUMBERS = Bank Reserves', 512, 200);
        ctx.fillStyle = '#00ff41';
        ctx.fillText('🔵 BLUE LINES = Open Accounts', 512, 250);
        ctx.fillStyle = '#ffff00';
        ctx.fillText('🟡 YELLOW DOTS = Payments Flowing', 512, 300);
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
        setTimeout(() => {
          scene.remove(mesh);
          mesh.geometry.dispose();
          mesh.material.map?.dispose();
          mesh.material.dispose();
        }, 10000);
        return mesh;
      };
      const welcomePanel = createWelcomePanel();
      setTimeout(() => {
        panelBridge.emit('auto-demo:start', {});
      }, 3000);
      renderer.setAnimationLoop(animate);
      session.addEventListener('end', () => {
        isVRActive = false;
        if (welcomePanel && scene) {
          scene.remove(welcomePanel);
          welcomePanel.geometry.dispose();
          welcomePanel.material.map?.dispose();
          welcomePanel.material.dispose();
        }
        scene.background = new THREE.Color(0x0a0a0a);
        if (scene) {
          scene.scale.setScalar(1);
          scene.position.set(0, 0, 0);
        }
        renderer.setAnimationLoop(null);
        animate();
      });
    } catch (error) {
      console.error('Failed to enter VR:', error);
      debug.error('VR session failed: ' + (error as Error).message);
    }
  }
  async function exitVR() {
    if (renderer?.xr?.getSession) {
      const session = await renderer.xr.getSession();
      if (session) {
        await session.end();
      }
    }
  }
  function fitCameraToEntities() {
    if (!camera || !controls || entities.length === 0) return;
    const box = new THREE.Box3();
    entities.forEach(entity => {
      box.expandByPoint(entity.position);
    });
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = Math.max(maxDim * 1.5, 50); // Min 50 units away
    camera.position.set(
      center.x,
      center.y + distance * 0.7,  // Above
      center.z + distance * 0.7   // Behind
    );
    controls.target.copy(center);
    controls.update();
  }
  function updateNetworkData() {
    if (!scene) return;
    const timeIndex = $isolatedTimeIndex;
    updateAvailableTokens();
    const computedEnv = (() => {
      const hist = get(isolatedHistory);
      if (timeIndex >= 0 && hist && hist.length > 0) {
        const idx = Math.min(timeIndex, hist.length - 1);
        return hist[idx];  // Historical frame
      }
      return get(isolatedEnv);  // Live state
    })();
    let entityData: any[] = [];
    let currentReplicas = computedEnv?.eReplicas || new Map();
    if (currentReplicas && currentReplicas.size > 0) {
      const replicaEntries = Array.from(currentReplicas.entries());
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
      const getNameFromEnv = (entityId: string): string => {
        if (!computedEnv?.gossip) return '';
        const profiles = typeof computedEnv.gossip.getProfiles === 'function'
          ? computedEnv.gossip.getProfiles()
          : (computedEnv.gossip.profiles || []);
        const profile = profiles.find((p: any) => p.entityId === entityId);
        return profile?.name || '';
      };
      entityData = Array.from(uniqueEntityIds).map(entityId => {
        const gossipName = getNameFromEnv(entityId);
        const displayName = gossipName || entityId;
        return {
          entityId,
          metadata: { name: displayName }
        };
      });
    }
    if (entityData.length === 0) {
      debug.warn(`⚠️ No entity data found at frame ${timeIndex} - clearing network`);
      clearNetwork(); // Proper clear - entities will be recreated on next frame with data
      return;
    }
    const connectionMap = new Map<string, Set<string>>();
    const capacityMap = new Map<string, number>();
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
    const connectionDegrees = new Map<string, number>();
    entityData.forEach(profile => {
      const degree = connectionMap.get(profile.entityId)?.size || 0;
      connectionDegrees.set(profile.entityId, degree);
    });
    const sortedByDegree = [...connectionDegrees.entries()].sort((a, b) => b[1] - a[1]);
    const top3Hubs = new Set(sortedByDegree.slice(0, 3).map(([id]) => id));
    const currentEntityIds = new Set(entities.map(e => e.id));
    const newEntityIds = new Set(entityData.map(e => e.entityId));
    const toRemove = entities.filter(e => !newEntityIds.has(e.id));
    const toAdd = entityData.filter(e => !currentEntityIds.has(e.entityId));
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
    const allEntitiesHaveSavedPositions = savedPositions && entityData.every(p => savedPositions!.has(p.entityId));
    const forceLayoutPositions = allEntitiesHaveSavedPositions && savedPositions
      ? savedPositions
      : applyForceDirectedLayout(entityData, connectionMap, capacityMap);
    const entityMap = new Map(entities.map(e => [e.id, e]));
    entityData.forEach(profile => {
      const existing = entityMap.get(profile.entityId);
      if (existing) {
        existing.profile = profile;
        existing.isHub = top3Hubs.has(profile.entityId);
        existing.mesh.userData['isHub'] = existing.isHub;
      }
    });
    toAdd.forEach((profile, index) => {
      const isHub = top3Hubs.has(profile.entityId);
      createEntityNode(profile, index, entityData.length, forceLayoutPositions, isHub, currentReplicas);
    });
    if (!allEntitiesHaveSavedPositions) {
      saveEntityPositions();
    }
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
    createConnections();
    createTransactionParticles();
  }
  function clearNetwork() {
    entities.forEach(entity => {
      scene.remove(entity.mesh);
      if (entity.mesh.geometry) entity.mesh.geometry.dispose();
      if (entity.mesh.material) {
        if (Array.isArray(entity.mesh.material)) {
          entity.mesh.material.forEach(m => m.dispose());
        } else {
          entity.mesh.material.dispose();
        }
      }
      if (entity.label) {
        scene.remove(entity.label);
        if (entity.label.geometry) entity.label.geometry.dispose();
        if (entity.label.material) entity.label.material.dispose();
      }
    });
    entities = [];
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
    jBlockHistory.forEach(block => {
      scene.remove(block.container);
      disposeObject3D(block.container);
    });
    jBlockHistory = [];
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
  function applyForceDirectedLayout(profiles: any[], connectionMap: Map<string, Set<string>>, capacityMap: Map<string, number>) {
    const positions = new Map<string, THREE.Vector3>();
    if (!forceLayoutEnabled) {
      return applySimpleRadialLayout(profiles, connectionMap);
    }
    const connectionCounts = new Map<string, number>();
    profiles.forEach(profile => {
      const connections = connectionMap.get(profile.entityId);
      connectionCounts.set(profile.entityId, connections?.size || 0);
    });
    const nodePositions = new Map<string, {x: number, y: number}>();
    profiles.forEach((profile, index) => {
      const degree = connectionCounts.get(profile.entityId) || 0;
      const isHub = degree > 2;
      const radius = isHub ? 10 : 30 + Math.random() * 20;
      const angle = (index / profiles.length) * Math.PI * 2;
      nodePositions.set(profile.entityId, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius
      });
    });
    const width = 100;
    const height = 100;
    const area = width * height;
    const k = Math.sqrt(area / profiles.length); // Optimal distance
    const iterations = 100;
    let temperature = width / 10; // Initial temperature (cooling schedule)
    const coolingFactor = 0.95;
    const repulsionForce = (dist: number) => (k * k) / dist;
    const attractionForce = (dist: number, capacity: number) => {
      const weight = Math.max(0.1, Math.log10(capacity + 1));
      return (dist * dist * weight) / k;
    };
    for (let iter = 0; iter < iterations; iter++) {
      const displacement = new Map<string, {x: number, y: number}>();
      profiles.forEach(p => {
        displacement.set(p.entityId, {x: 0, y: 0});
      });
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
      for (const [entityId, neighbors] of connectionMap.entries()) {
        const vPos = nodePositions.get(entityId);
        if (!vPos) continue;
        for (const neighborId of neighbors) {
          const uPos = nodePositions.get(neighborId);
          if (!uPos) continue;
          const dx = vPos.x - uPos.x;
          const dy = vPos.y - uPos.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
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
      profiles.forEach(profile => {
        const pos = nodePositions.get(profile.entityId)!;
        const disp = displacement.get(profile.entityId)!;
        const dispLength = Math.sqrt(disp.x * disp.x + disp.y * disp.y) || 0.01;
        const cappedDisp = Math.min(dispLength, temperature);
        pos.x += (disp.x / dispLength) * cappedDisp;
        pos.y += (disp.y / dispLength) * cappedDisp;
        const halfWidth = width / 2;
        const halfHeight = height / 2;
        pos.x = Math.max(-halfWidth, Math.min(halfWidth, pos.x));
        pos.y = Math.max(-halfHeight, Math.min(halfHeight, pos.y));
      });
      temperature *= coolingFactor;
    }
    profiles.forEach(profile => {
      const pos2d = nodePositions.get(profile.entityId)!;
      positions.set(profile.entityId, new THREE.Vector3(pos2d.x, pos2d.y, 0));
    });
    return positions;
  }
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
      return compareStableText(a.entityId, b.entityId);
    });
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
    let x: number, y: number, z: number;
    const currentReplicas = passedReplicas || getTimeAwareReplicas();
    const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(profile.entityId + ':'));
    const replica = replicaKey ? currentReplicas.get(replicaKey) : null;
    const isFed = replica?.signerId?.includes('_fed') || false;
    const persistedPosition = $entityPositions.get(profile.entityId);
    const getJMachinePosition = (jurisdictionName: string): { x: number; y: number; z: number } | null => {
      if (env?.jReplicas) {
        const jr = env.jReplicas.get(jurisdictionName);
        if (jr?.position) return jr.position;
      }
      const jMesh = jMachines.get(jurisdictionName);
      if (jMesh) return { x: jMesh.position.x, y: jMesh.position.y, z: jMesh.position.z };
      return null;
    };
    if (persistedPosition) {
      const jMachinePos = getJMachinePosition(persistedPosition.jurisdiction);
      if (jMachinePos) {
        x = jMachinePos.x + persistedPosition.x;
        y = jMachinePos.y + persistedPosition.y;
        z = jMachinePos.z + persistedPosition.z;
      } else {
        x = persistedPosition.x;
        y = persistedPosition.y;
        z = persistedPosition.z;
      }
    } else if (replica?.position) {
      const replicaJurisdiction = replica.position.jurisdiction || replica.position.xlnomy || env?.activeJurisdiction || 'default';
      const jMachinePos = getJMachinePosition(replicaJurisdiction);
      if (jMachinePos) {
        x = jMachinePos.x + replica.position.x;
        y = jMachinePos.y + replica.position.y;
        z = jMachinePos.z + replica.position.z;
      } else {
        x = replica.position.x;
        y = replica.position.y;
        z = replica.position.z;
      }
    } else if (profile.metadata?.position) {
      x = profile.metadata.position.x;
      y = profile.metadata.position.y;
      z = profile.metadata.position.z;
    } else if (forceLayoutPositions.has(profile.entityId) && forceLayoutEnabled) {
      const pos = forceLayoutPositions.get(profile.entityId)!;
      x = pos.x;
      y = pos.y;
      z = pos.z;
    } else {
      const radius = 30;
      const angle = (index / total) * Math.PI * 2;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
      z = 0;
    }
    const geometry = new THREE.SphereGeometry(1.0, 32, 32);
    let baseColor: number, emissiveColor: number, emissiveIntensity: number;
    if (isFed) {
      baseColor = 0x8b7fb8;      // Ethereum purple (matches J-Machine)
      emissiveColor = 0x9a8ac4;  // Bright purple glow
      emissiveIntensity = 2.0;   // Very bright
    } else {
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
    }
    mesh.userData['isHub'] = isHub;
    mesh.userData['isFed'] = isFed; // Used to skip color updates for Fed (always purple)
    mesh.userData['baseMaterial'] = material;
    scene.add(mesh);
    const labelSprite = createEntityLabel(profile.entityId);
    labelSprite.position.set(0, 1.8, 0); // Local position above unit sphere (scales with mesh)
    mesh.add(labelSprite); // Child of mesh = auto-sync position
    entities.push({
      id: profile.entityId,
      position: new THREE.Vector3(x, y, z),
      mesh,
      label: labelSprite, // Entity name
      profile,
      isHub,
      lastActivity: 0
    });
  }
  function createConnections() {
    const processedConnections = new Set<string>();
    const currentReplicas = getTimeAwareReplicas();
    if (currentReplicas.size > 0) {
      for (const [replicaKey, replica] of currentReplicas.entries()) {
        const [entityId] = replicaKey.split(':');
        const entityAccounts = replica.state?.accounts;
        if (!entityAccounts || !entityId) continue;
        for (const accountKey of entityAccounts.keys()) {
          const counterpartyId = String(accountKey);
          if (!counterpartyId) continue;
          const connectionKey = [entityId, counterpartyId].sort().join('<->');
          if (processedConnections.has(connectionKey)) continue;
          processedConnections.add(connectionKey);
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
    buildConnectionIndexMap();
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
    currentFrameActivity = {
      activeEntities: new Set(),
      incomingFlows: new Map(),
      outgoingFlows: new Map()
    };
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
                triggerEntityInputStrike(fromEntityId, toEntityId);
                if (!currentFrameActivity.outgoingFlows.has(fromEntityId)) {
                  currentFrameActivity.outgoingFlows.set(fromEntityId, []);
                }
                currentFrameActivity.outgoingFlows.get(fromEntityId)!.push(toEntityId);
                createDirectionalLightning(fromEntityId, toEntityId, 'outgoing', tx.data.accountTx);
                if (!currentFrameActivity.incomingFlows.has(toEntityId)) {
                  currentFrameActivity.incomingFlows.set(toEntityId, []);
                }
                currentFrameActivity.incomingFlows.get(toEntityId)!.push(fromEntityId);
                triggerEntityActivity(fromEntityId);
                triggerEntityActivity(toEntityId);
              } else if (['r2c', 'reserve_to_collateral', 'deposit_reserve', 'withdraw_reserve'].includes(tx.type)) {
                createBroadcastRipple(processingEntityId, tx.type);
              } else if (tx.type === 'payFromReserve' || tx.kind === 'payFromReserve') {
                const fromEntityId = processingEntityId;
                const toEntityId = tx.targetEntityId || tx.data?.targetEntityId;
                const amount = tx.amount || tx.data?.amount || 0n;
                if (toEntityId) {
                  addTxToJMachine(fromEntityId);
                  triggerEntityActivity(fromEntityId);
                  triggerEntityActivity(toEntityId);
                }
              }
            });
          }
        });
      }
    } else if (($isolatedTimeIndex === -1) && $isolatedEnv?.runtimeInput?.entityInputs) {
      $isolatedEnv.runtimeInput.entityInputs.forEach((entityInput: any) => {
        const processingEntityId = entityInput.entityId;
        currentFrameActivity.activeEntities.add(processingEntityId);
        if (entityInput.entityTxs) {
          entityInput.entityTxs.forEach((tx: any) => {
            if (tx.type === 'accountInput' && tx.data) {
              const fromEntityId = tx.data.fromEntityId;
              const toEntityId = tx.data.toEntityId;
              triggerEntityInputStrike(fromEntityId, toEntityId);
              if (!currentFrameActivity.outgoingFlows.has(fromEntityId)) {
                currentFrameActivity.outgoingFlows.set(fromEntityId, []);
              }
              currentFrameActivity.outgoingFlows.get(fromEntityId)!.push(toEntityId);
              createDirectionalLightning(fromEntityId, toEntityId, 'outgoing', tx.data.accountTx);
              if (!currentFrameActivity.incomingFlows.has(toEntityId)) {
                currentFrameActivity.incomingFlows.set(toEntityId, []);
              }
              currentFrameActivity.incomingFlows.get(toEntityId)!.push(fromEntityId);
              triggerEntityActivity(fromEntityId);
              triggerEntityActivity(toEntityId);
            } else if (['r2c', 'reserve_to_collateral', 'deposit_reserve', 'withdraw_reserve'].includes(tx.type)) {
              createBroadcastRipple(processingEntityId, tx.type);
            } else if (tx.type === 'payFromReserve' || tx.kind === 'payFromReserve') {
              const fromEntityId = processingEntityId;
              const toEntityId = tx.targetEntityId;
              if (toEntityId) {
                addTxToJMachine(fromEntityId);
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
    const key = `${fromEntityId}->${toEntityId}`;
    const connectionIndex = connectionIndexMap.get(key) ??
                            connectionIndexMap.get(`${toEntityId}->${fromEntityId}`) ??
                            -1;
    if (connectionIndex === -1) return;
    const connection = connections[connectionIndex];
    if (!connection) return;
    const positions = connection.line.geometry.getAttribute('position');
    const start = new THREE.Vector3().fromBufferAttribute(positions, 0);
    const end = new THREE.Vector3().fromBufferAttribute(positions, 1);
    const boltLength = start.distanceTo(end);
    const boltDirection = new THREE.Vector3().subVectors(end, start).normalize();
    const paymentAmount = accountTx?.data?.amount ? Number(accountTx.data.amount) : 0;
    const amountUSD = paymentAmount / 1e18; // Convert from wei to tokens
    let radius = 0.08; // Default for non-payments
    if (amountUSD > 0) {
      radius = Math.log10(amountUSD) * 0.08; // $1k=0.24, $1M=0.48, $1B=0.72
      radius = Math.max(0.05, Math.min(radius, 0.8)); // Clamp 0.05-0.8
    }
    let color = 0x00ccff; // Default cyan
    let emissiveColor = 0x00ccff;
    if (amountUSD > 0) {
      if (amountUSD < 1000) {
        color = 0x0088ff;
        emissiveColor = 0x0088ff;
      } else if (amountUSD < 100000) {
        color = 0x00ccff;
        emissiveColor = 0x00ccff;
      } else if (amountUSD < 1000000) {
        color = 0x00ff88;
        emissiveColor = 0x00ff88;
      } else if (amountUSD < 10000000) {
        color = 0xffff00;
        emissiveColor = 0xffff00;
      } else {
        color = 0xff4444;
        emissiveColor = 0xff4444;
      }
    }
    const geometry = new THREE.CylinderGeometry(radius, radius, boltLength, 16);
    const material = new THREE.MeshLambertMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      emissive: emissiveColor,
      emissiveIntensity: 2.0 // Very bright for electric feel
    });
    const bolt = new THREE.Mesh(geometry, material);
    const midpoint = start.clone().lerp(end, 0.5);
    bolt.position.copy(midpoint);
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
    const entity = entities.find(e => e.id === entityId);
    if (!entity) {
      return;
    }
    const startRadius = 0.5;
    const expandSpeed = 0.05;
    let color = 0x00ffff; // Cyan default
    switch (txType) {
      case 'r2c':
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
    const geometry = new THREE.TorusGeometry(startRadius, 0.05, 16, 32);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    });
    const ripple = new THREE.Mesh(geometry, material);
    ripple.position.copy(entity.position);
    ripple.rotation.x = Math.PI / 2;
    scene.add(ripple);
    gridPulseIntensity = 1.0;
    particles.push({
      mesh: ripple,
      connectionIndex: -1, // -1 indicates broadcast ripple (not connection-based)
      progress: 0,
      speed: expandSpeed,
      type: `ripple_${txType}`,
      amount: 0n // No amount for ripples
    });
  }
  function updateConnectionsForEntity(entityId: string) {
    connections.forEach(conn => {
      if (conn.from === entityId || conn.to === entityId) {
        const fromEntity = entities.find(e => e.id === conn.from);
        const toEntity = entities.find(e => e.id === conn.to);
        if (fromEntity && toEntity) {
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
          if (conn.progressBars) {
            scene.remove(conn.progressBars);
            if (conn.mempoolBoxes) {
              scene.remove(conn.mempoolBoxes.leftBox);
              scene.remove(conn.mempoolBoxes.rightBox);
              [conn.mempoolBoxes.leftBox, conn.mempoolBoxes.rightBox].forEach(box => {
                disposeObject3D(box);
              });
            }
            const currentReplicas = getTimeAwareReplicas();
            const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(k => k.startsWith(conn.from + ':') || k.startsWith(conn.to + ':'));
            const replica = replicaKey ? currentReplicas.get(replicaKey) : null;
            if (replica) {
              const { bars, mempoolBoxes } = createAccountBarsForConnection(fromEntity, toEntity, conn.from, conn.to, replica);
              conn.progressBars = bars;
              conn.mempoolBoxes = mempoolBoxes;
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
    const currentReplicas = getTimeAwareReplicas();
    const fromReplicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(fromId + ':'));
    const toReplicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(toId + ':'));
    const fromReplicaData = fromReplicaKey ? currentReplicas.get(fromReplicaKey) : null;
    const toReplicaData = toReplicaKey ? currentReplicas.get(toReplicaKey) : null;
    const isFedConnection =
      fromReplicaData?.signerId?.includes('_fed') ||
      toReplicaData?.signerId?.includes('_fed');
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
    const currentReplicas = getTimeAwareReplicas();
    const fromIsLeftEntity = XLN?.isLeft?.(fromId, toId) ?? (fromId < toId);
    const leftId = fromIsLeftEntity ? fromId : toId;
    const rightId = fromIsLeftEntity ? toId : fromId;
    let accountData: any = null;
    const leftReplica = [...currentReplicas.entries()]
      .find(([key]) => key.startsWith(leftId + ':'));
    const rightReplica = [...currentReplicas.entries()]
      .find(([key]) => key.startsWith(rightId + ':'));
    const leftAccount = leftReplica?.[1]?.state?.accounts?.get(rightId);
    const rightAccount = rightReplica?.[1]?.state?.accounts?.get(leftId);
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
        accountData = leftAccount;
        confirmedAccount = leftAccount; // Both synced
        pendingAccount = null; // No pending state
      }
    } else {
      accountData = leftAccount || rightAccount;
      confirmedAccount = accountData;
      pendingAccount = null;
    }
    if (!accountData) {
      accountData = confirmedAccount; // Use last committed state
    }
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
    const mempoolBoxes = createAccountMempoolBoxes(
      scene,
      fromEntity,
      toEntity,
      leftAccount,
      rightAccount,
      fromIsLeftEntity,
      getEntitySizeForToken
    );
    if (mempoolBoxes) {
      scene.add(mempoolBoxes.leftBox);
      scene.add(mempoolBoxes.rightBox);
    }
    return { bars, mempoolBoxes };
  }
  function getAccountTokenDelta(accountData: any, tokenId: number): any | null {
    if (!accountData?.deltas) {
      return null;
    }
    return accountData.deltas.get(tokenId) ?? null;
  }
  function deriveEntry(tokenDelta: any, isLeft: boolean): GraphDerivedAccountData {
    if (!XLN?.deriveDelta) {
      throw new Error('FINTECH-SAFETY: xlnFunctions.deriveDelta not available');
    }
    if (!tokenDelta) {
      throw new Error('FINTECH-SAFETY: Cannot derive from null token delta');
    }
    const derived = XLN?.deriveDelta(tokenDelta, isLeft);
    if (!derived) {
      return { delta: 0, totalCapacity: 0, ownCreditLimit: 0, peerCreditLimit: 0, inCapacity: 0, outCapacity: 0, collateral: 0, outOwnCredit: 0, inCollateral: 0, outPeerCredit: 0, inOwnCredit: 0, outCollateral: 0, inPeerCredit: 0 };
    }
    const result: GraphDerivedAccountData = {
      delta: Number(derived.delta),
      totalCapacity: Number(derived.totalCapacity || 0n),
      ownCreditLimit: Number(derived.ownCreditLimit || 0n),
      peerCreditLimit: Number(derived.peerCreditLimit || 0n),
      inCapacity: Number(derived.inCapacity || 0n),
      outCapacity: Number(derived.outCapacity || 0n),
      collateral: Number(derived.collateral || 0n),
      outOwnCredit: Number(derived.outOwnCredit || 0n),
      inCollateral: Number(derived.inCollateral || 0n),
      outPeerCredit: Number(derived.outPeerCredit || 0n),
      inOwnCredit: Number(derived.inOwnCredit || 0n),
      outCollateral: Number(derived.outCollateral || 0n),
      inPeerCredit: Number(derived.inPeerCredit || 0n)
    };
    return result;
  }
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
    const leftState = leftAccount ? XLN?.classifyBilateralState?.(leftAccount, 0, true) : null;
    const rightState = rightAccount ? XLN?.classifyBilateralState?.(rightAccount, 0, false) : null;
    const leftMempoolTxs = leftAccount?.mempool || [];
    const leftPendingTxs = leftAccount?.pendingFrame?.accountTxs || [];
    const rightMempoolTxs = rightAccount?.mempool || [];
    const rightPendingTxs = rightAccount?.pendingFrame?.accountTxs || [];
    const leftBoxColor = leftState?.state === 'committed' ? 0x00ff88 : 0xff4444;
    const rightBoxColor = rightState?.state === 'committed' ? 0x00ff88 : 0xff4444;
    const leftBox = createMempoolBox(leftBoxColor, leftMempoolTxs, leftPendingTxs, normalizedDirection);
    const rightBox = createMempoolBox(rightBoxColor, rightMempoolTxs, rightPendingTxs, normalizedDirection);
    const fromEntitySize = getEntitySizeForToken(fromEntity.id, 1);
    const toEntitySize = getEntitySizeForToken(toEntity.id, 1);
    const barRadius = 0.08 * 2.5; // 0.2
    const safeGap = 0.2;
    const boxDepth = 0.4; // Match box depth above (wider box for gray+blue)
    const fromBarStartPos = fromEntity.position.clone().add(
      normalizedDirection.clone().multiplyScalar(fromEntitySize + barRadius + safeGap)
    );
    const toBarStartPos = toEntity.position.clone().sub(
      normalizedDirection.clone().multiplyScalar(toEntitySize + barRadius + safeGap)
    );
    leftBox.position.copy(fromBarStartPos).sub(
      normalizedDirection.clone().multiplyScalar(boxDepth/2)
    );
    rightBox.position.copy(toBarStartPos).add(
      normalizedDirection.clone().multiplyScalar(boxDepth/2)
    );
    return { leftBox, rightBox };
  }
  function createMempoolBox(
    borderColor: number,
    mempoolTxs: any[],
    pendingTxs: any[],
    direction: THREE.Vector3
  ): THREE.Group {
    const group = new THREE.Group();
    const width = 1.6;   // Wide enough for 2 rows of cubes
    const height = 0.8;
    const depth = 0.4;   // Thicker to clearly separate gray/blue zones
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
    const edgesGeometry = new THREE.EdgesGeometry(geometry);
    const edgesMaterial = new THREE.LineBasicMaterial({
      color: borderColor,
      linewidth: 1,
      transparent: true,
      opacity: 0.6
    });
    const edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    group.add(edges);
    const txSize = 0.18;  // Tiny to fit in 0.8 width box
    const spacing = 0.35; // Tight spacing
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
      const xOffset = i === 0 ? -spacing/2 : spacing/2;
      txCube.position.set(xOffset, 0, -depth/3);
      group.add(txCube);
    });
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
      const xOffset = i === 0 ? -spacing/2 : spacing/2;
      txCube.position.set(xOffset, 0, depth/6);  // depth/6 keeps it inside
      group.add(txCube);
    });
    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3(0, 0, 1);
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(forward, direction);
    group.quaternion.copy(quaternion);
    return group;
  }
  function createEntityLabel(entityId: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 512;
    canvas.height = 128;
    const entityName = getEntityShortName(entityId);
    const currentReplicas = getTimeAwareReplicas();
    const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(key => key.startsWith(entityId + ':'));
    const replica = replicaKey ? currentReplicas.get(replicaKey) : null;
    const flag = getGraphEntityFlag(replica?.signerId);
    let balanceStr = '';
    if (replica?.state?.reserves) {
      const totalReserves = graphTotalReserves(replica);
      balanceStr = formatGraphReserveBadge(totalReserves);
    }
    const labelText = entityName + balanceStr;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (flag) {
      context.font = `${48 * labelScale}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(flag, 256, 32); // Top half (centered at 512/2=256)
      context.font = `bold ${18 * labelScale}px sans-serif`;
      context.strokeStyle = '#000000';
      context.lineWidth = 3;
      context.strokeText(labelText, 256, 90);
      context.fillStyle = '#FFD700'; // Gold for Fed
      context.fillText(labelText, 256, 90);
    } else {
      context.font = `bold ${24 * labelScale}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.strokeStyle = '#000000';
      context.lineWidth = 3;
      context.strokeText(labelText, 256, 64);
      context.fillStyle = '#00ff88';
      context.fillText(labelText, 256, 64);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // Always visible on top
      sizeAttenuation: true // Scale with distance for better depth perception
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    const vrMultiplier = isVRActive ? 3.0 : 1.0;
    const baseScale = 1.5 * labelScale * vrMultiplier;
    sprite.scale.set(baseScale * 4, baseScale, 1); // 4:1 aspect ratio for emoji + text
    return sprite;
  }
  function createMempoolIndicator(entityId: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 128;
    canvas.height = 64;
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
  function updateMempoolIndicators() {
    const currentReplicas = getTimeAwareReplicas();
    entities.forEach(entity => {
      const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(
        k => k.startsWith(entity.id + ':')
      );
      const replica = replicaKey ? currentReplicas.get(replicaKey) : null;
      const entityMempoolCount = replica?.mempool?.length || 0;
      let accountMempoolOut = 0;
      let accountMempoolIn = 0;
      if (replica?.state?.accounts) {
        for (const [counterpartyId, accountMachine] of replica.state.accounts) {
          const pending = accountMachine?.mempool?.length || 0;
          accountMempoolOut += pending;
        }
      }
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
      if (totalOut === 0 && totalIn === 0) {
        if (entity.mempoolIndicator) {
          entity.mempoolIndicator.visible = false;
        }
        return;
      }
      if (!entity.mempoolIndicator) {
        entity.mempoolIndicator = createMempoolIndicator(entity.id);
        const entitySize = getEntitySizeForToken(entity.id, selectedTokenId);
        entity.mempoolIndicator.position.set(entitySize + 0.5, 0, 0); // Right side of entity
        entity.mesh.add(entity.mempoolIndicator);
      }
      entity.mempoolIndicator.visible = true;
      const canvas = entity.mempoolIndicator.userData['canvas'] as HTMLCanvasElement;
      const context = entity.mempoolIndicator.userData['context'] as CanvasRenderingContext2D;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (totalOut > 0) {
        context.font = 'bold 24px sans-serif';
        context.textAlign = 'center';
        context.fillStyle = '#ff8800'; // Orange for outgoing
        context.fillText(`↑${totalOut}`, 32, 36);
      }
      if (totalIn > 0) {
        context.font = 'bold 24px sans-serif';
        context.textAlign = 'center';
        context.fillStyle = '#00ccff'; // Cyan for incoming
        context.fillText(`↓${totalIn}`, 96, 36);
      }
      const texture = entity.mempoolIndicator.material.map as THREE.CanvasTexture;
      texture.needsUpdate = true;
    });
  }
  function updateEntityLabels() {
    if (!camera) return;
    const currentReplicas = getTimeAwareReplicas();
    const currentTimeIndex = get(isolatedTimeIndex);
    const forceRecreateLabels = currentTimeIndex !== lastLabelUpdateTimeIndex;
    if (forceRecreateLabels) {
      lastLabelUpdateTimeIndex = currentTimeIndex;
    }
    entities.forEach(entity => {
      if (!entity.label || forceRecreateLabels) {
        if (entity.label) {
          entity.mesh.remove(entity.label);
          if (entity.label.material?.map) {
            entity.label.material.map.dispose();
          }
          entity.label.material?.dispose();
        }
        entity.label = createEntityLabel(entity.id);
        const entitySize = getEntitySizeForToken(entity.id, selectedTokenId);
        entity.label.position.set(0, entitySize + 0.8, 0);
        entity.mesh.add(entity.label);
      }
      if (entity.label.parent !== entity.mesh) {
        scene.remove(entity.label);
        const labelEntitySize = getEntitySizeForToken(entity.id, selectedTokenId);
        entity.label.position.set(0, labelEntitySize + 0.8, 0);
        entity.mesh.add(entity.label);
      }
      const replicaKey = Array.from(currentReplicas.keys() as IterableIterator<string>).find(
        (k: any) => k.startsWith(entity.id + ':')
      );
      const replica = replicaKey ? currentReplicas.get(replicaKey) : null;
      const reserveAmount = graphReserveValue(replica?.state?.reserves, String(selectedTokenId));
      if (forceRecreateLabels) {
        const material = entity.mesh.material as THREE.MeshLambertMaterial;
        if (material && !entity.mesh.userData['isFed']) { // Don't change Fed color
          material.transparent = false;
          material.opacity = 1.0;
          material.depthWrite = true;
          if (reserveAmount <= 0n) {
            material.color.setHex(0x666666);
            material.emissive.setHex(0x333333);
            material.emissiveIntensity = 0.1;
          } else {
            material.color.setHex(0x5cb85c);  // Collateral green
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
    renderFps = Math.min(metrics.fps, 9999);
    frameTime = metrics.frameTime;
    panelBridge.emit('renderFps', metrics.fps);
  });
  function animate() {
    perfMonitor.begin(); // Start FPS measurement
    if (!renderer?.xr?.isPresenting) {
      animationId = requestAnimationFrame(animate);
    }
    animateCallCount++;
    animateEntityInputStrikes();
    if (vrGrabbedEntity && vrGrabController) {
      const controllerPos = new THREE.Vector3();
      controllerPos.setFromMatrixPosition(vrGrabController.matrixWorld);
      vrGrabbedEntity.mesh.position.copy(controllerPos);
      vrGrabbedEntity.position.copy(controllerPos);
      if (vrGrabbedEntity.label) {
        vrGrabbedEntity.label.position.copy(controllerPos);
        vrGrabbedEntity.label.position.y += 3;
      }
    }
    if (isVRActive && handTrackingController) {
      const grabbableEntities = entities.map(e => ({
        id: e.id,
        mesh: e.mesh as THREE.Mesh,
        position: e.position,
        isPinned: e.isPinned,
        label: e.label as THREE.Object3D | undefined
      })) as GrabbableEntity[];
      handTrackingController.update(grabbableEntities);
    }
    if ((rotationX > 0 || rotationY > 0 || rotationZ > 0) && controls) {
      const maxRotationSpeed = 0.01; // Maximum rotation speed at slider = 10000
      const currentPosition = camera.position.clone();
      const target = controls.target.clone();
      const offset = currentPosition.sub(target);
      let newOffset = offset.clone();
      if (rotationX > 0) {
        const angleX = (rotationX / 10000) * maxRotationSpeed;
        const newY = newOffset.y * Math.cos(angleX) - newOffset.z * Math.sin(angleX);
        const newZ = newOffset.y * Math.sin(angleX) + newOffset.z * Math.cos(angleX);
        newOffset.y = newY;
        newOffset.z = newZ;
      }
      if (rotationY > 0) {
        const angleY = (rotationY / 10000) * maxRotationSpeed;
        const newX = newOffset.x * Math.cos(angleY) - newOffset.z * Math.sin(angleY);
        const newZ = newOffset.x * Math.sin(angleY) + newOffset.z * Math.cos(angleY);
        newOffset.x = newX;
        newOffset.z = newZ;
      }
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
      if (Math.random() < 0.01) { // ~1% chance per frame = every few seconds
        saveBirdViewSettings();
      }
    }
    if (autoRotate && controls && camera) {
      const radiansPerSecond = (autoRotateSpeed / 60) * (2 * Math.PI); // RPM to rad/s
      const radiansPerFrame = radiansPerSecond / 60; // Assuming 60 FPS
      const currentPos = camera.position.clone();
      const target = controls.target.clone();
      const offset = currentPos.sub(target);
      const cos = Math.cos(radiansPerFrame);
      const sin = Math.sin(radiansPerFrame);
      const newX = offset.x * cos - offset.z * sin;
      const newZ = offset.x * sin + offset.z * cos;
      camera.position.x = target.x + newX;
      camera.position.z = target.z + newZ;
      camera.lookAt(target);
    }
    if (controls) {
      controls.update();
    } else {
      if (scene) {
        scene.rotation.y += 0.002;
      }
    }
    applyCollisionRepulsion();
    updateEntityLabels();
    updateMempoolIndicators();
    animateParticles();
    animateEntityPulses();
    if (gridPulseIntensity > 0 && gridHelper) {
      gridPulseIntensity *= 0.95; // Exponential decay
      if (gridPulseIntensity < 0.01) gridPulseIntensity = 0;
      const baseMaterial = gridHelper.material as THREE.LineBasicMaterial;
      const pulseColor = new THREE.Color(gridColor).lerp(
        new THREE.Color(0x00ff88), // Bright green
        gridPulseIntensity
      );
      baseMaterial.color = pulseColor;
      baseMaterial.opacity = gridOpacity + (gridPulseIntensity * 0.3); // Brighten on pulse
    }
    updateRipples();
    if (Math.random() < 0.05) { // Check ~5% of frames = 3 times per second at 60fps
      detectJurisdictionalEvents();
    }
    if (renderer && camera) {
      renderer.render(scene, camera);
      perfMonitor.end(); // Complete FPS measurement
    }
  }
  let lastConnectionRebuild = 0;
  let needsConnectionRebuild = false;
  function applyCollisionRepulsion() {
    if (isDragging) return;
    let anyMoved = false;
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entityA = entities[i];
        const entityB = entities[j];
        if (!entityA || !entityB) continue;
        const radiusA = getEntitySizeForToken(entityA.id, selectedTokenId);
        const radiusB = getEntitySizeForToken(entityB.id, selectedTokenId);
        const distance = entityA.position.distanceTo(entityB.position);
        const minDistance = radiusA + radiusB;
        if (distance < minDistance && distance > 0.01) {
          const overlap = minDistance - distance;
          const direction = new THREE.Vector3().subVectors(entityB.position, entityA.position).normalize();
          const pushStrength = overlap * 0.5; // Gentle continuous push
          if (!entityA.isPinned && !entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushStrength / 2));
            entityB.position.add(direction.clone().multiplyScalar(pushStrength / 2));
            entityA.mesh.position.copy(entityA.position);
            entityB.mesh.position.copy(entityB.position);
            anyMoved = true;
          }
          else if (entityA.isPinned && !entityB.isPinned) {
            entityB.position.add(direction.clone().multiplyScalar(pushStrength));
            entityB.mesh.position.copy(entityB.position);
            anyMoved = true;
          }
          else if (!entityA.isPinned && entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushStrength));
            entityA.mesh.position.copy(entityA.position);
            anyMoved = true;
          }
        }
      }
    }
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
      particle.progress += particle.speed;
      const maxProgress = 1.0;
      if (particle.progress >= maxProgress) {
        scene.remove(particle.mesh);
        particles.splice(index, 1);
        return;
      }
      if (particle.connectionIndex === -1) {
        const startRadius = 0.5;
        const maxRadius = 5.0;
        const currentRadius = startRadius + (maxRadius - startRadius) * particle.progress;
        particle.mesh.scale.setScalar(currentRadius / startRadius);
        const material = particle.mesh.material as THREE.MeshLambertMaterial;
        material.opacity = 0.8 * (1 - particle.progress);
        return;
      }
      const connection = connections[particle.connectionIndex];
      if (!connection) return;
      const material = particle.mesh.material as THREE.MeshLambertMaterial;
      if (particle.progress < 0.45) {
        const phase1Progress = particle.progress / 0.45; // 0 to 1
        particle.mesh.scale.y = phase1Progress;
        const fadeIn = Math.min(1, phase1Progress * 3);
        material.opacity = 0.95 * fadeIn;
        material.emissiveIntensity = 2.5 * fadeIn;
        material.color.setHex(0x00ffff);
      }
      else if (particle.progress < 0.55) {
        const phase2Progress = (particle.progress - 0.45) / 0.1; // 0 to 1
        particle.mesh.scale.y = 1.0;
        material.opacity = 1.0;
        material.emissiveIntensity = 4.0 * Math.sin(phase2Progress * Math.PI); // Peak at midpoint
        const flashBrightness = Math.sin(phase2Progress * Math.PI);
        material.color.setRGB(
          flashBrightness * 0.5,
          flashBrightness,
          1.0
        );
      }
      else {
        const phase3Progress = (particle.progress - 0.55) / 0.45; // 0 to 1
        particle.mesh.scale.y = 1.0;
        const fadeOut = Math.max(0, 1 - phase3Progress);
        material.opacity = 0.9 * fadeOut;
        material.emissiveIntensity = 2.0 * fadeOut;
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
      let baseSize = getEntitySizeForToken(entityId, selectedTokenId);
      if (entity.mesh.userData['isFed']) {
        baseSize = baseSize * 3;
      }
      if (isActive) {
        const hasIncoming = currentFrameActivity.incomingFlows.has(entityId);
        const hasOutgoing = currentFrameActivity.outgoingFlows.has(entityId);
        const targetScale = baseSize;
        const currentScale = entity.mesh.scale.x;
        const lerpSpeed = 0.1; // Smooth but responsive
        const newScale = currentScale + (targetScale - currentScale) * lerpSpeed;
        entity.mesh.scale.setScalar(newScale);
        const pulseIntensity = Math.max(0, 1 - timeSinceActivity / 2000);
        let glowR = 0, glowG = 0, glowB = 0;
        if (hasIncoming && hasOutgoing) {
          glowR = 0;
          glowG = 0.8;
          glowB = 1;
        } else if (hasIncoming) {
          glowR = 0;
          glowG = 0.4;
          glowB = 1;
        } else if (hasOutgoing) {
          glowR = 1;
          glowG = 0.6;
          glowB = 0;
        } else {
          glowR = 0;
          glowG = 1;
          glowB = 0;
        }
        const glowIntensity = pulseIntensity * 0.6;
        material.emissive.setRGB(glowR * glowIntensity, glowG * glowIntensity, glowB * glowIntensity);
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
        entity.activityRing.scale.setScalar(1);
        ringMaterial.opacity = 0.6 * pulseIntensity;
      } else {
        const targetScale = baseSize;
        const currentScale = entity.mesh.scale.x;
        const lerpSpeed = 0.1;
        const newScale = currentScale + (targetScale - currentScale) * lerpSpeed;
        entity.mesh.scale.setScalar(newScale);
        const hasReserves = checkEntityHasReserves(entityId);
        if (hasReserves) {
          material.color.setHex(0x00ff88); // Bright green - has funds
          material.emissive.setRGB(0, 0.15, 0.05);
        } else {
          material.color.setHex(0xcccccc); // Light white/grey - empty (visible)
          material.emissive.setRGB(0.1, 0.1, 0.1);
        }
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
  function animateEntityInputStrikes() {
    if (!scene) return;
    const now = performance.now();
    for (let i = entityInputStrikes.length - 1; i >= 0; i--) {
      const strike = entityInputStrikes[i];
      if (!strike) continue;
      const elapsed = now - strike.startTime;
      const progress = Math.min(elapsed / strike.duration, 1.0);
      const material = strike.line.material as THREE.LineBasicMaterial;
      material.opacity = 1.0 - progress;
      if (progress >= 1.0) {
        scene.remove(strike.line);
        strike.line.geometry.dispose();
        material.dispose();
        entityInputStrikes.splice(i, 1);
      }
    }
  }
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
        const connection = connections.find(c =>
          (c.from === entityA.id && c.to === entityB.id) ||
          (c.from === entityB.id && c.to === entityA.id)
        );
        if (!connection) continue;
        const entityASizeData = getEntitySizeForToken(entityA.id, selectedTokenId);
        const entityBSizeData = getEntitySizeForToken(entityB.id, selectedTokenId);
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
        const minGapSpread = 2; // Spread mode: small gap in middle
        const minGapClose = 1; // Close mode: small gap on each side
        const requiredGap = barsMode === 'spread' ? minGapSpread : (2 * minGapClose);
        const minDistance = entityASizeData + entityBSizeData + totalBarsLength + requiredGap;
        const currentDistance = entityA.position.distanceTo(entityB.position);
        if (currentDistance < minDistance) {
          const pushDistance = minDistance - currentDistance;
          const direction = new THREE.Vector3().subVectors(entityB.position, entityA.position).normalize();
          anyAdjusted = true;
          if (!entityA.isPinned && !entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushDistance / 2));
            entityB.position.add(direction.clone().multiplyScalar(pushDistance / 2));
            entityA.mesh.position.copy(entityA.position);
            entityB.mesh.position.copy(entityB.position);
          }
          else if (entityA.isPinned && !entityB.isPinned) {
            entityB.position.add(direction.clone().multiplyScalar(pushDistance));
            entityB.mesh.position.copy(entityB.position);
          }
          else if (!entityA.isPinned && entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushDistance));
            entityA.mesh.position.copy(entityA.position);
          }
          else {
            debug.warn(`⚠️ Both entities pinned but too close: ${entityA.id.slice(-4)} ↔ ${entityB.id.slice(-4)}`);
          }
        }
      }
    }
    } // End while loop
    if (iterations > 1) {
    }
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
    if (event.button !== 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const entityMeshes = entities.map(e => e.mesh);
    const intersects = raycaster.intersectObjects(entityMeshes);
    if (intersects.length > 0) {
      const intersectedObject = intersects[0]?.object;
      if (!intersectedObject) return;
      const entity = entities.find(e => e.mesh === intersectedObject);
      if (!entity) return;
      event.preventDefault();
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
  function onMouseUp(_event: MouseEvent) {
    if (draggedEntity && isDragging) {
      if (hasMoved) {
        draggedEntity.isPinned = true;
      }
      draggedEntity.isDragging = false;
      if (draggedEntity.mesh.material instanceof THREE.MeshLambertMaterial) {
        draggedEntity.mesh.material.emissive.setHex(0x002200);
      }
      if (hasMoved) {
        enforceSpacingConstraints();
        saveEntityPositions();
        justDragged = true;
        setTimeout(() => {
          justDragged = false;
        }, 100); // Clear flag after 100ms
      }
      draggedEntity = null;
      isDragging = false;
    }
    if (controls) {
      controls.enabled = true;
    }
  }
  function onMouseMove(event: MouseEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    if (isDragging && draggedEntity) {
      hasMoved = true; // Actual movement occurred
      const intersection = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, intersection);
      draggedEntity.position.copy(intersection.add(dragOffset));
      draggedEntity.mesh.position.copy(draggedEntity.position);
      updateConnectionsForEntity(draggedEntity.id);
      return; // Skip hover logic while dragging
    }
    const entityMeshes = entities.map(e => e.mesh);
    const entityIntersects = raycaster.intersectObjects(entityMeshes);
    const connectionLines = connections.map(c => c.line);
    const lineIntersects = raycaster.intersectObjects(connectionLines);
    if (entityIntersects.length > 0) {
      const intersectedObject = entityIntersects[0]?.object;
      if (!intersectedObject) {
        throw new Error('FINTECH-SAFETY: No intersected object found');
      }
      const entity = entities.find(e => e.mesh === intersectedObject);
      if (!entity) {
        tooltip.visible = false;
        dualTooltip.visible = false;
        return;
      }
      if (hoveredObject !== intersectedObject) {
        hoveredObject = intersectedObject;
        const balanceInfo = getEntityBalanceInfo(entity.id);
        tooltip = {
          visible: true,
          x: event.clientX,
          y: event.clientY,
          content: balanceInfo || 'No reserves'
        };
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
        tooltip.visible = false;
        const lineMesh = intersectedLine as THREE.Line;
        const lineMaterial = lineMesh.material as THREE.LineDashedMaterial;
        if (!lineMaterial?.color) {
          throw new Error('FINTECH-SAFETY: Connection material missing color property');
        }
        lineMaterial.color.setHex(0xffff00);
      }
    } else {
      if (hoveredObject) {
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
    if (justDragged) {
      return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const jMachineObjects: THREE.Object3D[] = [];
    jMachines.forEach(group => {
      group.children.forEach(child => jMachineObjects.push(child));
    });
    const jMachineIntersects = raycaster.intersectObjects(jMachineObjects);
    if (jMachineIntersects.length > 0 && jMachineIntersects[0]) {
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
        if (controls && pos) {
          cameraTarget = pos;
          controls.target.set(pos.x, pos.y, pos.z);
          controls.update();
        }
        panelBridge.emit('openJurisdiction', { jurisdictionName: name });
        return; // Don't process entity clicks
      }
    }
    const entityMeshes = entities.map(e => e.mesh);
    const intersects = raycaster.intersectObjects(entityMeshes);
    if (intersects.length > 0) {
      const intersectedObject = intersects[0]?.object;
      if (!intersectedObject) {
        throw new Error('FINTECH-SAFETY: No intersected object in click');
      }
      const entity = entities.find(e => e.mesh === intersectedObject);
      if (!entity || !entity.id) {
        return;
      }
      triggerEntityActivity(entity.id);
      if (!entity.id) {
        console.error('[Graph3D] ❌ Entity has no ID!', entity);
        return;
      }
      const entityName = getEntityName(entity.id);
      const signerId = getSignerIdForEntity(entity.id);
      panelBridge.emit('entity:selected', { entityId: entity.id });
      panelBridge.emit('openEntityOperations', {
        entityId: entity.id,
        entityName: entityName || entity.id,
        signerId: signerId || entity.id
      });
    } else {
      showMiniPanel = false;
    }
  }
  function getEntityName(entityId: string): string {
    return getGraphEntityNameFromGossip(env?.gossip, entityId);
  }
  function getSignerIdForEntity(entityId: string): string {
    return getGraphSignerIdForEntity(getTimeAwareReplicas(), entityId);
  }
  function closeMiniPanel() {
    showMiniPanel = false;
  }
  function handleMiniPanelAction(event: CustomEvent) {
    const { type, entityId } = event.detail;
    const entityName = getEntityName(entityId);
    panelBridge.emit('openEntityOperations', {
      entityId,
      entityName,
      signerId: getSignerIdForEntity(entityId),
      action: type // 'r2r' or 'r2c'
    });
    showMiniPanel = false;
  }
  function handleOpenFullPanel(event: CustomEvent) {
    const { entityId, entityName, signerId } = event.detail;
    panelBridge.emit('openEntityOperations', { entityId, entityName, signerId: signerId || entityId });
    showMiniPanel = false;
  }
  function onMouseDoubleClick(event: MouseEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const entityMeshes = entities.map(e => e.mesh);
    const intersects = raycaster.intersectObjects(entityMeshes);
    if (intersects.length > 0) {
      let intersectedObject = intersects[0]?.object;
      if (!intersectedObject) {
        throw new Error('FINTECH-SAFETY: No intersected object in double-click');
      }
      let entity = entities.find(e => e.mesh === intersectedObject);
      while (!entity && intersectedObject.parent && intersectedObject.parent !== scene) {
        intersectedObject = intersectedObject.parent;
        entity = entities.find(e => e.mesh === intersectedObject);
      }
      if (!entity) {
        console.warn('Double-click: Could not find entity for object', intersectedObject);
        return; // Gracefully ignore instead of throwing
      }
      saveBirdViewSettings(false);
      const entityName = getEntityName(entity.id);
      const signerId = getSignerIdForEntity(entity.id);
      panelBridge.emit('entity:selected', { entityId: entity.id });
      panelBridge.emit('openEntityOperations', {
        entityId: entity.id,
        entityName: entityName || entity.id,
        signerId: signerId || entity.id
      });
    }
  }
  function onTouchStart(event: TouchEvent) {
    event.preventDefault();
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((touch!.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((touch!.clientY - rect.top) / rect.height) * 2 + 1;
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
      if (hasMoved) {
        draggedEntity.isPinned = true;
      }
      draggedEntity.isDragging = false;
      if (draggedEntity.mesh.material instanceof THREE.MeshLambertMaterial) {
        draggedEntity.mesh.material.emissive.setHex(0x002200);
      }
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
    clearRouteHighlight();
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
  function updateAvailableTokens() {
    const currentReplicas = getTimeAwareReplicas();
    const tokenSet = new Set<number>();
    for (const [_, replica] of currentReplicas.entries()) {
      if (!replica?.state?.reserves) continue;
      replica.state.reserves.forEach((_: bigint, tokenIdStr: string) => {
        const tokenId = Number(tokenIdStr);
        if (!isNaN(tokenId)) {
          tokenSet.add(tokenId);
        }
      });
    }
    availableTokens = Array.from(tokenSet).sort((a, b) => a - b);
    if (!availableTokens.includes(1)) {
      availableTokens.push(1);
      availableTokens.sort((a, b) => a - b);
    }
    if (availableTokens.length === 0) {
      availableTokens = [1];
      selectedTokenId = 1;
    } else if (!availableTokens.includes(selectedTokenId) && ($isolatedTimeIndex === -1)) {
      selectedTokenId = availableTokens.includes(1) ? 1 : availableTokens[0]!;
      saveBirdViewSettings();
    }
  }
  const DOLLARS_PER_PX = 500_000; // $500K = 1.0 radius
  const EMPTY_SIZE = 0.4;         // $0 entities - still visible
  const MIN_SIZE = 0.5;           // Minimum for funded entities
  const MAX_SIZE = 2.7;           // Cap for whales
  const VISUAL_POWER = 0.6;       // Scaling curve (0.5=sqrt, 0.33=cbrt)
  let lastLabelUpdateTimeIndex = -999; // Track for label updates on frame change
  function getEntitySizeForToken(entityId: string, _tokenId: number): number {
    const currentReplicas = getTimeAwareReplicas();
    for (const [key, replica] of currentReplicas) {
      const replicaEntityId = key.split(':')[0] || key;
      if (replicaEntityId !== entityId) continue;
      if (!replica?.state?.reserves) {
        return EMPTY_SIZE;
      }
      const totalReserves = graphTotalReserves(replica);
      const reserveValueUSD = Number(totalReserves) / 1e18;
      if (reserveValueUSD <= 0) {
        return EMPTY_SIZE;
      }
      const ratio = Math.max(1, reserveValueUSD / DOLLARS_PER_PX);
      return Math.max(MIN_SIZE, Math.min(MIN_SIZE * Math.pow(ratio, VISUAL_POWER), MAX_SIZE));
    }
    return EMPTY_SIZE; // Entity not found in replicas
  }
  function checkEntityHasReserves(entityId: string): boolean {
    return graphEntityHasReserves(getTimeAwareReplicas(), entityId);
  }
  function calculateAvailableRoutes(from: string, to: string) {
    if (!env) {
      availableRoutes = [];
      return;
    }
    availableRoutes = buildGraphAvailableRoutes({
      replicas: env.eReplicas,
      from,
      to,
      getEntityShortName,
    });
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
      const selectedRoute = availableRoutes[selectedRouteIndex];
      if (!selectedRoute) {
        alert('No route available for this payment');
        return;
      }
      getLiveEnvForAction('Graph payment');
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const job: GraphPaymentJob = {
        id: jobId,
        from: paymentFrom,
        to: paymentTo,
        amount: paymentAmount,
        tps: paymentTPS,
        sentCount: 0,
        startedAt: Date.now()
      };
      if (paymentTPS === 0) {
        await executeSinglePayment(job);
      } else {
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
  async function executeSinglePayment(job: GraphPaymentJob) {
    try {
      if (!XLN) {
        throw new Error('XLN runtime not loaded');
      }
      const actionEnv = getLiveEnvForAction('Graph payment');
      let ourReplica: any = null;
      for (const key of actionEnv.eReplicas.keys()) {
        if (key.startsWith(job.from + ':')) {
          ourReplica = actionEnv.eReplicas.get(key);
          break;
        }
      }
      if (!ourReplica) {
        throw new Error(`No replica found for entity ${getEntityShortName(job.from)} (${job.from})`);
      }
      const hasDirectAccount = ourReplica?.state?.accounts?.has(job.to);
      if (!hasDirectAccount) {
      }
      const decimals = 18;
      const amountStr = String(job.amount);
      const amountParts = amountStr.split('.');
      const wholePart = BigInt(amountParts[0] || 0);
      const decimalPart = amountParts[1] || '';
      const paddedDecimal = decimalPart.padEnd(decimals, '0').slice(0, decimals);
      const amountInSmallestUnit = wholePart * BigInt(10 ** decimals) + BigInt(paddedDecimal || 0);
      const selectedRoute = availableRoutes[selectedRouteIndex];
      if (!selectedRoute) {
        throw new Error('No route selected');
      }
      const routePath = selectedRoute.path;
      if (!routePath || routePath.length < 2) {
        throw new Error(`Invalid route: expected at least 2 entities, got ${routePath?.length || 0}`);
      }
      if (routePath[0] !== job.from || routePath[routePath.length - 1] !== job.to) {
        throw new Error(`Route mismatch: expected ${job.from} → ${job.to}, got ${routePath[0]} → ${routePath[routePath.length - 1]}`);
      }
      let signerId = '1'; // default
      for (const key of actionEnv.eReplicas.keys()) {
        if (key.startsWith(job.from + ':')) {
          signerId = key.split(':')[1] || '1';
          break;
        }
      }
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
      triggerEntityActivity(job.from);
      triggerEntityActivity(job.to);
      (XLN as any).enqueueRuntimeInput(actionEnv, { runtimeTxs: [], entityInputs: [paymentInput] });
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
      alert(`Payment failed: ${errorMsg}`);
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
    rippleMesh.rotation.x = Math.random() * Math.PI;
    rippleMesh.rotation.y = Math.random() * Math.PI;
    rippleMesh.rotation.z = Math.random() * Math.PI;
    scene.add(rippleMesh);
    const ripple: GraphRipple = {
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
        scene.remove(ripple.mesh);
        ripple.mesh.geometry.dispose();
        (ripple.mesh.material as THREE.Material).dispose();
        return false;
      }
      const scale = 0.1 + progress * ripple.maxRadius;
      ripple.mesh.scale.set(scale, scale, 1);
      const material = ripple.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = 0.8 * (1 - progress); // Fade out
      return true;
    });
  }
  function detectJurisdictionalEvents() {
    if (!env) return;
    const currentFrame = env.serverState?.history?.[env.serverState.history.length - 1];
    if (!currentFrame) return;
    const entityFrames = currentFrame.entityFrames;
    if (!entityFrames || !(entityFrames instanceof Map)) return;
    entityFrames.forEach((entityFrame: any, entityId: string) => {
      const jEvents = entityFrame.jEvents;
      if (jEvents && jEvents.length > 0) {
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
      const response = await fetch(`/worlds/${selectedScenarioFile}`);
      if (!response.ok) {
        throw new Error(`Failed to load scenario: ${response.statusText}`);
      }
      const scenarioText = await response.text();
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);
      const parsed = XLN?.parseScenario(scenarioText);
      if (parsed.errors.length > 0) {
        console.error('Scenario parse errors:', parsed.errors);
        debug.error('Scenario has errors - check console');
        return;
      }
      const actionEnv = getLiveEnvForAction('Graph scenario');
      const result = await XLN?.executeScenario(actionEnv, parsed.scenario);
      isolatedHistory.set(actionEnv.history || []);
      isolatedEnv.set(createRuntimeViewEnv(actionEnv));
      if (!result.success) {
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
  function getEntityBalanceInfo(entityId: string): string {
    return formatGraphEntityBalanceInfo({
      entityId,
      replicas: getTimeAwareReplicas(),
      selectedTokenId,
      getTokenSymbol,
    });
  }
  function getEntityShortName(entityId: string): string {
    return formatGraphEntityShortNameFromReplicas({
      entityId,
      replicas: getTimeAwareReplicas(),
      getEntityShortId: (value) => XLN?.getEntityShortId?.(value),
    });
  }
  function getDualConnectionAccountInfo(entityA: string, entityB: string): { left: string, right: string, leftEntity: string, rightEntity: string } {
    return formatGraphDualConnectionAccountInfoFromReplicas({
      entityA,
      entityB,
      replicas: getTimeAwareReplicas(),
      selectedTokenId,
      getAccountTokenDelta,
      deriveEntry,
      getEntityShortName,
    });
  }
  function onWindowResize() {
    if (!camera || !renderer || !container) return;
    const containerWidth = container.clientWidth || window.innerWidth;
    const containerHeight = container.clientHeight || window.innerHeight;
    camera.aspect = containerWidth / containerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(containerWidth, containerHeight);
  }
  function toggleBarsMode() {
    barsMode = barsMode === 'close' ? 'spread' : 'close';
    saveBirdViewSettings();
  }

  function handleVrPaymentClick(): void {
    if (entities.length < 2) return;
    const from = entities[Math.floor(Math.random() * entities.length)];
    const to = entities[Math.floor(Math.random() * entities.length)];
    if (from && to && from.id !== to.id) {
      panelBridge.emit('vr:payment', { from: from.id, to: to.id });
    }
  }

  function handleVrAutoRotateClick(): void {
    autoRotate = !autoRotate;
    panelBridge.emit('settings:update', { key: 'autoRotate', value: autoRotate });
  }
</script>

<Graph3DViewport
  bind:container
  {showMiniPanel}
  {miniPanelEntityId}
  {miniPanelEntityName}
  {miniPanelPosition}
  {isolatedEnv}
  {isolatedHistory}
  {isolatedTimeIndex}
  {showFpsOverlay}
  {renderFps}
  {frameTime}
  entityCount={entities.length}
  connectionCount={connections.length}
  particleCount={particles.length}
  {barsMode}
  {isVRActive}
  {closeMiniPanel}
  {handleMiniPanelAction}
  {handleOpenFullPanel}
  {toggleBarsMode}
  {handleVrPaymentClick}
  {handleVrAutoRotateClick}
  {exitVR}
/>
