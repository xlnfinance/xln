import { describe, expect, test } from 'bun:test';

import {
  assertCompleteHltAuthorityEvidence,
  buildHltAuthorityEvidence,
} from '../../../scripts/operations/hlt/replay/authority-evidence';
import { buildHltEntityFrameEventEvidence } from '../../../scripts/operations/hlt/replay/entity-frame-event-evidence';
import { createEntityProposalFixture } from '../../helpers/entity-proposal-fixture';
import {
  hltAuthorityEvidenceRecording,
  hltAuthorityEvidenceRelayUrls,
} from '../../../scripts/operations/hlt/authority-evidence-policy';
import type { PersistedFrameJournal } from '../../../storage/types';
import type { EntityTx } from '../../../types/entity-tx';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const owner = entityId('11');

const journal = (entityTxs: EntityTx[] = [], height = 41): PersistedFrameJournal => ({
  height,
  timestamp: 1_700_000_000_000,
  replicaMetaDigest: `0x${'04'.repeat(32)}`,
  postStateHash: `0x${'05'.repeat(32)}`,
  canonicalStateHash: `0x${'06'.repeat(32)}`,
  runtimeInput: {
    runtimeTxs: [],
    entityInputs: entityTxs.length === 0 ? [] : [{
      entityId: owner,
      signerId: '1',
      entityTxs,
    }],
  },
  runtimeOutputCount: 2,
  runtimeOutputsDigest: `0x${'07'.repeat(32)}`,
  entityContexts: new Map(),
  logs: [],
});

describe('HLT Rust Runtime authority evidence', () => {
  test('selects production availability routing only for authority recording', () => {
    expect(hltAuthorityEvidenceRecording({})).toBe(false);
    expect(hltAuthorityEvidenceRecording({ XLN_HLT_AUTHORITY_EVIDENCE: '1' })).toBe(true);
    expect(() => hltAuthorityEvidenceRecording({ XLN_HLT_AUTHORITY_EVIDENCE: 'true' }))
      .toThrow('HLT_AUTHORITY_EVIDENCE_FLAG_INVALID:true');
    expect(hltAuthorityEvidenceRelayUrls({})).toEqual([]);
    expect(hltAuthorityEvidenceRelayUrls({
      XLN_HLT_AUTHORITY_EVIDENCE: '1',
      XLN_PORT_BASE: '20000',
    })).toEqual(['ws://127.0.0.1:20004/relay']);
    expect(() => hltAuthorityEvidenceRelayUrls({
      XLN_HLT_AUTHORITY_EVIDENCE: '1',
      XLN_PORT_BASE: '65532',
    })).toThrow('HLT_AUTHORITY_EVIDENCE_PORT_BASE_INVALID:65532');
  });

  test('binds canonical Runtime roots and ordered effects without an eager Account-history oracle', () => {
    const evidence = buildHltAuthorityEvidence(Array.from(
      { length: 1_000 },
      (_, index) => journal([], 41 + index),
    ));
    expect(() => assertCompleteHltAuthorityEvidence(evidence)).not.toThrow();
    expect(Object.hasOwn(evidence, 'economicOperations')).toBe(false);
    expect(evidence.expectations.runtimeFrames[0]?.canonicalStateHash).toBe(`0x${'06'.repeat(32)}`);
    expect(evidence.expectations.effects[0]).toEqual({
      runtimeHeight: 41,
      outputCount: 2,
      orderedOutputDigest: `0x${'07'.repeat(32)}`,
    });
    expect(evidence.expectations.entityFrameEvents).toHaveLength(1_000);
    // Shared TS/Rust empty-list vector. This catches drift in either the
    // parity domain or the canonical event-array encoding.
    expect(evidence.expectations.entityFrameEvents[0]?.orderedEventDigest).toBe(
      '0x701d6f37973653c3cd817e7c8b7cbc401a10bdad404170e7cda85a02f605d656',
    );
  });

  test('rejects disabled lending from the canonical Runtime WAL input', () => {
    const lending: EntityTx = {
      type: 'lendingRepay',
      data: {
        hubEntityId: owner,
        loanId: 'loan-1',
        tokenId: 1,
        amount: 1n,
      },
    };
    expect(() => buildHltAuthorityEvidence([journal([lending])]))
      .toThrow('HLT_AUTHORITY_SCOPE_ENTITY_TX_FORBIDDEN:lendingRepay');
  });

  test('binds current Runtime output events rather than the next inbound proposal', async () => {
    const fixture = createEntityProposalFixture('hlt-event-phase-shift');
    const { frame, proposer } = await fixture.buildHonestProposal();
    const outputFrame = structuredClone(frame);
    outputFrame.events = [{ type: 'status', message: 'current-output' }];
    const inboundFrame = structuredClone(frame);
    inboundFrame.events = [{ type: 'status', message: 'later-inbound' }];
    const base = journal();
    const recorded = {
      ...base,
      runtimeInput: {
        runtimeTxs: [],
        entityInputs: [{
          entityId: fixture.entityId,
          signerId: proposer.signerId,
          proposedFrame: inboundFrame,
        }],
      },
      runtimeOutputs: [{
        entityId: fixture.entityId,
        signerId: proposer.signerId,
        proposedFrame: outputFrame,
      }],
    } satisfies PersistedFrameJournal;
    const evidence = buildHltEntityFrameEventEvidence(recorded);
    expect(evidence.eventCount).toBe(1);
    expect(buildHltEntityFrameEventEvidence({
      ...recorded,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
    }).orderedEventDigest).toBe(evidence.orderedEventDigest);
    expect(buildHltEntityFrameEventEvidence({
      ...recorded,
      runtimeOutputs: [{
        entityId: fixture.entityId,
        signerId: proposer.signerId,
        proposedFrame: inboundFrame,
      }],
    }).orderedEventDigest).not.toBe(evidence.orderedEventDigest);
  });
});
