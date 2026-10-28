import { AbiCoder, id, keccak256 } from 'ethers';
import type { HashLadderRegistration } from '../../jurisdiction/machine/batch';

const REGISTRATION_ABI = 'tuple(bytes32 counterpartyEntity,bool targetRole,bytes32 fullHash,bytes32 partialRoot,tuple(uint16 fillRatio,bytes32 fullSecret,bytes32[4] reveals) witness)';

/** Beneficiary authority, independent of the Depository Entity batch nonce. */
export const hashTargetReveal = (
  chainId: number,
  depositoryAddress: string,
  beneficiary: string,
  registration: HashLadderRegistration,
): string => {
  if (!registration.targetRole) throw new Error('TARGET_REVEAL_ROLE_REQUIRED');
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address', 'bytes32', REGISTRATION_ABI],
    [id('XLN_TARGET_HASH_LADDER_REVEAL'), chainId, depositoryAddress, beneficiary, registration],
  ));
};
