import { expect, test } from 'bun:test';
import { AbiCoder, ZeroHash, keccak256 } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types';
import {
  decodeDisputeFinalizationEvidenceCalldata,
  decodeDisputeProofBodyEvidenceCalldata,
  resolveDisputeFinalizationEvidence,
} from '../jurisdiction/adapter/rpc-public';
import { encodeInt512 } from '../protocol/crypto/abi-money';

const sender = `0x${'11'.repeat(32)}`;
const proof = {
  counterentity: `0x${'22'.repeat(32)}`,
  initialNonce: 7n,
  finalNonce: 11n,
  proposerIsLeft: false,
  initialProofbodyHash: ZeroHash,
  startedByLeft: true,
  cooperative: false,
  finalProofbody: {
    watchSeed: ZeroHash,
    leftResponseSeconds: 10,
    rightResponseSeconds: 10,
    offdeltas: [encodeInt512(-100n)],
    tokenIds: [1n],
    transformers: [
      {
        transformerAddress: `0x${'33'.repeat(20)}`,
        encodedBatch: '0x1234',
        allowances: [{ deltaIndex: 0n, rightAllowance: 3n, leftAllowance: 4n }],
      },
    ],
  },
  starterArguments: '0x5678',
  otherArguments: '0xabcd',
  sig: '0x0102',
};
const calldata = Depository__factory.createInterface().encodeFunctionData('watchtowerCounterDispute', [
  sender,
  proof,
  4n,
  11n,
  '0x0304',
]);

test('delegated finalization authenticates the effective empty signature and rejects the repeated calldata signature', () => {
  // Depository authorizes the selected counter, then sets executable.sig=""
  // before hashing DisputeFinalized. Raw calldata.sig is not the emitted evidence.
  const event = {
    sender,
    counterentity: proof.counterentity,
    initialNonce: 7n,
    finalProofbodyHash: ZeroHash,
    finalizationEvidenceHash: keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
        [
          proof.initialProofbodyHash,
          proof.finalNonce,
          proof.proposerIsLeft,
          proof.startedByLeft,
          keccak256(proof.starterArguments),
          keccak256(proof.otherArguments),
          keccak256('0x'),
        ],
      ),
    ),
  };
  const candidates = decodeDisputeFinalizationEvidenceCalldata(calldata);
  expect(resolveDisputeFinalizationEvidence(candidates, ZeroHash, event).sig).toBe('0x');
  expect(() =>
    resolveDisputeFinalizationEvidence(
      candidates.map(c => ({ ...c, sig: proof.sig })),
      ZeroHash,
      event,
    ),
  ).toThrow('J_DISPUTE_FINALIZATION_EVIDENCE_NOT_FOUND');
});

test('delegated proof bodies are validated plain state, including nested amounts and allowances', () => {
  const candidates = decodeDisputeProofBodyEvidenceCalldata(calldata);
  expect(candidates.map(candidate => candidate.eventName)).toEqual(['CounterDisputeRegistered', 'DisputeFinalized']);
  for (const candidate of candidates) {
    expect(structuredClone(candidate.proofbody)).toEqual(proof.finalProofbody);
  }
});
