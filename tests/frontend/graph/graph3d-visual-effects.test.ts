import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import {
  createBroadcastRippleMesh,
  createDirectionalLightningMesh,
} from '../../../frontend/packages/ui/src/graph3d-visual-effects';

const connection = () => ({
  line: new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 10, 0),
    ]),
  ),
});

describe('Graph3D shared visual effects', () => {
  test('sizes and positions directional lightning from the connection geometry', () => {
    const bolt = createDirectionalLightningMesh(connection(), { data: { amount: 1_000_000_000_000_000_000n } });
    const geometry = bolt.geometry as THREE.CylinderGeometry;
    const material = bolt.material as THREE.MeshLambertMaterial;

    expect(geometry.parameters.radiusTop).toBe(0.05);
    expect(geometry.parameters.height).toBe(10);
    expect(bolt.position.toArray()).toEqual([0, 5, 0]);
    expect(material.color.getHex()).toBe(0x0088ff);
    expect(material.emissive.getHex()).toBe(0x0088ff);
  });

  test('preserves the default and high-value lightning tiers', () => {
    const defaultBolt = createDirectionalLightningMesh(connection(), undefined);
    const highValueBolt = createDirectionalLightningMesh(connection(), {
      data: { amount: 10_000_000_000_000_000_000_000_000n },
    });

    expect((defaultBolt.geometry as THREE.CylinderGeometry).parameters.radiusTop).toBe(0.08);
    expect((defaultBolt.material as THREE.MeshLambertMaterial).color.getHex()).toBe(0x00ccff);
    expect((highValueBolt.material as THREE.MeshLambertMaterial).color.getHex()).toBe(0xff4444);
  });

  test('maps transaction kinds to canonical ripple colors and orientation', () => {
    const reserveRipple = createBroadcastRippleMesh(new THREE.Vector3(1, 2, 3), 'withdraw_reserve');
    const unknownRipple = createBroadcastRippleMesh(new THREE.Vector3(), 'unknown');

    expect(reserveRipple.position.toArray()).toEqual([1, 2, 3]);
    expect(reserveRipple.rotation.x).toBe(Math.PI / 2);
    expect((reserveRipple.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xff0000);
    expect((unknownRipple.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x00ffff);
  });

  test('moves live effects to shared UI and removes the unused random ripple', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-visual-effects.ts', 'utf8');
    const legacy = readFileSync('frontend/src/lib/view/panels/graph3d/graph3d-visuals.ts', 'utf8');
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');

    expect(shared).toContain('export function createDirectionalLightningMesh');
    expect(shared).toContain('export function createBroadcastRippleMesh');
    expect(legacy).not.toContain('createDirectionalLightningMesh');
    expect(legacy).not.toContain('createBroadcastRippleMesh');
    expect(legacy).not.toContain('createGraphRippleMesh');
    expect(panel).toContain('packages/ui/src/graph3d-visual-effects');
  });
});
