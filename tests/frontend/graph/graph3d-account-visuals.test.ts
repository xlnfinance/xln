import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import { createAccountMempoolBoxes } from '../../../frontend/packages/ui/src/graph3d-account-visuals';

const readMaterialColor = (object: THREE.Object3D | undefined): number => {
  if (!object || !('material' in object)) throw new Error('TEST_GRAPH_MATERIAL_MISSING');
  const material = object.material;
  if (typeof material !== 'object' || material === null || !('color' in material)) {
    throw new Error('TEST_GRAPH_MATERIAL_COLOR_MISSING');
  }
  const color = material.color;
  if (typeof color !== 'object' || color === null || !('getHex' in color) || typeof color.getHex !== 'function') {
    throw new Error('TEST_GRAPH_COLOR_INVALID');
  }
  return color.getHex();
};

describe('Graph3D shared Account visuals', () => {
  test('positions one mempool box per observed account side', () => {
    const fromEntity = { id: 'alice', position: new THREE.Vector3(0, 0, 0) };
    const toEntity = { id: 'bob', position: new THREE.Vector3(10, 0, 0) };
    const boxes = createAccountMempoolBoxes({
      fromEntity,
      toEntity,
      leftAccount: { mempool: [{}], pendingFrame: { accountTxs: [{}] } },
      rightAccount: { mempool: [{}, {}, {}], pendingFrame: { accountTxs: [{}, {}, {}] } },
      leftState: 'committed',
      rightState: 'proposal',
      getEntitySize: (entityId) => entityId === 'alice' ? 2 : 3,
    });

    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.position.x).toBeCloseTo(2.2);
    expect(boxes[1]?.position.x).toBeCloseTo(6.8);
    expect(boxes[0]?.position.y).toBe(0);
    expect(boxes[1]?.position.y).toBe(0);
    expect(boxes[0]?.children).toHaveLength(4);
    expect(boxes[1]?.children).toHaveLength(6);
    expect(readMaterialColor(boxes[0]?.children[0])).toBe(0x00ff88);
    expect(readMaterialColor(boxes[1]?.children[0])).toBe(0xff4444);
  });

  test('does not invent a visual for an unobserved account side', () => {
    const boxes = createAccountMempoolBoxes({
      fromEntity: { id: 'alice', position: new THREE.Vector3() },
      toEntity: { id: 'bob', position: new THREE.Vector3(0, 5, 0) },
      leftAccount: null,
      rightAccount: { mempool: [] },
      leftState: null,
      rightState: null,
      getEntitySize: () => 1,
    });

    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.position.toArray()).toEqual([0, 3.8, 0]);
    expect(readMaterialColor(boxes[0]?.children[0])).toBe(0x00ff88);
  });

  test('moves Account mempool geometry while keeping financial bar derivation canonical', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-account-visuals.ts', 'utf8');
    const legacy = readFileSync('frontend/src/lib/view/panels/graph3d/graph3d-visuals.ts', 'utf8');

    expect(shared).toContain('export function createAccountMempoolBoxes');
    expect(legacy).toContain('createAccountBars(');
    expect(legacy).not.toContain('function createMempoolBox');
    expect(legacy).not.toContain('export function createAccountMempoolBoxes');
    expect(legacy).toContain('packages/ui/src/graph3d-account-visuals');
  });
});
