import * as THREE from 'three';

type GraphAccountEndpoint = Readonly<{
  id: string;
  position: THREE.Vector3;
}>;

type GraphAccountMempoolView = Readonly<{
  mempool?: readonly unknown[];
  pendingFrame?: Readonly<{ accountTxs?: readonly unknown[] }>;
}>;

const MEMPOOL_BOX_DEPTH = 0.4;

const createMempoolTransactionCube = (color: number, opacity: number, z: number, index: number): THREE.Mesh => {
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
  return cube;
};

const addMempoolTransactions = (
  group: THREE.Group,
  transactions: readonly unknown[],
  color: number,
  opacity: number,
  z: number,
): void => {
  transactions.slice(0, 2).forEach((_, index) => {
    group.add(createMempoolTransactionCube(color, opacity, z, index));
  });
};

const createMempoolBoxFrame = (borderColor: number): THREE.Group => {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1.6, 0.8, MEMPOOL_BOX_DEPTH);
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
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: borderColor, linewidth: 1, transparent: true, opacity: 0.6 }),
    ),
  );
  return group;
};

function createMempoolBox(
  borderColor: number,
  mempoolTxs: readonly unknown[],
  pendingTxs: readonly unknown[],
  direction: THREE.Vector3,
): THREE.Group {
  const group = createMempoolBoxFrame(borderColor);
  addMempoolTransactions(group, mempoolTxs, 0x888888, 0.7, -MEMPOOL_BOX_DEPTH / 3);
  addMempoolTransactions(group, pendingTxs, 0x00ccff, 0.95, MEMPOOL_BOX_DEPTH / 6);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
  return group;
}

/**
 * Render one box per observed Account side. An absent side means "not observed",
 * never "not committed", so it must not produce a synthetic desync visual.
 */
export function createAccountMempoolBoxes(options: {
  fromEntity: GraphAccountEndpoint;
  toEntity: GraphAccountEndpoint;
  leftAccount: GraphAccountMempoolView | null | undefined;
  rightAccount: GraphAccountMempoolView | null | undefined;
  leftState: string | null | undefined;
  rightState: string | null | undefined;
  getEntitySize(entityId: string, tokenId: number): number;
}): THREE.Group[] {
  const direction = new THREE.Vector3().subVectors(options.toEntity.position, options.fromEntity.position).normalize();
  const sides = [
    { account: options.leftAccount, state: options.leftState, anchor: options.fromEntity, sign: 1 },
    { account: options.rightAccount, state: options.rightState, anchor: options.toEntity, sign: -1 },
  ];
  return sides.flatMap(({ account, state, anchor, sign }) => {
    if (!account) return [];
    const box = createMempoolBox(
      state && state !== 'committed' ? 0xff4444 : 0x00ff88,
      account.mempool || [],
      account.pendingFrame?.accountTxs || [],
      direction,
    );
    const offset = sign * (options.getEntitySize(anchor.id, 1) + 0.4 - 0.2);
    box.position.copy(anchor.position).add(direction.clone().multiplyScalar(offset));
    return [box];
  });
}
