import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';

import {
  fetchDemoNetworkTrail,
  parseNetworkTrail,
  serializeNetworkTrail,
  trailNetworkTimelineSource,
} from '../../../../frontend/src/lib/network3d/timeline/networkTimelineSource';
import { networkTrailFromSnapshots } from '../../../../core/scenarios/network-trail';
import { compileNetworkMachine, DEFAULT_NETWORK_MACHINE_CONFIG } from '../../../../frontend/src/lib/network3d/networkMachine';
import { projectRuntimeGraphFrame } from '../../../../frontend/src/lib/network3d/runtimeGraphProjection';
import { deriveNetworkStepMotion } from '../../../../frontend/src/lib/network3d/timeline/networkStepMotion';

const ALICE = `0x${'a'.repeat(64)}`;
const HUB = `0x${'b'.repeat(64)}`;
const BOB = `0x${'c'.repeat(64)}`;
const TRAIL_DIR = 'frontend/static/demo-trails';

const response = (status: number, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body }) as Response;

describe('offline demo trails', () => {
  test('a demo trail name is a bare slug and a missing file fails loudly', async () => {
    const requested: string[] = [];
    const fetcher = async (path: string) => {
      requested.push(path);
      return response(404);
    };
    await expect(fetchDemoNetworkTrail('../secrets', fetcher)).rejects.toThrow('NETWORK_DEMO_TRAIL_NAME_INVALID:../secrets');
    await expect(fetchDemoNetworkTrail('ahb', fetcher)).rejects.toThrow('NETWORK_DEMO_TRAIL_UNAVAILABLE:ahb:404');
    expect(requested).toEqual(['/demo-trails/ahb.json']);
  });

  test('recorded narration names the parties its frame touched, and frames name their jurisdiction', () => {
    const snapshot = {
      state: {
        height: 4,
        timestamp: 4,
        eReplicas: new Map([[`${HUB}:1`, {
          entityId: HUB,
          signerId: '1',
          state: { height: 4, timestamp: 4, accounts: new Map(), reserves: new Map(), config: { jurisdiction: { name: 'Arrakis', address: 'http://127.0.0.1:20000' } } },
        }]]),
      },
      runtimeInput: {
        runtimeTxs: [],
        jInputs: [],
        entityInputs: [{ entityId: HUB, entityTxs: [{ type: 'htlcPayment', data: { targetEntityId: BOB, route: [ALICE, HUB, BOB] } }] }],
      },
      runtimeOutputs: [],
      description: '',
      meta: { subtitle: { title: 'Payment crosses the hub' } },
    } as never;

    const trail = networkTrailFromSnapshots('demo', [snapshot]);

    expect(trail.cues[0]?.focusEntityIds).toEqual([ALICE, HUB, BOB].sort());
    expect(trail.cues[0]?.focusAccountIds).toEqual([`${ALICE}:${HUB}`, `${HUB}:${BOB}`]);
    expect(trail.frames['4']?.entities[0]?.summary.jurisdiction).toEqual({ name: 'Arrakis' });
  });

  test('a served trail round-trips through the canonical codec', async () => {
    const trail = { version: 1 as const, runtimeId: 'r1', index: { runtimeId: 'r1', frames: [] }, frames: {}, activity: [], cues: [] };
    const fetched = await fetchDemoNetworkTrail('demo-1', async () => response(200, serializeNetworkTrail(trail)));
    expect(fetched).toEqual(trail);
  });

  test('every shipped trail replays and carries payment motion', async () => {
    const files = readdirSync(TRAIL_DIR).filter((name) => name.endsWith('.json')).sort();
    expect(files).toEqual(['ahb.json', 'dispute-lifecycle.json', 'lock-ahb.json', 'settle.json', 'swap.json']);
    for (const file of files) {
      const trail = parseNetworkTrail(readFileSync(`${TRAIL_DIR}/${file}`, 'utf8'));
      const source = trailNetworkTimelineSource(trail);
      const machine = compileNetworkMachine([await source.readIndex()], { ...DEFAULT_NETWORK_MACHINE_CONFIG, cues: source.cues ?? [] });
      expect(machine.steps.length).toBeGreaterThan(10);
      let flows = 0;
      for (let index = 1; index < machine.steps.length && flows <= 3; index += 1) {
        const project = async (height: number) => projectRuntimeGraphFrame(await source.readGraphFrame(height), { runtimeId: trail.runtimeId, adapterKind: 'browser' });
        const motion = deriveNetworkStepMotion({
          key: String(index),
          previous: [await project(machine.steps[index - 1]!.event.height)],
          current: [await project(machine.steps[index]!.event.height)],
          activity: [],
        });
        flows += motion.flows.length;
      }
      expect(flows).toBeGreaterThan(3);
    }
  });

  test('shipped trails speak to the audience: named banks, a named jurisdiction, money in words', () => {
    const fullyNarrated = new Set(['ahb.json', 'lock-ahb.json', 'swap.json', 'settle.json', 'dispute-lifecycle.json']);
    for (const file of readdirSync(TRAIL_DIR).filter((name) => name.endsWith('.json')).sort()) {
      const trail = parseNetworkTrail(readFileSync(`${TRAIL_DIR}/${file}`, 'utf8'));
      const last = trail.frames[String(trail.index.frames.at(-1)!.height)]!;
      for (const entity of last.entities) {
        expect(entity.summary.label, `${file} label`).not.toMatch(/^Entity |^0x/);
        expect(entity.summary.jurisdiction?.name, `${file} jurisdiction`).toBe('Local test chain · Depository');
        expect((entity.summary as { position?: unknown }).position, `${file} authored position`).toBeDefined();
      }
      expect(trail.cues.length, `${file} cues`).toBeGreaterThan(8);
      for (const cue of trail.cues) {
        for (const metric of cue.keyMetrics ?? []) expect(metric, `${file} raw minor units`).not.toMatch(/\d{7,}|e-\d/);
        expect(cue.keyMetrics?.length ?? 0, `${file} ${cue.title} metric cards`).toBeLessThanOrEqual(3);
        if (!fullyNarrated.has(file)) continue;
        expect(cue.what, `${file} ${cue.title} what`).toBeTruthy();
        expect(cue.why, `${file} ${cue.title} why`).toBeTruthy();
        expect(cue.tradfiParallel, `${file} ${cue.title} tradfi`).toBeTruthy();
      }
    }
  });

  test('swap packets can name both legs of a fill', async () => {
    const trail = parseNetworkTrail(readFileSync(`${TRAIL_DIR}/swap.json`, 'utf8'));
    const source = trailNetworkTimelineSource(trail);
    const heights = (await source.readIndex()).frames.map((frame) => frame.height);
    const project = async (height: number) => projectRuntimeGraphFrame(await source.readGraphFrame(height), { runtimeId: trail.runtimeId, adapterKind: 'browser' });
    let legs = 0;
    for (let index = 1; index < heights.length; index += 1) {
      const motion = deriveNetworkStepMotion({ key: String(index), previous: [await project(heights[index - 1]!)], current: [await project(heights[index]!)], activity: [] });
      legs += motion.flows.filter((flow) => flow.kind === 'swap' && flow.swapLegs).length;
    }
    expect(legs).toBeGreaterThan(3);
  });

  /** Every word a cue puts on screen. */
  const cueText = (cue: NonNullable<ReturnType<typeof parseNetworkTrail>['cues']>[number]): string => [
    cue.title, cue.subtitle, cue.what, cue.why, cue.tradfiParallel, ...(cue.keyMetrics ?? []),
    ...(cue.badges ?? []).flatMap((badge) => [badge.label, badge.detail]),
  ].filter(Boolean).join(' \n ');

  test('shipped narration never overstates: no central bank money, no risk-free claims, no jargon', () => {
    const banned: Array<[RegExp, string]> = [
      // Only ever as a contrast ("no central bank money"), never as a claim.
      [/(?<!no )central bank money|reserves? (?:account )?at the central bank|central-bank reserves|federal reserve|fedwire/i, 'central bank money claim'],
      [/zero risk|risk-free|100% collateral|\binsured\b|\buninsured\b|\bTR\b|total risk/i, 'risk-free language'],
      [/pre-funded nostro|four-hop|token lane|workspace revision|r2cRequestSoftLimit|J-Machine|J-Block|\bR2R\b|\bR2C\b/i, 'jargon or wrong analogy'],
      [/never out of pocket|guaranteed delivery|capital injection/i, 'overstated guarantee'],
    ];
    for (const file of readdirSync(TRAIL_DIR).filter((name) => name.endsWith('.json')).sort()) {
      const trail = parseNetworkTrail(readFileSync(`${TRAIL_DIR}/${file}`, 'utf8'));
      for (const cue of trail.cues ?? []) {
        for (const [pattern, reason] of banned) expect(cueText(cue), `${file} ${cue.title}: ${reason}`).not.toMatch(pattern);
      }
    }
    // Hash-locked payments are conditional payments, never payment-versus-payment.
    const lockAhb = parseNetworkTrail(readFileSync(`${TRAIL_DIR}/lock-ahb.json`, 'utf8'));
    for (const cue of lockAhb.cues ?? []) expect(cueText(cue), cue.title).not.toMatch(/payment-versus-payment|\bPvP\b/i);
  });

  test('the story states finality in three layers, a hub default, real netting and the challenge window', () => {
    const cues = (file: string) => parseNetworkTrail(readFileSync(`${TRAIL_DIR}/${file}`, 'utf8')).cues ?? [];
    const ahb = cues('ahb.json');
    expect(ahb.find((cue) => cue.condensePrior)?.title).toMatch(/^Starting point/);
    expect(ahb.find((cue) => cue.endsPresentation)).toBeDefined();
    expect(ahb.find((cue) => cue.badges)?.badges?.map((badge) => badge.label)).toEqual(['Bilateral', 'On-chain', 'Legal']);
    expect(ahb.some((cue) => cue.title === 'If Hub failed now' && /first-come, not pro rata/.test(cue.why ?? ''))).toBe(true);
    expect(ahb.some((cue) => /shortfall becomes Hub's debt/.test(cue.title))).toBe(true);
    expect(ahb.some((cue) => /Gross bilateral flow/.test((cue.keyMetrics ?? []).join()) && /Moved on-chain: 0/.test((cue.keyMetrics ?? []).join()))).toBe(true);
    const settle = cues('settle.json');
    expect(settle.some((cue) => (cue.keyMetrics ?? []).some((metric) => /^Settled on-chain:/.test(metric)))).toBe(true);
    for (const file of ['ahb.json', 'swap.json', 'dispute-lifecycle.json']) {
      expect(cues(file).some((cue) => (cue.keyMetrics ?? []).some((metric) => /^Challenge window: \d+ hours?$/.test(metric))), file).toBe(true);
    }
  });
});
