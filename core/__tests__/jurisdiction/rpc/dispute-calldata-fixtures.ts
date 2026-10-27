import { ethers, type Provider } from 'ethers';
import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { createEmptyBatch, encodeJBatch } from '../../../jurisdiction/machine/batch';
import { hashProofBodyStruct } from '../../../protocol/dispute/proof-builder';
import { PROOF_BODY_ABI } from '../../../protocol/dispute/proof-body';

export const depository = Depository__factory.createInterface();
export const location = { blockHash: `0x${'99'.repeat(32)}`, blockNumber: 42 };
export const body = {
  watchSeed: `0x${'44'.repeat(32)}`,
  leftResponseSeconds: 10,
  rightResponseSeconds: 10,
  offdeltas: [{ high: 0n, low: 5n }],
  tokenIds: [1n],
  transformers: [{ transformerAddress: ethers.ZeroAddress, encodedBatch: '0x', allowances: [] }],
};
export type Body = typeof body;
export const argsFor = (proofbody: Body) => ({
  counterentity: `0x${'22'.repeat(32)}`,
  nonce: 7n,
  proposerIsLeft: true,
  proofbodyHash: hashProofBodyStruct(proofbody),
});
export const wrap = (data: string, decoys = '0x01'): string =>
  depository.encodeFunctionData('processBatch', [data, decoys, 1n]);
export const startCall = (proofbody = body, claimedHash = hashProofBodyStruct(proofbody)): string => {
  const batch = createEmptyBatch();
  batch.disputeStarts.push({
    ...argsFor(proofbody),
    nonce: 7,
    proofbodyHash: claimedHash,
    initialProofbody: proofbody,
    watchSeed: proofbody.watchSeed,
    sig: '0x01',
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
    starterCounterProofCommitment: ethers.ZeroHash,
  });
  return wrap(encodeJBatch(batch));
};
export const sizedStart = (length: number): { actual: string; proofbody: Body } => {
  const padding = length - ethers.dataLength(startCall());
  if (padding < 0 || padding % 32 !== 0) throw new Error(`BAD_FIXTURE_SIZE:${length}`);
  const proofbody = {
    ...body,
    transformers: [{ ...body.transformers[0]!, encodedBatch: `0x${'ab'.repeat(padding)}` }],
  };
  const actual = startCall(proofbody);
  if (ethers.dataLength(actual) !== length) throw new Error('FIXTURE_SIZE_MISMATCH');
  return { actual, proofbody };
};
export const word = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes.set(ethers.getBytes(ethers.toBeHex(value, 32)), offset);
};

/** Construct deep canonical bytes wrappers in O(n), without recursive ethers encoding. */
export const nested = (inner: string, depth: number, signature = true): string => {
  const initial = ethers.getBytes(inner);
  if (initial.length % 32 !== 4) throw new Error('FIXTURE_CALL_ALIGNMENT');
  const step = signature ? 224 : 192;
  const bytes = new Uint8Array(initial.length + step * depth);
  const selector = ethers.getBytes(depository.getFunction('processBatch')!.selector);
  for (let index = 0; index < depth; index += 1) {
    const start = index * 132;
    const length = initial.length + step * (depth - index - 1);
    bytes.set(selector, start);
    word(bytes, start + 4, 96);
    word(bytes, start + 36, 128 + Math.ceil(length / 32) * 32);
    word(bytes, start + 68, 1);
    word(bytes, start + 100, length);
    const tail = start + 132 + Math.ceil(length / 32) * 32;
    word(bytes, tail, signature ? 1 : 0);
    if (signature) bytes[tail + 32] = 1;
  }
  bytes.set(initial, depth * 132);
  return ethers.hexlify(bytes);
};

export const signedTransaction = async (data: string) => {
  const signer = new ethers.Wallet(`0x${'11'.repeat(32)}`);
  const tx = ethers.Transaction.from(
    await signer.signTransaction({
      chainId: 1,
      nonce: 0,
      gasLimit: 30_000_000,
      gasPrice: 1,
      to: ethers.ZeroAddress,
      value: 0,
      data,
    }),
  );
  let reads = 0;
  // A genuine signed envelope; only transport is supplied locally.
  const provider = {
    getTransaction: async () => {
      reads += 1;
      return tx;
    },
  } as unknown as Provider;
  return { hash: tx.hash!, provider, reads: () => reads };
};
export const encodedBodyBytes = (proofbody: Body): number =>
  ethers.dataLength(ethers.AbiCoder.defaultAbiCoder().encode([PROOF_BODY_ABI], [proofbody]));

export const finalizationCall = (): string =>
  depository.encodeFunctionData('watchtowerCounterDispute', [
    ethers.ZeroHash,
    {
      counterentity: argsFor(body).counterentity,
      initialNonce: 7n,
      finalNonce: 11n,
      proposerIsLeft: false,
      initialProofbodyHash: ethers.ZeroHash,
      finalProofbody: body,
      starterArguments: '0x12',
      otherArguments: '0x34',
      sig: '0x01',
      startedByLeft: true,
      cooperative: false,
    },
    25n,
    3n,
    '0x01',
  ]);
