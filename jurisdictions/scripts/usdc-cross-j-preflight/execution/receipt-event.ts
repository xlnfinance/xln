import type { TransactionReceipt } from 'ethers';
import { Depository__factory } from '../../../typechain-types';
import { computeBatchHankoHash } from '../../../../core/jurisdiction/machine/batch';
import type { ChainBinding } from './providers';

export const depositoryAbi = Depository__factory.createInterface();

export const readDepositoryEvent = (
  chain: ChainBinding,
  receipt: TransactionReceipt,
  name: Parameters<typeof depositoryAbi.getEvent>[0],
) => {
  const event = depositoryAbi.getEvent(name);
  const logs = receipt.logs.filter(
    log => log.address.toLowerCase() === chain.depository && log.topics[0] === event.topicHash,
  );
  if (logs.length !== 1) throw new Error(`USDC_EXECUTION_BATCH_EVENT_COUNT:${receipt.hash}`);
  const log = logs[0]!;
  return depositoryAbi.decodeEventLog(event, log.data, log.topics);
};

/** An approved EOA pays gas. The Depository event identifies the Entity that authorized the batch. */
export const verifyBatchReceipt = (
  chain: ChainBinding,
  receipt: TransactionReceipt,
  batch: Readonly<{ encoded: string; nonce: bigint; entityId: string }>,
): void => {
  const [entity, hash, nonce] = readDepositoryEvent(chain, receipt, 'HankoBatchProcessed');
  const expectedHash = computeBatchHankoHash(BigInt(chain.chainId), chain.depository, batch.encoded, batch.nonce);
  if (entity !== batch.entityId || hash !== expectedHash || nonce !== batch.nonce)
    throw new Error(`USDC_EXECUTION_BATCH_EVENT_MISMATCH:${receipt.hash}`);
};
