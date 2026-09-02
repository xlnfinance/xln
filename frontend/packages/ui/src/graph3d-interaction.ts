import * as THREE from 'three';
import { detachGraphObject3D } from './graph3d-renderer';

export type GraphGestureOutcome = 'none' | 'select' | 'open' | 'drag-end';

export type GraphGestureState = {
  active: Record<string, { entityId: string; startedAt: number }>;
  lastTap: Record<string, { entityId: string; endedAt: number }>;
};

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

type GraphSelectableEntity = Readonly<{
  id: string;
  mesh: THREE.Object3D;
}>;

export type GraphDraggableEntity = {
  position: THREE.Vector3;
  mesh: THREE.Object3D;
  isDragging?: boolean;
};

export type GraphXrEntity = GraphDraggableEntity & Readonly<{ id: string }>;

export type GraphXrGrab<T extends GraphXrEntity = GraphXrEntity> = Readonly<{
  entity: T;
  controller: THREE.Object3D;
  sourceId: string;
  startPosition: THREE.Vector3;
  rayDistance: number;
}>;

export const emptyGraphGestureState = (): GraphGestureState => ({ active: {}, lastTap: {} });

const gestureSource = (value: string): string => String(value || '').trim().toLowerCase();
const gestureEntity = (value: string): string => String(value || '').trim().toLowerCase();
const gestureTime = (value: number): number => Math.max(0, Number(value) || 0);

export const beginGraphGesture = (
  state: GraphGestureState,
  input: { sourceId: string; entityId: string; at: number },
): GraphGestureState => {
  const sourceId = gestureSource(input.sourceId);
  const entityId = gestureEntity(input.entityId);
  if (!sourceId || !entityId) throw new Error('GRAPH_GESTURE_SOURCE_AND_ENTITY_REQUIRED');
  return { ...state, active: { ...state.active, [sourceId]: { entityId, startedAt: gestureTime(input.at) } } };
};

export const endGraphGesture = (
  state: GraphGestureState,
  input: { sourceId: string; entityId: string; at: number; moved: boolean; doubleSelectMs?: number },
): { state: GraphGestureState; outcome: GraphGestureOutcome } => {
  const sourceId = gestureSource(input.sourceId);
  const entityId = gestureEntity(input.entityId);
  const active = state.active[sourceId];
  if (!active || active.entityId !== entityId) return { state, outcome: 'none' };
  const activeNext = { ...state.active };
  delete activeNext[sourceId];
  if (input.moved) {
    const lastTap = { ...state.lastTap };
    delete lastTap[sourceId];
    return { state: { active: activeNext, lastTap }, outcome: 'drag-end' };
  }
  const endedAt = gestureTime(input.at);
  const previous = state.lastTap[sourceId];
  const doubleSelectMs = Math.max(100, Math.floor(Number(input.doubleSelectMs ?? 450)));
  if (previous?.entityId === entityId && endedAt >= previous.endedAt && endedAt - previous.endedAt <= doubleSelectMs) {
    const lastTap = { ...state.lastTap };
    delete lastTap[sourceId];
    return { state: { active: activeNext, lastTap }, outcome: 'open' };
  }
  return {
    state: { active: activeNext, lastTap: { ...state.lastTap, [sourceId]: { entityId, endedAt } } },
    outcome: 'select',
  };
};

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

const setGraphDragEmissive = (entity: GraphDraggableEntity, color: number): void => {
  if (!hasGraphMaterial(entity.mesh) || !isMeshLambertMaterial(entity.mesh.material)) return;
  entity.mesh.material.emissive.setHex(color);
};

export function beginGraphEntityDrag(
  camera: THREE.Camera,
  raycaster: THREE.Raycaster,
  entity: GraphDraggableEntity,
  dragPlane: THREE.Plane,
  dragOffset: THREE.Vector3,
): void {
  entity.isDragging = true;
  dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).normalize(), entity.position);
  const intersection = new THREE.Vector3();
  raycaster.ray.intersectPlane(dragPlane, intersection);
  dragOffset.subVectors(entity.position, intersection);
  setGraphDragEmissive(entity, 0x00ff88);
}

export function moveGraphEntityDrag(
  raycaster: THREE.Raycaster,
  entity: GraphDraggableEntity,
  dragPlane: THREE.Plane,
  dragOffset: THREE.Vector3,
): void {
  const intersection = new THREE.Vector3();
  raycaster.ray.intersectPlane(dragPlane, intersection);
  entity.position.copy(intersection.add(dragOffset));
  entity.mesh.position.copy(entity.position);
}

export function endGraphEntityDrag(entity: GraphDraggableEntity): void {
  entity.isDragging = false;
  setGraphDragEmissive(entity, 0x002200);
}

export function createGraphXrRaycaster(controller: THREE.Object3D): THREE.Raycaster {
  const controllerRotation = new THREE.Matrix4().extractRotation(controller.matrixWorld);
  const raycaster = new THREE.Raycaster();
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(controllerRotation);
  return raycaster;
}

export function beginGraphXrGrab<T extends GraphXrEntity>(
  entity: T,
  controller: THREE.Object3D,
  sourceId: string,
  rayDistance: number,
): GraphXrGrab<T> {
  entity.isDragging = true;
  return { entity, controller, sourceId, startPosition: entity.position.clone(), rayDistance };
}

export function moveGraphXrGrab(grab: GraphXrGrab, graphWorld: THREE.Object3D): void {
  const controllerPosition = new THREE.Vector3().setFromMatrixPosition(grab.controller.matrixWorld);
  const controllerRotation = new THREE.Matrix4().extractRotation(grab.controller.matrixWorld);
  const rayDirection = new THREE.Vector3(0, 0, -1).applyMatrix4(controllerRotation).normalize();
  const graphPosition = graphWorld.worldToLocal(controllerPosition.add(rayDirection.multiplyScalar(grab.rayDistance)));
  grab.entity.mesh.position.copy(graphPosition);
  grab.entity.position.copy(graphPosition);
}

export function endGraphXrGrab(grab: GraphXrGrab): boolean {
  const moved = grab.entity.position.distanceTo(grab.startPosition) > 0.5;
  grab.entity.isDragging = false;
  return moved;
}

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

export function updateGraphSelectionHighlight(entities: readonly GraphSelectableEntity[], selectedEntityId: string): void {
  for (const entity of entities) {
    const previous = entity.mesh.getObjectByName('graph-selection-highlight');
    if (previous) detachGraphObject3D(entity.mesh, previous);
    if (entity.id !== selectedEntityId) continue;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.35, 0.07, 8, 36),
      new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.95, depthTest: false }),
    );
    ring.name = 'graph-selection-highlight';
    ring.rotation.x = Math.PI / 2;
    entity.mesh.add(ring);
  }
}
