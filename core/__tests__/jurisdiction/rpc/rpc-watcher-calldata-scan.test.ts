import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { Depository__factory } from '../../../../jurisdictions/typechain-types';
import { extractEmbeddedDisputeCalls } from '../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-calldata';

const depository = Depository__factory.createInterface();
const call = (data = '0x'): string => depository.encodeFunctionData('processBatch', [data, '0x01', 1n]);
const word = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes.set(ethers.getBytes(ethers.toBeHex(value, 32)), offset);
};

test('an exact canonical call consumes nested selector-shaped bytes once', () => {
  let nested = call();
  for (let index = 0; index < 128; index += 1) nested = call(nested);
  expect(extractEmbeddedDisputeCalls(`0x12345678${nested.slice(2)}`)).toEqual([nested]);
});

test('noncontiguous and overlapping bytes tails are not canonical calls', () => {
  for (const [slot, value] of [
    [4, 128],
    [36, 96],
    [36, 192],
  ]) {
    const bytes = ethers.getBytes(call('0x1234'));
    word(bytes, slot!, value!);
    expect(extractEmbeddedDisputeCalls(ethers.hexlify(bytes))).toEqual([]);
  }
});

test('watchtower nested tuple and dynamic-array tails must remain contiguous', () => {
  const proof = {
    counterentity: ethers.ZeroHash,
    initialNonce: 1n,
    finalNonce: 2n,
    proposerIsLeft: true,
    initialProofbodyHash: ethers.ZeroHash,
    finalProofbody: {
      watchSeed: ethers.ZeroHash,
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [{ high: 0n, low: 1n }],
      tokenIds: [1n],
      transformers: [
        {
          transformerAddress: ethers.ZeroAddress,
          encodedBatch: '0x1234',
          allowances: [{ deltaIndex: 0n, rightAllowance: 1n, leftAllowance: 2n }],
        },
      ],
    },
    starterArguments: '0x01',
    otherArguments: '0x02',
    sig: '0x03',
    startedByLeft: true,
    cooperative: false,
  };
  const encoded = depository.encodeFunctionData('watchtowerCounterDispute', [ethers.ZeroHash, proof, 10n, 1n, '0x04']);
  expect(extractEmbeddedDisputeCalls(encoded)).toEqual([encoded]);
  const bytes = ethers.getBytes(encoded);
  // params starts after five top-level words; its first dynamic field is slot 5.
  word(bytes, 4 + 5 * 32 + 5 * 32, 12 * 32);
  expect(extractEmbeddedDisputeCalls(ethers.hexlify(bytes))).toEqual([]);
});
