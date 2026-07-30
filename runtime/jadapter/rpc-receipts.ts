import { ethers } from 'ethers';
import { normalizeEntityId } from '../entity/id';
import type { JEvent } from './types';
import type { RpcContractStack } from './rpc-contract-stack';

export type RpcReceiptReaders = {
  readEntityProviderActionReceipt(entityId: string, actionNonce: bigint): Promise<JEvent | null>;
  hasProcessedBatch(entityId: string, batchHash: string, entityNonce: bigint): Promise<boolean>;
};

export const createRpcReceiptReaders = (
  provider: ethers.JsonRpcProvider,
  stack: RpcContractStack,
): RpcReceiptReaders => ({
  async readEntityProviderActionReceipt(entityId, actionNonce) {
    const normalizedEntityId = normalizeEntityId(entityId);
    if (actionNonce <= 0n || actionNonce > ethers.MaxUint256) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_NONCE_INVALID:${actionNonce.toString()}`);
    }
    const providerAddress = await stack.getEntityProviderAddress();
    const logs = (
      await Promise.all(
        (['EntityProviderActionExecuted', 'EntityProviderActionCancelled'] as const).map(async eventName => {
          const event = stack.entityProvider.interface.getEvent(eventName);
          return provider.getLogs({
            address: providerAddress,
            fromBlock: stack.entityProviderDeploymentBlock,
            toBlock: 'latest',
            topics: [
              event.topicHash,
              ethers.zeroPadValue(normalizedEntityId, 32),
              ethers.zeroPadValue(ethers.toBeHex(actionNonce), 32),
            ],
          });
        }),
      )
    ).flat();
    if (logs.length > 1) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_DUPLICATE:${normalizedEntityId}:${actionNonce.toString()}`);
    }
    const log = logs[0];
    if (!log) return null;
    const parsed = stack.entityProvider.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed || (parsed.name !== 'EntityProviderActionExecuted' && parsed.name !== 'EntityProviderActionCancelled')) {
      throw new Error(`ENTITY_PROVIDER_ACTION_RECEIPT_DECODE_FAILED:${log.transactionHash}`);
    }
    return {
      name: parsed.name,
      args: Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name, parsed.args[index]])),
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    };
  },

  async hasProcessedBatch(entityId, batchHash, entityNonce) {
    const normalizedEntityId = normalizeEntityId(entityId);
    if (!ethers.isHexString(batchHash, 32)) throw new Error(`HANKO_BATCH_RECEIPT_HASH_INVALID:${batchHash}`);
    if (entityNonce <= 0n || entityNonce > ethers.MaxUint256) {
      throw new Error(`HANKO_BATCH_RECEIPT_NONCE_INVALID:${entityNonce.toString()}`);
    }
    const event = stack.depository.interface.getEvent('HankoBatchProcessed');
    if (!event) throw new Error('HANKO_BATCH_EVENT_ABI_MISSING');
    const logs = await provider.getLogs({
      address: await stack.getDepositoryAddress(),
      fromBlock: Math.max(0, stack.entityProviderDeploymentBlock),
      toBlock: 'latest',
      topics: [event.topicHash, ethers.zeroPadValue(normalizedEntityId, 32), ethers.zeroPadValue(batchHash, 32)],
    });
    const exact = logs.filter(log => {
      const parsed = stack.depository.interface.parseLog({ topics: [...log.topics], data: log.data });
      return parsed?.name === 'HankoBatchProcessed' && BigInt(parsed.args['nonce']) === entityNonce;
    });
    if (exact.length > 1) {
      throw new Error(`HANKO_BATCH_RECEIPT_DUPLICATE:${normalizedEntityId}:${batchHash}:${entityNonce.toString()}`);
    }
    return exact.length === 1;
  },
});
