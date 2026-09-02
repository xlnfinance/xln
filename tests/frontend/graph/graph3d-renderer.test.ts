import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import {
  detachGraphObject3D,
  disposeGraphObject3D,
  getGraphThemeColors,
} from '../../../frontend/packages/ui/src/graph3d-renderer';

describe('Graph3D shared renderer boundary', () => {
  test('preserves the canonical graph palette', () => {
    expect(getGraphThemeColors('dark')).toEqual({
      background: 0x222222,
      entity: 0x007acc,
      connection: 0x444444,
      entityColor: '#007acc',
      entityEmissive: '#003366',
      connectionColor: '#444444',
    });
  });

  test('disposes nested geometry, materials, and texture maps', () => {
    const root = new THREE.Group();
    const child = new THREE.Object3D() as THREE.Object3D & {
      geometry: { dispose: () => void };
      material: Array<{ dispose: () => void; map: { dispose: () => void } | null }>;
    };
    let geometryDisposals = 0;
    let materialDisposals = 0;
    let textureDisposals = 0;
    child.geometry = { dispose: () => { geometryDisposals += 1; } };
    child.material = [
      {
        dispose: () => { materialDisposals += 1; },
        map: { dispose: () => { textureDisposals += 1; } },
      },
      {
        dispose: () => { materialDisposals += 1; },
        map: null,
      },
    ];
    root.add(child);

    disposeGraphObject3D(root);

    expect({ geometryDisposals, materialDisposals, textureDisposals }).toEqual({
      geometryDisposals: 1,
      materialDisposals: 2,
      textureDisposals: 1,
    });
  });

  test('detaches before disposal and is safe for absent children', () => {
    const parent = new THREE.Group();
    const child = new THREE.Object3D() as THREE.Object3D & { geometry: { dispose: () => void } };
    let disposals = 0;
    child.geometry = { dispose: () => { disposals += 1; } };
    parent.add(child);

    detachGraphObject3D(parent, child);
    detachGraphObject3D(parent, null);

    expect(parent.children).toEqual([]);
    expect(disposals).toBe(1);
  });

  test('moves renderer ownership out of the legacy Svelte tree', () => {
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');
    const visuals = readFileSync('frontend/src/lib/view/panels/graph3d/graph3d-visuals.ts', 'utf8');

    expect(panel).toContain('packages/ui/src/graph3d-renderer');
    expect(visuals).toContain('packages/ui/src/graph3d-renderer');
    expect(() => readFileSync('frontend/src/lib/view/panels/graph3d/graph3d-renderer.ts', 'utf8')).toThrow();
  });
});
