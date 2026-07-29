import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
// `three` is a frontend-only dependency; the root test runner has no copy of its own.
import * as THREE from '../../frontend/node_modules/three';

import { createAccountBars } from '../../frontend/src/lib/network3d/AccountBarRenderer';
import { toDerivedAccountData } from '../../frontend/src/lib/network3d/derivedAccount';
import { createGraphGrid } from '../../frontend/src/lib/view/panels/graph3d-visuals';

const endpoint = (id: string, x: number) => ({ id, position: new THREE.Vector3(x, 0, 0) });

const runtime = {
  deriveDelta: () => ({
    delta: 0n,
    totalCapacity: 2_000_000n,
    ownCreditLimit: 1_000_000n,
    peerCreditLimit: 1_000_000n,
    inCapacity: 1_000_000n,
    outCapacity: 1_000_000n,
    collateral: 500_000n,
    outOwnCredit: 400_000n,
    inCollateral: 500_000n,
    outPeerCredit: 300_000n,
    inOwnCredit: 200_000n,
    outCollateral: 500_000n,
    inPeerCredit: 100_000n,
  }),
  getTokenInfo: () => ({ symbol: 'USDC', decimals: 6 }),
};

const buildBars = (parent: THREE.Object3D) =>
  createAccountBars(
    parent,
    endpoint('a', 0),
    endpoint('b', 40),
    // A used lane: the stubbed deriveDelta above reports collateral, so the stored delta
    // has to carry it too — an empty lane is skipped before any bar is built.
    new Map([[1, { tokenId: 1, collateral: 500_000n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 1_000_000n, rightCreditLimit: 1_000_000n }]]),
    true,
    { barsMode: 'close', portfolioScale: 5000 },
    () => 1,
    runtime,
  );

describe('account bar parenting', () => {
  test('bars attach to the object the caller passes, so removal from it works', () => {
    const scene = new THREE.Scene();
    const graphWorld = new THREE.Group();
    scene.add(graphWorld);

    const bars = buildBars(graphWorld);

    expect(bars.parent).toBe(graphWorld);
    expect(graphWorld.children).toContain(bars);
    // Regression: bars used to attach to the scene while every cleanup path removed them
    // from graphWorld, so removal was a silent no-op and each rebuild leaked a bar group.
    expect(scene.children.filter((child) => child !== graphWorld)).toHaveLength(0);

    graphWorld.remove(bars);
    expect(graphWorld.children).toHaveLength(0);
    expect(bars.parent).toBeNull();
  });

  test('repeated rebuild-and-detach cycles leave no orphaned groups behind', () => {
    const graphWorld = new THREE.Group();
    for (let cycle = 0; cycle < 25; cycle += 1) {
      graphWorld.remove(buildBars(graphWorld));
    }
    expect(graphWorld.children).toHaveLength(0);
  });

  test('bars inherit graph-world transforms (VR scales the world, not the scene)', () => {
    const graphWorld = new THREE.Group();
    graphWorld.scale.setScalar(0.01);
    graphWorld.position.set(0, -0.5, -1);
    graphWorld.updateMatrixWorld(true);

    const bars = buildBars(graphWorld);
    graphWorld.updateMatrixWorld(true);

    const worldScale = new THREE.Vector3();
    bars.getWorldScale(worldScale);
    expect(worldScale.x).toBeCloseTo(0.01, 6);
  });

  test('graph content is built into graphWorld, so cleanup and VR transforms apply to it', () => {
    const panel = readFileSync('frontend/src/lib/view/panels/Graph3DPanel.svelte', 'utf8');
    const visuals = readFileSync('frontend/src/lib/view/panels/graph3d-visuals.ts', 'utf8');
    const bars = readFileSync('frontend/src/lib/network3d/AccountBarRenderer.ts', 'utf8');

    // The visual builders take no scene at all — everything lands in graphWorld.
    for (const source of [visuals, bars]) {
      expect(source).not.toMatch(/\bscene\.\w+\(/); // no scene.add(...) / scene.remove(...)
      expect(source).not.toMatch(/\bscene\s*:/); // no `scene:` option or parameter
    }
    expect(panel).toContain('function detachFromGraphWorld');
    expect(panel).toContain('createAccountBarsForConnection');

    // `scene.add` in the panel is only ever the world group, lights and head-locked XR nodes.
    const sceneAdds = panel.match(/scene\.add\(([^)]*)\)/g) ?? [];
    for (const call of sceneAdds) {
      expect(call).toMatch(/graphWorld|Light|controller|mesh/);
    }
  });

  test('grid honours the configured size and divisions', () => {
    const vertexCount = (grid: THREE.GridHelper) => grid.geometry.getAttribute('position').count;

    // Regression: size/divisions were hardcoded to (2000, 3), so both Settings sliders
    // rebuilt an identical grid and looked broken.
    expect(vertexCount(createGraphGrid('#ffffff', 0.4, 2000, 3))).toBe(16);
    expect(vertexCount(createGraphGrid('#ffffff', 0.4, 2000, 40))).toBe(164);

    const grid = createGraphGrid('#00ff41', 0.25, 300, 12);
    expect(grid.material.opacity).toBe(0.25);
    expect(grid.material.transparent).toBe(true);
    expect(vertexCount(grid)).toBe(52);

    // Divisions below 1 would produce a degenerate grid.
    expect(vertexCount(createGraphGrid('#ffffff', 0.4, 2000, 0))).toBe(8);
  });

  test('derived-account conversion has a single implementation', () => {
    const derived = toDerivedAccountData(runtime.deriveDelta());
    expect(derived.collateral).toBe(500_000);
    expect(derived.inPeerCredit).toBe(100_000);
    expect(toDerivedAccountData(null).totalCapacity).toBe(0);

    for (const file of [
      'frontend/src/lib/network3d/AccountBarRenderer.ts',
      'frontend/src/lib/view/panels/graph3d-visuals.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain('inPeerCredit: Number(');
    }
  });
});
