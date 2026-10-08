import { describe, expect, test } from 'bun:test';
import * as THREE from '../../../frontend/node_modules/three';

import { presentationCapacityScale, stageUnit } from '../../../frontend/src/lib/view/panels/graph3d/graph3d-stage';
import { DEMO_STORY, demoChapterHref, demoChapterPosition } from '../../../frontend/src/lib/network3d/timeline/demoStory';
import {
  depositoryLedger,
  formatLedgerAmount,
  formatStageAmount,
  formatStageChange,
  presentationLegendKeys,
} from '../../../frontend/src/lib/network3d/timeline/presentationStage';
import { accountAnnotationLines } from '../../../frontend/src/lib/network3d/accountAnnotation';
import { deriveDelta } from '../../../core/account/utils';

const point = (x: number, y = 0) => new THREE.Vector3(x, y, 0);
const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));

describe('presentation stage sizing', () => {
  test('a stage unit follows the network span and is clamped', () => {
    expect(stageUnit([point(-40), point(40)])).toBe(1);
    expect(stageUnit([point(-20), point(20)])).toBe(0.5);
    expect(stageUnit([point(-1000), point(1000)])).toBe(3);
    expect(stageUnit([point(0)])).toBe(1);
  });

  test('one dollar scale in every part: the same value draws the same bar at a given stage unit', () => {
    const scale = presentationCapacityScale([
      { tokenId: 1, symbol: 'USDC', decimals: 6 },
      { tokenId: 2, symbol: 'WETH', decimals: 18 },
    ], 1);
    expect(Number(usdc(1_000_000)) * scale.get(1)!).toBeCloseTo(26);
    // WETH is valued at the demo's 3,000 USDC per WETH.
    expect((1_000_000 / 3_000) * 1e18 * scale.get(2)!).toBeCloseTo(26);
    expect(Number(usdc(500_000)) * presentationCapacityScale([{ tokenId: 1, symbol: 'USDC', decimals: 6 }], 0.5).get(1)!).toBeCloseTo(6.5);
    expect(() => presentationCapacityScale([{ tokenId: 9, symbol: 'XYZ', decimals: 6 }], 1)).toThrow('GRAPH_PRESENTATION_BAR_SCALE_MISSING:XYZ');
  });
});

describe('presentation numbers', () => {
  test('stage amounts never round a visible change away', () => {
    expect([950, 1_000, 9_999, 12_500, 125_000, 199_999.95, 999_999, 2_000_000, 4_960_000].map((value) => formatStageAmount(usdc(value), 6)))
      .toEqual(['950', '1,000', '9,999', '12.5K', '125K', '200K', '1.0M', '2.0M', '4.96M']);
    expect(formatStageChange(usdc(-50), 6)).toBe('−50');
    expect(formatStageChange(usdc(200_000), 6)).toBe('+200K');
    expect(formatLedgerAmount(usdc(199_999.95), { symbol: 'USDC', decimals: 6 })).toBe('199,999.95');
  });

  const ALICE = `0x${'a'.repeat(64)}`;
  const HUB = `0x${'b'.repeat(64)}`;
  const delta = (fields: Partial<Record<string, bigint>>) => ({
    tokenId: 1, collateral: 0n, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n,
    leftAllowance: 0n, rightAllowance: 0n, leftHold: 0n, rightHold: 0n, ...fields,
  });
  const frameWith = (aliceReserve: bigint, collateral: bigint, debts: unknown[] = []) => new Map([['r', {
    runtimeId: 'r', height: 1, timestamp: 1, stateHash: '',
    entities: [
      { summary: { entityId: ALICE, label: 'Alice', position: { x: -40 } }, core: { reserves: new Map([[1, aliceReserve]]) }, accounts: { items: [{ leftEntity: ALICE, rightEntity: HUB, deltas: new Map([[1, delta({ collateral, ondelta: collateral, offdelta: usdc(-125_000) })]]) }] } },
      { summary: { entityId: HUB, label: 'Hub', position: { x: 0 } }, core: { reserves: new Map([[1, 0n]]), debts }, accounts: { items: [] } },
    ],
  }]]) as never;

  test('the Depository ledger lists reserves, collateral and debts, with the change since the last frame', () => {
    const before = frameWith(usdc(2_500_000), 0n);
    const after = frameWith(usdc(2_000_000), usdc(500_000), [{ tokenId: 1, creditor: ALICE, remaining: usdc(50_000), queueIndex: 0 }]);
    const ledger = depositoryLedger(after, before);
    expect(ledger.reserves.map((row) => [row.label, row.amount, row.change])).toEqual([['Alice', usdc(2_000_000), usdc(-500_000)], ['Hub', 0n, 0n]]);
    expect(ledger.collateral.map((row) => [row.label, row.amount, row.change])).toEqual([['Alice–Hub', usdc(500_000), usdc(500_000)]]);
    expect(ledger.debts.map((row) => [row.label, row.amount])).toEqual([['Hub owes Alice', usdc(50_000)]]);
    expect(depositoryLedger(after, new Map()).reserves.every((row) => row.change === 0n)).toBe(true);
  });

  test('the legend names only what the stage draws, and annotations state the bars in words', () => {
    const frames = frameWith(usdc(2_000_000), usdc(500_000));
    expect([...presentationLegendKeys(frames, deriveDelta as never)].sort()).toEqual(['collateral', 'netPosition']);
    const lines = accountAnnotationLines(ALICE, HUB, new Map([[1, delta({ collateral: usdc(500_000), ondelta: usdc(500_000), offdelta: usdc(-125_000) })]]) as never, {
      labelFor: (id) => (id === ALICE ? 'Alice' : 'Hub'),
      formatAmount: (_tokenId, amount) => formatStageAmount(amount, 6),
      symbolOf: () => 'USDC',
      derive: deriveDelta as never,
      lineHeight: 1,
    });
    expect(lines.map((line) => line.text)).toEqual(["collateral 500K · Hub's share 125K"]);
    const unsecured = accountAnnotationLines(ALICE, HUB, new Map([[1, delta({ offdelta: usdc(250_000), leftCreditLimit: usdc(500_000) })]]) as never, {
      labelFor: (id) => (id === ALICE ? 'Bob' : 'Hub'),
      formatAmount: (_tokenId, amount) => formatStageAmount(amount, 6),
      symbolOf: () => 'USDC',
      derive: deriveDelta as never,
      lineHeight: 1,
    });
    expect(unsecured.map((line) => line.text)).toEqual(['Hub owes Bob 250K, unsecured']);
  });
});

describe('presenter story', () => {
  test('chapters run from a payment to unilateral exit, each pointing at the next', () => {
    expect(DEMO_STORY.map((chapter) => chapter.trail)).toEqual(['ahb', 'lock-ahb', 'swap', 'settle', 'dispute-lifecycle']);
    expect(demoChapterPosition('swap')).toMatchObject({ index: 2, count: 5, next: { trail: 'settle' } });
    expect(demoChapterPosition('dispute-lifecycle')?.next).toBeNull();
    expect(demoChapterPosition('grid')).toBeNull();
    expect(demoChapterHref('lock-ahb')).toBe('/embed?trail=lock-ahb&present=1');
  });
});
