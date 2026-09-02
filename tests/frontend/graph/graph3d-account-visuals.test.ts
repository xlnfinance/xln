import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from '../../../frontend/node_modules/three';
import type { Delta } from '../../../core/types/account';
import { classifyBilateralState, getAccountBarVisual } from '../../../core/account/view-state';

import {
  buildGraphAccountVisuals,
  createAccountMempoolBoxes,
  type GraphAccountBarRenderRequest,
} from '../../../frontend/packages/ui/src/graph3d-account-visuals';
import { createAccountBars } from '../../../frontend/src/lib/network3d/AccountBarRenderer';

const createDelta = (tokenId: number): Delta => ({
  tokenId,
  collateral: 0n,
  ondelta: 0n,
  offdelta: 0n,
  leftCreditLimit: 1_000_000n,
  rightCreditLimit: 1_000_000n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
});

const barRuntime = {
  deriveDelta: () => ({
    delta: 0n,
    totalCapacity: 2_000_000n,
    ownCreditLimit: 1_000_000n,
    peerCreditLimit: 1_000_000n,
    inCapacity: 1_000_000n,
    outCapacity: 1_000_000n,
    collateral: 0n,
    outOwnCredit: 1_000_000n,
    inCollateral: 0n,
    outPeerCredit: 0n,
    inOwnCredit: 0n,
    outCollateral: 0n,
    inPeerCredit: 1_000_000n,
  }),
  getTokenInfo: () => ({ decimals: 6 }),
};

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

  test('preserves canonical Account lookup and height projection when draw direction is reversed', () => {
    const leftDeltas = new Map([[1, createDelta(1)]]);
    const rightDeltas = new Map([[1, createDelta(1)], [2, createDelta(2)]]);
    const leftAccount = { state: { deltas: leftDeltas }, currentFrame: { height: 4 }, mempool: [{}] };
    const rightAccount = {
      state: { deltas: rightDeltas },
      currentFrame: { height: 7 },
      pendingFrame: { height: 8, accountTxs: [{}] },
      activeDispute: { startedByLeft: false, disputeTimeout: 20, initialNonce: 3 },
    };
    const calls: Array<{ account: typeof leftAccount | typeof rightAccount | undefined; peerHeight: number; isLeft: boolean }> = [];
    const requests: GraphAccountBarRenderRequest<Delta, ReturnType<typeof getAccountBarVisual>>[] = [];
    const graphWorld = new THREE.Group();

    const result = buildGraphAccountVisuals({
      graphWorld,
      fromEntity: { id: 'bob', position: new THREE.Vector3(10, 0, 0) },
      toEntity: { id: 'alice', position: new THREE.Vector3(0, 0, 0) },
      fromId: 'bob',
      toId: 'alice',
      replicas: new Map([
        ['alice:device', { state: { accounts: new Map([['bob', leftAccount]]) } }],
        ['bob:device', { state: { accounts: new Map([['alice', rightAccount]]) } }],
      ]),
      barsMode: 'close',
      portfolioScale: 5000,
      getEntitySize: () => 1,
      classifyBilateralState: (account, peerHeight, isLeft) => {
        calls.push({ account, peerHeight, isLeft });
        return classifyBilateralState(account, peerHeight, isLeft);
      },
      getAccountBarVisual,
      renderBars: request => {
        requests.push(request);
        return createAccountBars(
          request.graphWorld,
          request.fromEntity,
          request.toEntity,
          request.deltas,
          request.fromIsLeft,
          {
            barsMode: request.barsMode,
            portfolioScale: request.portfolioScale,
            desyncDetected: request.desyncDetected,
            bilateralState: request.bilateralState,
            dispute: request.dispute,
          },
          request.getEntitySize,
          barRuntime,
        );
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.deltas).toBe(rightDeltas);
    expect(requests[0]?.fromIsLeft).toBe(false);
    expect(requests[0]?.desyncDetected).toBe(true);
    expect(requests[0]?.dispute).toEqual(rightAccount.activeDispute);
    expect(result.bars.children).toHaveLength(2);
    expect(result.mempoolBoxes).toHaveLength(2);
    expect(graphWorld.children).toContain(result.bars);
    expect(calls).toEqual([
      { account: rightAccount, peerHeight: 4, isLeft: true },
      { account: leftAccount, peerHeight: 7, isLeft: false },
      { account: leftAccount, peerHeight: 0, isLeft: true },
      { account: rightAccount, peerHeight: 0, isLeft: false },
    ]);
  });

  test('keeps the empty-delta short circuit attached and side-effect free', () => {
    const graphWorld = new THREE.Group();
    let classifyCalls = 0;
    let renderCalls = 0;
    const result = buildGraphAccountVisuals({
      graphWorld,
      fromEntity: { id: 'alice', position: new THREE.Vector3() },
      toEntity: { id: 'bob', position: new THREE.Vector3(1, 0, 0) },
      fromId: 'alice',
      toId: 'bob',
      replicas: new Map([
        ['alice:device', { state: { accounts: new Map([['bob', { state: { deltas: new Map<number, Delta>() } }]]) } }],
      ]),
      barsMode: 'spread',
      portfolioScale: 5000,
      getEntitySize: () => 1,
      classifyBilateralState: (account, peerHeight, isLeft) => {
        classifyCalls += 1;
        return classifyBilateralState(account, peerHeight, isLeft);
      },
      getAccountBarVisual,
      renderBars: request => {
        renderCalls += 1;
        return createAccountBars(
          request.graphWorld,
          request.fromEntity,
          request.toEntity,
          request.deltas,
          request.fromIsLeft,
          { barsMode: request.barsMode, portfolioScale: request.portfolioScale },
          request.getEntitySize,
          barRuntime,
        );
      },
    });

    expect(classifyCalls).toBe(0);
    expect(renderCalls).toBe(0);
    expect(result.mempoolBoxes).toEqual([]);
    expect(result.bars.parent).toBe(graphWorld);
  });

  test('moves Account visual orchestration while keeping financial bar derivation canonical', () => {
    const shared = readFileSync('frontend/packages/ui/src/graph3d-account-visuals.ts', 'utf8');
    const legacy = readFileSync('frontend/src/lib/view/panels/graph3d/graph3d-visuals.ts', 'utf8');
    const canonicalBars = readFileSync('frontend/src/lib/network3d/AccountBarRenderer.ts', 'utf8');

    expect(shared).toContain('export function buildGraphAccountVisuals');
    expect(shared).toContain('export function createAccountMempoolBoxes');
    expect(shared).not.toContain('deriveDelta');
    expect(legacy).toContain('createAccountBars(');
    expect(legacy).toContain('buildSharedGraphAccountVisuals');
    expect(legacy).not.toContain('const leftAccount =');
    expect(legacy).not.toContain('function createMempoolBox');
    expect(legacy).not.toContain('export function createAccountMempoolBoxes');
    expect(legacy).toContain('packages/ui/src/graph3d-account-visuals');
    expect(canonicalBars).toContain('toDerivedAccountData(xlnFunctions.deriveDelta(delta, fromIsLeft))');
  });
});
