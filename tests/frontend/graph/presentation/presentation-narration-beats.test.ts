import { describe, expect, test } from 'bun:test';

import { networkTrailFromSnapshots, serializeNetworkTrailV1 } from '../../../../core/scenarios/network-trail';
import { narrate, startScenarioNarration } from '../../../../core/scenarios/harness/narration';
import { disputeWindowText, finalityBadges } from '../../../../core/scenarios/harness/story';
import { parseNetworkTrail, trailNetworkTimelineSource } from '../../../../frontend/src/lib/network3d/timeline/networkTimelineSource';
import {
  activeNetworkMachineCue,
  compileNetworkMachine,
  DEFAULT_NETWORK_MACHINE_CONFIG,
  presentationNetworkMachine,
} from '../../../../frontend/src/lib/network3d/networkMachine';
import { captionForStep } from '../../../../frontend/src/lib/network3d/timeline/networkCaption';

const snapshot = (height: number, title?: string) => ({
  state: { height, timestamp: height, eReplicas: new Map() },
  runtimeInput: { runtimeTxs: [], jInputs: [], entityInputs: [] },
  runtimeOutputs: [],
  description: '',
  ...(title ? { meta: { subtitle: { title, what: `${title} what` } } } : {}),
}) as never;

const machineFor = async (trail: ReturnType<typeof networkTrailFromSnapshots>) => {
  const restored = parseNetworkTrail(serializeNetworkTrailV1(trail));
  const source = trailNetworkTimelineSource(restored);
  return compileNetworkMachine([await source.readIndex()], { ...DEFAULT_NETWORK_MACHINE_CONFIG, cues: source.cues ?? [] });
};

describe('narration about an applied state', () => {
  test('narrate records a beat on the latest committed frame and fails before the first', () => {
    const env = { state: { height: 0 } } as never;
    expect(() => narrate(env, 'Too early')).toThrow('SCENARIO_NARRATION_BEFORE_FIRST_FRAME');
    (env as { state: { height: number } }).state.height = 5;
    const collector = startScenarioNarration(env);
    narrate(env, 'Outcome', { what: 'Bob is paid.', keyMetrics: ['Paid: 1 USDC'] });
    expect(collector.read()).toEqual([{ height: 5, title: 'Outcome', what: 'Bob is paid.', keyMetrics: ['Paid: 1 USDC'] }]);
    collector.stop();
    const fresh = startScenarioNarration(env);
    expect(fresh.read()).toEqual([]);
    fresh.stop();
  });

  test('a beat on an announced frame becomes its own step, spoken after the announcement', async () => {
    const trail = networkTrailFromSnapshots('demo', [snapshot(1, 'Announce'), snapshot(2)], [
      { height: 1, title: 'Outcome', what: 'Applied.' },
      { height: 1, title: 'How final?', badges: finalityBadges('Up to collateral.') },
      { height: 2, title: 'Later outcome' },
    ]);
    expect(trail.cues.map((cue) => cue.id)).toEqual([
      'authored:demo:h1', 'authored:demo:h1:b00', 'authored:demo:h1:b01', 'authored:demo:h2:b00',
    ]);
    const machine = await machineFor(trail);
    expect(machine.steps.map((step) => [step.event.height, activeNetworkMachineCue(step.cues)?.title])).toEqual([
      [1, 'Announce'], [1, 'Outcome'], [1, 'How final?'], [2, 'Later outcome'],
    ]);
    const caption = captionForStep({ runtimeId: 'demo', height: 1, cues: machine.steps[2]!.cues }, []);
    expect(caption.badges?.map((badge) => [badge.label, badge.tone])).toEqual([['Bilateral', 'done'], ['On-chain', 'bounded'], ['Legal', 'outside']]);
  });

  test('a beat must name a frame the trail recorded', () => {
    expect(() => networkTrailFromSnapshots('demo', [snapshot(1)], [{ height: 9, title: 'Nowhere' }])).toThrow('NETWORK_TRAIL_BEAT_FRAME_MISSING:h9');
  });

  test('a presentation plays from its setup summary to its closing beat', async () => {
    const trail = networkTrailFromSnapshots('demo', [1, 2, 3, 4, 5].map((height) => snapshot(height, height === 1 ? 'Setup' : undefined)), [
      { height: 2, title: 'Starting point', condensePrior: true },
      { height: 4, title: 'The end', endsPresentation: true },
    ]);
    const full = await machineFor(trail);
    expect(full.steps).toHaveLength(5);
    const presented = presentationNetworkMachine(full);
    expect(presented.steps.map((step) => [step.index, step.event.height])).toEqual([[0, 2], [1, 3], [2, 4]]);
    expect(activeNetworkMachineCue(presented.steps[0]!.cues)?.title).toBe('Starting point');
  });

  test('a challenge window reads as the account committed it', () => {
    expect(disputeWindowText({ leftResponseSeconds: 3600, rightResponseSeconds: 86_400 })).toBe('25 hours');
    expect(disputeWindowText({ leftResponseSeconds: 3600, rightResponseSeconds: 0 })).toBe('1 hour');
    expect(disputeWindowText({ leftResponseSeconds: 90, rightResponseSeconds: 30 })).toBe('2 minutes');
  });
});
