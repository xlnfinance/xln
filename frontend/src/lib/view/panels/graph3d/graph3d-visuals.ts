import * as THREE from 'three';
import type { AccountAnnotationContext } from '#lib/network3d/timeline/accountAnnotation.ts';
import type { Delta } from '@xln/core/api/public/runtime-module';
import { createAccountBars } from '#lib/network3d/AccountBarRenderer.ts';
import { toDerivedAccountData, type DerivedAccountData } from '#lib/network3d/derivedAccount.ts';
import { getGraphThemeColors } from './graph3d-renderer';
import type { GraphConnectionData, GraphEntityData, GraphEntityProfile, GraphXLNRuntime } from './graph3d-types';
import { formatGraphMempoolTxLabel, type GraphAccountViewLike, type GraphReplicaLike } from './graph3d-helpers';

function createTxLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_TX_LABEL_CONTEXT_UNAVAILABLE');
  canvas.width = 256;
  canvas.height = 48;
  context.fillStyle = 'rgba(0, 0, 0, 0.8)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 14px monospace';
  context.textBaseline = 'middle';
  const hasWithdrawals = text.includes('-') && text.includes('W');
  const hasDeposits = text.includes('+') && text.includes('D');
  if (hasWithdrawals && hasDeposits) {
    context.textAlign = 'left';
    let x = 10;
    for (const part of text.split(/(\-\d+W|\+\d+D)/g).filter(Boolean)) {
      context.fillStyle = part.match(/\-\d+W/) ? '#ff4444' : part.match(/\+\d+D/) ? '#00ff88' : '#ffcc00';
      context.fillText(part, x, 24);
      x += context.measureText(part).width;
    }
  } else {
    context.textAlign = 'center';
    context.fillStyle = hasDeposits ? '#00ff88' : hasWithdrawals ? '#ff4444' : '#ffcc00';
    context.fillText(text, 128, 24);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3, 0.75, 1);
  return sprite;
}

export function createMempoolTxCube(
  index: number,
  getTokenDecimals: (tokenId: number) => number,
  tx?: unknown,
  blockHeight?: number,
): THREE.Group {
  const group = new THREE.Group();
  const cubeSize = 1.5;
  group.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize),
      new THREE.MeshLambertMaterial({
        color: 0xffcc00,
        transparent: true,
        opacity: 0.95,
        emissive: 0xffaa00,
        emissiveIntensity: 0.8,
      }),
    ),
  );
  const gridSize = 3;
  const spacing = 2.5;
  const halfGrid = ((gridSize - 1) * spacing) / 2;
  group.position.set(
    -halfGrid + (index % gridSize) * spacing,
    -4 + Math.floor(index / (gridSize * gridSize)) * spacing,
    -halfGrid + (Math.floor(index / gridSize) % gridSize) * spacing,
  );
  if (tx) {
    const label = createTxLabelSprite(formatGraphMempoolTxLabel(tx, getTokenDecimals, blockHeight));
    label.position.set(0, -(cubeSize + 0.3), 0);
    group.add(label);
  }
  return group;
}

export function getAccountTokenDelta(
  account: { state: { deltas: Map<number, Delta> } } | null | undefined,
  tokenId: number,
): Delta | null {
  return account?.state.deltas.get(tokenId) ?? null;
}

export function deriveGraphEntry(
  runtime: GraphXLNRuntime | null | undefined,
  tokenDelta: unknown,
  isLeft: boolean,
): DerivedAccountData {
  if (!runtime?.deriveDelta) throw new Error('FINTECH-SAFETY: xlnFunctions.deriveDelta not available');
  if (!tokenDelta) throw new Error('FINTECH-SAFETY: Cannot derive from null token delta');
  return toDerivedAccountData(runtime.deriveDelta(tokenDelta as never, isLeft));
}

function createMempoolBox(
  borderColor: number,
  mempoolTxs: unknown[],
  pendingTxs: unknown[],
  direction: THREE.Vector3,
): THREE.Group {
  const group = new THREE.Group();
  const width = 1.6;
  const height = 0.8;
  const depth = 0.4;
  const geometry = new THREE.BoxGeometry(width, height, depth);
  group.add(
    new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({
        color: borderColor,
        emissive: new THREE.Color(borderColor).multiplyScalar(0.3),
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
        shininess: 60,
        depthWrite: false,
      }),
    ),
  );
  group.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: borderColor, linewidth: 1, transparent: true, opacity: 0.6 }),
    ),
  );
  const addTransactions = (transactions: unknown[], color: number, opacity: number, z: number) => {
    transactions.slice(0, 2).forEach((_, index) => {
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.18, 0.18),
        new THREE.MeshLambertMaterial({
          color,
          transparent: true,
          opacity,
          emissive: color === 0x888888 ? 0x444444 : 0x0088cc,
          emissiveIntensity: color === 0x888888 ? 0.3 : 0.7,
        }),
      );
      cube.position.set(index === 0 ? -0.175 : 0.175, 0, z);
      group.add(cube);
    });
  };
  addTransactions(mempoolTxs, 0x888888, 0.7, -depth / 3);
  addTransactions(pendingTxs, 0x00ccff, 0.95, depth / 6);
  const quaternion = new THREE.Quaternion();
  quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
  group.quaternion.copy(quaternion);
  return group;
}

/**
 * One box per OBSERVED account side. The merged graph projection materializes only the
 * policy-selected observation (see runtimeGraphRender), so an absent side means "not
 * observed" — never "not committed". Rendering a red box for it would fake a desync.
 */
export function createAccountMempoolBoxes(options: {
  fromEntity: GraphEntityData;
  toEntity: GraphEntityData;
  leftAccount: GraphAccountViewLike | null | undefined;
  rightAccount: GraphAccountViewLike | null | undefined;
  runtime: GraphXLNRuntime | null | undefined;
  getEntitySize(entityId: string, tokenId: number): number;
}): THREE.Group[] {
  const direction = new THREE.Vector3().subVectors(options.toEntity.position, options.fromEntity.position).normalize();
  const barRadiusAndGap = 0.4;
  const halfBoxDepth = 0.2;
  const sides = [
    { account: options.leftAccount, isLeft: true, anchor: options.fromEntity, sign: 1 },
    { account: options.rightAccount, isLeft: false, anchor: options.toEntity, sign: -1 },
  ];
  return sides.flatMap(({ account, isLeft, anchor, sign }) => {
    if (!account) return [];
    const state = options.runtime?.classifyBilateralState?.(account, 0, isLeft);
    const box = createMempoolBox(
      state && state.state !== 'committed' ? 0xff4444 : 0x00ff88,
      account.mempool || [],
      account.pendingFrame?.accountTxs || [],
      direction,
    );
    const offset = sign * (options.getEntitySize(anchor.id, 1) + barRadiusAndGap - halfBoxDepth);
    box.position.copy(anchor.position).add(direction.clone().multiplyScalar(offset));
    return [box];
  });
}

/** Above the sphere by default; below it when the bank's account lines rise toward a hub. */
export function positionEntityLabel(label: THREE.Sprite, entitySize: number, below = false): void {
  const worldHeight = Number(label.userData['worldHeight']);
  if (!Number.isFinite(entitySize) || entitySize <= 0) throw new Error(`GRAPH_ENTITY_SIZE_INVALID:${entitySize}`);
  if (!Number.isFinite(worldHeight) || worldHeight <= 0) throw new Error(`GRAPH_LABEL_HEIGHT_INVALID:${worldHeight}`);
  label.scale.set((worldHeight * 4) / entitySize, worldHeight / entitySize, 1);
  label.position.set(0, ((below ? -1 : 1) * (entitySize + worldHeight / 2 + 1)) / entitySize, 0);
}

/** Presentation detail under a bank's name: its reserve, and how it just changed. */
export type EntityLabelDetail = { text: string; change?: { text: string; positive: boolean } };

export type EntityLabelContent = {
  flag: string;
  labelText: string;
  key: string;
  detail?: EntityLabelDetail;
  /** Out of the narration's focus: drawn in readable grey instead of being faded out. */
  dimmed?: boolean;
};

const LABEL_FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";

/** Two lines for a presentation: the name, then "reserve 2.0M" with a coloured change chip. */
function drawPresentationLabel(context: CanvasRenderingContext2D, content: EntityLabelContent & { detail: EntityLabelDetail }): void {
  const fit = (text: string, maxSize: number, weight: number): void => {
    context.font = `${weight} ${maxSize}px ${LABEL_FONT}`;
    const width = context.measureText(text).width;
    if (width > 492) context.font = `${weight} ${Math.floor((maxSize * 492) / width)}px ${LABEL_FONT}`;
  };
  fit(content.labelText, 58, 800);
  context.strokeText(content.labelText, 256, 40);
  context.fillStyle = content.dimmed ? '#93a3b6' : '#00ff88';
  context.fillText(content.labelText, 256, 40);
  const change = content.detail.change;
  const line = change ? `${content.detail.text}  ${change.text}` : content.detail.text;
  fit(line, 40, 700);
  const detailWidth = context.measureText(content.detail.text).width;
  const lineWidth = context.measureText(line).width;
  const start = 256 - lineWidth / 2;
  context.textAlign = 'left';
  context.strokeText(content.detail.text, start, 100);
  context.fillStyle = content.dimmed ? '#7f8fa3' : '#e3f6ee';
  context.fillText(content.detail.text, start, 100);
  if (change) {
    const changeStart = start + detailWidth + context.measureText('  ').width;
    context.strokeText(change.text, changeStart, 100);
    context.fillStyle = change.positive ? '#4ade80' : '#ff7a8a';
    context.fillText(change.text, changeStart, 100);
  }
  context.textAlign = 'center';
}

export function createEntityLabel(
  content: EntityLabelContent,
  labelScale: number,
  isVrActive: boolean,
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_ENTITY_LABEL_CONTEXT_UNAVAILABLE');
  canvas.width = 512;
  canvas.height = 128;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.strokeStyle = '#000000';
  context.lineWidth = 5;
  // Long names shrink to the canvas instead of being clipped at its edges.
  const fitFont = (maxSize: number): string => {
    context.font = `bold ${maxSize}px sans-serif`;
    const width = context.measureText(content.labelText).width;
    const size = width > 492 ? Math.floor((maxSize * 492) / width) : maxSize;
    return `bold ${size}px sans-serif`;
  };
  if (content.detail) {
    drawPresentationLabel(context, { ...content, detail: content.detail });
  } else if (content.flag) {
    context.font = '56px sans-serif';
    context.fillStyle = '#ffffff';
    context.fillText(content.flag, 256, 32);
    context.font = fitFont(32);
    context.strokeText(content.labelText, 256, 90);
    context.fillStyle = '#FFD700';
    context.fillText(content.labelText, 256, 90);
  } else {
    context.font = fitFont(64);
    context.strokeText(content.labelText, 256, 64);
    context.fillStyle = content.dimmed ? '#93a3b6' : '#00ff88';
    context.fillText(content.labelText, 256, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: true }),
  );
  sprite.userData['worldHeight'] = 2.2 * labelScale * (isVrActive ? 3 : 1);
  sprite.userData['contentKey'] = content.key;
  // Focus dimming greys this label out by redrawing it; it must not also fade it.
  sprite.userData['focusKeepsOpacity'] = true;
  return sprite;
}

export function createMempoolIndicator(entityId: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_MEMPOOL_INDICATOR_CONTEXT_UNAVAILABLE');
  canvas.width = 128;
  canvas.height = 64;
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: true }),
  );
  sprite.scale.set(1, 0.5, 1);
  sprite.userData['entityId'] = entityId;
  sprite.userData['canvas'] = canvas;
  sprite.userData['context'] = context;
  return sprite;
}

export function positionMempoolIndicator(indicator: THREE.Sprite, entitySize: number): void {
  if (!Number.isFinite(entitySize) || entitySize <= 0) throw new Error(`GRAPH_ENTITY_SIZE_INVALID:${entitySize}`);
  indicator.scale.set(2.4 / entitySize, 1.2 / entitySize, 1);
  indicator.position.set((entitySize + 1.7) / entitySize, 0, 0);
}

export function graphAccountMempoolCount(account: GraphAccountViewLike | null | undefined): number {
  const projectedCount = Number(account?.mempoolCount);
  if (Number.isSafeInteger(projectedCount) && projectedCount >= 0) return projectedCount;
  return Array.isArray(account?.mempool) ? account.mempool.length : 0;
}

export function createGraphRippleMesh(position: THREE.Vector3): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.1, 0.2, 32),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
  );
  mesh.position.copy(position);
  mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  return mesh;
}

type GraphConnectionOptions = {
  graphWorld: THREE.Group;
  fromEntity: GraphEntityData;
  toEntity: GraphEntityData;
  fromId: string;
  toId: string;
  replicas: Map<string, GraphReplicaLike>;
  runtime: GraphXLNRuntime | null | undefined;
  theme: string;
  barsMode: 'close' | 'spread';
  portfolioScale: number;
  barRadiusScale: number;
  /** Presentation bar scale per token; null keeps the renderer's fixed token-value scale. */
  capacityScale?: ReadonlyMap<number, number> | null;
  /** Presentation: annotate each account with its collateral and unsecured debt. */
  annotation?: AccountAnnotationContext | null;
  getEntitySize(entityId: string, tokenId: number): number;
};

export function buildGraphConnection(options: GraphConnectionOptions): GraphConnectionData {
  const geometry = new THREE.BufferGeometry().setFromPoints([options.fromEntity.position, options.toEntity.position]);
  const findReplica = (entityId: string) => {
    const key = [...options.replicas.keys()].find(candidate => candidate.startsWith(`${entityId}:`));
    return key ? options.replicas.get(key) : null;
  };
  const fromReplica = findReplica(options.fromId);
  const toReplica = findReplica(options.toId);
  const isFedConnection = fromReplica?.signerId?.includes('_fed') || toReplica?.signerId?.includes('_fed');
  const themeColors = getGraphThemeColors(options.theme);
  const material = new THREE.LineDashedMaterial({
    color: isFedConnection ? 0xffd700 : Number.parseInt(themeColors.connectionColor.replace('#', '0x')),
    opacity: isFedConnection ? 0.8 : 0.5,
    transparent: true,
    linewidth: isFedConnection ? 4 : 2,
    dashSize: isFedConnection ? 1 : 0.3,
    gapSize: isFedConnection ? 0.5 : 0.3,
  });
  const line = new THREE.Line(geometry, material);
  line.computeLineDistances();
  options.graphWorld.add(line);
  const { bars, mempoolBoxes } = buildGraphAccountVisuals(options);
  return { from: options.fromId, to: options.toId, line, progressBars: bars, mempoolBoxes };
}

export function buildGraphAccountVisuals(options: GraphConnectionOptions): {
  bars: THREE.Group;
  mempoolBoxes: THREE.Group[];
} {
  const findReplica = (entityId: string) => {
    const key = [...options.replicas.keys()].find(candidate => candidate.startsWith(`${entityId}:`));
    return key ? options.replicas.get(key) : null;
  };
  const fromIsLeft = options.fromId < options.toId;
  const leftId = fromIsLeft ? options.fromId : options.toId;
  const rightId = fromIsLeft ? options.toId : options.fromId;
  const leftAccount = findReplica(leftId)?.state?.accounts?.get(rightId);
  const rightAccount = findReplica(rightId)?.state?.accounts?.get(leftId);
  const leftHeight = Number(leftAccount?.currentFrame?.height ?? 0);
  const rightHeight = Number(rightAccount?.currentFrame?.height ?? 0);
  let account = leftAccount ?? rightAccount;
  let confirmedAccount = account;
  let pendingAccount = null;
  if (leftAccount && rightAccount && leftHeight !== rightHeight) {
    account = leftHeight > rightHeight ? leftAccount : rightAccount;
    confirmedAccount = leftHeight > rightHeight ? rightAccount : leftAccount;
    pendingAccount = account;
  }
  if (!account?.state.deltas || account.state.deltas.size === 0) {
    const bars = new THREE.Group();
    options.graphWorld.add(bars);
    return { bars, mempoolBoxes: [] };
  }

  const leftEntityAccount = fromIsLeft ? confirmedAccount : pendingAccount;
  const rightEntityAccount = fromIsLeft ? pendingAccount : confirmedAccount;
  const leftConsensus = options.runtime?.classifyBilateralState?.(
    leftEntityAccount ?? undefined,
    Number(rightEntityAccount?.currentFrame?.height ?? 0),
    true,
  );
  const rightConsensus = options.runtime?.classifyBilateralState?.(
    rightEntityAccount ?? undefined,
    Number(leftEntityAccount?.currentFrame?.height ?? 0),
    false,
  );
  const barVisual =
    leftConsensus && rightConsensus ? options.runtime?.getAccountBarVisual?.(leftConsensus, rightConsensus) : null;
  // Unknown consensus (no runtime helper) is not evidence of desync.
  const desyncDetected = Boolean(
    leftConsensus && rightConsensus && (leftConsensus.state !== 'committed' || rightConsensus.state !== 'committed'),
  );
  const dispute = account.activeDispute;
  const bars = createAccountBars(
    options.graphWorld,
    options.fromEntity,
    options.toEntity,
    account.state.deltas,
    fromIsLeft,
    {
      barsMode: options.barsMode,
      portfolioScale: options.portfolioScale,
      barRadiusScale: options.barRadiusScale,
      capacityScale: options.capacityScale ?? null,
      annotation: options.annotation ?? null,
      desyncDetected,
      bilateralState: barVisual,
      dispute: dispute
        ? {
            startedByLeft: dispute.startedByLeft,
            disputeTimeout: dispute.disputeTimeout,
            initialNonce: dispute.initialNonce,
          }
        : null,
    },
    options.getEntitySize,
    options.runtime,
  );
  const mempoolBoxes = createAccountMempoolBoxes({
    fromEntity: options.fromEntity,
    toEntity: options.toEntity,
    leftAccount,
    rightAccount,
    runtime: options.runtime,
    getEntitySize: options.getEntitySize,
  });
  for (const box of mempoolBoxes) options.graphWorld.add(box);
  return { bars, mempoolBoxes };
}

export function createGraphEntityNode(options: {
  profile: GraphEntityProfile;
  index: number;
  total: number;
  forceLayoutPosition: THREE.Vector3 | undefined;
  forceLayoutEnabled: boolean;
  isHub: boolean;
  replica: GraphReplicaLike | null | undefined;
  userPosition: { x: number; y: number; z: number } | undefined;
  persistedPosition: { x: number; y: number; z: number; jurisdiction: string } | undefined;
  defaultJurisdiction: string;
  resolveJMachinePosition(jurisdiction: string): { x: number; y: number; z: number } | null;
  selectedTokenId: number;
  getEntitySize(entityId: string, tokenId: number): number;
  labelContent: { flag: string; labelText: string; key: string };
  labelScale: number;
  isVrActive: boolean;
}): GraphEntityData {
  const position = (() => {
    if (options.userPosition) return options.userPosition;
    if (options.persistedPosition) {
      const jurisdiction = options.resolveJMachinePosition(options.persistedPosition.jurisdiction);
      return jurisdiction
        ? {
            x: jurisdiction.x + options.persistedPosition.x,
            y: jurisdiction.y + options.persistedPosition.y,
            z: jurisdiction.z + options.persistedPosition.z,
          }
        : options.persistedPosition;
    }
    if (options.replica?.position) {
      const jurisdictionName =
        options.replica.position.jurisdiction ||
        options.defaultJurisdiction ||
        'default';
      const jurisdiction = options.resolveJMachinePosition(jurisdictionName);
      return jurisdiction
        ? {
            x: jurisdiction.x + options.replica.position.x,
            y: jurisdiction.y + options.replica.position.y,
            z: jurisdiction.z + options.replica.position.z,
          }
        : options.replica.position;
    }
    if (options.profile.metadata?.position) return options.profile.metadata.position;
    if (options.forceLayoutPosition && options.forceLayoutEnabled) return options.forceLayoutPosition;
    const angle = (options.index / options.total) * Math.PI * 2;
    return { x: Math.cos(angle) * 30, y: Math.sin(angle) * 30, z: 0 };
  })();
  const isFed = options.replica?.signerId?.includes('_fed') || false;
  const material = new THREE.MeshLambertMaterial({
    color: isFed ? 0x8b7fb8 : 0x0077cc,
    emissive: isFed ? 0x9a8ac4 : 0x003366,
    emissiveIntensity: isFed ? 2 : options.isHub ? 1.5 : 0.3,
    transparent: true,
    opacity: isFed ? 1 : 0.9,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 32), material);
  mesh.position.set(position.x, position.y, position.z);
  const entitySize = options.getEntitySize(options.profile.entityId, options.selectedTokenId);
  mesh.scale.setScalar(entitySize);
  if (isFed) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x8b7fb8, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
    );
    ring.rotation.x = Math.PI / 2;
    mesh.add(ring);
  }
  mesh.userData['isHub'] = options.isHub;
  mesh.userData['isFed'] = isFed;
  mesh.userData['baseMaterial'] = material;
  const label = createEntityLabel(options.labelContent, options.labelScale, options.isVrActive);
  positionEntityLabel(label, entitySize);
  mesh.add(label);
  return {
    id: options.profile.entityId,
    position: new THREE.Vector3(position.x, position.y, position.z),
    mesh,
    label,
    profile: options.profile,
    isHub: options.isHub,
    lastActivity: 0,
  };
}

export function createGraphGrid(
  color: THREE.ColorRepresentation,
  opacity: number,
  size: number,
  divisions: number,
): THREE.GridHelper {
  const grid = new THREE.GridHelper(size, Math.max(1, Math.floor(divisions)), color, color);
  grid.material.opacity = opacity;
  grid.material.transparent = true;
  grid.position.set(0, -50, 0);
  return grid;
}

/**
 * The jurisdiction's name, whole: it is the one label naming the settlement layer, so it
 * shrinks to fit instead of being cut. The block height shows only when it is known.
 */
/** Below the box (dock), or to its right (presentation: packets arrive from below). */
export type JMachineLabelPlacement = 'below' | 'right';

export function createJMachineLabelTexture(
  name: string,
  jHeight: number,
  placement: JMachineLabelPlacement = 'below',
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_J_MACHINE_LABEL_CONTEXT_UNAVAILABLE');
  canvas.width = 512;
  canvas.height = 128;
  const text = jHeight > 0 ? `${name} #${jHeight}` : name;
  const family = '"Inter", "Helvetica Neue", Arial, sans-serif';
  context.font = `600 52px ${family}`;
  const width = context.measureText(text).width;
  context.font = `600 ${width > 492 ? Math.floor((52 * 492) / width) : 52}px ${family}`;
  context.fillStyle = '#9fd8ff';
  context.textAlign = placement === 'right' ? 'left' : 'center';
  context.textBaseline = 'middle';
  context.fillText(text, placement === 'right' ? 10 : 256, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

export function createGraphJMachine(
  size = 25,
  position = { x: 0, y: 200, z: 0 },
  name = 'J-MACHINE',
  jHeight = 0,
  labelPlacement: JMachineLabelPlacement = 'below',
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(position.x, position.y, position.z);
  group.userData = { type: 'jMachine', jurisdictionName: name, position, labelPlacement };
  const geometry = new THREE.BoxGeometry(size, size, size);
  group.add(
    new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({
        color: 0x4488aa,
        emissive: 0x224455,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
        shininess: 100,
        depthWrite: false,
      }),
    ),
  );
  group.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x66ccff, linewidth: 2 }),
    ),
  );
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: createJMachineLabelTexture(name, jHeight, labelPlacement), transparent: true }));
  label.scale.set(size * 2, size * 0.5, 1);
  if (labelPlacement === 'right') {
    // Larger, left-aligned text, sprite centred half its width past the box's right face.
    // "Right" is the viewer's right, so keepJMachineLabelBeside re-aims it as the camera moves.
    label.scale.set(size * 3, size * 0.75, 1);
    group.userData['labelOffset'] = size * 0.7 + size * 1.5;
    label.position.set(size * 0.7 + size * 1.5, 0, 0);
  } else {
    label.position.set(0, -size / 2 - size * 0.66, 0);
  }
  group.add(label);
  return group;
}

/** Keeps a side-placed J-machine label to the viewer's right, whatever the camera angle. */
export function keepJMachineLabelBeside(group: THREE.Group, camera: THREE.Camera): void {
  if (group.userData['labelPlacement'] !== 'right') return;
  const label = group.children.find((child) => child instanceof THREE.Sprite);
  if (!label) return;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  right.applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()).invert());
  label.position.copy(right.multiplyScalar(Number(group.userData['labelOffset'])));
}

export function buildSimpleRadialLayout(
  profiles: GraphEntityProfile[],
  connectionMap: Map<string, Set<string>>,
  compareIds: (left: string, right: string) => number,
): Map<string, THREE.Vector3> {
  const positions = new Map<string, THREE.Vector3>();
  const connectionCounts = new Map(
    profiles.map(profile => [profile.entityId, connectionMap.get(profile.entityId)?.size || 0]),
  );
  const sorted = [...profiles].sort((left, right) => {
    const countDifference = (connectionCounts.get(right.entityId) || 0) - (connectionCounts.get(left.entityId) || 0);
    return countDifference || compareIds(left.entityId, right.entityId);
  });
  const angleStep = (Math.PI * 2) / profiles.length;
  sorted.forEach((profile, index) => {
    const degree = connectionCounts.get(profile.entityId) || 0;
    const radius = degree > 0 ? Math.max(5, 50 / (degree + 1)) : 50;
    positions.set(
      profile.entityId,
      new THREE.Vector3(Math.cos(index * angleStep) * radius, Math.sin(index * angleStep) * radius, 0),
    );
  });
  return positions;
}
