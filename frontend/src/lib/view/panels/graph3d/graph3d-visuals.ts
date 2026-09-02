import * as THREE from 'three';
import type { Delta } from '@xln/core/api/public/runtime-module';
import { createAccountBars } from '$lib/network3d/AccountBarRenderer';
import { toDerivedAccountData, type DerivedAccountData } from '$lib/network3d/derivedAccount';
import { getGraphThemeColors } from '../../../../../packages/ui/src/graph3d-renderer';
import { createAccountMempoolBoxes } from '../../../../../packages/ui/src/graph3d-account-visuals';
import type { GraphConnectionData, GraphEntityData, GraphXLNRuntime } from './graph3d-types';
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

export function graphAccountMempoolCount(account: GraphAccountViewLike | null | undefined): number {
  const projectedCount = Number(account?.mempoolCount);
  if (Number.isSafeInteger(projectedCount) && projectedCount >= 0) return projectedCount;
  return Array.isArray(account?.mempool) ? account.mempool.length : 0;
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
    leftState: leftAccount
      ? options.runtime?.classifyBilateralState?.(leftAccount, 0, true)?.state ?? null
      : null,
    rightState: rightAccount
      ? options.runtime?.classifyBilateralState?.(rightAccount, 0, false)?.state ?? null
      : null,
    getEntitySize: options.getEntitySize,
  });
  for (const box of mempoolBoxes) options.graphWorld.add(box);
  return { bars, mempoolBoxes };
}
