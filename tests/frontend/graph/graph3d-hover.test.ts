import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';

import {
  highlightGraphHoverTarget,
  resolveGraphHoverHit,
} from '../../../frontend/packages/ui/src/graph3d-hover';

const createRaycaster = (): THREE.Raycaster =>
  new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));

const createConnection = () => {
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1, 0, 0.75),
      new THREE.Vector3(1, 0, 0.75),
    ]),
    new THREE.LineDashedMaterial({ color: 0x00ff44 }),
  );
  return { from: 'alice', to: 'bob', line };
};

describe('Graph3D shared hover mechanics', () => {
  test('gives entity intersections priority over connection intersections', () => {
    const scene = new THREE.Scene();
    const graphWorld = new THREE.Group();
    const entity = {
      id: 'alice',
      mesh: new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial({ emissive: 0x002200 }),
      ),
    };
    const connection = createConnection();
    scene.add(graphWorld);
    graphWorld.add(entity.mesh, connection.line);
    scene.updateMatrixWorld(true);

    const hit = resolveGraphHoverHit(createRaycaster(), [entity], [connection], graphWorld, scene);

    expect(hit.kind).toBe('entity');
    if (hit.kind !== 'entity') throw new Error('GRAPH_HOVER_ENTITY_HIT_EXPECTED');
    expect(hit.entity).toBe(entity);
    expect(hit.target).toBe(entity.mesh);
  });

  test('resolves a connection when no entity is intersected', () => {
    const scene = new THREE.Scene();
    const graphWorld = new THREE.Group();
    const connection = createConnection();
    scene.add(graphWorld);
    graphWorld.add(connection.line);
    scene.updateMatrixWorld(true);

    const hit = resolveGraphHoverHit(createRaycaster(), [], [connection], graphWorld, scene);

    expect(hit.kind).toBe('connection');
    if (hit.kind !== 'connection') throw new Error('GRAPH_HOVER_CONNECTION_HIT_EXPECTED');
    expect(hit.connection).toBe(connection);
    expect(hit.target).toBe(connection.line);
  });

  test('returns none when the ray intersects no graph object', () => {
    const scene = new THREE.Scene();
    const graphWorld = new THREE.Group();
    scene.add(graphWorld);

    expect(resolveGraphHoverHit(createRaycaster(), [], [], graphWorld, scene)).toEqual({ kind: 'none' });
  });

  test('applies the canonical entity and connection hover colors', () => {
    const entityMaterial = new THREE.MeshLambertMaterial({ emissive: 0x002200 });
    const connectionMaterial = new THREE.LineDashedMaterial({ color: 0x00ff44 });
    const entity = new THREE.Mesh(new THREE.BoxGeometry(), entityMaterial);
    const connection = new THREE.Line(new THREE.BufferGeometry(), connectionMaterial);

    highlightGraphHoverTarget('entity', entity);
    highlightGraphHoverTarget('connection', connection);

    expect(entityMaterial.emissive.getHex()).toBe(0x444400);
    expect(connectionMaterial.color.getHex()).toBe(0xffff00);
  });

  test('fails loudly when a hover target lacks the required material capability', () => {
    expect(() => highlightGraphHoverTarget('entity', new THREE.Mesh())).toThrow(
      'FINTECH-SAFETY: Entity material missing emissive property',
    );
    expect(() => highlightGraphHoverTarget('connection', new THREE.Object3D())).toThrow(
      'FINTECH-SAFETY: Connection material missing color property',
    );
  });

  test('moves reusable hover mechanics out of the canonical Svelte panel', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-hover.ts', 'utf8');
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');

    expect(shared).toContain('export function resolveGraphHoverHit');
    expect(shared).toContain('export function highlightGraphHoverTarget');
    expect(panel).toContain('packages/ui/src/graph3d-hover');
    expect(panel).not.toContain('const entityIntersects = raycaster.intersectObjects');
    expect(panel).not.toContain('const lineIntersects = raycaster.intersectObjects');
    expect(panel).not.toContain('material.emissive.setHex(0x444400)');
    expect(panel).not.toContain('lineMaterial.color.setHex(0xffff00)');
  });
});
