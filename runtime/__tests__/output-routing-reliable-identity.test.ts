import { describe, expect, test } from 'bun:test';

import {
  buildPendingNetworkOutputs,
  buildRouteOutputKey,
  getReliableOutputIdentity,
} from '../machine/output-routing';
import { safeStringify } from '../protocol/serialization';
import {
  assignCertifiedOutputIdentities,
  hashCertifiedEntityOutputSemantic,
} from '../entity/consensus/output-certification';
import type { DeliverableEntityInput, EntityState, EntityTx, JPrefixAttestation, RoutedEntityInput } from '../types';

const runtimeId = (byte: string): string => `0x${byte.repeat(20)}`;
const entityId = (byte: string): string => `0x${byte.repeat(32)}`;

const targetRuntimeId = runtimeId('a1');
const targetEntityId = entityId('a2');
const targetSignerId = runtimeId('a3');
const accountPeerId = entityId('a4');

const baseOutput = (): DeliverableEntityInput => ({
  runtimeId: targetRuntimeId,
  entityId: targetEntityId,
  signerId: targetSignerId,
});

const accountAckOutput = (
  height: number,
  frameHash: string,
  frameHanko: string,
): DeliverableEntityInput => ({
  ...baseOutput(),
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'ack',
      fromEntityId: accountPeerId,
      toEntityId: targetEntityId,
      ack: { height, frameHash, frameHanko },
    },
  } as never],
});

const accountFrameAckOutput = (
  height: number,
  frameHash: string,
  proposalStateHash: string,
  frameHanko = '0xproposal-hanko',
): DeliverableEntityInput => ({
  ...baseOutput(),
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'frame_ack',
      fromEntityId: accountPeerId,
      toEntityId: targetEntityId,
      ack: { height, frameHash, frameHanko: '0xack-hanko' },
      proposal: {
        frame: {
          height: height + 1,
          timestamp: height + 1,
          jHeight: height + 1,
          accountTxs: [],
          prevFrameHash: frameHash,
          accountStateRoot: `0xaccount-root-${height + 1}`,
          stateHash: proposalStateHash,
          deltas: [],
        },
        frameHanko,
      },
    },
  } as never],
});

const accountProposalOutput = (
  height: number,
  stateHash: string,
): DeliverableEntityInput => ({
  ...baseOutput(),
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'frame',
      fromEntityId: accountPeerId,
      toEntityId: targetEntityId,
      proposal: {
        frame: {
          height,
          timestamp: height,
          jHeight: height,
          accountTxs: [],
          prevFrameHash: `0xaccount-frame-${height - 1}`,
          accountStateRoot: `0xaccount-root-${height}`,
          stateHash,
          deltas: [],
        },
        frameHanko: '0xproposal-hanko',
      },
    },
  } as never],
});

const certifiedOutput = (
  inner: EntityTx,
  overrides: Partial<Extract<EntityTx, { type: 'consensusOutput' }>['data']['origin']> = {},
): DeliverableEntityInput => {
  const nested = [structuredClone(inner)];
  const sourceEntityId = overrides.sourceEntityId ?? accountPeerId;
  const lane = overrides.lane ?? 'account-ack';
  const sequence = overrides.sequence ?? 7n;
  const semanticHash = overrides.semanticHash ?? hashCertifiedEntityOutputSemantic(
    sourceEntityId,
    targetEntityId,
    lane,
    sequence,
    nested,
  );
  return {
    ...baseOutput(),
    entityTxs: [{
      type: 'consensusOutput',
      data: {
        origin: {
          sourceEntityId,
          lane,
          sequence,
          semanticHash,
          height: 19,
          frameHash: entityId('b2'),
          outputIndex: 3,
          ...overrides,
        },
        outputHanko: `0x${'ab'.repeat(65)}`,
        targetEntityId,
        entityTxs: nested,
      },
    }],
  };
};

const jFinalityOutput = (
  scannedThroughHeight: number,
  rangeHash: string,
  signature: string,
  sourceValidatorId = targetSignerId,
): DeliverableEntityInput => ({
  ...baseOutput(),
  entityTxs: [{
    type: 'j_event',
    data: {
      from: sourceValidatorId,
      jurisdictionRef: 'stack:31337:0x00000000000000000000000000000000000000a5',
      baseHeight: scannedThroughHeight - 1,
      scannedThroughHeight,
      observedAt: scannedThroughHeight,
      blocks: [],
      tipBlockHash: `0xtip-${scannedThroughHeight}`,
      rangeHash,
      eventHistoryRoot: `0xroot-${scannedThroughHeight}`,
      signature,
    },
  } as never],
});

const hashPrecommitOutput = (
  height: number,
  frameHash: string,
  validatorId: string,
  signature: string,
): DeliverableEntityInput => ({
  ...baseOutput(),
  hashPrecommitFrame: { height, frameHash },
  hashPrecommits: new Map([[validatorId, [signature]]]),
} as never);

const jPrefixOutput = (
  targetEntityHeight: number,
  scannedThroughHeight: number,
  signatureByte = 'aa',
): DeliverableEntityInput => {
  const sourceValidatorId = runtimeId('a8');
  const attestation: JPrefixAttestation = {
    version: 1,
    entityId: targetEntityId,
    targetEntityHeight,
    parentFrameHash: targetEntityHeight === 1 ? 'genesis' : `0x${'19'.repeat(32)}`,
    validatorId: sourceValidatorId,
    jurisdictionRef: 'stack:31337:0x00000000000000000000000000000000000000a5',
    baseHeight: 10,
    scannedThroughHeight,
    tipBlockHash: `0x${scannedThroughHeight.toString(16).padStart(64, '0')}`,
    eventHistoryRoot: `0x${'21'.repeat(32)}`,
    rangeHash: `0x${'22'.repeat(32)}`,
    headers: Array.from({ length: scannedThroughHeight - 10 }, (_, index) => ({
      jHeight: 11 + index,
      jBlockHash: `0x${(11 + index).toString(16).padStart(64, '0')}`,
    })),
    blocks: [],
    signature: `0x${signatureByte.repeat(65)}`,
  };
  return {
    ...baseOutput(),
    jPrefixAttestations: new Map([[sourceValidatorId, attestation]]),
  };
};

const canonicalPending = (outputs: RoutedEntityInput[]): string =>
  safeStringify(buildPendingNetworkOutputs(outputs));

describe('reliable output logical identities', () => {
  test('same-height Account proposal and ACK occupy distinct certified lanes', () => {
    const proposal = accountProposalOutput(10, '0xproposal-state-10');
    const ack = accountAckOutput(10, '0xproposal-state-10', '0xack-hanko');
    const outputs = [proposal, ack];

    assignCertifiedOutputIdentities({ entityId: accountPeerId } as EntityState, outputs);

    expect(outputs.map(output => output.certifiedOutputIdentity?.lane)).toEqual([
      'account-frame',
      'account-ack',
    ]);
    expect(outputs.map(output => output.certifiedOutputIdentity?.sequence)).toEqual([10n, 10n]);
    expect(outputs[0]?.certifiedOutputIdentity?.semanticHash)
      .not.toBe(outputs[1]?.certifiedOutputIdentity?.semanticHash);
  });

  test('batched Account ACK H7 + proposal H8 uses proposal lane and binds both bodies', () => {
    const original = accountFrameAckOutput(7, '0xaccount-frame-7', '0xproposal-state-8');
    const changedAck = structuredClone(original);
    const changedProposal = structuredClone(original);
    const ackTx = changedAck.entityTxs?.[0];
    const proposalTx = changedProposal.entityTxs?.[0];
    if (ackTx?.type !== 'accountInput' || ackTx.data.kind !== 'frame_ack') {
      throw new Error('TEST_FRAME_ACK_INPUT_MISSING');
    }
    if (proposalTx?.type !== 'accountInput' || proposalTx.data.kind !== 'frame_ack') {
      throw new Error('TEST_FRAME_ACK_PROPOSAL_INPUT_MISSING');
    }
    ackTx.data.ack.frameHash = '0xchanged-account-frame-7';
    proposalTx.data.proposal.frame.stateHash = '0xchanged-proposal-state-8';
    const outputs = [original, changedAck, changedProposal];

    assignCertifiedOutputIdentities({ entityId: accountPeerId } as EntityState, outputs);

    expect(outputs.map(output => output.certifiedOutputIdentity?.lane))
      .toEqual(['account-frame', 'account-frame', 'account-frame']);
    expect(outputs.map(output => output.certifiedOutputIdentity?.sequence)).toEqual([8n, 8n, 8n]);
    const semanticHashes = outputs.map(output => output.certifiedOutputIdentity?.semanticHash);
    expect(new Set(semanticHashes).size).toBe(3);
  });

  test('Account ACK identity is height + exact frameHash, independent of Hanko bytes', () => {
    const first = accountAckOutput(7, '0xaccount-frame-7', '0xhanko-b');
    const second = accountAckOutput(7, '0xaccount-frame-7', '0xhanko-a');

    expect(buildRouteOutputKey(first)).toBe(buildRouteOutputKey(second));
    expect(buildPendingNetworkOutputs([first, second])).toHaveLength(1);
    expect(canonicalPending([first, second])).toBe(canonicalPending([second, first]));
  });

  test('Account ACK rejects two frame hashes at the same lane height', () => {
    const first = accountAckOutput(7, '0xaccount-frame-a', '0xhanko-a');
    const second = accountAckOutput(7, '0xaccount-frame-b', '0xhanko-b');

    expect(() => buildPendingNetworkOutputs([first, second]))
      .toThrow('ROUTE_RELIABLE_LANE_ORDER_CONFLICT');
  });

  test('plain ACK and richer frame_ack share one ordered slot but retain exact evidence identities', () => {
    const plain = accountAckOutput(7, '0xaccount-frame-7', '0xack-hanko');
    const richer = accountFrameAckOutput(7, '0xaccount-frame-7', '0xproposal-state-8');
    const plainIdentity = getReliableOutputIdentity(plain);
    const richerIdentity = getReliableOutputIdentity(richer);

    expect(plainIdentity?.logicalKey).toBe(richerIdentity?.logicalKey);
    expect(plainIdentity?.bodyDigest).toBe(richerIdentity?.bodyDigest);
    expect(plainIdentity?.evidenceKind).toBe('account-ack');
    expect(richerIdentity?.evidenceKind).toBe('account-frame-ack');
    expect(plainIdentity?.evidenceDigest).not.toBe(richerIdentity?.evidenceDigest);
    expect(buildPendingNetworkOutputs([richer, plain])).toEqual([plain, richer]);
  });

  test('certified Account ACK keeps its inner reliable identity and binds the stable outer semantic envelope', () => {
    const direct = accountAckOutput(7, '0xaccount-frame-7', '0xack-hanko');
    const inner = direct.entityTxs![0]!;
    const wrapped = certifiedOutput(inner);
    const reissued = certifiedOutput(inner, {
      height: 23,
      frameHash: entityId('b3'),
      outputIndex: 8,
    });
    const directIdentity = getReliableOutputIdentity(direct);
    const wrappedIdentity = getReliableOutputIdentity(wrapped);
    const reissuedIdentity = getReliableOutputIdentity(reissued);

    expect(wrappedIdentity?.kind).toBe('account-ack');
    expect(wrappedIdentity?.logicalKey).toBe(directIdentity?.logicalKey);
    expect(wrappedIdentity?.frameHash).toBe(directIdentity?.frameHash);
    expect(wrappedIdentity?.evidenceDigest).toBe(reissuedIdentity?.evidenceDigest);
    expect(buildRouteOutputKey(wrapped)).toBe(buildRouteOutputKey(reissued));

    const conflicting = certifiedOutput(inner, { semanticHash: entityId('b4') });
    expect(() => buildPendingNetworkOutputs([wrapped, conflicting]))
      .toThrow('CONSENSUS_OUTPUT_SEMANTIC_HASH_MISMATCH');
  });

  test('certified reliable payload must be one atomic nested transaction', () => {
    const inner = accountAckOutput(7, '0xaccount-frame-7', '0xack-hanko').entityTxs![0]!;
    const mixed = certifiedOutput(inner);
    const wrapper = mixed.entityTxs![0];
    if (wrapper?.type !== 'consensusOutput') throw new Error('expected consensusOutput');
    wrapper.data.entityTxs.push({ type: 'profile-update', data: { name: 'ordinary' } } as never);

    expect(() => getReliableOutputIdentity(mixed))
      .toThrow('ROUTE_CERTIFIED_RELIABLE_OUTPUT_MUST_BE_ATOMIC');
  });

  test('frame_ack identity binds the full proposal body but excludes post-body Hankos', () => {
    const first = accountFrameAckOutput(
      7,
      '0xaccount-frame-7',
      '0xproposal-state-8',
      '0xproposal-hanko-a',
    );
    const sameBody = accountFrameAckOutput(
      7,
      '0xaccount-frame-7',
      '0xproposal-state-8',
      '0xproposal-hanko-b',
    );
    const conflicting = accountFrameAckOutput(
      7,
      '0xaccount-frame-7',
      '0xconflicting-proposal-state-8',
    );

    expect(buildRouteOutputKey(first)).toBe(buildRouteOutputKey(sameBody));
    expect(buildPendingNetworkOutputs([first, sameBody])).toHaveLength(1);
    expect(() => buildPendingNetworkOutputs([first, conflicting]))
      .toThrow('ROUTE_ACCOUNT_ACK_EVIDENCE_CONFLICT');
  });

  test('J finality identity excludes signature bytes but binds the unsigned range', () => {
    const first = jFinalityOutput(12, '0xrange-12', '0xsignature-b');
    const second = jFinalityOutput(12, '0xrange-12', '0xsignature-a');

    expect(buildRouteOutputKey(first)).toBe(buildRouteOutputKey(second));
    expect(buildPendingNetworkOutputs([first, second])).toHaveLength(1);
    expect(canonicalPending([first, second])).toBe(canonicalPending([second, first]));
  });

  test('certified J finality keeps exact range ordering through the outer envelope', () => {
    const direct = jFinalityOutput(12, '0xrange-12', '0xsignature-a');
    const wrapped = certifiedOutput(direct.entityTxs![0]!, {
      lane: 'generic',
      sequence: 1n,
    });
    const directIdentity = getReliableOutputIdentity(direct);
    const wrappedIdentity = getReliableOutputIdentity(wrapped);

    expect(wrappedIdentity?.kind).toBe('j-finality');
    expect(wrappedIdentity?.height).toBe(12);
    expect(wrappedIdentity?.frameHash).toBe(directIdentity?.frameHash);
    expect(wrappedIdentity?.logicalKey).toBe(directIdentity?.logicalKey);
  });

  test('J finality rejects different range identities at the same lane height', () => {
    const first = jFinalityOutput(12, '0xrange-a', '0xsignature-a');
    const second = jFinalityOutput(12, '0xrange-b', '0xsignature-b');

    expect(() => buildPendingNetworkOutputs([first, second]))
      .toThrow('ROUTE_RELIABLE_LANE_ORDER_CONFLICT');
  });

  test('J finality isolates same-height observations by authenticated source validator', () => {
    const first = jFinalityOutput(12, '0xrange-a', '0xsignature-a', runtimeId('a8'));
    const second = jFinalityOutput(12, '0xrange-b', '0xsignature-b', runtimeId('a9'));

    expect(getReliableOutputIdentity(first)?.laneKey)
      .not.toBe(getReliableOutputIdentity(second)?.laneKey);
    expect(buildPendingNetworkOutputs([first, second])).toHaveLength(2);
  });

  test('frozen J-prefix votes replay exactly and the deferred H12 head uses the next Entity round', () => {
    const head11 = jPrefixOutput(1, 11);
    const exactReplay = structuredClone(head11);
    const nextRoundHead12 = jPrefixOutput(2, 12, 'bb');
    const pending = buildPendingNetworkOutputs([nextRoundHead12, exactReplay, head11]);

    expect(getReliableOutputIdentity(head11)?.height).toBe(1);
    expect(getReliableOutputIdentity(nextRoundHead12)?.height).toBe(2);
    expect(pending).toHaveLength(2);
    expect(pending.map(output => getReliableOutputIdentity(output)?.height)).toEqual([1, 2]);
    expect(pending[0]?.jPrefixAttestations?.values().next().value?.scannedThroughHeight).toBe(11);
    expect(pending[1]?.jPrefixAttestations?.values().next().value?.scannedThroughHeight).toBe(12);
  });

  test('two different signed J-prefix heads in one signer round fail closed', () => {
    const head11 = jPrefixOutput(1, 11);
    const forbiddenExtension = jPrefixOutput(1, 12, 'bb');

    expect(() => buildPendingNetworkOutputs([head11, forbiddenExtension]))
      .toThrow('ROUTE_RELIABLE_LANE_ORDER_CONFLICT:j-prefix-attestation:1');
  });

  test('frame-bound precommit variants remain exact and reject signer equivocation', () => {
    const validatorA = runtimeId('a6');
    const validatorB = runtimeId('a7');
    const first = hashPrecommitOutput(9, '0xentity-frame-9', validatorA, '0xsig-a');
    const second = hashPrecommitOutput(9, '0xentity-frame-9', validatorB, '0xsig-b');
    const merged = buildPendingNetworkOutputs([second, first]);

    expect(merged).toHaveLength(2);
    expect(new Set(merged.flatMap(output => [...(output.hashPrecommits?.keys() ?? [])])))
      .toEqual(new Set([validatorA, validatorB]));
    expect(() => buildPendingNetworkOutputs([
      first,
      hashPrecommitOutput(9, '0xentity-frame-9', validatorA, '0xsig-conflict'),
    ])).toThrow('ROUTE_PRECOMMIT_EQUIVOCATION');
  });

  test('pending exact evidence is immutable after its source bundle changes', () => {
    const validatorA = runtimeId('a6');
    const validatorB = runtimeId('a7');
    const source = hashPrecommitOutput(9, '0xentity-frame-9', validatorA, '0xsig-a');
    const [pending] = buildPendingNetworkOutputs([source]);
    if (!pending) throw new Error('TEST_PENDING_OUTPUT_MISSING');
    const pendingKey = buildRouteOutputKey(pending);

    source.hashPrecommits!.set(validatorB, ['0xsig-b']);

    expect(pending.hashPrecommits).toEqual(new Map([[validatorA, ['0xsig-a']]]));
    expect(buildRouteOutputKey(pending)).toBe(pendingKey);
    expect(buildRouteOutputKey(source)).not.toBe(pendingKey);
  });

  test('mixed ACK and ordinary txs are isolated into separate envelopes', () => {
    const ack = accountAckOutput(4, '0xaccount-frame-4', '0xhanko-4').entityTxs![0]!;
    const mixed = {
      ...baseOutput(),
      entityTxs: [
        { type: 'profile-update', data: { name: 'ordinary' } } as never,
        ack,
      ],
    } satisfies DeliverableEntityInput;
    const pending = buildPendingNetworkOutputs([mixed]);

    expect(pending).toHaveLength(2);
    expect(pending.map(output => output.entityTxs?.map(tx => tx.type))).toEqual([
      ['accountInput'],
      ['profile-update'],
    ]);
  });
});
