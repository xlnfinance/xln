import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import {
  buildSimpleRadialLayout,
  createGraphJMachine,
  startProportionalBroadcast,
} from '../../../frontend/packages/ui/src/graph3d-scene-primitives';

describe('Graph3D shared scene primitives', () => {
  test('lays out connected entities deterministically by degree and id', () => {
    const positions = buildSimpleRadialLayout(
      [{ entityId: 'charlie' }, { entityId: 'alice' }, { entityId: 'bob' }],
      new Map([
        ['alice', new Set(['bob', 'charlie'])],
        ['bob', new Set(['alice'])],
        ['charlie', new Set(['alice'])],
      ]),
      (left, right) => left.localeCompare(right),
    );

    expect([...positions.keys()]).toEqual(['alice', 'bob', 'charlie']);
    expect(positions.get('alice')?.toArray()).toEqual([50 / 3, 0, 0]);
    expect(positions.get('bob')?.x).toBeCloseTo(-12.5);
    expect(positions.get('bob')?.y).toBeCloseTo(21.650635);
    expect(positions.get('charlie')?.x).toBeCloseTo(-12.5);
    expect(positions.get('charlie')?.y).toBeCloseTo(-21.650635);
    expect(buildSimpleRadialLayout([], new Map(), () => 0).size).toBe(0);
  });

  test('builds the canonical jurisdiction mesh and label', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: '',
            font: '',
            textAlign: '',
            fillText: () => {},
          }),
        }),
      },
    });
    try {
      const machine = createGraphJMachine(30, { x: 1, y: 2, z: 3 }, 'Federal Reserve', 42);

      expect(machine.position.toArray()).toEqual([1, 2, 3]);
      expect(machine.userData).toEqual({
        type: 'jMachine',
        jurisdictionName: 'Federal Reserve',
        position: { x: 1, y: 2, z: 3 },
      });
      expect(machine.children).toHaveLength(3);
      expect(machine.children[2]?.position.toArray()).toEqual([0, -23, 0]);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  test('does not allocate a broadcast animation for an empty batch', () => {
    expect(startProportionalBroadcast({
      graphWorld: new THREE.Group(),
      position: new THREE.Vector3(1, 2, 3),
      transactionCount: 0,
      onComplete: () => {},
    })).toBeNull();
  });

  test('moves scene primitives out of the legacy visual factory', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-scene-primitives.ts', 'utf8');
    const legacy = readFileSync('frontend/src/lib/view/panels/graph3d/graph3d-visuals.ts', 'utf8');
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');

    for (const symbol of [
      'createGraphGrid',
      'createGraphJMachine',
      'startProportionalBroadcast',
      'buildSimpleRadialLayout',
    ]) {
      expect(shared).toContain(`export function ${symbol}`);
      expect(legacy).not.toContain(`export function ${symbol}`);
    }
    expect(panel).toContain('packages/ui/src/graph3d-scene-primitives');
  });
});
