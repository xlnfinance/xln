import * as THREE from 'three';

type GraphAccountEndpoint = Readonly<{
  id: string;
  position: THREE.Vector3;
}>;

type GraphAccountMempoolView = Readonly<{
  mempool?: readonly unknown[];
  pendingFrame?: Readonly<{ accountTxs?: readonly unknown[] }>;
}>;

type GraphAccountVisualView<TDelta> = GraphAccountMempoolView & Readonly<{
  state: Readonly<{ deltas: Map<number, TDelta> }>;
  currentFrame?: Readonly<{ height?: number }>;
  activeDispute?: Readonly<{
    startedByLeft: boolean;
    disputeTimeout: number;
    initialNonce: number;
  }>;
}>;

type GraphAccountReplica<TAccount> = Readonly<{
  state?: Readonly<{ accounts?: ReadonlyMap<string, TAccount> | null }> | null;
}>;

type GraphPresentationState = Readonly<{ state: string }>;

export type GraphAccountBarRenderRequest<TDelta, TVisual> = Readonly<{
  graphWorld: THREE.Group;
  fromEntity: GraphAccountEndpoint;
  toEntity: GraphAccountEndpoint;
  deltas: Map<number, TDelta>;
  fromIsLeft: boolean;
  barsMode: 'close' | 'spread';
  portfolioScale: number;
  desyncDetected: boolean;
  bilateralState: TVisual | null;
  dispute: GraphAccountVisualView<TDelta>['activeDispute'] | null;
  getEntitySize(entityId: string, tokenId: number): number;
}>;

type GraphAccountVisualOptions<
  TDelta,
  TAccount extends GraphAccountVisualView<TDelta>,
  TState extends GraphPresentationState,
  TVisual,
> = Readonly<{
  graphWorld: THREE.Group;
  fromEntity: GraphAccountEndpoint;
  toEntity: GraphAccountEndpoint;
  fromId: string;
  toId: string;
  replicas: ReadonlyMap<string, GraphAccountReplica<TAccount>>;
  barsMode: 'close' | 'spread';
  portfolioScale: number;
  getEntitySize(entityId: string, tokenId: number): number;
  classifyBilateralState(account: TAccount | undefined, peerHeight: number, isLeft: boolean): TState | undefined;
  getAccountBarVisual(leftState: TState, rightState: TState): TVisual | null | undefined;
  renderBars(request: GraphAccountBarRenderRequest<TDelta, TVisual>): THREE.Group;
}>;

type SelectedAccountViews<TAccount> = Readonly<{
  account: TAccount | undefined;
  confirmedAccount: TAccount | undefined;
  pendingAccount: TAccount | null;
}>;

const MEMPOOL_BOX_DEPTH = 0.4;

const findGraphAccount = <TAccount>(
  replicas: ReadonlyMap<string, GraphAccountReplica<TAccount>>,
  entityId: string,
  peerId: string,
): TAccount | undefined => {
  const key = Array.from(replicas.keys()).find(candidate => candidate.startsWith(`${entityId}:`));
  return key ? replicas.get(key)?.state?.accounts?.get(peerId) : undefined;
};

const selectAccountViews = <TAccount extends { currentFrame?: { height?: number } }>(
  leftAccount: TAccount | undefined,
  rightAccount: TAccount | undefined,
): SelectedAccountViews<TAccount> => {
  const account = leftAccount ?? rightAccount;
  const leftHeight = Number(leftAccount?.currentFrame?.height ?? 0);
  const rightHeight = Number(rightAccount?.currentFrame?.height ?? 0);
  if (!leftAccount || !rightAccount || leftHeight === rightHeight) {
    return { account, confirmedAccount: account, pendingAccount: null };
  }
  const leftIsAhead = leftHeight > rightHeight;
  return {
    account: leftIsAhead ? leftAccount : rightAccount,
    confirmedAccount: leftIsAhead ? rightAccount : leftAccount,
    pendingAccount: leftIsAhead ? leftAccount : rightAccount,
  };
};

const addEmptyAccountBars = (graphWorld: THREE.Group): THREE.Group => {
  const bars = new THREE.Group();
  graphWorld.add(bars);
  return bars;
};

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

const classifyAccountViews = <
  TDelta,
  TAccount extends GraphAccountVisualView<TDelta>,
  TState extends GraphPresentationState,
  TVisual,
>(
  options: GraphAccountVisualOptions<TDelta, TAccount, TState, TVisual>,
  selected: SelectedAccountViews<TAccount>,
  fromIsLeft: boolean,
): Readonly<{ leftState: TState | undefined; rightState: TState | undefined }> => {
  const leftView = fromIsLeft ? selected.confirmedAccount : selected.pendingAccount;
  const rightView = fromIsLeft ? selected.pendingAccount : selected.confirmedAccount;
  return {
    leftState: options.classifyBilateralState(
      leftView ?? undefined,
      Number(rightView?.currentFrame?.height ?? 0),
      true,
    ),
    rightState: options.classifyBilateralState(
      rightView ?? undefined,
      Number(leftView?.currentFrame?.height ?? 0),
      false,
    ),
  };
};

/**
 * Build the visual projection for one bilateral Account without deriving balances.
 *
 * Account storage orientation is security-sensitive: LEFT is always the lower
 * entity id lexicographically, regardless of which endpoint happened to create
 * the drawn connection. Reversing draw direction must never reverse the replica
 * lookup. The existing confirmed/pending presentation projection is applied only
 * after those canonical sides and their exact frame heights have been resolved.
 */
export function buildGraphAccountVisuals<
  TDelta,
  TAccount extends GraphAccountVisualView<TDelta>,
  TState extends GraphPresentationState,
  TVisual,
>(options: GraphAccountVisualOptions<TDelta, TAccount, TState, TVisual>): {
  bars: THREE.Group;
  mempoolBoxes: THREE.Group[];
} {
  const fromIsLeft = options.fromId < options.toId;
  const leftId = fromIsLeft ? options.fromId : options.toId;
  const rightId = fromIsLeft ? options.toId : options.fromId;
  const leftAccount = findGraphAccount(options.replicas, leftId, rightId);
  const rightAccount = findGraphAccount(options.replicas, rightId, leftId);
  const selected = selectAccountViews(leftAccount, rightAccount);
  if (!selected.account?.state.deltas || selected.account.state.deltas.size === 0) {
    return { bars: addEmptyAccountBars(options.graphWorld), mempoolBoxes: [] };
  }

  const { leftState, rightState } = classifyAccountViews(options, selected, fromIsLeft);
  const bilateralState = leftState && rightState
    ? options.getAccountBarVisual(leftState, rightState) ?? null
    : null;
  const bars = options.renderBars({
    graphWorld: options.graphWorld,
    fromEntity: options.fromEntity,
    toEntity: options.toEntity,
    deltas: selected.account.state.deltas,
    fromIsLeft,
    barsMode: options.barsMode,
    portfolioScale: options.portfolioScale,
    desyncDetected: Boolean(
      leftState && rightState && (leftState.state !== 'committed' || rightState.state !== 'committed'),
    ),
    bilateralState,
    dispute: selected.account.activeDispute ?? null,
    getEntitySize: options.getEntitySize,
  });
  const leftMempoolState = leftAccount
    ? options.classifyBilateralState(leftAccount, 0, true)?.state ?? null
    : null;
  const rightMempoolState = rightAccount
    ? options.classifyBilateralState(rightAccount, 0, false)?.state ?? null
    : null;
  const mempoolBoxes = createAccountMempoolBoxes({
    fromEntity: options.fromEntity,
    toEntity: options.toEntity,
    leftAccount,
    rightAccount,
    leftState: leftMempoolState,
    rightState: rightMempoolState,
    getEntitySize: options.getEntitySize,
  });
  for (const box of mempoolBoxes) options.graphWorld.add(box);
  return { bars, mempoolBoxes };
}
