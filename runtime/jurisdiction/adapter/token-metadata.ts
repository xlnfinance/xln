import { ethers } from 'ethers';

import type { JTokenInfo } from './types';

const DIVIDEND_CLASS_BIT = 1n << 255n;

const requireTokenType = (value: bigint | number): 0 | 1 | 2 => {
  const tokenType = Number(value);
  if (tokenType !== 0 && tokenType !== 1 && tokenType !== 2) {
    throw new Error(`TOKEN_REGISTRY_ENTRY_TYPE_INVALID:${String(value)}`);
  }
  return tokenType;
};

export const buildNonFungibleTokenInfo = (input: Readonly<{
  tokenId: number;
  tokenType: bigint | number;
  contractAddress: string;
  externalTokenId: bigint;
  entityProviderAddress: string;
}>): JTokenInfo => {
  const tokenType = requireTokenType(input.tokenType);
  if (tokenType === 0) throw new Error('TOKEN_REGISTRY_NON_FUNGIBLE_TYPE_REQUIRED');
  const address = ethers.getAddress(input.contractAddress);
  const provider = ethers.getAddress(input.entityProviderAddress);
  if (tokenType === 2 && address === provider) {
    const dividend = (input.externalTokenId & DIVIDEND_CLASS_BIT) !== 0n;
    const entityNumber = input.externalTokenId & ~DIVIDEND_CLASS_BIT;
    if (entityNumber <= 0n || entityNumber > ((1n << 160n) - 1n)) {
      throw new Error(`ENTITY_SHARE_TOKEN_ID_INVALID:${input.externalTokenId.toString()}`);
    }
    const shareClass = dividend ? 'DIVIDEND' : 'CONTROL';
    return {
      tokenId: input.tokenId,
      tokenType,
      externalTokenId: input.externalTokenId,
      address,
      decimals: 0,
      symbol: `${shareClass}-${entityNumber.toString()}`,
      name: `${shareClass === 'CONTROL' ? 'Control' : 'Dividend'} shares · Entity ${entityNumber.toString()}`,
    };
  }
  const standard = tokenType === 1 ? 'ERC721' : 'ERC1155';
  return {
    tokenId: input.tokenId,
    tokenType,
    externalTokenId: input.externalTokenId,
    address,
    decimals: 0,
    symbol: `${standard}-${input.tokenId}`,
    name: `${standard} asset #${input.externalTokenId.toString()}`,
  };
};
