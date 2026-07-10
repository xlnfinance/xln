import type {
  MergedRuntimeGraph,
  RuntimeGraphPosition,
} from './runtimeGraphProjection';

export type RuntimeGraphPositionSource = 'user' | 'runtime' | 'layout';
export type RuntimeGraphPlacedNode = {
  entityId: string;
  position: RuntimeGraphPosition;
  source: RuntimeGraphPositionSource;
};

type MutablePoint = { x: number; y: number; z: number; fixed: boolean };

const hashText = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const initialPoint = (entityId: string, index: number, total: number, isHub: boolean): MutablePoint => {
  const hash = hashText(entityId);
  const angle = (index * 2.399963229728653) + ((hash % 360) * Math.PI / 180);
  const normalizedZ = total <= 1 ? 0 : 1 - (2 * index) / (total - 1);
  const planar = Math.sqrt(Math.max(0, 1 - normalizedZ * normalizedZ));
  const radius = isHub ? 10 : 28 + (hash % 13);
  return {
    x: Math.cos(angle) * planar * radius,
    y: Math.sin(angle) * planar * radius,
    z: normalizedZ * radius * 0.55,
    fixed: false,
  };
};

const finitePosition = (position: RuntimeGraphPosition | null | undefined): RuntimeGraphPosition | null => {
  if (!position) return null;
  if (![position.x, position.y, position.z].every(Number.isFinite)) return null;
  return { ...position };
};

const separation = (leftId: string, rightId: string): { x: number; y: number; z: number } => {
  const hash = hashText(`${leftId}:${rightId}`);
  const angle = (hash % 360) * Math.PI / 180;
  return { x: Math.cos(angle), y: Math.sin(angle), z: ((hash >>> 9) % 3) - 1 };
};

const applyRepulsion = (
  ids: string[],
  points: Map<string, MutablePoint>,
  displacement: Map<string, RuntimeGraphPosition>,
  strength: number,
): void => {
  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
      const leftId = ids[leftIndex]!;
      const rightId = ids[rightIndex]!;
      const left = points.get(leftId)!;
      const right = points.get(rightId)!;
      let dx = left.x - right.x;
      let dy = left.y - right.y;
      let dz = left.z - right.z;
      let distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared < 0.0001) {
        const direction = separation(leftId, rightId);
        dx = direction.x;
        dy = direction.y;
        dz = direction.z;
        distanceSquared = dx * dx + dy * dy + dz * dz;
      }
      const distance = Math.sqrt(distanceSquared);
      const force = strength / distanceSquared;
      const x = dx / distance * force;
      const y = dy / distance * force;
      const z = dz / distance * force;
      const leftMove = displacement.get(leftId)!;
      const rightMove = displacement.get(rightId)!;
      leftMove.x += x; leftMove.y += y; leftMove.z += z;
      rightMove.x -= x; rightMove.y -= y; rightMove.z -= z;
    }
  }
};

const applyAttraction = (
  graph: MergedRuntimeGraph,
  points: Map<string, MutablePoint>,
  displacement: Map<string, RuntimeGraphPosition>,
): void => {
  for (const edge of graph.accounts) {
    const left = points.get(edge.selected.leftEntityId);
    const right = points.get(edge.selected.rightEntityId);
    if (!left || !right) continue;
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const dz = right.z - left.z;
    const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const force = Math.max(0, distance - 14) * 0.035;
    const x = dx / distance * force;
    const y = dy / distance * force;
    const z = dz / distance * force;
    const leftMove = displacement.get(edge.selected.leftEntityId)!;
    const rightMove = displacement.get(edge.selected.rightEntityId)!;
    leftMove.x += x; leftMove.y += y; leftMove.z += z;
    rightMove.x -= x; rightMove.y -= y; rightMove.z -= z;
  }
};

const integrate = (
  ids: string[],
  points: Map<string, MutablePoint>,
  displacement: Map<string, RuntimeGraphPosition>,
  temperature: number,
): void => {
  for (const entityId of ids) {
    const point = points.get(entityId)!;
    if (point.fixed) continue;
    const move = displacement.get(entityId)!;
    const length = Math.max(0.0001, Math.sqrt(move.x * move.x + move.y * move.y + move.z * move.z));
    const scale = Math.min(length, temperature) / length;
    point.x += move.x * scale;
    point.y += move.y * scale;
    point.z += move.z * scale;
  }
};

export const layoutRuntimeGraph = (
  graph: MergedRuntimeGraph,
  userPositions: ReadonlyMap<string, RuntimeGraphPosition> = new Map(),
): Map<string, RuntimeGraphPlacedNode> => {
  const nodes = [...graph.nodes].sort((left, right) => left.entityId.localeCompare(right.entityId));
  const ids = nodes.map((node) => node.entityId);
  const points = new Map<string, MutablePoint>();
  nodes.forEach((node, index) => {
    const fixed = finitePosition(userPositions.get(node.entityId)) ?? finitePosition(node.selected.position);
    points.set(node.entityId, fixed ? { ...fixed, fixed: true } : initialPoint(node.entityId, index, nodes.length, node.selected.isHub));
  });
  let temperature = 8;
  for (let iteration = 0; iteration < 90; iteration += 1) {
    const displacement = new Map(ids.map((entityId) => [entityId, { x: 0, y: 0, z: 0 }]));
    applyRepulsion(ids, points, displacement, 180);
    applyAttraction(graph, points, displacement);
    integrate(ids, points, displacement, temperature);
    temperature *= 0.94;
  }
  return new Map(nodes.map((node) => {
    const user = finitePosition(userPositions.get(node.entityId));
    const runtime = finitePosition(node.selected.position);
    const point = points.get(node.entityId)!;
    return [node.entityId, {
      entityId: node.entityId,
      position: user ?? runtime ?? { x: point.x, y: point.y, z: point.z },
      source: user ? 'user' : runtime ? 'runtime' : 'layout',
    }];
  }));
};
