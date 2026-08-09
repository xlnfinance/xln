import { describe, expect, test } from 'bun:test';
import { ethers, type Provider } from 'ethers';

import { Depository__factory } from '../../jurisdictions/typechain-types';
import {
  decodeDisputeFinalizationEvidenceCalldata,
  decodeDisputeProofBodyEvidenceCalldata,
  resolveDisputeFinalizationEvidence,
  resolveDisputeProofBodyEvidence,
} from '../jurisdiction/adapter/rpc-public';
import { createEmptyBatch, encodeJBatch } from '../jurisdiction/machine/batch';
import { createTxFinalizationEvidenceReader } from '../jurisdiction/adapter/rpc-watcher-inputs';

const bytes32 = (byte: string): string => `0x${byte.repeat(32)}`;

describe('J watcher DisputeFinalized calldata evidence', () => {
  const params = {
    counterentity: bytes32('22'),
    initialNonce: 7n,
    finalNonce: 11n,
    proposerIsLeft: false,
    initialProofbodyHash: bytes32('33'),
    finalProofbody: {
      watchSeed: bytes32('44'),
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [5n, -3n],
      tokenIds: [1n, 2n],
      transformers: [],
    },
    starterArguments: '0x5678',
    otherArguments: '0xabcd',
    sig: '0x0102',
    startedByLeft: true,
    cooperative: false,
  };
  const expectedEvidence = {
    counterentity: params.counterentity,
    initialNonce: '7',
    finalNonce: '11',
    initialProofbodyHash: params.initialProofbodyHash,
    proposerIsLeft: params.proposerIsLeft,
    leftArguments: params.starterArguments,
    rightArguments: params.otherArguments,
    startedByLeft: params.startedByLeft,
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
    });
    const calldata = Depository__factory.createInterface().encodeFunctionData(
      'processBatch',
      [encodeJBatch(batch), '0x0102', 3n],
    );

    expect(decodeDisputeFinalizationEvidenceCalldata(calldata)).toEqual([expectedEvidence]);
  });

  test('recovers every signed dispute body from authenticated processBatch calldata', () => {
    const batch = createEmptyBatch();
    batch.disputeStarts.push({
      counterentity: params.counterentity,
      nonce: 7,
      proposerIsLeft: true,
      proofbodyHash: bytes32('77'),
      initialProofbody: params.finalProofbody,
      watchSeed: params.finalProofbody.watchSeed,
      sig: '0x01',
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
      starterCounterProofCommitment: bytes32('00'),
    });
    batch.counterDisputes.push({
      counterentity: params.counterentity,
      initialNonce: 7,
      initialProofbodyHash: bytes32('77'),
      counterNonce: 11,
      proposerIsLeft: false,
      counterProofbody: params.finalProofbody,
      sig: '0x02',
    });
    batch.disputeFinalizations.push({
      ...params,
      initialNonce: Number(params.initialNonce),
      finalNonce: Number(params.finalNonce),
    });
    const calldata = Depository__factory.createInterface().encodeFunctionData(
      'processBatch',
      [encodeJBatch(batch), '0x0102', 3n],
    );
    const candidates = decodeDisputeProofBodyEvidenceCalldata(calldata);
    expect(candidates.map(candidate => candidate.eventName)).toEqual([
      'DisputeStarted',
      'CounterDisputeRegistered',
      'DisputeFinalized',
    ]);
    for (const candidate of candidates) {
      const args = candidate.eventName === 'DisputeFinalized'
        ? {
            counterentity: candidate.counterentity,
            initialNonce: candidate.initialNonce,
            finalProofbodyHash: candidate.proofbodyHash,
          }
        : {
            counterentity: candidate.counterentity,
            nonce: candidate.nonce,
            proposerIsLeft: candidate.proposerIsLeft,
            proofbodyHash: candidate.proofbodyHash,
          };
      expect(resolveDisputeProofBodyEvidence(candidates, candidate.eventName, args))
        .toEqual(params.finalProofbody);
    }
  });

  test('binds calldata evidence to the exact emitted finalization', () => {
    const eventArgs = {
      sender: bytes32('11'),
      counterentity: params.counterentity,
      initialNonce: params.initialNonce,
      finalProofbodyHash: bytes32('66'),
      finalizationEvidenceHash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
          [params.initialProofbodyHash, params.finalNonce, params.proposerIsLeft, params.startedByLeft,
          ethers.keccak256(params.starterArguments), ethers.keccak256(params.otherArguments),
          ethers.keccak256(params.sig)],
      )),
    };
    expect(resolveDisputeFinalizationEvidence(
      [expectedEvidence],
      bytes32('55'),
      eventArgs,
    )).toEqual({
      sender: bytes32('11'),
      ...expectedEvidence,
      finalProofbodyHash: bytes32('66'),
    });

    expect(() => resolveDisputeFinalizationEvidence(
      [{ ...expectedEvidence, rightArguments: '0xdead' }], bytes32('55'), eventArgs,
    )).toThrow('J_DISPUTE_FINALIZATION_EVIDENCE_NOT_FOUND');
  });

  test('fails loudly for malformed or unrelated Depository calldata', () => {
    expect(() => decodeDisputeFinalizationEvidenceCalldata('0x1234'))
      .toThrow('J_DISPUTE_FINALIZATION_CALLDATA_UNKNOWN');
    const unrelated = Depository__factory.createInterface().encodeFunctionData('getTokensLength');
    expect(() => decodeDisputeFinalizationEvidenceCalldata(unrelated))
      .toThrow('J_DISPUTE_FINALIZATION_CALLDATA_UNSUPPORTED:getTokensLength');
  });

  test('rejects forged RPC calldata even when the provider claims the canonical tx hash', async () => {
    const calldata = Depository__factory.createInterface().encodeFunctionData(
      'watchtowerCounterDispute',
      [bytes32('11'), params, 25n, 3n, '0x0304'],
    );
    const wallet = ethers.Wallet.createRandom();
    const raw = await wallet.signTransaction({
      chainId: 1,
      nonce: 0,
      gasLimit: 1_000_000,
      gasPrice: 1,
      to: ethers.ZeroAddress,
      value: 0,
      data: calldata,
    });
    const signed = ethers.Transaction.from(raw);
    const location = { blockHash: bytes32('99'), blockNumber: 42 };
    const response = {
      type: signed.type,
      chainId: signed.chainId,
      nonce: signed.nonce,
      gasLimit: signed.gasLimit,
      gasPrice: signed.gasPrice,
      to: signed.to,
      value: signed.value,
      data: '0x1234',
      accessList: signed.accessList,
      signature: signed.signature,
      hash: signed.hash,
      blockHash: location.blockHash,
      blockNumber: location.blockNumber,
    };
    const provider = {
      getTransaction: async () => response,
    } as unknown as Provider;

    await expect(createTxFinalizationEvidenceReader(provider)(signed.hash!, location))
      .rejects.toThrow('J_DISPUTE_TX_HASH_INVALID');
  });
});
