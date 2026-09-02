import * as THREE from 'three';
import { findGraphEntityFromObject } from './graph3d-interaction';

type GraphHoverEntity = Readonly<{
  mesh: THREE.Object3D;
}>;

type GraphHoverConnection = Readonly<{
  line: THREE.Line;
}>;

export type GraphHoverHit<TEntity, TConnection> =
  | Readonly<{ kind: 'entity'; entity: TEntity; target: THREE.Object3D }>
  | Readonly<{ kind: 'unresolved-entity' }>
  | Readonly<{ kind: 'connection'; connection: TConnection; target: THREE.Object3D }>
  | Readonly<{ kind: 'none' }>;

const hasMaterial = (target: THREE.Object3D): target is THREE.Object3D & { material: unknown } =>
  'material' in target;

type GraphColor = Readonly<{
  setHex: (color: number) => unknown;
}>;

const isGraphColor = (value: unknown): value is GraphColor =>
  typeof value === 'object' &&
  value !== null &&
  'setHex' in value &&
  typeof value.setHex === 'function';

const hasEmissiveColor = (material: unknown): material is { emissive: GraphColor } =>
  typeof material === 'object' &&
  material !== null &&
  'emissive' in material &&
  isGraphColor(material.emissive);

const hasColor = (material: unknown): material is { color: GraphColor } =>
  typeof material === 'object' &&
  material !== null &&
  'color' in material &&
  isGraphColor(material.color);

export function resolveGraphHoverHit<
  TEntity extends GraphHoverEntity,
  TConnection extends GraphHoverConnection,
>(
  raycaster: THREE.Raycaster,
  entities: readonly TEntity[],
  connections: readonly TConnection[],
  graphWorld: THREE.Object3D,
  scene: THREE.Object3D,
): GraphHoverHit<TEntity, TConnection> {
  const entityIntersects = raycaster.intersectObjects(entities.map((entity) => entity.mesh));
  if (entityIntersects.length > 0) {
    const intersectedObject = entityIntersects[0]?.object;
    if (!intersectedObject) throw new Error('FINTECH-SAFETY: No intersected object found');
    const entity = findGraphEntityFromObject(intersectedObject, entities, graphWorld, scene);
    return entity
      ? { kind: 'entity', entity, target: entity.mesh }
      : { kind: 'unresolved-entity' };
  }

  const lineIntersects = raycaster.intersectObjects(connections.map((connection) => connection.line));
  if (lineIntersects.length === 0) return { kind: 'none' };
  const intersectedLine = lineIntersects[0]?.object;
  if (!intersectedLine) throw new Error('FINTECH-SAFETY: No intersected line found');
  const connection = connections.find((candidate) => candidate.line === intersectedLine);
  if (!connection) throw new Error('FINTECH-SAFETY: Connection not found for intersected line');
  return { kind: 'connection', connection, target: intersectedLine };
}

export function highlightGraphHoverTarget(
  kind: 'entity' | 'connection',
  target: THREE.Object3D,
): void {
  const material = hasMaterial(target) ? target.material : null;
  if (kind === 'entity') {
    if (!hasEmissiveColor(material)) {
      throw new Error('FINTECH-SAFETY: Entity material missing emissive property');
    }
    material.emissive.setHex(0x444400);
    return;
  }
  if (!hasColor(material)) {
    throw new Error('FINTECH-SAFETY: Connection material missing color property');
  }
  material.color.setHex(0xffff00);
}
