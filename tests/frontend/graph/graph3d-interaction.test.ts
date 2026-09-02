import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import {
  findGraphEntityFromObject,
  resetGraphObjectHighlight,
  setGraphPointerNdc,
} from '../../../frontend/packages/ui/src/graph3d-interaction';

describe('Graph3D shared interaction boundary', () => {
  test('projects client coordinates into normalized device coordinates', () => {
    const pointer = new THREE.Vector2();
    const bounds = { left: 100, top: 50, width: 200, height: 100 };

    setGraphPointerNdc(pointer, { clientX: 100, clientY: 50 }, bounds);
    expect(pointer.toArray()).toEqual([-1, 1]);
    setGraphPointerNdc(pointer, { clientX: 200, clientY: 100 }, bounds);
    expect(pointer.toArray()).toEqual([0, 0]);
    setGraphPointerNdc(pointer, { clientX: 300, clientY: 150 }, bounds);
    expect(pointer.toArray()).toEqual([1, -1]);
  });

  test('rejects invalid viewport and pointer inputs', () => {
    const pointer = new THREE.Vector2();
    const bounds = { left: 0, top: 0, width: 100, height: 100 };

    expect(() => setGraphPointerNdc(pointer, { clientX: 0, clientY: 0 }, { ...bounds, width: 0 })).toThrow(
      'GRAPH_VIEWPORT_BOUNDS_INVALID',
    );
    expect(() => setGraphPointerNdc(pointer, { clientX: Number.NaN, clientY: 0 }, bounds)).toThrow(
      'GRAPH_POINTER_COORDINATES_INVALID',
    );
  });

  test('resolves nested entity visuals without escaping graph scene roots', () => {
    const scene = new THREE.Scene();
    const graphWorld = new THREE.Group();
    const entityMesh = new THREE.Mesh();
    const nestedVisual = new THREE.Mesh();
    const unrelatedVisual = new THREE.Mesh();
    const entity = { id: 'alice', mesh: entityMesh };
    scene.add(graphWorld);
    graphWorld.add(entityMesh, unrelatedVisual);
    entityMesh.add(nestedVisual);

    expect(findGraphEntityFromObject(entityMesh, [entity], graphWorld, scene)).toBe(entity);
    expect(findGraphEntityFromObject(nestedVisual, [entity], graphWorld, scene)).toBe(entity);
    expect(findGraphEntityFromObject(unrelatedVisual, [entity], graphWorld, scene)).toBeNull();
    expect(findGraphEntityFromObject(null, [entity], graphWorld, scene)).toBeNull();
  });

  test('restores canonical entity and connection highlight colors', () => {
    const entityMaterial = new THREE.MeshLambertMaterial({ emissive: 0xffff00 });
    const lineMaterial = new THREE.LineDashedMaterial({ color: 0xffff00 });
    const entity = new THREE.Mesh(new THREE.BoxGeometry(), entityMaterial);
    const connection = new THREE.Line(new THREE.BufferGeometry(), lineMaterial);

    resetGraphObjectHighlight(entity);
    resetGraphObjectHighlight(connection);

    expect(entityMaterial.emissive.getHex()).toBe(0x002200);
    expect(lineMaterial.color.getHex()).toBe(0x00ff44);
  });

  test('moves reusable hit mechanics out of the canonical Svelte panel', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-interaction.ts', 'utf8');
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');

    expect(shared).toContain('export function setGraphPointerNdc');
    expect(shared).toContain('export function findGraphEntityFromObject');
    expect(shared).toContain('export function resetGraphObjectHighlight');
    expect(panel).toContain('packages/ui/src/graph3d-interaction');
    expect(panel).not.toContain('function entityFromObject');
    expect(panel).not.toContain('function resetHoveredObjectHighlight');
    expect(panel).not.toContain('clientX - rect.left');
  });
});
