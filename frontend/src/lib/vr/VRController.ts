/**
 * VR Camera Controller - Thumbstick-based camera controls for WebXR
 * Provides OrbitControls-like behavior using Quest controllers
 */

import * as THREE from 'three';

export interface VRControllerConfig {
  orbitTarget: THREE.Vector3;
  orbitSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
  minPolarAngle?: number;
  maxPolarAngle?: number;
}

const DEFAULT_CONFIG: VRControllerConfig = {
  orbitTarget: new THREE.Vector3(0, 0, 0),
  orbitSpeed: 0.05,
  panSpeed: 2.0,
  zoomSpeed: 5.0,
  minPolarAngle: 0.1,
  maxPolarAngle: Math.PI - 0.1
};

/**
 * Update camera based on VR controller inputs
 * Call this every frame from animate() loop
 */
export function updateVRCamera(
  camera: THREE.PerspectiveCamera,
  session: XRSession | null,
  config: Partial<VRControllerConfig> = {}
): void {
  if (!session) return;

  const cfg = { ...DEFAULT_CONFIG, ...config };

  for (const source of session.inputSources) {
    if (!source.gamepad || source.gamepad.axes.length < 4) continue;

    const axes = source.gamepad.axes;

    if (source.handedness === 'right') {
      handleRightStickOrbit(camera, axes, cfg);
      handleRightGripZoom(camera, source.gamepad, cfg, true);
    }

    if (source.handedness === 'left') {
      handleLeftStickPan(camera, axes, cfg);
      handleLeftGripZoom(camera, source.gamepad, cfg, false);
    }
  }
}

/**
 * Right stick: Orbit camera around target (spherical coordinates)
 */
function handleRightStickOrbit(
  camera: THREE.PerspectiveCamera,
  axes: readonly number[],
  config: VRControllerConfig
): void {
  const rotateX = axes[2] != null ? axes[2] : 0;
  const rotateY = axes[3] != null ? axes[3] : 0;

  if (Math.abs(rotateX) < 0.1 && Math.abs(rotateY) < 0.1) return;

  // Convert camera position to spherical coords relative to target
  const offset = camera.position.clone().sub(config.orbitTarget);
  const spherical = new THREE.Spherical().setFromVector3(offset);

  // Apply rotation
  spherical.theta -= rotateX * config.orbitSpeed;  // Horizontal (azimuth)
  spherical.phi -= rotateY * config.orbitSpeed;    // Vertical (polar)

  // Clamp vertical rotation (prevent flipping)
  spherical.phi = Math.max(
    config.minPolarAngle!,
    Math.min(config.maxPolarAngle!, spherical.phi)
  );

  // Update camera position
  offset.setFromSpherical(spherical);
  camera.position.copy(config.orbitTarget).add(offset);
  camera.lookAt(config.orbitTarget);
}

/**
 * Left stick: Pan view (camera + target move together)
 */
function handleLeftStickPan(
  camera: THREE.PerspectiveCamera,
  axes: readonly number[],
  config: VRControllerConfig
): void {
  const panX = axes[2] != null ? axes[2] : 0;
  const panY = axes[3] != null ? axes[3] : 0;

  if (Math.abs(panX) < 0.1 && Math.abs(panY) < 0.1) return;

  // Pan along camera's local axes
  const panVector = new THREE.Vector3(panX * config.panSpeed, -panY * config.panSpeed, 0);
  panVector.applyQuaternion(camera.quaternion);

  camera.position.add(panVector);
  config.orbitTarget.add(panVector);
  camera.lookAt(config.orbitTarget);
}

/**
 * Grip buttons: Zoom in/out
 */
function handleRightGripZoom(
  camera: THREE.PerspectiveCamera,
  gamepad: Gamepad,
  config: VRControllerConfig,
  zoomIn: boolean
): void {
  if (gamepad.buttons.length <= 1) return;

  const gripPressed = gamepad.buttons[1]?.pressed;
  if (!gripPressed) return;

  const direction = new THREE.Vector3()
    .subVectors(config.orbitTarget, camera.position)
    .normalize();

  if (zoomIn) {
    camera.position.add(direction.multiplyScalar(config.zoomSpeed));
  } else {
    camera.position.sub(direction.multiplyScalar(config.zoomSpeed));
  }
}

function handleLeftGripZoom(
  camera: THREE.PerspectiveCamera,
  gamepad: Gamepad,
  config: VRControllerConfig,
  _zoomIn: boolean
): void {
  if (gamepad.buttons.length <= 1) return;

  const gripPressed = gamepad.buttons[1]?.pressed;
  if (!gripPressed) return;

  const direction = new THREE.Vector3()
    .subVectors(config.orbitTarget, camera.position)
    .normalize();

  // Left grip = zoom out
  camera.position.sub(direction.multiplyScalar(config.zoomSpeed));
}
