/** Read-only audit of the installed native NDJSON journal. Ignition alone
 * replays/schedules Futures; no sidecar state or transaction sender lives here. */
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const readNativeJournal = async directory => {
  let messages;
  try {
    messages = (await readFile(join(directory, 'journal.jsonl'), 'utf8'))
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line, (_, value) => (value && value._kind === 'bigint' ? BigInt(value.value) : value)));
  } catch (error) {
    throw new Error('STACK_MANAGER_IGNITION_JOURNAL_INVALID', { cause: error });
  }
  if (
    messages[0]?.type !== 'DEPLOYMENT_INITIALIZE' ||
    !Number.isSafeInteger(messages[0].chainId) ||
    messages.some(message => !message || typeof message.type !== 'string')
  )
    throw new Error('STACK_MANAGER_IGNITION_JOURNAL_INVALID');
  return messages;
};

const readNativeTransactions = async directory => {
  const messages = await readNativeJournal(directory);
  const states = new Map();
  const transactions = [];
  const latest = new Map();
  const confirmed = new Set();
  for (const message of messages) {
    if (['DEPLOYMENT_EXECUTION_STATE_INITIALIZE', 'CALL_EXECUTION_STATE_INITIALIZE'].includes(message.type)) {
      states.set(message.futureId, message);
    } else if (message.type === 'TRANSACTION_SEND') {
      const state = states.get(message.futureId);
      if (!state || !/^0x[0-9a-fA-F]{64}$/.test(message.transaction?.hash) || !Number.isSafeInteger(message.nonce)) {
        throw new Error('STACK_MANAGER_IGNITION_TRANSACTION_INVALID');
      }
      const name = state.functionName
        ? `${states.get(state.artifactId)?.contractName}#${state.functionName}`
        : state.contractName;
      if (typeof name !== 'string' || name.startsWith('undefined#'))
        throw new Error('STACK_MANAGER_IGNITION_ARTIFACT_INVALID');
      const key = `${message.futureId}/${message.networkInteractionId}`;
      latest.set(key, message.transaction.hash);
      transactions.push({
        futureId: message.futureId,
        networkInteractionId: message.networkInteractionId,
        nonce: message.nonce,
        from: state.from,
        to: state.contractAddress,
        txHash: message.transaction.hash,
        fees: message.transaction.fees,
        name,
        params: state.args || state.constructorArgs,
        value: state.value,
        status: 'PENDING',
        key,
      });
    } else if (message.type === 'TRANSACTION_CONFIRM') {
      confirmed.add(`${message.futureId}/${message.networkInteractionId}`);
      const sent = transactions.filter(
        tx =>
          tx.txHash === message.hash &&
          tx.futureId === message.futureId &&
          tx.networkInteractionId === message.networkInteractionId,
      );
      if (!sent.length || !['SUCCESS', 'FAILURE'].includes(message.receipt?.status))
        throw new Error('STACK_MANAGER_IGNITION_CONFIRM_INVALID');
      const { blockHash, blockNumber } = message.receipt;
      if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash) || !Number.isSafeInteger(blockNumber) || blockNumber < 0)
        throw new Error('STACK_MANAGER_IGNITION_CONFIRM_INVALID');
      sent.forEach(tx => {
        tx.status = message.receipt.status;
        tx.inclusion = { blockHash, blockNumber };
      });
    }
  }
  return transactions.map(({ key, ...tx }) => ({
    ...tx,
    status: tx.status === 'PENDING' && (confirmed.has(key) || latest.get(key) !== tx.txHash) ? 'DROPPED' : tx.status,
  }));
};

module.exports = { readNativeJournal, readNativeTransactions };
