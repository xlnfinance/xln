import type { JsonRpcProvider } from 'ethers';
import { readNativeJournal, readNativeTransactions } from '../transactions.cjs';
import { assertNativeJournalIdentity } from '../artifacts/namespace.cjs';
import { assertNativeReceipts } from '../receipts.cjs';
import { STACK_ARTIFACTS } from '../../../../core/jurisdiction/adapter/stack-manager/verification.ts';
import { record } from './inputs.ts';
import type { readVerificationInputs } from './readonly-identity.ts';

type Input = Awaited<ReturnType<typeof readVerificationInputs>>;

const operations = (input: Input) => {
  const { manifest } = input;
  const creations = Object.entries(STACK_ARTIFACTS).map(([name, descriptor]) => {
    const deployment = record(record(manifest.evmContracts)[name]);
    return {
      name: descriptor.contractName,
      transactionHash: deployment['transactionHash'],
      blockNumber: deployment['deploymentBlock'],
      target: null,
    };
  });
  if (manifest.evmContracts.stablecoin)
    creations.push({
      name: 'ERC20Mock',
      transactionHash: manifest.evmContracts.stablecoin.transactionHash,
      blockNumber: manifest.evmContracts.stablecoin.deploymentBlock,
      target: null,
    });
  const calls = [
    {
      name: 'DeltaTransformer#bindDepository',
      ...manifest.evmContracts.deltaTransformerBinding,
      target: manifest.contracts.deltaTransformer,
    },
    {
      name: 'EntityProvider#bindShareDepository',
      ...manifest.evmContracts.shareDepositoryBinding,
      target: manifest.contracts.entityProvider,
    },
    {
      name: 'EntityProvider#foundationRegisterExternalToken',
      ...manifest.evmContracts.stablecoinRegistration,
      target: manifest.contracts.entityProvider,
    },
  ];
  return [...creations, ...calls];
};

export const verifyReadonlyJournal = async (input: Input, provider: JsonRpcProvider): Promise<number> => {
  const messages: unknown = await readNativeJournal(input.directory);
  if (!Array.isArray(messages) || record(messages[0])['chainId'] !== input.manifest.chainId) {
    throw new Error('XLN_VERIFY_JOURNAL_CHAIN_MISMATCH');
  }
  assertNativeJournalIdentity(messages, input.manifest.deploymentId);
  const transactions: unknown = await readNativeTransactions(input.directory);
  if (!Array.isArray(transactions)) throw new Error('XLN_VERIFY_NATIVE_TRANSACTIONS_INVALID');
  const winners = transactions.map(record).filter(transaction => transaction['status'] === 'SUCCESS');
  const expected = operations(input);
  if (
    winners.length !== expected.length ||
    new Set(winners.map(transaction => transaction['futureId'])).size !== expected.length ||
    new Set(expected.map(operation => operation.transactionHash)).size !== expected.length
  ) {
    throw new Error('XLN_VERIFY_NATIVE_OPERATIONS_MISMATCH');
  }
  for (const operation of expected) {
    const winner = winners.find(transaction => transaction['txHash'] === operation.transactionHash);
    if (
      !winner ||
      winner['name'] !== operation.name ||
      record(winner['inclusion'])['blockNumber'] !== operation.blockNumber ||
      winner['from'] !== input.manifest.deployer
    )
      throw new Error('XLN_VERIFY_NATIVE_OPERATION_MISMATCH');
    const transaction = await provider.getTransaction(String(operation.transactionHash));
    if (
      !transaction ||
      transaction.from !== input.manifest.deployer ||
      transaction.nonce !== winner['nonce'] ||
      transaction.to !== operation.target
    )
      throw new Error('XLN_VERIFY_NATIVE_TRANSACTION_MISMATCH');
  }
  const nonces = winners.map(transaction => transaction['nonce']).sort((left, right) => Number(left) - Number(right));
  if (nonces.some((nonce, index) => nonce !== input.identity.origin.nonce + index))
    throw new Error('XLN_VERIFY_NATIVE_NONCE_MISMATCH');
  await assertNativeReceipts(input.directory, provider);
  return expected.length;
};
