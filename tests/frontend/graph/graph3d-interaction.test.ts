import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import {
  beginGraphEntityDrag,
  endGraphEntityDrag,
  findGraphEntityFromObject,
  moveGraphEntityDrag,
  resetGraphObjectHighlight,
  setGraphPointerNdc,
  updateGraphSelectionHighlight,
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

  test('replaces and disposes the canonical entity selection highlight', () => {
    const alice = { id: 'alice', mesh: new THREE.Mesh() };
    const bob = { id: 'bob', mesh: new THREE.Mesh() };

    updateGraphSelectionHighlight([alice, bob], 'alice');
    const first = alice.mesh.getObjectByName('graph-selection-highlight');
    expect(first?.rotation.x).toBe(Math.PI / 2);
    expect(bob.mesh.getObjectByName('graph-selection-highlight')).toBeUndefined();

    updateGraphSelectionHighlight([alice, bob], 'bob');
    expect(alice.mesh.getObjectByName('graph-selection-highlight')).toBeUndefined();
    expect(bob.mesh.getObjectByName('graph-selection-highlight')).toBeDefined();
  });

  test('shares exact drag-plane offset, movement, and material state', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster(new THREE.Vector3(1, 1, 10), new THREE.Vector3(0, 0, -1));
    const material = new THREE.MeshLambertMaterial({ emissive: 0x002200 });
    const entity = {
      position: new THREE.Vector3(2, 3, 0),
      mesh: new THREE.Mesh(new THREE.BoxGeometry(), material),
      isDragging: false,
    };
    const dragPlane = new THREE.Plane();
    const dragOffset = new THREE.Vector3();

    beginGraphEntityDrag(camera, raycaster, entity, dragPlane, dragOffset);
    expect(entity.isDragging).toBe(true);
    expect(dragPlane.normal.x).toBeCloseTo(0);
    expect(dragPlane.normal.y).toBeCloseTo(0);
    expect(dragPlane.normal.z).toBe(-1);
    expect(dragOffset.toArray()).toEqual([1, 2, 0]);
    expect(material.emissive.getHex()).toBe(0x00ff88);

    raycaster.ray.origin.set(4, 5, 10);
    moveGraphEntityDrag(raycaster, entity, dragPlane, dragOffset);
    expect(entity.position.toArray()).toEqual([5, 7, 0]);
    expect(entity.mesh.position.toArray()).toEqual([5, 7, 0]);

    endGraphEntityDrag(entity);
    expect(entity.isDragging).toBe(false);
    expect(material.emissive.getHex()).toBe(0x002200);
  });

  test('moves reusable hit mechanics out of the canonical Svelte panel', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-interaction.ts', 'utf8');
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');

    expect(shared).toContain('export function setGraphPointerNdc');
    expect(shared).toContain('export function findGraphEntityFromObject');
    expect(shared).toContain('export function resetGraphObjectHighlight');
    expect(shared).toContain('export const beginGraphGesture');
    expect(shared).toContain('export function beginGraphEntityDrag');
    expect(shared).toContain('export function moveGraphEntityDrag');
    expect(shared).toContain('export function endGraphEntityDrag');
    expect(shared).toContain('export function updateGraphSelectionHighlight');
    expect(panel).toContain('packages/ui/src/graph3d-interaction');
    expect(panel).not.toContain('function entityFromObject');
    expect(panel).not.toContain('function resetHoveredObjectHighlight');
    expect(panel).not.toContain('function updateGraphSelectionVisual');
    expect(panel).not.toContain('clientX - rect.left');
    expect(panel).not.toContain('dragPlane.setFromNormalAndCoplanarPoint');
    expect(panel).not.toContain('raycaster.ray.intersectPlane(dragPlane');
    expect(existsSync('frontend/src/lib/network3d/graphSelectionGesture.ts')).toBe(false);
  });
});
