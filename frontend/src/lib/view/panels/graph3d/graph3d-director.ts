/**
 * Camera direction for narrated playback: one framing formula and one tween.
 *
 * `frameGraphPoints` is the only place that decides how far the camera stands from a set of
 * points, so the initial auto-fit, a cue's focus framing and the presentation overview agree.
 */

import * as THREE from 'three';
import type { NetworkMachineCameraCue } from '$lib/network3d/networkMachine';

export type CameraShot = { position: THREE.Vector3; target: THREE.Vector3; fov: number };

export type CameraTween = { from: CameraShot; to: CameraShot; startMs: number; durationMs: number };

/** Looking down at the network from the front, the same angle the graph always opened with. */
export const DEFAULT_VIEW_DIRECTION = new THREE.Vector3(0, 1, 1).normalize();

/**
 * Presentation looks at the network almost head-on: the J-machine reads as standing above
 * the banks, and labels face the audience instead of foreshortening into the floor.
 */
export const PRESENTATION_VIEW_DIRECTION = new THREE.Vector3(0, 0.32, 1).normalize();

export const shotFromCameraCue = (cue: NetworkMachineCameraCue, currentFov: number): CameraShot => ({
  position: new THREE.Vector3(cue.position.x, cue.position.y, cue.position.z),
  target: new THREE.Vector3(cue.target.x, cue.target.y, cue.target.z),
  fov: cue.fov ?? currentFov,
});

export const currentCameraShot = (camera: THREE.PerspectiveCamera, target: THREE.Vector3): CameraShot => ({
  position: camera.position.clone(),
  target: target.clone(),
  fov: camera.fov,
});

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Exact perspective fit: the camera distance from `center` along `direction` at which every
 * point lands inside the frustum. Points nearer the camera need more room, which a
 * bounding-box estimate misses — that is how a near sphere ends up cut by the frame edge.
 */
export const requiredCameraDistance = (
  points: readonly THREE.Vector3[],
  center: THREE.Vector3,
  direction: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  padding: number,
): number => {
  const towardCamera = direction.clone().normalize();
  const right = new THREE.Vector3().crossVectors(WORLD_UP, towardCamera).normalize();
  const up = new THREE.Vector3().crossVectors(towardCamera, right);
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanH = tanV * Math.max(camera.aspect, 0.1);
  return points.reduce((distance, point) => {
    const offset = point.clone().sub(center);
    const depth = offset.dot(towardCamera);
    const lateral = Math.max(Math.abs(offset.dot(right)) / tanH, Math.abs(offset.dot(up)) / tanV);
    return Math.max(distance, depth + lateral * padding);
  }, 0);
};

/**
 * Frames every point inside the viewport. `padding` > 1 leaves room around the subject;
 * `minDistance` keeps a two-node close-up from pressing the camera into a sphere.
 */
export const frameGraphPoints = (
  points: readonly THREE.Vector3[],
  camera: THREE.PerspectiveCamera,
  options: { padding: number; minDistance: number; direction?: THREE.Vector3 },
): CameraShot | null => {
  if (points.length === 0) return null;
  const center = new THREE.Box3().setFromPoints([...points]).getCenter(new THREE.Vector3());
  const direction = (options.direction ?? DEFAULT_VIEW_DIRECTION).clone().normalize();
  const distance = Math.max(options.minDistance, requiredCameraDistance(points, center, direction, camera, options.padding));
  return { position: center.clone().addScaledVector(direction, distance), target: center, fov: camera.fov };
};

const PRESENTATION_ELEVATION = Math.atan2(PRESENTATION_VIEW_DIRECTION.y, Math.hypot(PRESENTATION_VIEW_DIRECTION.x, PRESENTATION_VIEW_DIRECTION.z));

/** Spread of the points across the screen when looking along horizontal `direction`. */
const lateralSpread = (points: readonly THREE.Vector3[], center: THREE.Vector3, direction: THREE.Vector3): number => {
  const right = new THREE.Vector3().crossVectors(WORLD_UP, direction).normalize();
  return points.reduce((sum, point) => sum + Math.pow(point.clone().sub(center).dot(right), 2), 0);
};

const atElevation = (horizontal: THREE.Vector3): THREE.Vector3 => {
  const flat = new THREE.Vector3(horizontal.x, 0, horizontal.z).normalize();
  return flat.multiplyScalar(Math.cos(PRESENTATION_ELEVATION)).setY(Math.sin(PRESENTATION_ELEVATION));
};

/**
 * Face-on presentation azimuth: look perpendicular to the layout's principal horizontal
 * axis, so banks spread across the screen instead of stacking behind each other. The
 * current azimuth is kept while it shows at least 85% of the best spread, so a growing
 * network does not swing the camera.
 */
export const presentationViewDirection = (
  points: readonly THREE.Vector3[],
  current: THREE.Vector3 | null,
): THREE.Vector3 => {
  const preferred = current && Math.hypot(current.x, current.z) > 1e-6 ? atElevation(current) : PRESENTATION_VIEW_DIRECTION.clone();
  if (points.length < 2) return preferred;
  const center = new THREE.Box3().setFromPoints([...points]).getCenter(new THREE.Vector3());
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const point of points) {
    const dx = point.x - center.x;
    const dz = point.z - center.z;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
  }
  const principal = 0.5 * Math.atan2(2 * xz, xx - zz);
  const faceOn = new THREE.Vector3(-Math.sin(principal), 0, Math.cos(principal));
  if (faceOn.dot(preferred) < 0) faceOn.negate();
  const best = atElevation(faceOn);
  return lateralSpread(points, center, preferred) >= lateralSpread(points, center, best) * 0.85 ? preferred : best;
};

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Applies the tween at `nowMs` to camera and orbit target. Returns true once it has landed. */
export const advanceCameraTween = (
  tween: CameraTween,
  nowMs: number,
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
): boolean => {
  const raw = Math.min(1, Math.max(0, (nowMs - tween.startMs) / tween.durationMs));
  const t = easeInOutCubic(raw);
  camera.position.lerpVectors(tween.from.position, tween.to.position, t);
  target.lerpVectors(tween.from.target, tween.to.target, t);
  const fov = tween.from.fov + (tween.to.fov - tween.from.fov) * t;
  if (Math.abs(camera.fov - fov) > 1e-6) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  return raw >= 1;
};
