<script lang="ts">
import { onMount, onDestroy } from "svelte";
import { get, type Writable } from "svelte/store";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { EnvSnapshot, RuntimeReplica } from "@xln/core/api/public/runtime-module";
import { panelBridge } from "../../utils/panelBridge";
import { PerformanceMonitor, type PerfMetrics } from "../../utils/perfMonitor";
import { getXLN, entityPositions } from "$lib/stores/xlnStore";
import { requireTokenDecimals } from "$lib/components/Entity/token-metadata";
import Graph3DViewport from "../../components/Graph3DViewport.svelte";
import { compareStableText } from "$lib/utils/stableSort";
  import { activeRuntimeId, runtimeOperations, runtimes, type Runtime } from "$lib/stores/runtimeStore";
import { runtimeControllerHandle } from "$lib/stores/runtimeControllerStore";
import { runtimeView } from "$lib/stores/runtimeViewStore";
import { runtimeGraphLiveFrameCache, watchRuntimeGraphFrameCache } from "$lib/network3d/runtimeGraphFrameCache";
import { runtimeGraphCanonicity, runtimeGraphControlOperations, runtimeGraphScope } from "$lib/stores/network/runtimeGraphControlStore";
import { ImmersiveWalletSurface } from "$lib/network3d/ImmersiveWalletSurface";
import { registerDebugSurface } from "$lib/utils/runtime/debugSurface";
import { networkMachineRuntime } from "$lib/stores/network/networkMachineRuntimeStore";
import { mergeRuntimeGraphProjections, requireActionableGraphNodeRuntimeId, type MergedRuntimeGraph, type RuntimeGraphCanonicity, type RuntimeGraphProjection } from "$lib/network3d/runtimeGraphProjection";
import { materializeRuntimeGraphReplicas } from "$lib/network3d/runtimeGraphRender";
import { connectedRuntimeGraphEntityIds, resolveRuntimeGraphLayout, type RuntimeGraphLayoutCache } from "$lib/network3d/runtimeGraphLayout";
import { readGraphPositionOverrides, writeGraphPositionOverride } from "$lib/network3d/graphPositionOverrides";
import {
  buildGraphAvailableRoutes,
  formatGraphDualConnectionAccountInfoFromReplicas,
  formatGraphEntityBalanceInfo,
  formatGraphEntityShortNameFromReplicas,
  findGraphJReplica,
  findGraphReplicaByEntityId,
  formatGraphReserveBadge,
  graphJReplicaHeight,
  getGraphEntityNameFromGossip,
  getGraphEntityFlag,
  getGraphSignerIdForEntity,
  graphEntityHasReserves,
  graphReserveValue,
  type GraphPaymentRoute,
  type GraphReplicaLike,
} from "./graph3d-helpers";
import { buildBirdViewSettings, readBirdViewSettings, writeBirdViewSettings, type BirdViewSettings } from "./graph3d-settings";
import { createGraphRenderer, detachGraphObject3D, disposeGraphObject3D, getGraphThemeColors, type GraphRenderer } from "../../../../../packages/ui/src/graph3d-renderer";
import {
  buildGraphAccountVisuals,
  createBlockContainer,
  buildGraphConnection,
  createMempoolTxCube,
  deriveGraphEntry,
  getAccountTokenDelta,
  graphAccountMempoolCount,
} from "./graph3d-visuals";
import type { GraphConnectionData, GraphEntityData, GraphEntityProfile, GraphFrameActivity, GraphJBlockHistoryEntry, GraphRendererMode, GraphRipple, GraphTransactionLike, GraphXLNRuntime } from "./graph3d-types";
import { buildRuntimeGraphProjections } from "./graph3d-runtime-projections";
import { collectGraphTokenIds, getGraphEntitySizeForToken } from "./graph3d-actions";
import {
  bindGraphControlsLifecycle,
  bindGraphViewportLifecycle,
  type GraphLifecycleBinding,
} from "../../../../../packages/ui/src/graph3d-lifecycle";
import {
  createGraph3dSceneInputView,
  graph3dSceneTransactionOf,
} from "../../../../../packages/runtime-client/src/graph3d-scene-input";
import {
  buildSimpleRadialLayout,
  createGraphGrid,
  createGraphJMachine,
  startProportionalBroadcast,
} from "../../../../../packages/ui/src/graph3d-scene-primitives";
import {
  createBroadcastRippleMesh,
  createDirectionalLightningMesh,
} from "../../../../../packages/ui/src/graph3d-visual-effects";
import {
  createEntityLabel,
  createGraphEntityNode,
  createMempoolIndicator,
  positionEntityLabel,
  positionMempoolIndicator,
} from "../../../../../packages/ui/src/graph3d-entity-visuals";
import {
  beginGraphEntityDrag,
  beginGraphGesture,
  emptyGraphGestureState,
  endGraphEntityDrag,
  endGraphGesture,
  findGraphEntityFromObject,
  moveGraphEntityDrag,
  resetGraphObjectHighlight,
  setGraphPointerNdc,
  updateGraphSelectionHighlight,
  type GraphGestureOutcome,
} from "../../../../../packages/ui/src/graph3d-interaction";
import {
  applyGraphCameraPose,
  applyGraphCameraTarget,
  fitGraphCameraToEntities,
} from "../../../../../packages/ui/src/graph3d-camera";
let showMiniPanel = false;
let miniPanelEntityId = "";
let miniPanelEntityName = "";
let miniPanelPosition = { x: 0, y: 0 };
export let runtimeFrameEnv: Writable<RuntimeReplica | null>;
export let runtimeFrameHistory: Writable<EnvSnapshot[]>;
export let runtimeFrameTimeIndex: Writable<number>;
export let graphInitSignal: Writable<boolean> | undefined = undefined;
$: initEnabled = graphInitSignal ? $graphInitSignal : true;
$: env = (() => {
  const timeIdx = $runtimeFrameTimeIndex;
  const historyFrames = $runtimeFrameHistory;
  if (timeIdx >= 0 && historyFrames && historyFrames.length > 0) {
    const idx = Math.min(timeIdx, historyFrames.length - 1);
    return historyFrames[idx]; // Historical frame
  }
  return $runtimeFrameEnv; // Live state
})();
let graphPositionOverrides = readGraphPositionOverrides(typeof localStorage === "undefined" ? null : localStorage);
let graphProjections: RuntimeGraphProjection[] = [];
let graphProjectionError = "";
let mergedRuntimeGraph: MergedRuntimeGraph = mergeRuntimeGraphProjections([], $runtimeGraphCanonicity);
let graphReplicaProjection = new Map<string, GraphReplicaLike>();
let autoFittedGraphSignature = "";
let forceLayoutCache: RuntimeGraphLayoutCache | null = null;
$: graphProjections = buildRuntimeGraphProjections({
  runtimeMap: $runtimes,
  activeRuntimeId: $activeRuntimeId,
  controllerRuntimeId: $runtimeControllerHandle.runtimeId,
  scope: $runtimeGraphScope,
  networkState: $networkMachineRuntime,
  liveRemoteFrames: $runtimeGraphLiveFrameCache,
  currentEnv: env ?? null,
});
$: if ($runtimeGraphScope !== "merged" && !graphProjections.some((item) => item.source.runtimeId === $runtimeGraphScope)) {
  runtimeGraphControlOperations.setScope("merged");
}
$: mergedRuntimeGraph = mergeRuntimeGraphProjections(graphProjections, $runtimeGraphCanonicity, $runtimeGraphScope);
$: graphReplicaProjection = materializeRuntimeGraphReplicas(mergedRuntimeGraph);
$: graphSceneInput = createGraph3dSceneInputView(graphProjections, mergedRuntimeGraph);
function getTimeAwareReplicas(): Map<string, GraphReplicaLike> {
  return graphReplicaProjection;
}
/** Replica keys are `entityId:signerId`. Single lookup used by every graph consumer. */
function findReplicaForEntity(entityId: string, replicas: Map<string, GraphReplicaLike> = getTimeAwareReplicas()): GraphReplicaLike | null {
  return findGraphReplicaByEntityId(replicas, entityId);
}
/** Detach + free a graph child. Bars/boxes live in graphWorld, so removal must target it. */
function detachFromGraphWorld(child: THREE.Object3D | null | undefined): void {
  detachGraphObject3D(graphWorld, child);
}
function detachConnectionVisuals(connection: GraphConnectionData): void {
  detachFromGraphWorld(connection.line);
  detachFromGraphWorld(connection.progressBars);
  for (const box of connection.mempoolBoxes) detachFromGraphWorld(box);
}
function detachEntityVisuals(entity: GraphEntityData): void {
  detachFromGraphWorld(entity.mesh); // label + rings are children of the mesh
}
let XLN: GraphXLNRuntime | null = null;
const debug = {
  warn: (...args: unknown[]) => console.warn("[Graph3D]", ...args),
  error: (...args: unknown[]) => console.error("[Graph3D]", ...args),
};
const reportGraphInitError = (error: unknown) => {
  debug.error("Graph initialization failed:", error);
};
const settingNumber = (value: unknown, key: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`GRAPH_SETTING_NUMBER_INVALID:${key}`);
  return value;
};
const settingBoolean = (value: unknown, key: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`GRAPH_SETTING_BOOLEAN_INVALID:${key}`);
  return value;
};
const settingVector = (value: unknown, key: string): { x: number; y: number; z: number } => {
  if (!value || typeof value !== 'object') throw new Error(`GRAPH_SETTING_VECTOR_INVALID:${key}`);
  const record = value as Record<string, unknown>;
  return {
    x: settingNumber(record['x'], `${key}.x`),
    y: settingNumber(record['y'], `${key}.y`),
    z: settingNumber(record['z'], `${key}.z`),
  };
};
const settings = { theme: "dark", portfolioScale: 5000, dollarsPerPx: 30000 };
let OrbitControlsConstructor: typeof OrbitControls;
let container: HTMLDivElement;
let scene: THREE.Scene;
let graphWorld: THREE.Group;
let camera: THREE.PerspectiveCamera;
let renderer: GraphRenderer;
let controls: OrbitControls;
let raycaster: THREE.Raycaster;
let mouse: THREE.Vector2;
let entityMeshMap = new Map<string, THREE.Object3D | undefined>();
let jMachines: Map<string, THREE.Group> = new Map(); // jurisdiction name → J-Machine mesh
$: jMachine = graphSceneInput.activeJurisdictionName ? jMachines.get(graphSceneInput.activeJurisdictionName) || null : null;
let jMachineTxBoxes: (THREE.Group | THREE.Mesh)[] = []; // Yellow tx cubes inside J-Machine (current mempool)
let jBlockHistory: GraphJBlockHistoryEntry[] = []; // Last 3 committed blocks stacked above J-machine
let jMachineCapacity = 3; // Max txs before broadcast (lowered to show O(n) problem)
let broadcastEnabled = true;
let jAutoProposerInterval: ReturnType<typeof setInterval> | null = null;
let jProposalIntervalMs = 1000; // 1 second default - configurable
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
  direction?: "incoming" | "outgoing";
}> = [];
let entityInputStrikes: Array<{
  line: THREE.Line;
  startTime: number;
  duration: number;
}> = [];
let currentFrameActivity: GraphFrameActivity = {
  activeEntities: new Set(),
  incomingFlows: new Map(),
  outgoingFlows: new Map(),
};
let connectionIndexMap: Map<string, number> = new Map();
let animationId: number | null;
let activeBroadcastSpheres: Array<{ sphere: THREE.Mesh; animationId: number }> = [];
let hoveredObject: THREE.Object3D | null = null;
let tooltip = { visible: false, x: 0, y: 0, content: "" };
let dualTooltip = {
  visible: false,
  x: 0,
  y: 0,
  leftContent: "",
  rightContent: "",
  leftEntity: "",
  rightEntity: "",
};
let draggedEntity: GraphEntityData | null = null;
let dragPlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // Plane for 3D dragging
let dragOffset: THREE.Vector3 = new THREE.Vector3();
let isDragging: boolean = false;
let hasMoved: boolean = false; // Track if actual movement occurred during drag
let justDragged: boolean = false; // Flag to prevent click after drag
let selectedGraphEntityId = "";
let graphGestureState = emptyGraphGestureState();
let immersiveWalletSurface: ImmersiveWalletSurface | null = null;
function loadBirdViewSettings(): BirdViewSettings {
  return readBirdViewSettings(typeof localStorage === "undefined" ? null : localStorage);
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
    camera:
      camera && controls
        ? {
            position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
            target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
            zoom: camera.zoom,
          }
        : undefined,
  });
  writeBirdViewSettings(typeof localStorage === "undefined" ? null : localStorage, nextSettings);
}
function saveEntityPositionOverride(entity: GraphEntityData) {
  try {
    graphPositionOverrides = writeGraphPositionOverride(typeof localStorage === "undefined" ? null : localStorage, entity.id, { x: entity.position.x, y: entity.position.y, z: entity.position.z });
  } catch (err) {
    debug.warn("Failed to save entity position override:", err);
  }
}
async function selectGraphRuntimeScope(nextScope: string): Promise<void> {
  const normalized = runtimeGraphControlOperations.setScope(nextScope);
  if (normalized !== "merged") await runtimeOperations.selectRuntime(normalized);
  if (scene) {
    clearNetwork();
    updateNetworkData();
  }
}
function selectGraphCanonicity(nextPolicy: RuntimeGraphCanonicity): void {
  runtimeGraphControlOperations.setCanonicity(nextPolicy);
  if (scene) {
    clearNetwork();
    updateNetworkData();
  }
}
const savedSettings = loadBirdViewSettings();
let barsMode: "close" | "spread" = savedSettings.barsMode;
let selectedTokenId = savedSettings.selectedTokenId;
let viewMode: "2d" | "3d" = savedSettings.viewMode;
let entityMode: "sphere" | "identicon" = savedSettings.entityMode;
let rotationX: number = savedSettings.rotationX; // 0-10000 (0 = stopped, 10000 = fast)
let rotationY: number = savedSettings.rotationY; // 0-10000 (0 = stopped, 10000 = fast)
let rotationZ: number = savedSettings.rotationZ; // 0-10000 (0 = stopped, 10000 = fast)
let availableTokens: number[] = []; // Will be populated from actual token data
let rendererMode: GraphRendererMode = "webgl";
let labelScale: number = 2.0;
let entitySizeMultiplier: number = 1.0;
let forceLayoutEnabled: boolean = true;
let gridSize: number = 2000;
let gridDivisions: number = 3;
let gridOpacity: number = 0.4;
let gridColor: string = "#ffffff"; // White for better contrast with 3x3 grid
let autoRotate: boolean = false;
let autoRotateSpeed: number = 0.5; // RPM
let showFpsOverlay: boolean = false; // Controlled by settings
let cameraTarget: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
let gridHelper: THREE.GridHelper | null = null;
let gridPulseIntensity: number = 0; // 0-1, animates on J-Machine broadcasts
function getTokenSymbol(tokenId: number): string {
  const tokenInfo = XLN?.getTokenInfo?.(tokenId);
  return tokenInfo?.symbol || `TKN${tokenId}`;
}
function getTokenDecimals(tokenId: number): number {
  return requireTokenDecimals(XLN?.getTokenInfo?.(tokenId)?.decimals, `token:${tokenId}`);
}
let paymentFrom: string = "";
let paymentTo: string = "";
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
  const themeColors = getGraphThemeColors(settings.theme);
  scene.background = new THREE.Color(themeColors.background);
}
$: if (scene && graphSceneInput.jurisdictions) {
  const jurisdictionsArray = graphSceneInput.jurisdictions;
  const currentJurisdictionNames = new Set(jurisdictionsArray.map((x) => x.name));
  for (const [name, mesh] of jMachines.entries()) {
    if (!currentJurisdictionNames.has(name)) {
      graphWorld.remove(mesh);
      jMachines.delete(name);
    }
  }
  jurisdictionsArray.forEach((jurisdiction) => {
    if (!jMachines.has(jurisdiction.name)) {
      const jMachineGroup = createJMachine(12, jurisdiction.jMachine.position, jurisdiction.name, jurisdiction.jMachine.jHeight); // 2x smaller for Fed Chair UX
      graphWorld.add(jMachineGroup);
      jMachines.set(jurisdiction.name, jMachineGroup);
    }
  });
  jurisdictionsArray.forEach((jurisdiction) => {
    const jMachineGroup = jMachines.get(jurisdiction.name);
    if (jMachineGroup) {
      const label = jMachineGroup.children.find((child) => child instanceof THREE.Sprite) as THREE.Sprite | undefined;
      if (label && label.material && label.material.map) {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (context) {
          canvas.width = 256;
          canvas.height = 64;
          context.fillStyle = "#66ccff";
          context.font = "bold 28px monospace";
          context.textAlign = "center";
          const shortName = (jurisdiction.name.split(" ")[0] ?? jurisdiction.name).substring(0, 8);
          context.fillText(`${shortName} (#${jurisdiction.jMachine.jHeight})`, 128, 40);
          const texture = new THREE.CanvasTexture(canvas);
          label.material.map = texture;
          label.material.needsUpdate = true;
        }
      }
    }
  });
  const activeJurisdiction = jurisdictionsArray.find((x) => x.name === graphSceneInput.activeJurisdictionName);
  const activeJMachine = activeJurisdiction ? jMachines.get(activeJurisdiction.name) : undefined;
  if (activeJurisdiction && activeJMachine) {
    const timeIdx = $runtimeFrameTimeIndex;
    const historyFrames = $runtimeFrameHistory;
    let prevMempoolSize = 0;
    let prevFrame = null;
    if (historyFrames && historyFrames.length > 0) {
      const prevFrameIdx = timeIdx === -1 ? historyFrames.length - 2 : timeIdx - 1;
      if (prevFrameIdx >= 0 && prevFrameIdx < historyFrames.length) {
        prevFrame = historyFrames[prevFrameIdx];
        const prevJReplicas = prevFrame?.state.jReplicas;
        if (prevJReplicas) {
          const prevJReplicaArr = Array.isArray(prevJReplicas) ? prevJReplicas : Array.from(prevJReplicas.values());
          const prevJR = prevJReplicaArr.find((jr) => jr.name === activeJurisdiction.name);
          prevMempoolSize = prevJR?.mempool?.length || 0;
        }
      }
    }
    jMachineTxBoxes.forEach((cube) => {
      if (cube && activeJMachine) {
        activeJMachine.remove(cube);
        disposeGraphObject3D(cube);
      }
    });
    jMachineTxBoxes = [];
    const mempool = activeJurisdiction.jMachine.mempool || [];
    const currentJHeight = activeJurisdiction.jMachine.jHeight || 0;
    const nextBlockHeight = Number(currentJHeight) + 1;
    mempool.forEach((tx, txIndex: number) => {
      const txCube = createMempoolTxCube(txIndex, getTokenDecimals, tx, nextBlockHeight);
      activeJMachine.add(txCube);
      jMachineTxBoxes.push(txCube);
    });
    if (prevFrame) {
      const prevJReplica = findGraphJReplica(prevFrame.state.jReplicas, activeJurisdiction.name);
      const prevJHeight = graphJReplicaHeight(prevJReplica);
      const currJHeightNum = Number(currentJHeight);
      if (currJHeightNum > prevJHeight && prevMempoolSize > 0) {
        const blockNumber = BigInt(currJHeightNum);
        const prevMempool = prevJReplica?.mempool || [];
        const { container: blockContainer, txCubes } = createBlockContainer({
          blockNum: blockNumber,
          txs: prevMempool,
          jMachinePosition: activeJMachine.position,
          yOffset: 15,
          getTokenDecimals,
        });
        const blockSpacing = 15;
        jBlockHistory.forEach((block) => {
          block.yOffset += blockSpacing;
          block.container.position.y = activeJMachine.position.y + block.yOffset;
        });
        blockContainer.position.copy(activeJMachine.position);
        blockContainer.position.y += blockSpacing;
        graphWorld.add(blockContainer);
        jBlockHistory.push({
          blockNumber,
          container: blockContainer,
          txCubes,
          yOffset: blockSpacing,
        });
        while (jBlockHistory.length > 3) {
          const oldBlock = jBlockHistory.shift();
          if (oldBlock) {
            graphWorld.remove(oldBlock.container);
            disposeGraphObject3D(oldBlock.container);
          }
        }
        createProportionalBroadcast(activeJMachine.position, prevMempoolSize);
      }
    }
    const currentHeightNum = Number(currentJHeight);
    const runtimeHistory = $runtimeFrameHistory || [];
    if (runtimeHistory.length > 0 && currentHeightNum > 0) {
      const blockBoundaries: Array<{ blockNum: number; txs: unknown[] }> = [];
      for (let targetHeight = currentHeightNum - 1; targetHeight >= Math.max(0, currentHeightNum - 3); targetHeight--) {
        const maxFrameIdx = $runtimeFrameTimeIndex >= 0 ? Math.min($runtimeFrameTimeIndex, runtimeHistory.length - 1) : runtimeHistory.length - 1;
        let foundFrame = null;
        let foundHeight = -1;
        for (let frameIdx = maxFrameIdx; frameIdx >= 0; frameIdx--) {
          const frame = runtimeHistory[frameIdx];
          const frameJReplica = findGraphJReplica(frame?.state.jReplicas, activeJurisdiction.name);
          const frameJHeight = graphJReplicaHeight(frameJReplica);
          if (frameJHeight <= targetHeight && frameJHeight > 0) {
            foundFrame = frameJReplica;
            foundHeight = frameJHeight;
            break;
          }
        }
        if (foundFrame) {
          const txs = foundFrame.mempool || [];
          blockBoundaries.push({
            blockNum: foundHeight + 1,
            txs: txs.slice(0, 9),
          });
        } else {
        }
      }
      const expectedBlocks = blockBoundaries.length;
      if (jBlockHistory.length !== expectedBlocks || (jBlockHistory[0] && Number(jBlockHistory[0].blockNumber) !== blockBoundaries[0]?.blockNum)) {
        jBlockHistory.forEach((block) => {
          graphWorld.remove(block.container);
          disposeGraphObject3D(block.container);
        });
        jBlockHistory = [];
        blockBoundaries.reverse().forEach((boundary, idx) => {
          const blockNum = BigInt(boundary.blockNum);
          const yOffset = (blockBoundaries.length - idx) * 15; // Stack upward
          const { container: blockContainer, txCubes } = createBlockContainer({
            blockNum,
            txs: boundary.txs,
            jMachinePosition: activeJMachine.position,
            yOffset,
            getTokenDecimals,
          });
          graphWorld.add(blockContainer);
          jBlockHistory.push({
            blockNumber: blockNum,
            container: blockContainer,
            txCubes,
            yOffset,
          });
        });
      }
    }
  }
}
function createProportionalBroadcast(jMachinePos: THREE.Vector3, txCount: number) {
  if (!scene || txCount === 0) return;
  const broadcast = startProportionalBroadcast({
    graphWorld,
    position: jMachinePos,
    transactionCount: txCount,
    onComplete: (sphere) => {
      activeBroadcastSpheres = activeBroadcastSpheres.filter((entry) => entry.sphere !== sphere);
    },
  });
  if (broadcast) activeBroadcastSpheres.push(broadcast);
}
$: if (jMachine && $runtimeFrameTimeIndex === -1) {
  const historyFrames = $runtimeFrameHistory;
  const currentLen = historyFrames?.length || 0;
  if (currentLen > lastAnimatedFrameIndex + 1) {
    for (let i = lastAnimatedFrameIndex + 1; i < currentLen; i++) {
      const frame = historyFrames[i];
      const entityInputs = frame?.runtimeInput?.entityInputs || [];
      entityInputs.forEach((entityInput) => {
        const txs = entityInput.entityTxs ?? [];
        txs.forEach((tx) => {
          const graphTx = graph3dSceneTransactionOf(tx);
          const txKind = graphTx.kind || graphTx.type;
          if (txKind === "payFromReserve" || txKind === "payToReserve" || txKind === "settleToReserve") {
            addTxToJMachine(entityInput.entityId);
          }
        });
      });
    }
    lastAnimatedFrameIndex = currentLen - 1;
  }
}
$: if (entities.length > 0) {
  entities.forEach((entity) => {
    entityMeshMap.set(entity.id, entity.mesh);
  });
}
let isVRSupported: boolean = false;
let isVRActive: boolean = false;
let activeRipples: GraphRipple[] = [];
let availableRoutes: GraphPaymentRoute[] = [];
let selectedRouteIndex: number = 0;
let graphInitialized = false;
let graphDestroyed = false;
let viewportLifecycle: GraphLifecycleBinding | null = null;
let controlsLifecycle: GraphLifecycleBinding | null = null;
async function initAndSetup() {
  if (graphInitialized) return;
  graphInitialized = true;
  try {
    XLN = await getXLN();
  } catch (err) {
    console.error("[Graph3D] Failed to load XLN runtime:", err);
  }
  if (graphDestroyed) return;
  if (navigator.xr) {
    try {
      const vrSupported = await navigator.xr.isSessionSupported("immersive-vr");
      isVRSupported = vrSupported === true;
    } catch (err) {
      isVRSupported = false;
    }
  } else {
    isVRSupported = false;
  }
  if (graphDestroyed) return;
  await initThreeJS();
  if (graphDestroyed) return;
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
  panelBridge.on("vr:toggle", handleVRToggle);
  const handleBroadcastToggle = (event: { enabled: boolean }) => {
    broadcastEnabled = event.enabled;
  };
  panelBridge.on("broadcast:toggle", handleBroadcastToggle);
  const handleSettingsUpdate = (event: { key: string; value: unknown }) => {
    const { key, value } = event;
    if (key === "gridSize") gridSize = settingNumber(value, key);
    else if (key === "gridDivisions") gridDivisions = settingNumber(value, key);
    else if (key === "gridOpacity") gridOpacity = settingNumber(value, key);
    else if (key === "gridColor") {
      if (typeof value !== 'string') throw new Error('GRAPH_SETTING_STRING_INVALID:gridColor');
      gridColor = value;
    }
    else if (key === "cameraTarget") {
      cameraTarget = settingVector(value, key);
      if (controls) {
        applyGraphCameraTarget(controls, cameraTarget);
      }
    } else if (key === "entityLabelScale") {
      labelScale = settingNumber(value, key);
      lastLabelUpdateTimeIndex = Number.NaN;
    } else if (key === "entitySizeMultiplier") {
      entitySizeMultiplier = settingNumber(value, key);
      lastLabelUpdateTimeIndex = Number.NaN;
    } else if (key === "rendererMode") {
      if (value !== 'webgl' && value !== 'webgpu') throw new Error('GRAPH_SETTING_RENDERER_INVALID');
      rendererMode = value;
    }
    else if (key === "forceLayoutEnabled") forceLayoutEnabled = settingBoolean(value, key);
    else if (key === "autoRotate") autoRotate = settingBoolean(value, key);
    else if (key === "autoRotateSpeed") autoRotateSpeed = settingNumber(value, key);
    else if (key === "showFpsOverlay") showFpsOverlay = settingBoolean(value, key);
    if (["gridSize", "gridDivisions", "gridOpacity", "gridColor"].includes(key)) {
      recreateGrid();
    }
  };
  const handleSettingsReset = () => {
    gridSize = 2000;
    gridDivisions = 3;
    gridOpacity = 0.4;
    gridColor = "#ffffff";
    cameraTarget = { x: 0, y: 0, z: 0 };
    labelScale = 2.0;
    entitySizeMultiplier = 1.0;
    lastLabelUpdateTimeIndex = Number.NaN;
    rendererMode = "webgl";
    forceLayoutEnabled = true;
    if (controls) {
      applyGraphCameraTarget(controls, cameraTarget);
    }
    recreateGrid();
  };
  const handleCameraFocus = (event: { target: { x: number; y: number; z: number } }) => {
    const { target } = event;
    if (controls) {
      cameraTarget = target;
      applyGraphCameraTarget(controls, target);
    }
  };
  const handleCameraRestore = (event: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } }) => {
    if (!controls || !camera) return;
    const { position, target } = event;
    cameraTarget = target;
    applyGraphCameraPose(camera, controls, { position, target });
    saveBirdViewSettings();
  };
  panelBridge.on("settings:update", handleSettingsUpdate);
  panelBridge.on("settings:reset", handleSettingsReset);
  panelBridge.on("camera:focus", handleCameraFocus);
  panelBridge.on("camera:restore", handleCameraRestore);
  let updateTimeout: ReturnType<typeof setTimeout> | null = null;
  const debouncedUpdate = () => {
    if (updateTimeout) clearTimeout(updateTimeout);
    updateTimeout = setTimeout(() => {
      if (scene) updateNetworkData();
      updateTimeout = null;
    }, 16); // ~60fps max update rate
  };
  const unsubscribe1 = runtimeFrameEnv.subscribe(debouncedUpdate);
  const unsubscribe2 = runtimeFrameTimeIndex.subscribe(debouncedUpdate);
  const unsubscribe3 = runtimeFrameHistory.subscribe(debouncedUpdate);
  let stopRemoteGraphWatch = (): void => {};
  const restartRemoteGraphWatch = (runtimeMap: Map<string, Runtime>): void => {
    stopRemoteGraphWatch();
    stopRemoteGraphWatch = watchRuntimeGraphFrameCache(runtimeMap, {
      onApplied: () => {
        graphProjectionError = "";
      },
      onError: (error) => {
        graphProjectionError = error instanceof Error ? error.message : String(error || "Remote graph projection failed");
        console.error("REMOTE_GRAPH_PROJECTION_FAILED", error);
      },
    });
  };
  const unsubscribe4 = runtimes.subscribe((runtimeMap) => {
    debouncedUpdate();
    restartRemoteGraphWatch(runtimeMap);
  });
  const unsubscribe5 = runtimeView.subscribe(debouncedUpdate);
  const unsubscribe6 = runtimeGraphLiveFrameCache.subscribe(debouncedUpdate);
  const unsubscribe7 = networkMachineRuntime.subscribe(debouncedUpdate);
  const handleScenarioLoaded = () => {
    if (scene) updateNetworkData();
  };
  panelBridge.on("scenario:loaded", handleScenarioLoaded);
  if (scene) {
    updateNetworkData();
  }
  return () => {
    if (updateTimeout) clearTimeout(updateTimeout);
    unsubscribe1();
    unsubscribe2();
    unsubscribe3();
    unsubscribe4();
    unsubscribe5();
    unsubscribe6();
    unsubscribe7();
    stopRemoteGraphWatch();
    panelBridge.off("scenario:loaded", handleScenarioLoaded);
    panelBridge.off("vr:toggle", handleVRToggle);
    panelBridge.off("broadcast:toggle", handleBroadcastToggle);
    panelBridge.off("settings:update", handleSettingsUpdate);
    panelBridge.off("settings:reset", handleSettingsReset);
    panelBridge.off("camera:focus", handleCameraFocus);
    panelBridge.off("camera:restore", handleCameraRestore);
  };
});
onDestroy(() => {
  graphDestroyed = true;
  viewportLifecycle?.dispose();
  viewportLifecycle = null;
  controlsLifecycle?.dispose();
  controlsLifecycle = null;
  unregisterGraphDebugSurface();
  immersiveWalletSurface?.dispose();
  immersiveWalletSurface = null;
  if (jAutoProposerInterval) {
    clearInterval(jAutoProposerInterval);
    jAutoProposerInterval = null;
  }
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  if (controls) {
    if (typeof controls.dispose === "function") {
      controls.dispose();
    }
  }
  entityMeshMap.clear();
  if (typeof window !== "undefined") {
    if (window.__debugScene === scene) delete window.__debugScene;
    if (window.__debugCamera === camera) delete window.__debugCamera;
    if (window.__debugRenderer === renderer) delete window.__debugRenderer;
  }
  let resourcesDisposed = false;
  const disposeGraphResources = () => {
    if (resourcesDisposed) return;
    resourcesDisposed = true;
    activeBroadcastSpheres.forEach(({ sphere, animationId: rafId }) => {
      cancelAnimationFrame(rafId);
      if (graphWorld) graphWorld.remove(sphere);
      disposeGraphObject3D(sphere);
    });
    activeBroadcastSpheres = [];
    entityInputStrikes.forEach((strike) => {
      if (!strike.line || !graphWorld) return;
      graphWorld.remove(strike.line);
      strike.line.geometry.dispose();
      (strike.line.material as THREE.Material).dispose();
    });
    entityInputStrikes = [];
    if (scene) {
      disposeGraphObject3D(scene);
      scene.clear();
    }
    gridHelper = null;
    entities = [];
    connections = [];
    particles = [];
    activeRipples = [];
    jMachines.clear();
    if (renderer) {
      renderer.setAnimationLoop(null);
      renderer.domElement.remove();
      renderer.dispose();
    }
  };
  const xrSession = renderer?.xr?.getSession?.() ?? null;
  if (xrSession) {
    void xrSession.end().catch((error) => {
      debug.error("Graph XR session teardown failed:", error);
    }).finally(disposeGraphResources);
  } else {
    disposeGraphResources();
  }
});
function createGrid() {
  if (!scene) return;
  gridHelper = createGraphGrid(gridColor, gridOpacity, gridSize, gridDivisions);
  graphWorld.add(gridHelper);
}
function recreateGrid() {
  requestAnimationFrame(() => {
    if (!scene || !gridHelper) return;
    detachFromGraphWorld(gridHelper);
    createGrid();
  });
}
function createJMachine(size: number = 25, position: { x: number; y: number; z: number } = { x: 0, y: 200, z: 0 }, name: string = "J-MACHINE", jHeight: number = 0): THREE.Group {
  return createGraphJMachine(size, position, name, jHeight);
}
function addTxToJMachine(_fromEntityId: string): THREE.Mesh | null {
  if (!jMachine || !scene) return null;
  const txGeometry = new THREE.BoxGeometry(2, 2, 2);
  const txMaterial = new THREE.MeshPhongMaterial({
    color: 0xffff00, // Yellow
    emissive: 0x888800,
    transparent: true,
    opacity: 0.9,
  });
  const txCube = new THREE.Mesh(txGeometry, txMaterial);
  const radius = 8; // Inside the 15-unit octahedron
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.random() * Math.PI;
  txCube.position.set(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));
  jMachine.add(txCube);
  jMachineTxBoxes.push(txCube);
  if (jMachineTxBoxes.length >= jMachineCapacity) {
    triggerBroadcast();
  }
  return txCube;
}
function triggerBroadcast() {
  if (!broadcastEnabled || !jMachine || !scene) return;
  jMachineTxBoxes.forEach((txCube) => {
    if (jMachine) jMachine.remove(txCube);
  });
  jMachineTxBoxes = [];
}
function startJAutoProposer() {
  if (jAutoProposerInterval) {
    clearInterval(jAutoProposerInterval);
  }
  jAutoProposerInterval = setInterval(() => {
    if (!jAutoProposerEnabled || !jMachine || !scene) return;
    if (jMachineTxBoxes.length === 0) return;
    triggerBroadcast();
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
    const { OrbitControls: OC } = await import("three/examples/jsm/controls/OrbitControls.js");
    OrbitControlsConstructor = OC;
  } catch (error) {
    debug.warn("OrbitControls not available:", error);
  }
  if (graphDestroyed) return;
  scene = new THREE.Scene();
  graphWorld = new THREE.Group();
  graphWorld.name = "xln-graph-world";
  scene.add(graphWorld);
  const themeColors = getGraphThemeColors(settings.theme);
  scene.background = new THREE.Color(themeColors.background);
  createGrid();
  const containerWidth = container.clientWidth || window.innerWidth;
  const containerHeight = container.clientHeight || window.innerHeight;
  camera = new THREE.PerspectiveCamera(
    75,
    containerWidth / containerHeight,
    0.01, // Near plane: zoom extremely close
    100000, // Far plane: see objects at extreme distances
  );
  camera.position.set(0.41, 572.94, 38.32); // AHB top-down view
  const createdRenderer = await createGraphRenderer(rendererMode, { antialias: false }); // Disabled for performance
  if (graphDestroyed) {
    createdRenderer?.dispose();
    return;
  }
  if (!createdRenderer) {
    console.warn("[Graph3D] Renderer unavailable - skipping 3D init");
    return;
  }
  renderer = createdRenderer;
  renderer.xr.enabled = !(typeof navigator !== "undefined" && navigator.webdriver); // Keep XR off in automation
  renderer.setSize(containerWidth, containerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // Cap at 1.5 for performance
  container.appendChild(renderer.domElement);
  if (typeof window !== "undefined") {
    window.__debugScene = scene;
    window.__debugCamera = camera;
    window.__debugRenderer = renderer;
  }
  if (OrbitControlsConstructor) {
    controls = new OrbitControlsConstructor(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.minDistance = 0; // No minimum - zoom into anything
    controls.maxDistance = Infinity; // No maximum - zoom out as far as you want
    controls.keys = { LEFT: "", UP: "", RIGHT: "", BOTTOM: "" };
    applyGraphCameraTarget(controls, { x: -37, y: 511, z: -243 });
    controlsLifecycle?.dispose();
    controlsLifecycle = bindGraphControlsLifecycle(controls, {
      onChange: () => panelBridge.emit("camera:update", {
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        distance: camera.position.distanceTo(controls.target),
      }),
      onEnd: saveBirdViewSettings,
    });
    controls.target.set(cameraTarget.x, cameraTarget.y, cameraTarget.z);
    if (savedSettings.camera) {
      applyGraphCameraPose(camera, controls, savedSettings.camera);
    } else {
      controls.update();
    }
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
  viewportLifecycle?.dispose();
  viewportLifecycle = bindGraphViewportLifecycle(container, renderer.domElement, {
    onMouseDown,
    onMouseUp,
    onMouseMove,
    onMouseOut,
    onClick: onMouseClick,
    onDoubleClick: onMouseDoubleClick,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onResize: onWindowResize,
  });
  if (isVRSupported && renderer) {
    setupVRControllers();
  }
}
function setupVRControllers() {
  if (!renderer || !scene) return;
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1.5)]);
  for (let index = 0; index < 2; index += 1) {
    const controller = renderer.xr.getController(index);
    controller.userData["sourceId"] = `xr:${index}`;
    controller.addEventListener("connected", (event) => {
      const inputSource = 'data' in event ? event.data as XRInputSource | undefined : undefined;
      const handedness = inputSource?.handedness || `slot-${index}`;
      const mode = inputSource?.targetRayMode || "unknown";
      controller.userData["sourceId"] = `xr:${mode}:${handedness}`;
      controller.userData["inputSource"] = inputSource ?? null;
      controller.visible = true;
    });
    controller.addEventListener("disconnected", () => {
      const sourceId = String(controller.userData["sourceId"] || `xr:${index}`);
      vrGrabs.delete(sourceId);
      controller.userData["inputSource"] = null;
      controller.visible = false;
    });
    controller.addEventListener("selectstart", onVRSelectStart);
    controller.addEventListener("selectend", onVRSelectEnd);
    const ray = new THREE.Line(geometry.clone(), new THREE.LineBasicMaterial({ color: 0x00ffff, opacity: 0.8, transparent: true }));
    ray.name = "xln-xr-target-ray";
    controller.add(ray);
    scene.add(controller);
  }
  geometry.dispose();
}
type VRGrab = { entity: GraphEntityData; controller: THREE.Object3D; sourceId: string; startPosition: THREE.Vector3; rayDistance: number };
const vrGrabs = new Map<string, VRGrab>();
function onVRSelectStart(event: { target: THREE.Object3D }) {
  const controller = event.target as THREE.Object3D;
  const sourceId = String(controller.userData["sourceId"] || controller.uuid);
  const tempMatrix = new THREE.Matrix4();
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  const raycaster = new THREE.Raycaster();
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  if (immersiveWalletSurface?.select(raycaster)) return;
  const intersects = raycaster.intersectObjects(
    entities.map((e) => e.mesh),
    true,
  );
  if (intersects.length > 0) {
    const hit = intersects[0];
    const entity = findGraphEntityFromObject(hit?.object, entities, graphWorld, scene);
    if (entity) {
      graphGestureState = beginGraphGesture(graphGestureState, { sourceId, entityId: entity.id, at: performance.now() });
      vrGrabs.set(sourceId, { entity, controller, sourceId, startPosition: entity.position.clone(), rayDistance: hit?.distance ?? 1 });
      entity.isDragging = true;
    }
  }
}
function onVRSelectEnd(event: { target: THREE.Object3D }) {
  const controller = event.target as THREE.Object3D;
  const sourceId = String(controller.userData["sourceId"] || controller.uuid);
  const grab = vrGrabs.get(sourceId);
  if (grab) {
    const moved = grab.entity.position.distanceTo(grab.startPosition) > 0.5;
    const result = endGraphGesture(graphGestureState, {
      sourceId,
      entityId: grab.entity.id,
      at: performance.now(),
      moved,
    });
    graphGestureState = result.state;
    grab.entity.isDragging = false;
    handleGraphGestureOutcome(result.outcome, grab.entity);
    if (moved) {
      grab.entity.isPinned = true;
      saveEntityPositionOverride(grab.entity);
    }
    enforceSpacingConstraints();
    updateConnectionsForEntity(grab.entity.id);
    vrGrabs.delete(sourceId);
  }
}
async function enterVR() {
  if (!renderer || !isVRSupported) {
    debug.error("VR not supported on this device");
    return;
  }
  try {
    const sessionInit: XRSessionInit = {
      optionalFeatures: [
        "local-floor",
        "bounded-floor",
        "hand-tracking",
        "layers", // Vision Pro AR passthrough
        "dom-overlay", // Better UI integration
        "anchors", // Physical world anchoring
      ],
      requiredFeatures: [],
      domOverlay: { root: container },
    };
    if (!navigator.xr) throw new Error('GRAPH_XR_API_UNAVAILABLE');
    const session = await navigator.xr.requestSession("immersive-vr", sessionInit);
    await renderer.xr.setSession(session);
    isVRActive = true;
    immersiveWalletSurface?.dispose();
    const xrCamera = renderer.xr.getCamera();
    immersiveWalletSurface = new ImmersiveWalletSurface(scene, xrCamera, (identity, action) => {
      panelBridge.emit("openEntityOperations", { ...identity, action });
    });
    scene.background = null; // Transparent = passthrough mode
    graphWorld.scale.setScalar(0.01); // Graph units become table-sized meters; XR input stays unscaled.
    graphWorld.position.set(0, -0.5, -1);
    const createWelcomePanel = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 512;
      const ctx = canvas.getContext("2d")!;
      const gradient = ctx.createLinearGradient(0, 0, 0, 512);
      gradient.addColorStop(0, "rgba(0, 0, 0, 0.95)");
      gradient.addColorStop(1, "rgba(10, 30, 50, 0.95)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1024, 512);
      ctx.strokeStyle = "#00ffff";
      ctx.lineWidth = 6;
      ctx.shadowColor = "#00ffff";
      ctx.shadowBlur = 20;
      ctx.strokeRect(3, 3, 1018, 506);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#00ffff";
      ctx.font = "bold 56px monospace";
      ctx.textAlign = "center";
      ctx.fillText("🏦 XLN FINANCIAL NETWORK", 512, 80);
      ctx.fillStyle = "#ffffff";
      ctx.font = "28px monospace";
      ctx.fillText("Cross-Jurisdictional Settlement System", 512, 130);
      ctx.font = "bold 32px monospace";
      ctx.fillStyle = "#4fd18b";
      ctx.fillText(" GREEN NUMBERS = Bank Reserves", 512, 200);
      ctx.fillStyle = "#00ff41";
      ctx.fillText("🔵 BLUE LINES = Open Accounts", 512, 250);
      ctx.fillStyle = "#ffff00";
      ctx.fillText("🟡 YELLOW DOTS = Payments Flowing", 512, 300);
      ctx.fillStyle = "#888888";
      ctx.font = "24px monospace";
      ctx.fillText("Payments auto-starting in 3 seconds...", 512, 380);
      ctx.fillStyle = "#aaaaaa";
      ctx.font = "italic 20px monospace";
      ctx.fillText("(Tap outside panel or wait 10s to dismiss)", 512, 420);
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 1.0,
        side: THREE.DoubleSide,
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
      panelBridge.emit("auto-demo:start", {});
    }, 3000);
    renderer.setAnimationLoop(animate);
    session.addEventListener("end", () => {
      isVRActive = false;
      if (welcomePanel && scene) {
        scene.remove(welcomePanel);
        welcomePanel.geometry.dispose();
        welcomePanel.material.map?.dispose();
        welcomePanel.material.dispose();
      }
      scene.background = new THREE.Color(0x0a0a0a);
      graphWorld.scale.setScalar(1);
      graphWorld.position.set(0, 0, 0);
      immersiveWalletSurface?.dispose();
      immersiveWalletSurface = null;
      renderer.setAnimationLoop(null);
      if (!graphDestroyed) animate();
    });
  } catch (error) {
    console.error("Failed to enter VR:", error);
    debug.error("VR session failed: " + (error as Error).message);
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
function fitCameraToEntities(preferredEntityIds: ReadonlySet<string> = new Set()) {
  if (!camera || !controls) return;
  fitGraphCameraToEntities(camera, controls, entities, preferredEntityIds);
}
function updateNetworkData() {
  if (!scene) return;
  const timeIndex = $runtimeFrameTimeIndex;
  updateAvailableTokens();
  const currentReplicas = graphReplicaProjection;
  const entityData: GraphEntityProfile[] = mergedRuntimeGraph.nodes.map((node) => ({
    entityId: node.entityId,
    metadata: {
      name: node.selected.label,
      isHub: node.selected.isHub,
      ...(node.selected.position ? { position: node.selected.position } : {}),
      provenance: node.provenance,
      desynchronized: node.desynchronized,
    },
  }));
  if (entityData.length === 0) {
    if (timeIndex >= 0) {
      debug.warn(`⚠️ No entity data found at frame ${timeIndex} - clearing network`);
    }
    clearNetwork(); // Proper clear - entities will be recreated on next frame with data
    return;
  }
  const connectionMap = new Map<string, Set<string>>();
  for (const [replicaKey, replica] of currentReplicas.entries()) {
    const entityId = String(replica.entityId || replicaKey.split(":")[0] || "")
      .trim()
      .toLowerCase();
    if (!entityId) throw new Error(`RuntimeGraphProjection replica has no entityId: ${replicaKey}`);
    const entityAccounts = replica.state?.accounts;
    if (!entityAccounts || entityAccounts.size === 0) continue;
    connectionMap.set(entityId, new Set(entityAccounts.keys()));
  }
  const connectionDegrees = new Map<string, number>();
  entityData.forEach((profile) => {
    const degree = connectionMap.get(profile.entityId)?.size || 0;
    connectionDegrees.set(profile.entityId, degree);
  });
  const sortedByDegree = [...connectionDegrees.entries()].sort((a, b) => b[1] - a[1]);
  const top3Hubs = new Set(sortedByDegree.slice(0, 3).map(([id]) => id));
  const currentEntityIds = new Set(entities.map((e) => e.id));
  const newEntityIds = new Set(entityData.map((e) => e.entityId));
  const toRemove = entities.filter((e) => !newEntityIds.has(e.id));
  const toAdd = entityData.filter((e) => !currentEntityIds.has(e.entityId));
  toRemove.forEach(detachEntityVisuals);
  entities = entities.filter((e) => newEntityIds.has(e.id));
  const removedIds = new Set(toRemove.map((e) => e.id));
  if (removedIds.size > 0) {
    connections.filter((c) => removedIds.has(c.from) || removedIds.has(c.to)).forEach(detachConnectionVisuals);
    connections = connections.filter((c) => !removedIds.has(c.from) && !removedIds.has(c.to));
  }
  const forceLayoutPositions = applyForceDirectedLayout(entityData, connectionMap);
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  entityData.forEach((profile) => {
    const existing = entityMap.get(profile.entityId);
    if (existing) {
      existing.profile = profile;
      existing.isHub = top3Hubs.has(profile.entityId);
      existing.mesh.userData["isHub"] = existing.isHub;
    }
  });
  toAdd.forEach((profile, index) => {
    const isHub = top3Hubs.has(profile.entityId);
    createEntityNode(profile, index, entityData.length, forceLayoutPositions, isHub, currentReplicas);
  });
  const graphSignature = [...mergedRuntimeGraph.sources.map((source) => source.runtimeId), ...mergedRuntimeGraph.nodes.map((node) => node.entityId), ...mergedRuntimeGraph.accounts.map((account) => account.accountId)].join("|");
  if (!savedSettings.camera && graphSignature && graphSignature !== autoFittedGraphSignature) {
    fitCameraToEntities(connectedRuntimeGraphEntityIds(mergedRuntimeGraph));
    autoFittedGraphSignature = graphSignature;
  }
  if (connections.length > 0) {
    connections.forEach(detachConnectionVisuals);
    connections = [];
  }
  if (selectedGraphEntityId && !entities.some((entity) => entity.id === selectedGraphEntityId)) {
    selectedGraphEntityId = "";
  }
  updateGraphSelectionHighlight(entities, selectedGraphEntityId);
  createConnections();
  applyNetworkMachineRuntimeHighlight();
  createTransactionParticles();
}
function removeRuntimeHighlight(parent: THREE.Object3D): void {
  const existing = parent.getObjectByName("network-machine-runtime-highlight");
  if (!existing) return;
  parent.remove(existing);
  if (existing instanceof THREE.Mesh || existing instanceof THREE.Line) {
    if (existing instanceof THREE.Mesh) existing.geometry.dispose();
    const materials = Array.isArray(existing.material) ? existing.material : [existing.material];
    materials.forEach((material) => material.dispose());
  }
}
function applyNetworkMachineRuntimeHighlight(): void {
  const step = $networkMachineRuntime.selectedStep;
  const activeRuntimeId = step?.activeRuntimeId || "";
  const activeColor = step?.activeRuntimeColor || "#ffffff";
  for (const entity of entities) {
    removeRuntimeHighlight(entity.mesh);
    const provenance = mergedRuntimeGraph.nodes.find((node) => node.entityId === entity.id)?.provenance ?? [];
    if (!activeRuntimeId || !provenance.includes(activeRuntimeId)) continue;
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.28, 20, 20), new THREE.MeshBasicMaterial({ color: activeColor, wireframe: true, transparent: true, opacity: 0.78, depthWrite: false }));
    shell.name = "network-machine-runtime-highlight";
    shell.userData["runtimeId"] = activeRuntimeId;
    entity.mesh.add(shell);
  }
  for (const connection of connections) {
    removeRuntimeHighlight(connection.line);
    const accountId = [connection.from, connection.to].sort().join(":");
    const provenance = mergedRuntimeGraph.accounts.find((account) => account.accountId === accountId)?.provenance ?? [];
    if (!activeRuntimeId || !provenance.includes(activeRuntimeId)) continue;
    const glow = new THREE.Line(connection.line.geometry, new THREE.LineBasicMaterial({ color: activeColor, transparent: true, opacity: 0.9, depthTest: false }));
    glow.name = "network-machine-runtime-highlight";
    glow.userData["runtimeId"] = activeRuntimeId;
    connection.line.add(glow);
  }
}
function clearNetwork() {
  entities.forEach(detachEntityVisuals);
  entities = [];
  connections.forEach(detachConnectionVisuals);
  connections = [];
  jBlockHistory.forEach((block) => detachFromGraphWorld(block.container));
  jBlockHistory = [];
  particles.forEach((particle) => detachFromGraphWorld(particle.mesh));
  particles = [];
}
function applyForceDirectedLayout(profiles: GraphEntityProfile[], connectionMap: Map<string, Set<string>>) {
  if (!forceLayoutEnabled) {
    return applySimpleRadialLayout(profiles, connectionMap);
  }
  forceLayoutCache = resolveRuntimeGraphLayout(mergedRuntimeGraph, graphPositionOverrides, forceLayoutCache);
  return new Map(Array.from(forceLayoutCache.positions, ([entityId, node]) => [entityId, new THREE.Vector3(node.position.x, node.position.y, node.position.z)]));
}
function applySimpleRadialLayout(profiles: GraphEntityProfile[], connectionMap: Map<string, Set<string>>) {
  return buildSimpleRadialLayout(profiles, connectionMap, compareStableText);
}
function createEntityNode(profile: GraphEntityProfile, index: number, total: number, forceLayoutPositions: Map<string, THREE.Vector3>, isHub: boolean, passedReplicas?: Map<string, GraphReplicaLike>) {
  const currentReplicas = passedReplicas || getTimeAwareReplicas();
  const replica = findReplicaForEntity(profile.entityId, currentReplicas);
  const node = createGraphEntityNode({
    profile,
    index,
    total,
    forceLayoutPosition: forceLayoutPositions.get(profile.entityId),
    forceLayoutEnabled,
    isHub,
    replica,
    userPosition: graphPositionOverrides.get(profile.entityId),
    persistedPosition: $entityPositions.get(profile.entityId),
    defaultJurisdiction: env && 'activeJurisdiction' in env ? env.activeJurisdiction || "default" : "default",
    resolveJMachinePosition: (jurisdictionName) => {
      const stored = env?.state.jReplicas?.get(jurisdictionName)?.position;
      if (stored) return stored;
      const mesh = jMachines.get(jurisdictionName);
      return mesh ? { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z } : null;
    },
    selectedTokenId,
    getEntitySize: getEntitySizeForToken,
    labelContent: entityLabelContent(profile.entityId),
    labelScale,
    isVrActive: isVRActive,
  });
  graphWorld.add(node.mesh);
  entities.push(node);
}
function createConnections() {
  const processedConnections = new Set<string>();
  const currentReplicas = getTimeAwareReplicas();
  if (currentReplicas.size > 0) {
    for (const [replicaKey, replica] of currentReplicas.entries()) {
      const [entityId] = replicaKey.split(":");
      const entityAccounts = replica.state?.accounts;
      if (!entityAccounts || !entityId) continue;
      for (const accountKey of entityAccounts.keys()) {
        const counterpartyId = String(accountKey);
        if (!counterpartyId) continue;
        const connectionKey = [entityId, counterpartyId].sort().join("<->");
        if (processedConnections.has(connectionKey)) continue;
        processedConnections.add(connectionKey);
        const fromEntity = entities.find((e) => e.id === entityId);
        const toEntity = entities.find((e) => e.id === counterpartyId);
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
    outgoingFlows: new Map(),
  };
  particles.forEach((particle) => detachFromGraphWorld(particle.mesh));
  particles = [];
  const timeIndex = $runtimeFrameTimeIndex;
  if (!($runtimeFrameTimeIndex === -1) && $runtimeFrameHistory && timeIndex >= 0) {
    const currentFrame = $runtimeFrameHistory[timeIndex];
    const entityInputs = currentFrame?.runtimeInput?.entityInputs || [];
    if (entityInputs.length > 0) {
      entityInputs.forEach((entityInput) => {
        const processingEntityId = entityInput.entityId;
        currentFrameActivity.activeEntities.add(processingEntityId);
        if (entityInput.entityTxs) {
          entityInput.entityTxs.forEach((tx) => {
            const graphTx = graph3dSceneTransactionOf(tx);
            if (graphTx.type === "accountInput" && graphTx.data?.fromEntityId && graphTx.data.toEntityId) {
              const fromEntityId = graphTx.data.fromEntityId;
              const toEntityId = graphTx.data.toEntityId;
              triggerEntityInputStrike(fromEntityId, toEntityId);
              if (!currentFrameActivity.outgoingFlows.has(fromEntityId)) {
                currentFrameActivity.outgoingFlows.set(fromEntityId, []);
              }
              currentFrameActivity.outgoingFlows.get(fromEntityId)!.push(toEntityId);
              createDirectionalLightning(fromEntityId, toEntityId, "outgoing", graphTx.data.accountTx);
              if (!currentFrameActivity.incomingFlows.has(toEntityId)) {
                currentFrameActivity.incomingFlows.set(toEntityId, []);
              }
              currentFrameActivity.incomingFlows.get(toEntityId)!.push(fromEntityId);
              triggerEntityActivity(fromEntityId);
              triggerEntityActivity(toEntityId);
            } else if (graphTx.type && ["r2c", "reserve_to_collateral", "deposit_reserve", "withdraw_reserve"].includes(graphTx.type)) {
              createBroadcastRipple(processingEntityId, graphTx.type);
            } else if (graphTx.type === "payFromReserve" || graphTx.kind === "payFromReserve") {
              const fromEntityId = processingEntityId;
              const toEntityId = graphTx.targetEntityId || graphTx.data?.targetEntityId;
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
}
function createDirectionalLightning(fromEntityId: string, toEntityId: string, direction: "incoming" | "outgoing", accountTx: GraphTransactionLike | undefined) {
  const key = `${fromEntityId}->${toEntityId}`;
  const connectionIndex = connectionIndexMap.get(key) ?? connectionIndexMap.get(`${toEntityId}->${fromEntityId}`) ?? -1;
  if (connectionIndex === -1) return;
  const connection = connections[connectionIndex];
  if (!connection) return;
  const bolt = createDirectionalLightningMesh(connection, accountTx);
  graphWorld.add(bolt);
  const amount = accountTx?.data?.amount;
  particles.push({
    mesh: bolt,
    connectionIndex,
    progress: 0,
    speed: 0.02, // Full 3-phase cycle in ~2.5s
    type: accountTx?.type || "unknown",
    ...(typeof amount === 'bigint' ? { amount } : {}),
    direction,
  });
}
function createBroadcastRipple(entityId: string, txType: string) {
  const entity = entities.find((e) => e.id === entityId);
  if (!entity) return;
  const ripple = createBroadcastRippleMesh(entity.position, txType);
  graphWorld.add(ripple);
  gridPulseIntensity = 1.0;
  particles.push({
    mesh: ripple,
    connectionIndex: -1, // -1 indicates broadcast ripple (not connection-based)
    progress: 0,
    speed: 0.05,
    type: `ripple_${txType}`,
    amount: 0n, // No amount for ripples
  });
}
function updateConnectionsForEntity(entityId: string) {
  connections.forEach((conn) => {
    if (conn.from === entityId || conn.to === entityId) {
      const fromEntity = entities.find((e) => e.id === conn.from);
      const toEntity = entities.find((e) => e.id === conn.to);
      if (fromEntity && toEntity) {
        const posAttr = conn.line.geometry.getAttribute("position");
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
          detachFromGraphWorld(conn.progressBars);
          for (const box of conn.mempoolBoxes) detachFromGraphWorld(box);
          const replica = findReplicaForEntity(conn.from) ?? findReplicaForEntity(conn.to);
          if (replica) {
            const { bars, mempoolBoxes } = createAccountBarsForConnection(fromEntity, toEntity, conn.from, conn.to, replica);
            conn.progressBars = bars;
            conn.mempoolBoxes = mempoolBoxes;
          }
        }
      }
    }
  });
}
function createConnectionLine(fromEntity: GraphEntityData, toEntity: GraphEntityData, fromId: string, toId: string, _replica: GraphReplicaLike) {
  const currentReplicas = getTimeAwareReplicas();
  connections.push(
    buildGraphConnection({
      graphWorld,
      fromEntity,
      toEntity,
      fromId,
      toId,
      replicas: currentReplicas,
      runtime: XLN,
      theme: settings.theme,
      barsMode,
      portfolioScale: settings.portfolioScale || 5000,
      getEntitySize: getEntitySizeForToken,
    }),
  );
}
function createAccountBarsForConnection(fromEntity: GraphEntityData, toEntity: GraphEntityData, fromId: string, toId: string, _replica: GraphReplicaLike) {
  return buildGraphAccountVisuals({
    graphWorld,
    fromEntity,
    toEntity,
    fromId,
    toId,
    replicas: getTimeAwareReplicas(),
    runtime: XLN,
    theme: settings.theme,
    barsMode,
    portfolioScale: settings.portfolioScale || 5000,
    getEntitySize: getEntitySizeForToken,
  });
}
function entityLabelContent(entityId: string) {
  const projectedLabel = String(mergedRuntimeGraph.nodes.find((node) => node.entityId === entityId)?.selected.label || "").trim();
  const entityName = projectedLabel && projectedLabel.toLowerCase() !== entityId.toLowerCase() ? projectedLabel : getEntityShortName(entityId);
  const currentReplicas = getTimeAwareReplicas();
  const replica = findReplicaForEntity(entityId, currentReplicas);
  const flag = getGraphEntityFlag(replica?.signerId);
  let balanceStr = "";
  if (replica?.state?.reserves) {
    const reserve = graphReserveValue(replica.state.reserves, String(selectedTokenId));
    balanceStr = formatGraphReserveBadge(reserve, getTokenDecimals(selectedTokenId), getTokenSymbol(selectedTokenId));
  }
  return {
    flag,
    labelText: entityName + balanceStr,
    key: `${entityName}|${flag}|${balanceStr}|${labelScale}|${isVRActive ? "vr" : "screen"}`,
  };
}
function updateMempoolIndicators() {
  const currentReplicas = getTimeAwareReplicas();
  entities.forEach((entity) => {
    const replica = findReplicaForEntity(entity.id, currentReplicas);
    const entityMempoolCount = replica?.mempool?.length || 0;
    let accountMempoolOut = 0;
    let accountMempoolIn = 0;
    if (replica?.state?.accounts) {
      for (const [, account] of replica.state.accounts) {
        const pending = graphAccountMempoolCount(account);
        accountMempoolOut += pending;
      }
    }
    for (const [otherKey, otherReplica] of currentReplicas.entries()) {
      const [otherEntityId] = otherKey.split(":");
      if (otherEntityId === entity.id) continue;
      if (otherReplica?.state?.accounts) {
        const accountToUs = otherReplica.state.accounts.get(entity.id);
        const incoming = graphAccountMempoolCount(accountToUs);
        if (incoming > 0) {
          accountMempoolIn += incoming;
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
      entity.mesh.add(entity.mempoolIndicator);
    }
    positionMempoolIndicator(entity.mempoolIndicator, entity.mesh.scale.x);
    entity.mempoolIndicator.visible = true;
    const canvas = entity.mempoolIndicator.userData["canvas"] as HTMLCanvasElement;
    const context = entity.mempoolIndicator.userData["context"] as CanvasRenderingContext2D;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (totalOut > 0) {
      context.font = "bold 24px sans-serif";
      context.textAlign = "center";
      context.fillStyle = "#ff8800"; // Orange for outgoing
      context.fillText(`↑${totalOut}`, 32, 36);
    }
    if (totalIn > 0) {
      context.font = "bold 24px sans-serif";
      context.textAlign = "center";
      context.fillStyle = "#00ccff"; // Cyan for incoming
      context.fillText(`↓${totalIn}`, 96, 36);
    }
    const texture = entity.mempoolIndicator.material.map as THREE.CanvasTexture;
    texture.needsUpdate = true;
  });
}
function updateEntityLabels() {
  if (!camera) return;
  const currentReplicas = getTimeAwareReplicas();
  const currentTimeIndex = get(runtimeFrameTimeIndex);
  const forceRecreateLabels = currentTimeIndex !== lastLabelUpdateTimeIndex;
  if (forceRecreateLabels) {
    lastLabelUpdateTimeIndex = currentTimeIndex;
  }
  entities.forEach((entity) => {
    const content = entityLabelContent(entity.id);
    const contentChanged = entity.label?.userData["contentKey"] !== content.key;
    if (!entity.label || forceRecreateLabels || contentChanged) {
      if (entity.label) {
        entity.mesh.remove(entity.label);
        if (entity.label.material?.map) {
          entity.label.material.map.dispose();
        }
        entity.label.material?.dispose();
      }
      entity.label = createEntityLabel(content, labelScale, isVRActive);
      entity.mesh.add(entity.label);
    }
    if (entity.label.parent !== entity.mesh) {
      graphWorld.remove(entity.label);
      entity.mesh.add(entity.label);
    }
    positionEntityLabel(entity.label, entity.mesh.scale.x);
    const replica = findReplicaForEntity(entity.id, currentReplicas);
    const reserveAmount = graphReserveValue(replica?.state?.reserves, String(selectedTokenId));
    if (forceRecreateLabels) {
      const material = entity.mesh.material as THREE.MeshLambertMaterial;
      if (material && !entity.mesh.userData["isFed"]) {
        material.transparent = false;
        material.opacity = 1.0;
        material.depthWrite = true;
        if (reserveAmount <= 0n) {
          material.color.setHex(0x666666);
          material.emissive.setHex(0x333333);
          material.emissiveIntensity = 0.1;
        } else {
          material.color.setHex(0x5cb85c); // Collateral green
          const baseColor = new THREE.Color(0x5cb85c);
          material.emissive.copy(baseColor.multiplyScalar(0.1));
          material.emissiveIntensity = entity.isHub ? 0.2 : 0.1; // Subtle glow
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
});
function animate() {
  if (graphDestroyed) return;
  perfMonitor.begin(); // Start FPS measurement
  if (!renderer?.xr?.isPresenting) {
    animationId = requestAnimationFrame(animate);
  }
  animateCallCount++;
  animateEntityInputStrikes();
  for (const grab of vrGrabs.values()) {
    const controllerWorldPosition = new THREE.Vector3().setFromMatrixPosition(grab.controller.matrixWorld);
    const controllerWorldRotation = new THREE.Matrix4().extractRotation(grab.controller.matrixWorld);
    const rayDirection = new THREE.Vector3(0, 0, -1).applyMatrix4(controllerWorldRotation).normalize();
    const rayPoint = controllerWorldPosition.add(rayDirection.multiplyScalar(grab.rayDistance));
    const graphPosition = graphWorld.worldToLocal(rayPoint);
    grab.entity.mesh.position.copy(graphPosition);
    grab.entity.position.copy(graphPosition);
    updateConnectionsForEntity(grab.entity.id);
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
    if (Math.random() < 0.01) {
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
  animateEntityPulses();
  updateEntityLabels();
  updateMempoolIndicators();
  animateParticles();
  if (gridPulseIntensity > 0 && gridHelper) {
    gridPulseIntensity *= 0.95; // Exponential decay
    if (gridPulseIntensity < 0.01) gridPulseIntensity = 0;
    const baseMaterial = gridHelper.material as THREE.LineBasicMaterial;
    const pulseColor = new THREE.Color(gridColor).lerp(
      new THREE.Color(0x00ff88), // Bright green
      gridPulseIntensity,
    );
    baseMaterial.color = pulseColor;
    baseMaterial.opacity = gridOpacity + gridPulseIntensity * 0.3; // Brighten on pulse
  }
  updateRipples();
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
        } else if (entityA.isPinned && !entityB.isPinned) {
          entityB.position.add(direction.clone().multiplyScalar(pushStrength));
          entityB.mesh.position.copy(entityB.position);
          anyMoved = true;
        } else if (!entityA.isPinned && entityB.isPinned) {
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
  if (needsConnectionRebuild && now - lastConnectionRebuild > 100) {
    connections.forEach(detachConnectionVisuals);
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
      graphWorld.remove(particle.mesh);
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
    } else if (particle.progress < 0.55) {
      const phase2Progress = (particle.progress - 0.45) / 0.1; // 0 to 1
      particle.mesh.scale.y = 1.0;
      material.opacity = 1.0;
      material.emissiveIntensity = 4.0 * Math.sin(phase2Progress * Math.PI); // Peak at midpoint
      const flashBrightness = Math.sin(phase2Progress * Math.PI);
      material.color.setRGB(flashBrightness * 0.5, flashBrightness, 1.0);
    } else {
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
      throw new Error("FINTECH-SAFETY: Entity material missing emissive property");
    }
    let baseSize = getEntitySizeForToken(entityId, selectedTokenId);
    if (entity.mesh.userData["isFed"]) {
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
      let glowR = 0,
        glowG = 0,
        glowB = 0;
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
          emissive: 0x00ff00,
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
  const entity = entities.find((e) => e.id === entityId);
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
      graphWorld.remove(strike.line);
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
  const fromEntity = entities.find((e) => e.id === fromEntityId);
  const toEntity = entities.find((e) => e.id === toEntityId);
  if (!fromEntity || !toEntity) {
    return;
  }
  const geometry = new THREE.BufferGeometry().setFromPoints([fromEntity.position.clone(), toEntity.position.clone()]);
  const material = new THREE.LineBasicMaterial({
    color: 0x00ffff, // Cyan
    transparent: true,
    opacity: 1.0,
    linewidth: 2,
  });
  const line = new THREE.Line(geometry, material);
  graphWorld.add(line);
  entityInputStrikes.push({
    line,
    startTime: performance.now(),
    duration: 100, // 100ms flash
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
        const connection = connections.find((c) => (c.from === entityA.id && c.to === entityB.id) || (c.from === entityB.id && c.to === entityA.id));
        if (!connection) continue;
        const entityASizeData = getEntitySizeForToken(entityA.id, selectedTokenId);
        const entityBSizeData = getEntitySizeForToken(entityB.id, selectedTokenId);
        const currentReplicas = getTimeAwareReplicas();
        let totalBarsLength = 0;
        const fromReplica = findReplicaForEntity(entityA.id, currentReplicas);
        if (fromReplica?.state?.accounts) {
          const accountData = fromReplica.state.accounts.get(entityB.id);
          if (accountData) {
            const tokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
            if (tokenDelta) {
              const derived = XLN?.deriveDelta(tokenDelta, entityA.id < entityB.id);
              if (!derived) continue;
              const globalScale = settings.portfolioScale || 5000;
              const decimals = getTokenDecimals(selectedTokenId);
              const tokensToVisualUnits = 0.00001;
              const barScale = (tokensToVisualUnits / Math.pow(10, decimals)) * (globalScale / 5000);
              totalBarsLength = (Number(derived.peerCreditLimit) + Number(derived.collateral) + Number(derived.ownCreditLimit)) * barScale;
            }
          }
        }
        const minGapSpread = 2; // Spread mode: small gap in middle
        const minGapClose = 1; // Close mode: small gap on each side
        const requiredGap = barsMode === "spread" ? minGapSpread : 2 * minGapClose;
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
          } else if (entityA.isPinned && !entityB.isPinned) {
            entityB.position.add(direction.clone().multiplyScalar(pushDistance));
            entityB.mesh.position.copy(entityB.position);
          } else if (!entityA.isPinned && entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushDistance));
            entityA.mesh.position.copy(entityA.position);
          } else {
            debug.warn(`⚠️ Both entities pinned but too close: ${entityA.id.slice(-4)} ↔ ${entityB.id.slice(-4)}`);
          }
        }
      }
    }
  } // End while loop
  if (iterations > 1) {
  }
  connections.forEach(detachConnectionVisuals);
  connections = [];
  createConnections();
}
function onMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  setGraphPointerNdc(mouse, event, rect);
  raycaster.setFromCamera(mouse, camera);
  const entityMeshes = entities.map((e) => e.mesh);
  const intersects = raycaster.intersectObjects(entityMeshes);
  if (intersects.length > 0) {
    const intersectedObject = intersects[0]?.object;
    if (!intersectedObject) return;
    const entity = findGraphEntityFromObject(intersectedObject, entities, graphWorld, scene);
    if (!entity) return;
    event.preventDefault();
    if (controls) {
      controls.enabled = false;
    }
    isDragging = true;
    hasMoved = false; // Reset movement flag for this drag
    draggedEntity = entity;
    selectGraphEntity(entity);
    beginGraphEntityDrag(camera, raycaster, entity, dragPlane, dragOffset);
  }
}
function onMouseUp(_event: MouseEvent) {
  if (draggedEntity && isDragging) {
    if (hasMoved) {
      draggedEntity.isPinned = true;
    }
    endGraphEntityDrag(draggedEntity);
    if (hasMoved) {
      enforceSpacingConstraints();
      saveEntityPositionOverride(draggedEntity);
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
  setGraphPointerNdc(mouse, event, rect);
  raycaster.setFromCamera(mouse, camera);
  if (isDragging && draggedEntity) {
    hasMoved = true; // Actual movement occurred
    moveGraphEntityDrag(raycaster, draggedEntity, dragPlane, dragOffset);
    updateConnectionsForEntity(draggedEntity.id);
    return; // Skip hover logic while dragging
  }
  const entityMeshes = entities.map((e) => e.mesh);
  const entityIntersects = raycaster.intersectObjects(entityMeshes);
  const connectionLines = connections.map((c) => c.line);
  const lineIntersects = raycaster.intersectObjects(connectionLines);
  if (entityIntersects.length > 0) {
    const intersectedObject = entityIntersects[0]?.object;
    if (!intersectedObject) {
      throw new Error("FINTECH-SAFETY: No intersected object found");
    }
    const entity = findGraphEntityFromObject(intersectedObject, entities, graphWorld, scene);
    if (!entity) {
      tooltip.visible = false;
      dualTooltip.visible = false;
      return;
    }
    if (hoveredObject !== entity.mesh) {
      hoveredObject = entity.mesh;
      const balanceInfo = getEntityBalanceInfo(entity.id);
      tooltip = {
        visible: true,
        x: event.clientX,
        y: event.clientY,
        content: balanceInfo || "No reserves",
      };
      const mesh = entity.mesh;
      const material = mesh.material as THREE.MeshLambertMaterial;
      if (!material?.emissive) {
        throw new Error("FINTECH-SAFETY: Entity material missing emissive property");
      }
      material.emissive.setHex(0x444400);
    }
  } else if (lineIntersects.length > 0) {
    const intersectedLine = lineIntersects[0]?.object;
    if (!intersectedLine) {
      throw new Error("FINTECH-SAFETY: No intersected line found");
    }
    const connection = connections.find((c) => c.line === intersectedLine);
    if (!connection) {
      throw new Error("FINTECH-SAFETY: Connection not found for intersected line");
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
        rightEntity: dualInfo.rightEntity,
      };
      tooltip.visible = false;
      const lineMesh = intersectedLine as THREE.Line;
      const lineMaterial = lineMesh.material as THREE.LineDashedMaterial;
      if (!lineMaterial?.color) {
        throw new Error("FINTECH-SAFETY: Connection material missing color property");
      }
      lineMaterial.color.setHex(0xffff00);
    }
  } else {
    if (hoveredObject) {
      resetGraphObjectHighlight(hoveredObject);
      hoveredObject = null;
      tooltip.visible = false;
      dualTooltip.visible = false;
    }
  }
}
function onMouseOut() {
  if (hoveredObject) {
    resetGraphObjectHighlight(hoveredObject);
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
  setGraphPointerNdc(mouse, event, rect);
  raycaster.setFromCamera(mouse, camera);
  const jMachineObjects: THREE.Object3D[] = [];
  jMachines.forEach((group) => {
    group.children.forEach((child) => jMachineObjects.push(child));
  });
  const jMachineIntersects = raycaster.intersectObjects(jMachineObjects);
  if (jMachineIntersects.length > 0 && jMachineIntersects[0]) {
    const clickedMesh = jMachineIntersects[0].object;
    const clickedJMachine = [...jMachines.values()].find((group) => group.children.includes(clickedMesh)) ?? null;
    if (clickedJMachine && clickedJMachine.userData['type'] === "jMachine") {
      const pos = clickedJMachine.userData['position'] as { x: number; y: number; z: number };
      const name = String(clickedJMachine.userData['jurisdictionName']);
      if (controls && pos) {
        cameraTarget = pos;
        applyGraphCameraTarget(controls, pos);
      }
      panelBridge.emit("openJurisdiction", { jurisdictionName: name });
      return; // Don't process entity clicks
    }
  }
  const entityMeshes = entities.map((e) => e.mesh);
  const intersects = raycaster.intersectObjects(entityMeshes);
  if (intersects.length > 0) {
    const intersectedObject = intersects[0]?.object;
    if (!intersectedObject) {
      throw new Error("FINTECH-SAFETY: No intersected object in click");
    }
    const entity = findGraphEntityFromObject(intersectedObject, entities, graphWorld, scene);
    if (!entity || !entity.id) {
      return;
    }
    selectGraphEntity(entity);
  } else {
    showMiniPanel = false;
    selectedGraphEntityId = "";
    updateGraphSelectionHighlight(entities, selectedGraphEntityId);
  }
}
function selectGraphEntity(entity: GraphEntityData): void {
  if (!entity.id) throw new Error("GRAPH_ENTITY_ID_REQUIRED");
  selectedGraphEntityId = entity.id;
  updateGraphSelectionHighlight(entities, selectedGraphEntityId);
  triggerEntityActivity(entity.id);
  panelBridge.emit("entity:selected", { entityId: entity.id });
}
async function openGraphEntityWallet(entity: GraphEntityData): Promise<void> {
  selectGraphEntity(entity);
  saveBirdViewSettings(false);
  const mergedNode = mergedRuntimeGraph.nodes.find((node) => node.entityId === entity.id);
  const targetRuntimeId = requireActionableGraphNodeRuntimeId(mergedNode, $activeRuntimeId);
  if (targetRuntimeId !== $activeRuntimeId) {
    if (!$runtimes.has(targetRuntimeId)) throw new Error(`GRAPH_ENTITY_RUNTIME_MISSING:${targetRuntimeId}`);
    await runtimeOperations.selectRuntime(targetRuntimeId);
  }
  const actionableState = mergedNode?.states.find((state) => state.runtimeId === targetRuntimeId);
  const entityName = mergedNode?.selected.label || getEntityName(entity.id);
  const signerId = actionableState?.signerId || getSignerIdForEntity(entity.id);
  if (isVRActive && immersiveWalletSurface) {
    immersiveWalletSurface.open({ entityId: entity.id, entityName: entityName || entity.id, signerId: signerId || entity.id });
  }
  panelBridge.emit("openEntityOperations", {
    entityId: entity.id,
    entityName: entityName || entity.id,
    signerId: signerId || entity.id,
  });
}
function requestGraphEntityWallet(entity: GraphEntityData): void {
  void openGraphEntityWallet(entity).catch((error) => {
    graphProjectionError = error instanceof Error ? error.message : String(error);
    console.error("Failed to open graph entity wallet:", error);
  });
}
function handleGraphGestureOutcome(outcome: GraphGestureOutcome, entity: GraphEntityData): void {
  if (outcome === "open") requestGraphEntityWallet(entity);
  else if (outcome === "select" || outcome === "drag-end") selectGraphEntity(entity);
}
function graphDebugSnapshot() {
  const rect = renderer?.domElement?.getBoundingClientRect?.();
  return {
    scope: $runtimeGraphScope,
    canonicity: $runtimeGraphCanonicity,
    sources: mergedRuntimeGraph.sources.map((source) => source.runtimeId),
    nodes: entities.map((entity) => {
      const world = entity.mesh.getWorldPosition(new THREE.Vector3());
      const projected = world.clone().project(camera);
      return {
        entityId: entity.id,
        label: mergedRuntimeGraph.nodes.find((node) => node.entityId === entity.id)?.selected.label ?? entity.id,
        provenance: mergedRuntimeGraph.nodes.find((node) => node.entityId === entity.id)?.provenance ?? [],
        selected: entity.id === selectedGraphEntityId,
        screen: rect
          ? {
              x: rect.left + ((projected.x + 1) / 2) * rect.width,
              y: rect.top + ((1 - projected.y) / 2) * rect.height,
            }
          : null,
      };
    }),
    accounts: mergedRuntimeGraph.accounts.map((account) => ({ accountId: account.accountId, provenance: account.provenance })),
    timeline: $networkMachineRuntime.selectedStep
      ? {
          runtimeId: $networkMachineRuntime.selectedStep.activeRuntimeId,
          height: $networkMachineRuntime.selectedStep.event.height,
          timestamp: $networkMachineRuntime.selectedStep.event.timestamp,
        }
      : null,
  };
}
const unregisterGraphDebugSurface = registerDebugSurface("graph", () => ({ snapshot: graphDebugSnapshot }));
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
  panelBridge.emit("openEntityOperations", {
    entityId,
    entityName,
    signerId: getSignerIdForEntity(entityId),
    action: type, // 'r2r' or 'r2c'
  });
  showMiniPanel = false;
}
function handleOpenFullPanel(event: CustomEvent) {
  const { entityId, entityName, signerId } = event.detail;
  panelBridge.emit("openEntityOperations", { entityId, entityName, signerId: signerId || entityId });
  showMiniPanel = false;
}
function onMouseDoubleClick(event: MouseEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  setGraphPointerNdc(mouse, event, rect);
  raycaster.setFromCamera(mouse, camera);
  const entityMeshes = entities.map((e) => e.mesh);
  const intersects = raycaster.intersectObjects(entityMeshes);
  if (intersects.length > 0) {
    const intersectedObject = intersects[0]?.object;
    if (!intersectedObject) {
      throw new Error("FINTECH-SAFETY: No intersected object in double-click");
    }
    const entity = findGraphEntityFromObject(intersectedObject, entities, graphWorld, scene);
    if (!entity) {
      console.warn("Double-click: Could not find entity for object", intersectedObject);
      return; // Gracefully ignore instead of throwing
    }
    requestGraphEntityWallet(entity);
  }
}
function onTouchStart(event: TouchEvent) {
  event.preventDefault();
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    if (!touch) throw new Error("GRAPH_PRIMARY_TOUCH_MISSING");
    const rect = renderer.domElement.getBoundingClientRect();
    setGraphPointerNdc(mouse, touch, rect);
    raycaster.setFromCamera(mouse, camera);
    const entityMeshes = entities.map((e) => e.mesh);
    const intersects = raycaster.intersectObjects(entityMeshes);
    if (intersects.length > 0) {
      const intersectedObject = intersects[0]?.object;
      if (!intersectedObject) return;
      const entity = findGraphEntityFromObject(intersectedObject, entities, graphWorld, scene);
      if (!entity) return;
      if (controls) {
        controls.enabled = false;
      }
      isDragging = true;
      hasMoved = false; // Reset movement flag for this drag
      draggedEntity = entity;
      graphGestureState = beginGraphGesture(graphGestureState, { sourceId: "touch:primary", entityId: entity.id, at: event.timeStamp });
      beginGraphEntityDrag(camera, raycaster, entity, dragPlane, dragOffset);
    }
  }
}
function onTouchMove(event: TouchEvent) {
  event.preventDefault();
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    if (!touch) throw new Error("GRAPH_PRIMARY_TOUCH_MISSING");
    const rect = renderer.domElement.getBoundingClientRect();
    setGraphPointerNdc(mouse, touch, rect);
    raycaster.setFromCamera(mouse, camera);
    if (isDragging && draggedEntity) {
      hasMoved = true; // Actual movement occurred
      moveGraphEntityDrag(raycaster, draggedEntity, dragPlane, dragOffset);
    }
  }
}
function onTouchEnd(event: TouchEvent) {
  event.preventDefault();
  if (draggedEntity && isDragging) {
    const releasedEntity = draggedEntity;
    const result = endGraphGesture(graphGestureState, {
      sourceId: "touch:primary",
      entityId: releasedEntity.id,
      at: event.timeStamp,
      moved: hasMoved,
    });
    graphGestureState = result.state;
    if (hasMoved) {
      draggedEntity.isPinned = true;
    }
    endGraphEntityDrag(draggedEntity);
    if (hasMoved) {
      enforceSpacingConstraints();
      saveEntityPositionOverride(draggedEntity);
      justDragged = true;
      setTimeout(() => {
        justDragged = false;
      }, 100);
    }
    draggedEntity = null;
    isDragging = false;
    handleGraphGestureOutcome(result.outcome, releasedEntity);
  }
  if (controls) {
    controls.enabled = true;
  }
}
function highlightRoutePath(route: (typeof availableRoutes)[0] | undefined) {
  if (!route) {
    clearRouteHighlight();
    return;
  }
  clearRouteHighlight();
  for (let i = 0; i < route.path.length - 1; i++) {
    const from = route.path[i];
    const to = route.path[i + 1];
    if (!from || !to) continue;
    const connection = connections.find((c) => (c.from === from && c.to === to) || (c.from === to && c.to === from));
    if (connection) {
      const lineMaterial = connection.line.material as THREE.LineDashedMaterial;
      lineMaterial.opacity = 0.8; // Bright highlight
      lineMaterial.color.setHex(0x00ff88); // Green for selected route
    }
  }
}
function clearRouteHighlight() {
  const themeColors = getGraphThemeColors(settings.theme);
  const connectionColor = parseInt(themeColors.connectionColor.replace("#", "0x"));
  connections.forEach((connection) => {
    const lineMaterial = connection.line.material as THREE.LineDashedMaterial;
    lineMaterial.opacity = 0.3; // Default opacity
    lineMaterial.color.setHex(connectionColor); // Theme color
  });
}
function updateAvailableTokens() {
  availableTokens = collectGraphTokenIds(getTimeAwareReplicas());
  if (!availableTokens.includes(selectedTokenId) && $runtimeFrameTimeIndex === -1) {
    selectedTokenId = availableTokens.includes(1) ? 1 : availableTokens[0]!;
    saveBirdViewSettings();
  }
}
let lastLabelUpdateTimeIndex = -999; // Track for label updates on frame change
function getEntitySizeForToken(entityId: string, tokenId: number): number {
  return getGraphEntitySizeForToken({
    replicas: getTimeAwareReplicas(),
    entityId,
    tokenId,
    tokenDecimals: getTokenDecimals(tokenId),
    sizeMultiplier: entitySizeMultiplier,
  });
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
    replicas: getTimeAwareReplicas(),
    from,
    to,
    getEntityShortName,
  });
  selectedRouteIndex = 0;
}
function updateRipples() {
  const now = Date.now();
  activeRipples = activeRipples.filter((ripple) => {
    const elapsed = now - ripple.startTime;
    const progress = Math.min(elapsed / ripple.duration, 1);
    if (progress >= 1) {
      graphWorld.remove(ripple.mesh);
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
function getEntityBalanceInfo(entityId: string): string {
  return formatGraphEntityBalanceInfo({
    entityId,
    replicas: getTimeAwareReplicas(),
    selectedTokenId,
    getTokenSymbol,
    getTokenDecimals,
  });
}
function getEntityShortName(entityId: string): string {
  return formatGraphEntityShortNameFromReplicas({
    entityId,
    replicas: getTimeAwareReplicas(),
    getEntityShortId: (value) => XLN?.getEntityShortId?.(value),
  });
}
function getDualConnectionAccountInfo(entityA: string, entityB: string): { left: string; right: string; leftEntity: string; rightEntity: string } {
  return formatGraphDualConnectionAccountInfoFromReplicas({
    entityA,
    entityB,
    replicas: getTimeAwareReplicas(),
    selectedTokenId,
    getAccountTokenDelta,
    deriveEntry: (tokenDelta, isLeft) => deriveGraphEntry(XLN, tokenDelta, isLeft),
    getEntityShortName,
    getTokenDecimals,
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
  barsMode = barsMode === "close" ? "spread" : "close";
  saveBirdViewSettings();
}
function handleVrPaymentClick(): void {
  if (entities.length < 2) return;
  const from = entities[Math.floor(Math.random() * entities.length)];
  const to = entities[Math.floor(Math.random() * entities.length)];
  if (from && to && from.id !== to.id) {
    panelBridge.emit("vr:payment", { from: from.id, to: to.id });
  }
}
function handleVrAutoRotateClick(): void {
  autoRotate = !autoRotate;
  panelBridge.emit("settings:update", { key: "autoRotate", value: autoRotate });
}
</script>
<Graph3DViewport
  bind:container
  {showMiniPanel} {miniPanelEntityId} {miniPanelEntityName} {miniPanelPosition} {runtimeFrameEnv} {runtimeFrameHistory} {runtimeFrameTimeIndex} {showFpsOverlay}
  {renderFps} {frameTime}
  entityCount={entities.length} connectionCount={connections.length} particleCount={particles.length}
  {barsMode} {isVRActive} {tooltip} {dualTooltip}
  runtimeScope={$runtimeGraphScope} runtimeScopeOptions={graphSceneInput.runtimeOptions} canonicity={$runtimeGraphCanonicity} sourceCount={mergedRuntimeGraph.sources.length}
  desyncCount={graphSceneInput.desyncCount} projectionError={graphProjectionError} runtimeNodeLabels={mergedRuntimeGraph.nodes.map((node) => node.selected.label)} timelineRuntimeId={$networkMachineRuntime.selectedStep?.activeRuntimeId ?? ''}
  timelineRuntimeColor={$networkMachineRuntime.selectedStep?.activeRuntimeColor ?? ''} timelineHeight={$networkMachineRuntime.selectedStep?.event.height ?? 0} timelineTimestamp={$networkMachineRuntime.selectedStep?.event.timestamp ?? 0}
  onRuntimeScopeChange={(scope) => { void selectGraphRuntimeScope(scope).catch(reportGraphInitError); }}
  onCanonicityChange={selectGraphCanonicity}
  {closeMiniPanel} {handleMiniPanelAction} {handleOpenFullPanel} {toggleBarsMode} {handleVrPaymentClick} {handleVrAutoRotateClick} {exitVR}
/>
