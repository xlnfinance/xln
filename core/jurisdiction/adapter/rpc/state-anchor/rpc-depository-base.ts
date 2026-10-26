import { ethers } from 'ethers';

import { readHashBoundStateRoot } from './rpc-header-hash';
import { readVerifiedGetProof } from './rpc-state-proof';
import { depositoryTokenCountSlot } from './rpc-storage-slots';

// Proof context shared by the Depository anchors (E1 reserves, D2 out-debts)
// at one block: the stateRoot of a header that hashes to the fenced block hash
// and the proven _tokens.length. An audit height reads the header and proves
// the count once instead of once per anchor; each anchor still proves its own
// slots against this stateRoot.

type RpcSend = (method: string, params: unknown[]) => Promise<unknown>;
type Fail = (code: string, detail?: string) => never;

export type DepositoryAnchorBase = {
  address: string;
  blockNumber: number;
  authenticatedBlockHash: string;
  stateRoot: string;
  tokenCount: bigint;
};

const EMPTY_CODE_HASH = ethers.keccak256('0x').toLowerCase();

export const readDepositoryAnchorBase = async (input: {
  send: RpcSend;
  depositoryAddress: string;
  blockNumber: number;
  authenticatedBlockHash: string;
  fail: Fail;
}): Promise<DepositoryAnchorBase> => {
  const { send, blockNumber, fail } = input;
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail('BLOCK_INVALID', String(blockNumber));
  const address = ethers.getAddress(String(input.depositoryAddress ?? ''));
  const stateRoot = await readHashBoundStateRoot(send, blockNumber, input.authenticatedBlockHash);
  const slot = depositoryTokenCountSlot();
  const proven = await readVerifiedGetProof(send, stateRoot, address, [slot], blockNumber);
  // A code-less account proves every slot zero; that is a wrong address.
  if (!proven.account || proven.account.codeHash.toLowerCase() === EMPTY_CODE_HASH) fail('CONTRACT_MISSING', address);
  const tokenCount = proven.storage.get(slot) ?? fail('SLOT_MISSING', 'tokens');
  // The constructor pushes the reserved token id 0; zero means a non-Depository.
  if (tokenCount < 1n || tokenCount > BigInt(Number.MAX_SAFE_INTEGER)) fail('TOKEN_COUNT_INVALID', tokenCount.toString());
  return {
    address,
    blockNumber,
    authenticatedBlockHash: String(input.authenticatedBlockHash).toLowerCase(),
    stateRoot,
    tokenCount,
  };
};

/** Returns the supplied base only if it describes exactly this contract, block and fenced hash. */
export const resolveDepositoryAnchorBase = async (input: {
  send: RpcSend;
  depositoryAddress: string;
  blockNumber: number;
  authenticatedBlockHash: string;
  base: DepositoryAnchorBase | undefined;
  fail: Fail;
}): Promise<DepositoryAnchorBase> => {
  if (!input.base) return readDepositoryAnchorBase(input);
  const { base, fail } = input;
  if (base.address !== ethers.getAddress(String(input.depositoryAddress ?? ''))
    || base.blockNumber !== input.blockNumber
    || base.authenticatedBlockHash !== String(input.authenticatedBlockHash).toLowerCase()) {
    fail('BASE_MISMATCH', `${input.blockNumber}:${base.blockNumber}`);
  }
  return base;
};
