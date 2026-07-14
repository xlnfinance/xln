import { describe, expect, test } from 'bun:test';

import { Depository__factory } from '../../jurisdictions/typechain-types';
import { decodeDisputeFinalizationEvidenceCalldata } from '../jadapter/rpc';
import { createEmptyBatch, encodeJBatch } from '../jurisdiction/batch';

const bytes32 = (byte: string): string => `0x${byte.repeat(32)}`;

describe('J watcher DisputeFinalized calldata evidence', () => {
  const params = {
    counterentity: bytes32('22'),
    initialNonce: 7n,
    finalNonce: 11n,
    initialProofbodyHash: bytes32('33'),
    finalProofbody: {
      watchSeed: bytes32('44'),
      offdeltas: [5n, -3n],
      tokenIds: [1n, 2n],
      transformers: [],
    },
    leftArguments: '0x1234',
    rightArguments: '0xabcd',
    starterInitialArguments: '0x5678',
    starterIncrementedArguments: '0x9abc',
    sig: '0x0102',
    startedByLeft: true,
    disputeUntilBlock: 100n,
    cooperative: false,
  };
  const expectedEvidence = {
    counterentity: params.counterentity,
    initialNonce: '7',
    finalNonce: '11',
    initialProofbodyHash: params.initialProofbodyHash,
    leftArguments: params.leftArguments,
    rightArguments: params.rightArguments,
    starterInitialArguments: params.starterInitialArguments,
    starterIncrementedArguments: params.starterIncrementedArguments,
    sig: params.sig,
  };

  test('decodes the externally reachable watchtowerCounterDispute path', () => {
    const calldata = Depository__factory.createInterface().encodeFunctionData(
      'watchtowerCounterDispute',
      [bytes32('11'), params, 25n, 3n, '0x0304'],
    );

    expect(decodeDisputeFinalizationEvidenceCalldata(calldata)).toEqual([expectedEvidence]);
  });

  test('keeps the processBatch finalization path byte-for-byte equivalent', () => {
    const batch = createEmptyBatch();
    batch.disputeFinalizations.push({
      ...params,
      initialNonce: Number(params.initialNonce),
      finalNonce: Number(params.finalNonce),
      disputeUntilBlock: Number(params.disputeUntilBlock),
    });
    const calldata = Depository__factory.createInterface().encodeFunctionData(
      'processBatch',
      [encodeJBatch(batch), '0x0102', 3n],
    );

    expect(decodeDisputeFinalizationEvidenceCalldata(calldata)).toEqual([expectedEvidence]);
  });

  test('fails loudly for malformed or unrelated Depository calldata', () => {
    expect(() => decodeDisputeFinalizationEvidenceCalldata('0x1234'))
      .toThrow('J_DISPUTE_FINALIZATION_CALLDATA_UNKNOWN');
    const unrelated = Depository__factory.createInterface().encodeFunctionData('getTokensLength');
    expect(() => decodeDisputeFinalizationEvidenceCalldata(unrelated))
      .toThrow('J_DISPUTE_FINALIZATION_CALLDATA_UNSUPPORTED:getTokensLength');
  });
});
