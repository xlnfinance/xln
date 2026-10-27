import { expect, spyOn, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  createTxDisputeProofBodyReader,
  createTxFinalizationEvidenceReader,
} from '../../../jurisdiction/adapter/rpc-watcher-inputs';
import { resolveDisputeFinalizationEvidence } from '../../../jurisdiction/adapter/rpc-public';
import { createEmptyBatch, decodeJBatch, encodeJBatch } from '../../../jurisdiction/machine/batch';
import {
  argsFor,
  body,
  depository,
  encodedBodyBytes,
  location,
  signedTransaction,
  startCall,
  wrap,
} from '../../helpers/jurisdiction/dispute-calldata-fixtures';

test('an authenticated decoder resource failure is typed, evicted, and succeeds on the next poll', async () => {
  const tx = await signedTransaction(startCall());
  const read = createTxDisputeProofBodyReader(tx.provider);
  const original = ethers.AbiCoder.prototype.decode;
  let attempts = 0;
  const observation = spyOn(ethers.AbiCoder.prototype, 'decode').mockImplementation(function (
    this: ethers.AbiCoder,
    ...args
  ) {
    if (attempts++ === 0) throw new Error(`J_DISPUTE_CALLDATA_BUDGET_EXCEEDED:${tx.hash}:608`);
    return original.apply(this, args);
  });
  try {
    const error = await read(tx.hash, 'DisputeStarted', argsFor(body), location).catch(error => error);
    expect(error.name).toBe('DisputeCalldataResourceError');
    expect(error.message).toContain(tx.hash);
    expect(error.message).toContain('608');
    expect(await read(tx.hash, 'DisputeStarted', argsFor(body), location)).toEqual(body);
    expect(tx.reads()).toBe(2);
  } finally {
    observation.mockRestore();
  }
});

test('one body is decoded once across distinct event entries; cached bodies never bypass event metadata', async () => {
  const batch = decodeJBatch(depository.decodeFunctionData('processBatch', startCall())[0]);
  batch.disputeStarts.push({ ...batch.disputeStarts[0]!, nonce: 8 });
  const tx = await signedTransaction(wrap(encodeJBatch(batch)));
  const read = createTxDisputeProofBodyReader(tx.provider);
  const original = ethers.AbiCoder.prototype.decode;
  let bytes = 0;
  const observation = spyOn(ethers.AbiCoder.prototype, 'decode').mockImplementation(function (
    this: ethers.AbiCoder,
    ...args
  ) {
    bytes += ethers.dataLength(args[1]);
    return original.apply(this, args);
  });
  try {
    expect(await read(tx.hash, 'DisputeStarted', argsFor(body), location)).toEqual(body);
    expect(await read(tx.hash, 'DisputeStarted', { ...argsFor(body), nonce: 8n }, location)).toEqual(body);
    expect(bytes).toBe(encodedBodyBytes(body));
    expect(tx.reads()).toBe(1);
    for (const args of [
      { ...argsFor(body), nonce: 9n },
      { ...argsFor(body), proposerIsLeft: false },
      { ...argsFor(body), counterentity: ethers.ZeroHash },
    ]) {
      await expect(read(tx.hash, 'DisputeStarted', args, location)).rejects.toThrow(
        'J_DISPUTE_PROOFBODY_EVIDENCE_NOT_FOUND',
      );
    }
  } finally {
    observation.mockRestore();
  }
});

test('raw processBatch counter/final bodies and right-started sidecars preserve event commitments', async () => {
  const batch = createEmptyBatch();
  const common = {
    counterentity: argsFor(body).counterentity,
    initialNonce: 7,
    initialProofbodyHash: ethers.ZeroHash,
    proposerIsLeft: false,
  };
  batch.counterDisputes.push({ ...common, counterNonce: 11, counterProofbody: body, sig: '0x01' });
  batch.disputeFinalizations.push({
    ...common,
    finalNonce: 11,
    finalProofbody: body,
    starterArguments: '0x12',
    otherArguments: '0x34',
    sig: '0x01',
    startedByLeft: false,
    cooperative: false,
  });
  const tx = await signedTransaction(wrap(encodeJBatch(batch)));
  const read = createTxDisputeProofBodyReader(tx.provider);
  expect(
    await read(tx.hash, 'CounterDisputeRegistered', { ...argsFor(body), nonce: 11n, proposerIsLeft: false }, location),
  ).toEqual(body);
  const event = {
    sender: ethers.ZeroHash,
    counterentity: common.counterentity,
    initialNonce: 7n,
    finalProofbodyHash: argsFor(body).proofbodyHash,
    finalizationEvidenceHash: ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'bool', 'bool', 'bytes32', 'bytes32', 'bytes32'],
        [
          ethers.ZeroHash,
          11n,
          false,
          false,
          ethers.keccak256('0x12'),
          ethers.keccak256('0x34'),
          ethers.keccak256('0x01'),
        ],
      ),
    ),
  };
  expect(await read(tx.hash, 'DisputeFinalized', event, location)).toEqual(body);
  const candidates = await createTxFinalizationEvidenceReader(tx.provider)(tx.hash, location);
  expect(resolveDisputeFinalizationEvidence(candidates, tx.hash, event)).toMatchObject({
    leftArguments: '0x34',
    rightArguments: '0x12',
    sig: '0x01',
  });
  expect(() =>
    resolveDisputeFinalizationEvidence(
      candidates.map(c => ({ ...c, sig: '0x' })),
      tx.hash,
      event,
    ),
  ).toThrow('J_DISPUTE_FINALIZATION_EVIDENCE_NOT_FOUND');
});

test.each([0, 1, 2, 3, 4])(
  'signed-envelope authentication retains transaction type %i and rejects substituted data',
  async type => {
    const signer = new ethers.Wallet(`0x${'11'.repeat(32)}`);
    const signed = ethers.Transaction.from(
      await signer.signTransaction({
        type,
        chainId: 1,
        nonce: 0,
        gasLimit: 1_000_000,
        to: ethers.ZeroAddress,
        data: startCall(),
        ...(type < 2 ? { gasPrice: 1 } : { maxFeePerGas: 2, maxPriorityFeePerGas: 1 }),
        ...(type === 3 ? { maxFeePerBlobGas: 1, blobVersionedHashes: [`0x01${'00'.repeat(31)}`] } : {}),
        ...(type === 4
          ? {
              authorizationList: [
                {
                  chainId: 1,
                  address: ethers.ZeroAddress,
                  nonce: 0,
                  signature: signer.signingKey.sign(ethers.ZeroHash),
                },
              ],
            }
          : {}),
      }),
    );
    const hash = signed.hash!;
    let substituteData = false;
    const response = new Proxy(signed, {
      get: (target, key) =>
        key === 'hash' ? hash : key === 'data' && substituteData ? '0x1234' : Reflect.get(target, key, target),
    });
    const provider = { getTransaction: async () => response } as unknown as import('ethers').Provider;
    expect(await createTxDisputeProofBodyReader(provider)(hash, 'DisputeStarted', argsFor(body), location)).toEqual(
      body,
    );
    substituteData = true;
    await expect(
      createTxDisputeProofBodyReader(provider)(hash, 'DisputeStarted', argsFor(body), location),
    ).rejects.toThrow('J_DISPUTE_TX_HASH_INVALID');
  },
);
