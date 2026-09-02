import * as THREE from 'three';

type GraphClientPoint = Readonly<{
  clientX: number;
  clientY: number;
}>;

type GraphViewportBounds = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

type GraphPointer = {
  x: number;
  y: number;
};

type GraphEntityHitTarget = Readonly<{
  mesh: THREE.Object3D;
}>;

const hasGraphMaterial = (target: THREE.Object3D): target is THREE.Object3D & { material: unknown } =>
  'material' in target;

const isMeshLambertMaterial = (material: unknown): material is THREE.MeshLambertMaterial =>
  typeof material === 'object' &&
  material !== null &&
  'isMeshLambertMaterial' in material &&
  material.isMeshLambertMaterial === true;

const isLineDashedMaterial = (material: unknown): material is THREE.LineDashedMaterial =>
  typeof material === 'object' &&
  material !== null &&
  'isLineDashedMaterial' in material &&
  material.isLineDashedMaterial === true;

export function setGraphPointerNdc(
  pointer: GraphPointer,
  point: GraphClientPoint,
  bounds: GraphViewportBounds,
): void {
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error('GRAPH_VIEWPORT_BOUNDS_INVALID');
  }
  if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) {
    throw new Error('GRAPH_POINTER_COORDINATES_INVALID');
  }
  pointer.x = ((point.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((point.clientY - bounds.top) / bounds.height) * 2 + 1;
}

export function findGraphEntityFromObject<T extends GraphEntityHitTarget>(
  object: THREE.Object3D | null | undefined,
  entities: readonly T[],
  graphWorld: THREE.Object3D,
  scene: THREE.Object3D,
): T | null {
  let current = object ?? null;
  while (current) {
    const entity = entities.find((candidate) => candidate.mesh === current);
    if (entity) return entity;
    if (current.parent === graphWorld || current.parent === scene) return null;
    current = current.parent;
  }
  return null;
}

export function resetGraphObjectHighlight(target: THREE.Object3D): void {
  if (!hasGraphMaterial(target)) return;
  const material = target.material;
  if (isMeshLambertMaterial(material)) material.emissive.setHex(0x002200);
  else if (isLineDashedMaterial(material)) material.color.setHex(0x00ff44);
}
