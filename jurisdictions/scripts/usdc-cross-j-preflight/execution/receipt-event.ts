import { Transaction, type TransactionReceipt } from 'ethers';
import type { RuntimeReplica } from '../../../../core/runtime/types';
import { evmAttemptSlot } from '../../../../core/storage/queries/evm-attempts';
import type { MinedReceipt } from '../../../../core/scenarios/usdc-poc/evidence';
import type { ChainAuthority, ExecutionAuthority, PayerGrant } from './authority';
import { validateAuthorizedWire } from './calls';
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

export const verifyAuthorizedReceipt = (
  authority: ExecutionAuthority,
  chain: ChainAuthority,
  payer: PayerGrant,
  nonce: number,
  entry: MinedReceipt,
) => {
  const { transaction, receipt } = entry;
  const signed = Transaction.from(transaction);
  // Establish the payer, nonce and receipt before classifying a call rejection.
  // An RPC mismatch cannot prove another transaction spent this slot.
  if (
    transaction.from.toLowerCase() !== payer.address ||
    signed.from?.toLowerCase() !== payer.address ||
    signed.nonce !== nonce ||
    signed.hash !== transaction.hash ||
    receipt.hash !== transaction.hash ||
    receipt.from.toLowerCase() !== payer.address ||
    receipt.to?.toLowerCase() !== signed.to?.toLowerCase() ||
    receipt.blockHash !== transaction.blockHash ||
    receipt.blockNumber !== transaction.blockNumber ||
    (receipt.status !== 1 && receipt.status !== 0)
  )
    throw new Error(`USDC_EXECUTION_RUN_RECEIPT_MISMATCH:${receipt.hash}`);
  const wire = validateAuthorizedWire(authority, chain, signed.serialized);
  if (wire.batch && receipt.status === 1) verifyBatchReceipt(chain, receipt, wire.batch);
  return { ...entry, batch: wire.batch };
};

export const receiptSlots = (authority: ExecutionAuthority, runIndex: number) => {
  const [source, target] = authority.chains;
  const sourceUser = source!.payers.find(payer => payer.role === 'source-user')!;
  const targetUser = target!.payers.find(payer => payer.role === 'target-user')!;
  const targetHub = target!.payers.find(payer => payer.role === 'target-hub')!;
  const nonce = sourceUser.firstNonce + runIndex * 3;
  return [
    ['approval', 0, source!, sourceUser, nonce],
    ['deposit', 0, source!, sourceUser, nonce + 1],
    ['collateral', 0, source!, sourceUser, nonce + 2],
    ['cover', 1, target!, targetHub, targetHub.firstNonce + runIndex],
    ['withdrawal', 1, target!, targetUser, targetUser.firstNonce + runIndex],
  ] as const;
};

const addSignedAttempt = (hashes: Map<string, string[]>, raw: string): void => {
  const wire = Transaction.from(raw);
  if (!wire.from || !wire.hash) throw new Error('USDC_STATUS_WAL_SIGNED_ATTEMPT_INVALID');
  const key = evmAttemptSlot(wire.chainId, wire.from, wire.nonce);
  hashes.set(key, [...new Set([...(hashes.get(key) ?? []), wire.hash])]);
};

export const committedAttemptHashes = (env: RuntimeReplica): Map<string, string[]> => {
  const hashes = new Map<string, string[]>();
  for (const raw of env.infrastructure?.evmWalletApprovals?.values() ?? []) addSignedAttempt(hashes, raw);
  for (const input of env.infrastructure?.pendingCommittedJOutbox ?? []) {
    for (const tx of input.jTxs) {
      if (tx.type !== 'batch') continue;
      const attempt = tx.data.runtimeSubmitAttempt;
      if (!attempt?.rawTransaction) continue;
      for (const raw of [attempt.rawTransaction, ...(attempt.competingTransactions ?? [])])
        addSignedAttempt(hashes, raw);
    }
  }
  return hashes;
};
