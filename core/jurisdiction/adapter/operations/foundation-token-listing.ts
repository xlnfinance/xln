/**
 * External token listing through the Foundation lane.
 *
 * Depository.registerExternalToken is callable only by the EntityProvider. A
 * token is listed by EntityProvider.foundationRegisterExternalToken under a
 * Hanko from the Foundation entity (bytes32(1)) over
 * computeFoundationActionHash(FOUNDATION_REGISTER_TOKEN, keccak256(abi.encode(
 * depository, tokenType, contractAddress, externalTokenId)), actionNonce) with
 * actionNonce = entityActionNonces(bytes32(1)) + 1. At genesis the Foundation
 * board is the 1-of-1 foundationRecipient EOA.
 */

import { ethers } from 'ethers';

import type { EntityProvider } from '../../../../jurisdictions/typechain-types/index.ts';
import { buildSingleSignerHanko } from '../../../hanko/batch';

const FOUNDATION_ENTITY_ID = ethers.zeroPadValue(ethers.toBeHex(1), 32) as `0x${string}`;

type FoundationTokenListing = Readonly<{
  depository: string;
  tokenType: number;
  contractAddress: string;
  externalTokenId: bigint;
}>;

const foundationTokenListingArgumentsHash = (listing: FoundationTokenListing): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint8', 'address', 'uint256'],
    [listing.depository, listing.tokenType, listing.contractAddress, listing.externalTokenId],
  ));

/** Build (hankoData, actionNonce) for foundationRegisterExternalToken from the Foundation signer key. */
const buildFoundationTokenListingAuthorization = async (
  entityProvider: Pick<EntityProvider, 'entityActionNonces' | 'computeFoundationActionHash' | 'FOUNDATION_REGISTER_TOKEN'>,
  listing: FoundationTokenListing,
  foundationSignerPrivateKey: string | Uint8Array,
): Promise<{ hankoData: string; actionNonce: bigint }> => {
  const actionNonce = (await entityProvider.entityActionNonces(FOUNDATION_ENTITY_ID)) + 1n;
  const actionHash = await entityProvider.computeFoundationActionHash(
    await entityProvider.FOUNDATION_REGISTER_TOKEN(),
    foundationTokenListingArgumentsHash(listing),
    actionNonce,
  );
  return {
    hankoData: buildSingleSignerHanko(FOUNDATION_ENTITY_ID, actionHash, foundationSignerPrivateKey),
    actionNonce,
  };
};

/** Submit the Foundation-authorized listing and wait for its receipt. */
export const foundationRegisterExternalToken = async (
  entityProvider: EntityProvider,
  listing: FoundationTokenListing,
  foundationSignerPrivateKey: string | Uint8Array,
): Promise<ethers.TransactionReceipt> => {
  const authorization = await buildFoundationTokenListingAuthorization(
    entityProvider,
    listing,
    foundationSignerPrivateKey,
  );
  const tx = await entityProvider.foundationRegisterExternalToken(
    listing.depository,
    listing.tokenType,
    listing.contractAddress,
    listing.externalTokenId,
    authorization.hankoData,
    authorization.actionNonce,
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`FOUNDATION_TOKEN_LISTING_RECEIPT_INVALID:${listing.contractAddress}`);
  }
  return receipt;
};
