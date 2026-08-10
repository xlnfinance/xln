import { ethers } from 'ethers';
import { normalizeEntityId } from '../../entity/id';
import type { JEvent } from './types';
import type { RpcContractStack } from './rpc-contract-stack';
import { extractCanonicalDepositoryEventArgs } from './depository-event-codec';
import {
  decodeDisputeFinalizationEvidenceCalldata,
  resolveDisputeFinalizationEvidence,
} from './rpc-public';

export type DisputeFinalizationReceipt = {
  blockNumber: number;
  transactionHash: string;
};

export type RpcReceiptReaders = {
  readEntityProviderActionReceipt(entityId: string, actionNonce: bigint): Promise<JEvent | null>;
  hasProcessedBatch(entityId: string, batchHash: string, entityNonce: bigint): Promise<boolean>;
  readDisputeFinalizationReceipt(
    entityId: string,
    counterentity: string,
    initialNonce: bigint,
    initialProofbodyHash: string,
  ): Promise<DisputeFinalizationReceipt | null>;
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

  async readDisputeFinalizationReceipt(entityId, counterentity, initialNonce, initialProofbodyHash) {
    const entity = normalizeEntityId(entityId);
    const counter = normalizeEntityId(counterentity);
    if (initialNonce < 0n || initialNonce > ethers.MaxUint256) {
      throw new Error(`DISPUTE_FINALIZATION_RECEIPT_NONCE_INVALID:${initialNonce.toString()}`);
    }
    if (!ethers.isHexString(initialProofbodyHash, 32)) {
      throw new Error(`DISPUTE_FINALIZATION_RECEIPT_PROOFBODY_HASH_INVALID:${initialProofbodyHash}`);
    }
    const event = stack.depository.interface.getEvent('DisputeFinalized');
    if (!event) throw new Error('DISPUTE_FINALIZATION_EVENT_ABI_MISSING');
    const pairTopics = [[entity, counter], [counter, entity]] as const;
    const depositoryAddress = await stack.getDepositoryAddress();
    const logs = (await Promise.all(pairTopics.map(([sender, peer]) => provider.getLogs({
      address: depositoryAddress,
      fromBlock: Math.max(0, stack.entityProviderDeploymentBlock),
      toBlock: 'latest',
      topics: [
        event.topicHash,
        ethers.zeroPadValue(sender, 32),
        ethers.zeroPadValue(peer, 32),
        ethers.zeroPadValue(ethers.toBeHex(initialNonce), 32),
      ],
    })))).flat();
    if (logs.length > 1) {
      throw new Error(`DISPUTE_FINALIZATION_RECEIPT_DUPLICATE:${entity}:${counter}:${initialNonce}`);
    }
    const log = logs[0];
    if (!log) return null;
    const parsed = stack.depository.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed || parsed.name !== 'DisputeFinalized') {
      throw new Error(`DISPUTE_FINALIZATION_RECEIPT_DECODE_FAILED:${log.transactionHash}`);
    }
    const args = extractCanonicalDepositoryEventArgs(parsed);
    const transaction = await provider.getTransaction(log.transactionHash);
    if (!transaction) throw new Error(`DISPUTE_FINALIZATION_TRANSACTION_MISSING:${log.transactionHash}`);
    const evidence = resolveDisputeFinalizationEvidence(
      decodeDisputeFinalizationEvidenceCalldata(transaction.data),
      log.transactionHash,
      args,
    );
    if (
      evidence.initialNonce !== initialNonce.toString() ||
      evidence.initialProofbodyHash.toLowerCase() !== initialProofbodyHash.toLowerCase()
    ) return null;
    return {
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    };
  },
});
