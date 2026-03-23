import { ethers } from 'ethers';

import { computeBatchHankoHash, encodeJBatch, type JBatch } from '../j-batch';
import { normalizeEntityId } from '../entity-id-utils';

const HANKO_ABI = ['tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256)[])'];

const toPrivateKeyHex = (privateKey: string | Uint8Array): string =>
  typeof privateKey === 'string' ? privateKey : ethers.hexlify(privateKey);

export const getEntityNonceAddress = (entityId: string): string =>
  ethers.getAddress(`0x${normalizeEntityId(entityId).slice(-40)}`);

export function buildSingleSignerHanko(
  entityId: string,
  hash: string,
  privateKey: string | Uint8Array,
): string {
  const signingKey = new ethers.SigningKey(toPrivateKeyHex(privateKey));
  const signature = signingKey.sign(ethers.getBytes(hash));
  const vBit = signature.v === 28 ? 1 : 0;
  const packedSig = ethers.concat([signature.r, signature.s, ethers.toBeHex(vBit, 1)]);
  const paddedEntityId = ethers.zeroPadValue(normalizeEntityId(entityId), 32);

  return ethers.AbiCoder.defaultAbiCoder().encode(HANKO_ABI, [[
    [],
    packedSig,
    [[paddedEntityId, [0], [1], 1]],
  ]]);
}

export function prepareSignedBatch(
  batch: JBatch,
  entityId: string,
  privateKey: string | Uint8Array,
  chainId: bigint,
  depositoryAddress: string,
  currentNonce: bigint,
): {
  encodedBatch: string;
  hankoData: string;
  nextNonce: bigint;
  batchHash: string;
} {
  const encodedBatch = encodeJBatch(batch);
  const nextNonce = currentNonce + 1n;
  const batchHash = computeBatchHankoHash(chainId, depositoryAddress, encodedBatch, nextNonce);
  const hankoData = buildSingleSignerHanko(entityId, batchHash, privateKey);
  return { encodedBatch, hankoData, nextNonce, batchHash };
}
