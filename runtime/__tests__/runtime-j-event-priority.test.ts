import { describe, expect, test } from 'bun:test';

import { prioritizeJEventFrame } from '../runtime';
import type { EntityInput, EntityTx, ProposedEntityFrame, RuntimeInput } from '../types';

describe('Runtime J-event frame priority', () => {
  test('keeps consensus payload exclusively on the deferred lane', () => {
    const jEvent = { type: 'j_event', data: {} } as EntityTx;
    const ordinary = { type: 'profile-update', data: { profile: { name: 'after' } } } as EntityTx;
    const proposedFrame = { height: 7 } as ProposedEntityFrame;
    const input: EntityInput = {
      entityId: `0x${'11'.repeat(32)}`,
      signerId: `0x${'22'.repeat(20)}`,
      from: `0x${'33'.repeat(20)}`,
      entityTxs: [jEvent, ordinary],
      proposedFrame,
      hashPrecommitFrame: { height: 7, frameHash: `0x${'44'.repeat(32)}` },
      hashPrecommits: new Map([[`0x${'55'.repeat(20)}`, [`0x${'66'.repeat(65)}`]]]),
      jPrefixAttestations: new Map(),
      leaderTimeoutVote: { height: 7 } as NonNullable<EntityInput['leaderTimeoutVote']>,
    };
    const runtimeInput: RuntimeInput = { runtimeTxs: [], entityInputs: [input] };
    const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };

    expect(prioritizeJEventFrame(runtimeInput, mempool, 123)).toBe(true);
    expect(runtimeInput.entityInputs).toHaveLength(1);
    expect(runtimeInput.entityInputs[0]?.entityTxs).toEqual([jEvent]);
    expect(runtimeInput.entityInputs[0]?.proposedFrame).toBeUndefined();
    expect(runtimeInput.entityInputs[0]?.hashPrecommitFrame).toBeUndefined();
    expect(runtimeInput.entityInputs[0]?.hashPrecommits).toBeUndefined();
    expect(runtimeInput.entityInputs[0]?.jPrefixAttestations).toBeUndefined();
    expect(runtimeInput.entityInputs[0]?.leaderTimeoutVote).toBeUndefined();

    expect(mempool.entityInputs).toHaveLength(1);
    expect(mempool.entityInputs[0]?.entityTxs).toEqual([ordinary]);
    expect(mempool.entityInputs[0]?.proposedFrame).toBe(proposedFrame);
    expect(mempool.queuedAt).toBe(123);
  });
});
