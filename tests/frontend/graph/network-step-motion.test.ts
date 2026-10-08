import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { projectRuntimeGraphFrame } from '../../../frontend/src/lib/network3d/runtimeGraphProjection';
import {
  classifyFrameTxs,
  deriveNetworkStepMotion,
} from '../../../frontend/src/lib/network3d/timeline/networkStepMotion';
import { resolveNetworkCueFocus } from '../../../frontend/src/lib/network3d/timeline/networkCueFocus';
import { activeNetworkMachineCue } from '../../../frontend/src/lib/network3d/networkMachine';
import { captionForStep } from '../../../frontend/src/lib/network3d/timeline/networkCaption';

const ALICE = `0x${'a'.repeat(64)}`;
const HUB = `0x${'b'.repeat(64)}`;
const BOB = `0x${'c'.repeat(64)}`;

type AccountSide = {
  counterparty: string;
  currentHeight: number;
  pending?: { height: number; accountTxs: Array<Record<string, unknown>> };
  collateral?: bigint;
};

const delta = (collateral = 0n) => ({ tokenId: 1, collateral, ondelta: 0n, offdelta: 0n, leftCreditLimit: 0n, rightCreditLimit: 0n, leftAllowance: 0n, rightAllowance: 0n });

const entity = (entityId: string, sides: AccountSide[], reserve = 0n) => ({
  summary: { entityId, label: entityId.slice(-4), height: 1 },
  core: { entityId, height: 1, timestamp: 1, reserves: new Map([[1, reserve]]), profile: { name: entityId.slice(-4), isHub: false } },
  accounts: {
    items: sides.map((side) => ({
      leftEntity: entityId < side.counterparty ? entityId : side.counterparty,
      rightEntity: entityId < side.counterparty ? side.counterparty : entityId,
      deltas: new Map([[1, delta(side.collateral)]]),
      currentHeight: side.currentHeight,
      ...(side.pending ? { pendingFrame: side.pending } : {}),
    })),
    nextCursor: null,
  },
});

const projection = (height: number, entities: ReturnType<typeof entity>[]) =>
  projectRuntimeGraphFrame({ runtimeId: 'r1', height, timestamp: height, stateHash: '', entities } as never, { runtimeId: 'r1', adapterKind: 'browser' });

describe('network step motion', () => {
  test('a new pending frame is a proposal travelling from its proposer to the counterparty', () => {
    const before = projection(1, [entity(ALICE, [{ counterparty: HUB, currentHeight: 3 }]), entity(HUB, [{ counterparty: ALICE, currentHeight: 3 }])]);
    const after = projection(2, [
      entity(ALICE, [{ counterparty: HUB, currentHeight: 3, pending: { height: 4, accountTxs: [{ type: 'htlc_lock', tokenId: 1, amount: 125n }] } }]),
      entity(HUB, [{ counterparty: ALICE, currentHeight: 3 }]),
    ]);

    const motion = deriveNetworkStepMotion({ key: 'r1:h2', previous: [before], current: [after], activity: [] });

    expect(motion.flows).toEqual([{ fromEntityId: ALICE, toEntityId: HUB, kind: 'htlc_lock', tokenId: 1, amount: 125n }]);
    expect(motion.pulses).toEqual([]);
  });

  test('signing the counterparty frame is an ACK back; landing an own proposal is not', () => {
    const before = projection(2, [
      entity(ALICE, [{ counterparty: HUB, currentHeight: 3, pending: { height: 4, accountTxs: [{ type: 'direct_payment' }] } }]),
      entity(HUB, [{ counterparty: ALICE, currentHeight: 3 }]),
    ]);
    const hubSigned = projection(3, [
      entity(ALICE, [{ counterparty: HUB, currentHeight: 3, pending: { height: 4, accountTxs: [{ type: 'direct_payment' }] } }]),
      entity(HUB, [{ counterparty: ALICE, currentHeight: 4 }]),
    ]);
    const aliceCommitted = projection(4, [
      entity(ALICE, [{ counterparty: HUB, currentHeight: 4 }]),
      entity(HUB, [{ counterparty: ALICE, currentHeight: 4 }]),
    ]);

    expect(deriveNetworkStepMotion({ key: 'h3', previous: [before], current: [hubSigned], activity: [] }).flows)
      .toEqual([{ fromEntityId: HUB, toEntityId: ALICE, kind: 'ack' }]);
    expect(deriveNetworkStepMotion({ key: 'h4', previous: [hubSigned], current: [aliceCommitted], activity: [] }).flows)
      .toEqual([]);
  });

  test('collateral and reserve changes pulse the party; j activity drives the J-machine', () => {
    const before = projection(5, [entity(ALICE, [{ counterparty: HUB, currentHeight: 5 }], 10n), entity(HUB, [{ counterparty: ALICE, currentHeight: 5 }])]);
    const after = projection(6, [
      entity(ALICE, [{ counterparty: HUB, currentHeight: 5, collateral: 7n }], 3n),
      entity(HUB, [{ counterparty: ALICE, currentHeight: 5, collateral: 7n }]),
    ]);
    const activity = [
      { id: 'a', height: 6, timestamp: 6, kind: 'onchain', type: 'system', source: 'runtime_input', direction: 'neutral', title: 'j_broadcast', subtitle: '', status: 'committed', rawType: 'j_broadcast', entityId: BOB },
      { id: 'b', height: 6, timestamp: 6, kind: 'onchain', type: 'j_event', source: 'runtime_input', direction: 'neutral', title: 'claim', subtitle: '', status: 'observed', rawType: 'j_event_claim', entityId: ALICE },
    ] as never;

    const motion = deriveNetworkStepMotion({ key: 'h6', previous: [before], current: [after], activity });

    expect(motion.pulses).toEqual([
      { entityId: ALICE, kind: 'collateral' },
      { entityId: HUB, kind: 'collateral' },
      { entityId: ALICE, kind: 'reserve' },
    ]);
    expect(motion.jSubmissions).toEqual([BOB]);
    expect(motion.jFinalized).toBe(1);
  });

  test('a known bank signing the frame that opens an account still ACKs; zero collateral is no deposit', () => {
    const before = projection(7, [
      entity(ALICE, [{ counterparty: HUB, currentHeight: 0, pending: { height: 1, accountTxs: [{ type: 'add_delta' }] } }]),
      entity(HUB, []),
    ]);
    const after = projection(8, [
      entity(ALICE, [{ counterparty: HUB, currentHeight: 0, pending: { height: 1, accountTxs: [{ type: 'add_delta' }] } }]),
      entity(HUB, [{ counterparty: ALICE, currentHeight: 1, collateral: 0n }]),
      entity(BOB, [{ counterparty: HUB, currentHeight: 4 }]),
    ]);

    const motion = deriveNetworkStepMotion({ key: 'h8', previous: [before], current: [after], activity: [] });

    // Bob joined the view this step: his accounts are not motion.
    expect(motion.flows).toEqual([{ fromEntityId: HUB, toEntityId: ALICE, kind: 'ack' }]);
    expect(motion.pulses).toEqual([]);
  });

  test('the first step of a timeline has nothing to compare against and moves nothing', () => {
    const only = projection(1, [entity(ALICE, [{ counterparty: HUB, currentHeight: 1, pending: { height: 2, accountTxs: [] } }])]);
    expect(deriveNetworkStepMotion({ key: 'h1', previous: null, current: [only], activity: [] }).flows).toEqual([]);
  });

  test('value-bearing txs name the frame, whatever else it carries', () => {
    expect(classifyFrameTxs([{ type: 'set_credit_limit' }, { type: 'direct_payment', data: { tokenId: 2, amount: 9n } }]))
      .toEqual({ kind: 'payment', tokenId: 2, amount: 9n });
    expect(classifyFrameTxs([{ type: 'unknown_tx' }])).toEqual({ kind: 'frame' });
  });

  test('a fill carries both of its legs; an offer (a limit) and a partial leg carry none', () => {
    expect(classifyFrameTxs([{ type: 'swap_resolve', giveTokenId: 2, giveAmount: 10n, wantTokenId: 1, wantAmount: 30_000n }]))
      .toEqual({ kind: 'swap', swapLegs: { give: { tokenId: 2, amount: 10n }, want: { tokenId: 1, amount: 30_000n } } });
    expect(classifyFrameTxs([{ type: 'swap_offer', data: { giveTokenId: 1, giveAmount: 31n, wantTokenId: 2, wantAmount: 1n } }]))
      .toEqual({ kind: 'swap' });
    expect(classifyFrameTxs([{ type: 'swap_resolve', giveTokenId: 2, giveAmount: 10n }])).toEqual({ kind: 'swap' });
  });
});

describe('narrated step direction', () => {
  const cue = (id: string, height: number, extra: Record<string, unknown> = {}) => ({
    id, at: { runtimeId: 'r1', height, timestamp: height }, title: `cue ${id}`, ...extra,
  });

  test('the most recent active cue speaks for the step', () => {
    const cues = [cue('first', 1), cue('second', 5)] as never;
    expect(activeNetworkMachineCue(cues)?.id).toBe('second');
    expect(captionForStep({ runtimeId: 'r1', height: 7, cues }, []).title).toBe('cue second');
  });

  test('focus lights named parties plus whatever moved, and clears without focus', () => {
    const motion = { key: 'k', flows: [{ fromEntityId: HUB, toEntityId: BOB, kind: 'payment' as const }], pulses: [], jSubmissions: [], jFinalized: 0 };
    const focus = resolveNetworkCueFocus(cue('pay', 3, { focusEntityIds: [ALICE], focusAccountIds: [`${HUB}:${ALICE}`] }) as never, motion);

    expect([...focus!.entityIds].sort()).toEqual([ALICE, HUB, BOB].sort());
    expect([...focus!.accountIds].sort()).toEqual([`${ALICE}:${HUB}`, `${HUB}:${BOB}`]);
    expect(focus!.includeEntityAccounts).toBe(false);
    expect(resolveNetworkCueFocus(cue('plain', 3) as never, motion)).toBeNull();
    expect(resolveNetworkCueFocus(null, motion)).toBeNull();
  });

  test('a cue naming parties but no account keeps their accounts in focus', () => {
    const focus = resolveNetworkCueFocus(cue('submit', 4, { focusEntityIds: [ALICE] }) as never, null);
    expect([...focus!.entityIds]).toEqual([ALICE]);
    expect(focus!.includeEntityAccounts).toBe(true);
  });

  test('a step without activity is captioned by what moved', () => {
    const motion = { key: 'k', flows: [{ fromEntityId: ALICE, toEntityId: HUB, kind: 'htlc_lock' as const, tokenId: 1, amount: 5n }], pulses: [], jSubmissions: [], jFinalized: 0 };
    const caption = captionForStep({ runtimeId: 'r1', height: 9, cues: [] }, [], {
      motion,
      labelFor: (id) => (id === ALICE ? 'Alice' : 'Hub'),
      formatAmount: () => '5 USDC',
    });

    expect(caption.source).toBe('motion');
    expect(caption.title).toBe('Hash-locked payment forwarded');
    expect(caption.subtitle).toBe('5 USDC  ·  Alice → Hub');
  });
});

describe('graph motion has one source', () => {
  test('Graph3DPanel animates the step source, not the retired history coupling', () => {
    const panel = readFileSync('frontend/src/lib/view/panels/graph3d/Graph3DPanel.svelte', 'utf8');
    const store = readFileSync('frontend/src/lib/stores/network/networkMachineRuntimeStore.ts', 'utf8');

    expect(store).toContain('const { motion, previousFrames } = await readStepMotion(current.indexes, step, frames, activity);');
    expect(panel).toContain('return state.motion;');
    expect(panel).toContain('deriveNetworkStepMotion({ key: `live:${signature}`');
    for (const retired of ['createTransactionParticles', 'addTxToJMachine', 'startJAutoProposer', 'jBlockHistory', 'entityInputStrikes', 'runtimeFrameHistory[timeIndex]']) {
      expect(panel).not.toContain(retired);
    }
  });
});
