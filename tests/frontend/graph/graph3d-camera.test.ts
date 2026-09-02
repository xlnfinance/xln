import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import {
  applyGraphCameraPose,
  applyGraphCameraTarget,
  fitGraphCameraToEntities,
} from '../../../frontend/packages/ui/src/graph3d-camera';

const createControls = () => {
  let updateCount = 0;
  return {
    target: new THREE.Vector3(),
    update: () => { updateCount += 1; },
    updates: () => updateCount,
  };
};

describe('Graph3D shared camera mechanics', () => {
  test('applies target-only camera events through one controls update', () => {
    const controls = createControls();

    applyGraphCameraTarget(controls, { x: 4, y: 5, z: 6 });

    expect(controls.target.toArray()).toEqual([4, 5, 6]);
    expect(controls.updates()).toBe(1);
  });

  test('restores camera pose and updates projection only when zoom is present', () => {
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 1000);
    const controls = createControls();
    const initialProjection = camera.projectionMatrix.clone();

    applyGraphCameraPose(camera, controls, {
      position: { x: 10, y: 20, z: 30 },
      target: { x: 1, y: 2, z: 3 },
      zoom: 2,
    });

    expect(camera.position.toArray()).toEqual([10, 20, 30]);
    expect(controls.target.toArray()).toEqual([1, 2, 3]);
    expect(camera.zoom).toBe(2);
    expect(camera.projectionMatrix.equals(initialProjection)).toBe(false);
    expect(controls.updates()).toBe(1);

    const zoomedProjection = camera.projectionMatrix.clone();
    applyGraphCameraPose(camera, controls, {
      position: { x: -1, y: -2, z: -3 },
      target: { x: 7, y: 8, z: 9 },
    });
    expect(camera.zoom).toBe(2);
    expect(camera.projectionMatrix.equals(zoomedProjection)).toBe(true);
    expect(controls.updates()).toBe(2);
  });

  test('fits to two preferred entities and preserves the canonical view direction', () => {
    const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 1000);
    const controls = createControls();
    const entities = [
      { id: 'alice', position: new THREE.Vector3(0, 0, 0) },
      { id: 'bob', position: new THREE.Vector3(10, 0, 0) },
      { id: 'outlier', position: new THREE.Vector3(1000, 1000, 1000) },
    ];

    expect(fitGraphCameraToEntities(camera, controls, entities, new Set(['alice', 'bob']))).toBe(true);

    const expectedDistance = 36 * 1.65;
    expect(controls.target.toArray()).toEqual([5, 0, 0]);
    expect(camera.position.x).toBeCloseTo(5);
    expect(camera.position.y).toBeCloseTo(expectedDistance / Math.sqrt(2));
    expect(camera.position.z).toBeCloseTo(expectedDistance / Math.sqrt(2));
    expect(controls.updates()).toBe(1);
  });

  test('falls back to all entities for a single preferred id and ignores an empty graph', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const controls = createControls();
    const entities = [
      { id: 'alice', position: new THREE.Vector3(0, 0, 0) },
      { id: 'bob', position: new THREE.Vector3(20, 0, 0) },
    ];

    expect(fitGraphCameraToEntities(camera, controls, entities, new Set(['alice']))).toBe(true);
    expect(controls.target.toArray()).toEqual([10, 0, 0]);
    expect(fitGraphCameraToEntities(camera, controls, [])).toBe(false);
    expect(controls.updates()).toBe(1);
  });

  test('moves reusable camera mechanics out of the Svelte panel', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-camera.ts', 'utf8');
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');

    expect(shared).toContain('export function fitGraphCameraToEntities');
    expect(shared).toContain('export function applyGraphCameraPose');
    expect(panel).toContain('packages/ui/src/graph3d-camera');
    expect(panel).not.toContain('new THREE.Box3()');
    expect(panel).not.toContain('const horizontalTangent =');
  });
});
