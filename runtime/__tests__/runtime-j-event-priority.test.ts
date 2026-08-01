import { describe, expect, test } from 'bun:test';

import { prioritizeJEventFrame } from '../runtime';
import type { EntityInput, EntityFrame } from '../entity/types';
import type { RuntimeInput } from '../runtime/types';
import type { EntityTx } from '../types/entity-tx';

const signer = (byte: string): string => `0x${byte.repeat(20)}`;
const entity = (byte: string): string => `0x${byte.repeat(32)}`;

describe('Runtime J-event frame priority', () => {
  test('keeps consensus payload exclusively on the deferred lane', () => {
    const jEvent = { type: 'j_event', data: {} } as EntityTx;
    const ordinary = { type: 'profile-update', data: { profile: { name: 'after' } } } as EntityTx;
    const proposedFrame = { height: 7 } as EntityFrame;
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

  test('never splits an atomic cross-j sibling cohort for J-event priority', () => {
    const jEvent = { type: 'j_event', data: {} } as EntityTx;
    const ordinary = { type: 'profile-update', data: { profile: { name: 'paired' } } } as EntityTx;
    const marker = { phase: 'proposal' as const, pairKey: 'paired-j-event' };
    const sourceRuntimeFrame = { height: 9, timestamp: 123 };
    const paired = [
      {
        entityId: entity('44'), signerId: signer('55'), from: signer('66'),
        sourceRuntimeFrame, atomicCrossJurisdictionPair: marker, entityTxs: [jEvent, ordinary],
      },
      {
        entityId: entity('77'), signerId: signer('88'), from: signer('66'),
        sourceRuntimeFrame, atomicCrossJurisdictionPair: marker, entityTxs: [ordinary],
      },
    ];
    const watcher = { entityId: entity('11'), signerId: signer('22'), entityTxs: [jEvent] };
    const runtimeInput: RuntimeInput = { runtimeTxs: [], entityInputs: [paired[0]!, watcher, paired[1]!] };
    const mempool: RuntimeInput = { runtimeTxs: [], entityInputs: [] };

    expect(prioritizeJEventFrame(runtimeInput, mempool, 123)).toBe(true);
    expect(runtimeInput.entityInputs).toEqual([watcher]);
    expect(mempool.entityInputs).toEqual(paired);
  });
});
