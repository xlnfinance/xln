import { Contract, Interface, JsonRpcProvider } from 'ethers';
import type { JurisdictionStackManifest } from './types';
import { readConfirmedReceipt } from './receipts';
import { encodeBoard, hashBoard } from '../../../entity/factory';

const verifyBinding = async (
  provider: JsonRpcProvider, manifest: JurisdictionStackManifest, confirmations: number,
  name: 'deltaTransformerBinding' | 'shareDepositoryBinding',
  blockTag: number | 'latest',
): Promise<void> => {
  const transformer = name === 'deltaTransformerBinding';
  const target = transformer ? manifest.contracts.deltaTransformer : manifest.contracts.entityProvider;
  const method = transformer ? 'bindDepository' : 'bindShareDepository';
  const binding = manifest.evmContracts[name];
  const transaction = await provider.getTransaction(binding.transactionHash);
  const expected = new Interface([`function ${method}(address)`]).encodeFunctionData(method, [manifest.contracts.depository]);
  if (!transaction || transaction.from.toLowerCase() !== manifest.deployer.toLowerCase()
    || transaction.to?.toLowerCase() !== target.toLowerCase() || transaction.data !== expected || transaction.value !== 0n) {
    throw new Error(`STACK_MANAGER_BINDING_TRANSACTION_MISMATCH:${name}`);
  }
  await readConfirmedReceipt(provider, binding.transactionHash, confirmations, receipt => {
    if (!receipt || receipt.status !== 1 || receipt.blockNumber !== binding.blockNumber || receipt.to?.toLowerCase() !== target.toLowerCase()) {
      throw new Error(`STACK_MANAGER_BINDING_RECEIPT_INVALID:${name}`);
    }
    return receipt;
  }, blockTag === 'latest' ? undefined : blockTag);
  const getter = transformer ? 'depository' : 'shareDepository';
  const contract = new Contract(target, [`function ${getter}() view returns (address)`], provider);
  if (String(await contract.getFunction(getter)({ blockTag })).toLowerCase() !== manifest.contracts.depository.toLowerCase()) {
    throw new Error(`STACK_MANAGER_BINDING_STATE_MISMATCH:${name}`);
  }
};

export const verifyStackBindings = async (provider: JsonRpcProvider, manifest: JurisdictionStackManifest, confirmations: number, blockTag: number | 'latest' = 'latest'): Promise<void> => {
  await verifyBinding(provider, manifest, confirmations, 'deltaTransformerBinding', blockTag);
  await verifyBinding(provider, manifest, confirmations, 'shareDepositoryBinding', blockTag);
  const authority = await readStackFoundationAuthority(provider, manifest.contracts.entityProvider, manifest.foundationRecipient, blockTag);
  if (authority.nonce !== 1n) throw new Error('STACK_MANAGER_FOUNDATION_NONCE_MISMATCH');
  if (authority.registrationBlock !== BigInt(manifest.entityProviderDeploymentBlock)) throw new Error('STACK_MANAGER_FOUNDATION_AUTHORITY_MISMATCH');
};

export const readStackFoundationAuthority = async (provider: JsonRpcProvider, address: string, recipient: string, blockTag: number | 'latest' = 'latest') => {
  const ep = new Contract(address, [
    'function entityActionNonces(bytes32) view returns (uint256)',
    'function getEntityInfo(bytes32) view returns (bool exists,bytes32 currentBoardHash,bytes32 proposedBoardHash,uint256 registrationBlock)',
  ], provider);
  const foundationId = `0x${'0'.repeat(63)}1`;
  const board = hashBoard(encodeBoard({ mode: 'proposer-based', threshold: 1n,
    validators: [recipient], shares: { [recipient]: 1n } }));
  const foundation = await ep.getFunction('getEntityInfo')(foundationId, { blockTag });
  if (!foundation.exists || foundation.currentBoardHash !== board) {
    throw new Error('STACK_MANAGER_FOUNDATION_AUTHORITY_MISMATCH');
  }
  return { nonce: BigInt(await ep.getFunction('entityActionNonces')(foundationId, { blockTag })), registrationBlock: BigInt(foundation.registrationBlock) };
};
