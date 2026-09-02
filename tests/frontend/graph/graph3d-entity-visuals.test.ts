import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import {
  createEntityLabel,
  createGraphEntityNode,
  createMempoolIndicator,
  positionEntityLabel,
  positionMempoolIndicator,
} from '../../../frontend/packages/ui/src/graph3d-entity-visuals';

const withCanvasDocument = <T>(run: () => T): T => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect: () => {},
          fillStyle: '',
          fillText: () => {},
          font: '',
          lineWidth: 0,
          strokeStyle: '',
          strokeText: () => {},
          textAlign: '',
          textBaseline: '',
        }),
      }),
    },
  });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
};

describe('Graph3D shared entity visuals', () => {
  test('positions labels and mempool indicators relative to entity scale', () => {
    const label = new THREE.Sprite();
    label.userData['worldHeight'] = 4;
    positionEntityLabel(label, 2);
    expect(label.scale.toArray()).toEqual([8, 2, 1]);
    expect(label.position.toArray()).toEqual([0, 2.5, 0]);

    const indicator = new THREE.Sprite();
    positionMempoolIndicator(indicator, 2);
    expect(indicator.scale.toArray()).toEqual([1.2, 0.6, 1]);
    expect(indicator.position.toArray()).toEqual([1.85, 0, 0]);
    expect(() => positionEntityLabel(label, 0)).toThrow('GRAPH_ENTITY_SIZE_INVALID:0');
    expect(() => positionMempoolIndicator(indicator, Number.NaN)).toThrow('GRAPH_ENTITY_SIZE_INVALID:NaN');
  });

  test('builds canvas-backed labels and indicators with canonical metadata', () => withCanvasDocument(() => {
    const label = createEntityLabel({ flag: '🇺🇸', labelText: 'Alice', key: 'alice:1' }, 2, true);
    const indicator = createMempoolIndicator('alice');

    expect(label.userData['worldHeight']).toBeCloseTo(13.2);
    expect(label.userData['contentKey']).toBe('alice:1');
    expect(indicator.userData['entityId']).toBe('alice');
    expect(indicator.userData['canvas']).toMatchObject({ width: 128, height: 64 });
    expect(indicator.scale.toArray()).toEqual([1, 0.5, 1]);
  }));

  test('preserves position precedence, jurisdiction offsets, and federal styling', () => withCanvasDocument(() => {
    const userPosition = createGraphEntityNode({
      profile: { entityId: 'alice', metadata: { position: { x: 30, y: 30, z: 30 } } },
      index: 0,
      total: 2,
      forceLayoutPosition: new THREE.Vector3(40, 40, 40),
      forceLayoutEnabled: true,
      isHub: false,
      replica: { signerId: 'alice_fed', position: { x: 3, y: 3, z: 3, jurisdiction: 'ECB' } },
      userPosition: { x: 1, y: 2, z: 3 },
      persistedPosition: { x: 4, y: 5, z: 6, jurisdiction: 'ECB' },
      defaultJurisdiction: 'default',
      resolveJMachinePosition: () => ({ x: 100, y: 200, z: 300 }),
      selectedTokenId: 1,
      getEntitySize: () => 2,
      labelContent: { flag: '', labelText: 'Alice', key: 'alice' },
      labelScale: 1,
      isVrActive: false,
    });
    const persistedPosition = createGraphEntityNode({
      profile: { entityId: 'bob' },
      index: 1,
      total: 2,
      forceLayoutPosition: undefined,
      forceLayoutEnabled: true,
      isHub: true,
      replica: null,
      userPosition: undefined,
      persistedPosition: { x: 4, y: 5, z: 6, jurisdiction: 'ECB' },
      defaultJurisdiction: 'default',
      resolveJMachinePosition: () => ({ x: 100, y: 200, z: 300 }),
      selectedTokenId: 1,
      getEntitySize: () => 1,
      labelContent: { flag: '', labelText: 'Bob', key: 'bob' },
      labelScale: 1,
      isVrActive: false,
    });

    expect(userPosition.position.toArray()).toEqual([1, 2, 3]);
    expect(userPosition.mesh.scale.toArray()).toEqual([2, 2, 2]);
    expect(userPosition.mesh.userData).toMatchObject({ isFed: true, isHub: false });
    expect(userPosition.mesh.children).toHaveLength(2);
    expect(persistedPosition.position.toArray()).toEqual([104, 205, 306]);
    expect((persistedPosition.mesh.material as THREE.MeshLambertMaterial).emissiveIntensity).toBe(1.5);
  }));

  test('moves entity construction out of the legacy visual factory', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-entity-visuals.ts', 'utf8');
    const legacy = readFileSync('frontend/src/lib/view/panels/graph3d/graph3d-visuals.ts', 'utf8');
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');

    for (const symbol of [
      'positionEntityLabel',
      'createEntityLabel',
      'createMempoolIndicator',
      'positionMempoolIndicator',
      'createGraphEntityNode',
    ]) {
      expect(shared).toContain(`export function ${symbol}`);
      expect(legacy).not.toContain(`export function ${symbol}`);
    }
    expect(panel).toContain('packages/ui/src/graph3d-entity-visuals');
  });
});
