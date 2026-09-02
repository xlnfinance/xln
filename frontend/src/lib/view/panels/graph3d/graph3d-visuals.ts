import * as THREE from 'three';
import type { Delta } from '@xln/core/api/public/runtime-module';
import { createAccountBars } from '$lib/network3d/AccountBarRenderer';
import { toDerivedAccountData, type DerivedAccountData } from '$lib/network3d/derivedAccount';
import { getGraphThemeColors } from '../../../../../packages/ui/src/graph3d-renderer';
import type { GraphConnectionData, GraphEntityData, GraphEntityProfile, GraphTransactionLike, GraphXLNRuntime } from './graph3d-types';
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

export function createBlockContainer(options: {
  blockNum: bigint;
  txs: unknown[];
  jMachinePosition: THREE.Vector3;
  yOffset: number;
  getTokenDecimals(tokenId: number): number;
}): { container: THREE.Group; txCubes: THREE.Object3D[] } {
  const container = new THREE.Group();
  container.userData['blockNumber'] = options.blockNum;
  container.position.copy(options.jMachinePosition);
  container.position.y += options.yOffset;
  const geometry = new THREE.BoxGeometry(12, 12, 12);
  container.add(
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
  container.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x66ccff, linewidth: 2 }),
    ),
  );
  const txCubes = options.txs.slice(0, 9).map((tx, index) => {
    const cube = createMempoolTxCube(index, options.getTokenDecimals, tx, Number(options.blockNum));
    container.add(cube);
    return cube;
  });
  return { container, txCubes };
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

export function positionEntityLabel(label: THREE.Sprite, entitySize: number): void {
  const worldHeight = Number(label.userData['worldHeight']);
  if (!Number.isFinite(entitySize) || entitySize <= 0) throw new Error(`GRAPH_ENTITY_SIZE_INVALID:${entitySize}`);
  if (!Number.isFinite(worldHeight) || worldHeight <= 0) throw new Error(`GRAPH_LABEL_HEIGHT_INVALID:${worldHeight}`);
  label.scale.set((worldHeight * 4) / entitySize, worldHeight / entitySize, 1);
  label.position.set(0, (entitySize + worldHeight / 2 + 1) / entitySize, 0);
}

export function createEntityLabel(
  content: { flag: string; labelText: string; key: string },
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
  if (content.flag) {
    context.font = '56px sans-serif';
    context.fillStyle = '#ffffff';
    context.fillText(content.flag, 256, 32);
    context.font = 'bold 32px sans-serif';
    context.strokeText(content.labelText, 256, 90);
    context.fillStyle = '#FFD700';
    context.fillText(content.labelText, 256, 90);
  } else {
    context.font = 'bold 64px sans-serif';
    context.strokeText(content.labelText, 256, 64);
    context.fillStyle = '#00ff88';
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

export function createDirectionalLightningMesh(connection: GraphConnectionData, accountTx: GraphTransactionLike | null | undefined): THREE.Mesh {
  const positions = connection.line.geometry.getAttribute('position');
  const start = new THREE.Vector3().fromBufferAttribute(positions, 0);
  const end = new THREE.Vector3().fromBufferAttribute(positions, 1);
  const amountUsd = accountTx?.data?.amount ? Number(accountTx.data.amount) / 1e18 : 0;
  const radius = amountUsd > 0 ? Math.max(0.05, Math.min(Math.log10(amountUsd) * 0.08, 0.8)) : 0.08;
  const color =
    amountUsd <= 0
      ? 0x00ccff
      : amountUsd < 1_000
        ? 0x0088ff
        : amountUsd < 100_000
          ? 0x00ccff
          : amountUsd < 1_000_000
            ? 0x00ff88
            : amountUsd < 10_000_000
              ? 0xffff00
              : 0xff4444;
  const bolt = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, start.distanceTo(end), 16),
    new THREE.MeshLambertMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      emissive: color,
      emissiveIntensity: 2,
    }),
  );
  bolt.position.copy(start.clone().lerp(end, 0.5));
  bolt.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3().subVectors(end, start).normalize(),
  );
  return bolt;
}

export function createBroadcastRippleMesh(position: THREE.Vector3, txType: string): THREE.Mesh {
  const colors: Record<string, number> = {
    r2c: 0x00ff88,
    reserve_to_collateral: 0x00ff88,
    deposit_reserve: 0x00ff00,
    withdraw_reserve: 0xff0000,
    credit_from_reserve: 0xffaa00,
    debit_to_reserve: 0xff44ff,
  };
  const ripple = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.05, 16, 32),
    new THREE.MeshBasicMaterial({
      color: colors[txType] ?? 0x00ffff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    }),
  );
  ripple.position.copy(position);
  ripple.rotation.x = Math.PI / 2;
  return ripple;
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

export function createGraphJMachine(
  size = 25,
  position = { x: 0, y: 200, z: 0 },
  name = 'J-MACHINE',
  jHeight = 0,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(position.x, position.y, position.z);
  group.userData = { type: 'jMachine', jurisdictionName: name, position };
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
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('GRAPH_J_MACHINE_LABEL_CONTEXT_UNAVAILABLE');
  canvas.width = 256;
  canvas.height = 64;
  context.fillStyle = '#66ccff';
  context.font = 'bold 28px monospace';
  context.textAlign = 'center';
  context.fillText(`${(name.split(' ')[0] || 'J').substring(0, 8)} (#${jHeight})`, 128, 40);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
  label.scale.set(25, 6, 1);
  label.position.set(0, -size / 2 - 8, 0);
  group.add(label);
  return group;
}

export function startProportionalBroadcast(options: {
  graphWorld: THREE.Group;
  position: THREE.Vector3;
  transactionCount: number;
  onComplete(sphere: THREE.Mesh): void;
}): { sphere: THREE.Mesh; animationId: number } | null {
  if (options.transactionCount === 0) return null;
  const intensity = Math.min(options.transactionCount / 5, 1);
  const maxScale = 30 + intensity * 70;
  const duration = 800 + intensity * 700;
  const geometry = new THREE.SphereGeometry(1, 32, 32);
  const material = new THREE.MeshBasicMaterial({
    color: 0x44ffaa,
    transparent: true,
    opacity: 0.3 + intensity * 0.3,
    side: THREE.DoubleSide,
  });
  const sphere = new THREE.Mesh(geometry, material);
  sphere.position.copy(options.position);
  options.graphWorld.add(sphere);
  const startTime = performance.now();
  let animationId = 0;
  const animate = () => {
    const progress = Math.min((performance.now() - startTime) / duration, 1);
    const scale = 1 + (1 - Math.pow(1 - progress, 2)) * maxScale;
    sphere.scale.set(scale, scale, scale);
    material.opacity = (0.3 + intensity * 0.3) * (1 - progress);
    if (progress < 1) {
      animationId = requestAnimationFrame(animate);
      return;
    }
    options.graphWorld.remove(sphere);
    geometry.dispose();
    material.dispose();
    options.onComplete(sphere);
  };
  animationId = requestAnimationFrame(animate);
  return { sphere, animationId };
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
