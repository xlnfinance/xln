import * as THREE from 'three';

export type GraphCameraPoint = Readonly<{ x: number; y: number; z: number }>;

export type GraphCameraControls = Readonly<{
  target: THREE.Vector3;
  update(): void;
}>;

export type GraphCameraPose = Readonly<{
  position: GraphCameraPoint;
  target: GraphCameraPoint;
  zoom?: number;
}>;

type GraphCameraEntity = Readonly<{
  id: string;
  position: THREE.Vector3;
}>;

export function applyGraphCameraTarget(controls: GraphCameraControls, target: GraphCameraPoint): void {
  controls.target.set(target.x, target.y, target.z);
  controls.update();
}

export function applyGraphCameraPose(
  camera: THREE.PerspectiveCamera,
  controls: GraphCameraControls,
  pose: GraphCameraPose,
): void {
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  controls.target.set(pose.target.x, pose.target.y, pose.target.z);
  if (pose.zoom !== undefined) {
    camera.zoom = pose.zoom;
    camera.updateProjectionMatrix();
  }
  controls.update();
}

const cameraFocusEntities = <T extends GraphCameraEntity>(
  entities: readonly T[],
  preferredEntityIds: ReadonlySet<string>,
): readonly T[] => {
  const preferred = entities.filter(entity => preferredEntityIds.has(entity.id));
  return preferred.length >= 2 ? preferred : entities;
};

export function fitGraphCameraToEntities(
  camera: THREE.PerspectiveCamera,
  controls: GraphCameraControls,
  entities: readonly GraphCameraEntity[],
  preferredEntityIds: ReadonlySet<string> = new Set(),
): boolean {
  if (entities.length === 0) return false;
  const box = new THREE.Box3().setFromPoints(
    cameraFocusEntities(entities, preferredEntityIds).map(entity => entity.position),
  );
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const verticalTangent = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const horizontalTangent = verticalTangent * Math.max(camera.aspect, 0.1);
  const fitWidth = size.x / (2 * horizontalTangent);
  const fitHeight = Math.hypot(size.y, size.z) / (2 * verticalTangent);
  const distance = Math.max(fitWidth, fitHeight, 36) * 1.65;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(0, 1, 1).normalize(), distance);
  controls.target.copy(center);
  controls.update();
  return true;
}
