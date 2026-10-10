import { describe, expect, test } from 'bun:test';
import { ethers, type Provider } from 'ethers';

import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { createEmptyBatch, encodeJBatch } from '../../../jurisdiction/machine/batch';
import {
  createTxDisputeProofBodyReader,
  createTxFinalizationEvidenceReader,
} from '../../../jurisdiction/adapter/rpc-watcher-inputs';
import { encodeInt512 } from '../../../protocol/crypto/abi-money';
import { hashProofBodyStruct } from '../../../protocol/dispute/proof-builder';

const bytes32 = (byte: string): string => `0x${byte.repeat(32)}`;
const depository = Depository__factory.createInterface();
const location = { blockHash: bytes32('99'), blockNumber: 42 };
const body = {
  watchSeed: bytes32('44'),
  leftResponseSeconds: 10,
  rightResponseSeconds: 10,
  offdeltas: [encodeInt512(5n), encodeInt512(-3n)],
  tokenIds: [1n, 2n],
  transformers: [],
};
const otherBody = { ...body, offdeltas: [encodeInt512(6n)] };
const startArgs = {
  counterentity: bytes32('22'), nonce: 7n, proposerIsLeft: true, proofbodyHash: hashProofBodyStruct(body),
};

const processBatchCall = (proofbodyHash: string, nonce = 3n, initialProofbody = body): string => {
  const batch = createEmptyBatch();
  batch.disputeStarts.push({
    counterentity: startArgs.counterentity,
    nonce: 7,
    proposerIsLeft: true,
    proofbodyHash,
    initialProofbody,
    watchSeed: body.watchSeed,
    sig: '0x01',
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: bytes32('00'),
  });
  return depository.encodeFunctionData('processBatch', [encodeJBatch(batch), '0x0102', nonce]);
};

/** Safe-style wrapper: the call is an ABI-encoded `bytes` argument. */
const safeWrapper = (inner: string): string =>
  new ethers.Interface(['function execTransaction(address to,uint256 value,bytes data)'])
    .encodeFunctionData('execTransaction', [ethers.ZeroAddress, 0n, inner]);

/** Gnosis MultiSend: packed (uint8,address,uint256,uint256,bytes) records, not 32-byte aligned. */
const multiSend = (...inner: string[]): string =>
  new ethers.Interface(['function multiSend(bytes transactions)']).encodeFunctionData('multiSend', [
    ethers.concat(inner.map(call => ethers.solidityPacked(
      ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
      [0, ethers.ZeroAddress, 0n, ethers.dataLength(call), call],
    ))),
  ]);

const signedTransaction = async (data: string): Promise<{ hash: string; provider: Provider }> => {
  const wallet = ethers.Wallet.createRandom();
  const signed = ethers.Transaction.from(await wallet.signTransaction({
    chainId: 1, nonce: 0, gasLimit: 1_000_000, gasPrice: 1, to: ethers.ZeroAddress, value: 0, data,
  }));
  const response = {
    type: signed.type, chainId: signed.chainId, nonce: signed.nonce, gasLimit: signed.gasLimit,
    gasPrice: signed.gasPrice, to: signed.to, value: signed.value, data: signed.data,
    accessList: signed.accessList, signature: signed.signature, hash: signed.hash,
  };
  return { hash: signed.hash!, provider: { getTransaction: async () => response } as unknown as Provider };
};

const resolveStart = async (data: string) => {
  const { hash, provider } = await signedTransaction(data);
  return createTxDisputeProofBodyReader(provider)(hash, 'DisputeStarted', startArgs, location);
};

describe('J watcher dispute calldata embedded in a wrapper call', () => {
  test('resolves the ProofBody of processBatch inside an ABI bytes argument', async () => {
    expect(await resolveStart(safeWrapper(processBatchCall(startArgs.proofbodyHash)))).toEqual(body);
  });

  test('resolves the ProofBody of processBatch inside a packed MultiSend record', async () => {
    const inner = processBatchCall(startArgs.proofbodyHash);
    const data = multiSend('0x01', inner);
    const innerOffset = (data.indexOf(inner.slice(2)) - 2) / 2;
    expect((innerOffset - 4) % 32).not.toBe(0);
    expect(await resolveStart(data)).toEqual(body);
  });

  test('accepts only the embedded entry whose proofbodyHash matches the event', async () => {
    await expect(resolveStart(safeWrapper(processBatchCall(hashProofBodyStruct(otherBody), 3n, otherBody))))
      .rejects.toThrow('J_DISPUTE_PROOFBODY_EVIDENCE_NOT_FOUND');
    // Decoys first: another claimed hash, then the event's hash claimed over another body.
    const decoyFirst = multiSend(
      processBatchCall(hashProofBodyStruct(otherBody), 9n, otherBody),
      processBatchCall(startArgs.proofbodyHash, 9n, otherBody),
      processBatchCall(startArgs.proofbodyHash),
    );
    expect(await resolveStart(decoyFirst)).toEqual(body);
  });

  test('resolves DisputeFinalized evidence of an embedded watchtower counter-dispute', async () => {
    const proof = {
      counterentity: bytes32('22'), initialNonce: 7n, finalNonce: 11n, proposerIsLeft: false,
      initialProofbodyHash: bytes32('33'), finalProofbody: body, starterArguments: '0x5678',
      otherArguments: '0xabcd', sig: '0x0102', startedByLeft: true, cooperative: false,
    };
    const inner = depository.encodeFunctionData('watchtowerCounterDispute', [bytes32('11'), proof, 25n, 3n, '0x0304']);
    const { hash, provider } = await signedTransaction(safeWrapper(inner));
    expect(await createTxFinalizationEvidenceReader(provider)(hash, location)).toEqual([expect.objectContaining({
      counterentity: proof.counterentity, initialNonce: '7', finalNonce: '11', leftArguments: '0x5678',
    })]);
  });

  test('calldata with no embedded dispute call keeps the strict decoder failure', async () => {
    await expect(resolveStart(safeWrapper('0x1234'))).rejects.toThrow('J_DISPUTE_PROOFBODY_CALLDATA_UNKNOWN');
  });
});
