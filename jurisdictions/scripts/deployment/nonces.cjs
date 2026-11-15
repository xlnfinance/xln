const { deploymentModuleIds } = require('./artifacts/namespace.cjs');
const { readNativeTransactions, readNativeJournal } = require('./transactions.cjs');

const assertBroadcastNonce = async (attempt, transaction) => {
  const transactions = await readNativeTransactions(attempt.journalDirectory);
  const messages = await readNativeJournal(attempt.journalDirectory);
  const prepare = messages.findLast(message => message.type === 'TRANSACTION_PREPARE_SEND');
  const order = [...new Set(transactions.map(tx => tx.futureId))];
  const index = order.indexOf(prepare?.futureId);
  const expected = attempt.identity.origin.nonce + (index < 0 ? order.length : index);
  // This only validates Ignition's proposed nonce before the signing provider
  // receives it. Ignition remains the sole allocator, retry and fee authority.
  if (!prepare || prepare.nonce !== expected || BigInt(transaction.nonce) !== BigInt(expected)) {
    throw new Error('STACK_MANAGER_SENDER_NONCE_CONFLICT');
  }
};

const assertNativeNonces = async (attempt, prior, transactions, provider) => {
  const latest = await provider.getTransactionCount(attempt.deployer, 'latest');
  const pending = await provider.getTransactionCount(attempt.deployer, 'pending');
  const nonces = [...new Set(transactions.map(tx => tx.nonce))];
  const first = attempt.identity.origin.nonce;
  if (!nonces.length && pending !== first) throw new Error('STACK_MANAGER_SENDER_NONCE_CONFLICT');
  const order = [...new Set(transactions.map(tx => tx.futureId))];
  if (transactions.some(tx => tx.nonce !== first + order.indexOf(tx.futureId)))
    throw new Error('STACK_MANAGER_SENDER_NONCE_CONFLICT');
  for (const nonce of nonces) {
    if (nonce >= latest) continue;
    const receipts = await Promise.all(
      transactions.filter(tx => tx.nonce === nonce).map(tx => provider.getTransactionReceipt(tx.txHash)),
    );
    // A consumed sender nonce must belong to a known native broadcast. Native
    // may otherwise reallocate a user-replaced nonce and change CREATE order.
    if (!receipts.some(Boolean)) throw new Error('STACK_MANAGER_SENDER_NONCE_CONFLICT');
    if (receipts.some(receipt => receipt?.status === 0)) throw new Error('STACK_MANAGER_NATIVE_TRANSACTION_REVERTED');
  }
  const listing = `${deploymentModuleIds(attempt.deploymentId).listing}#${attempt.wrapped ? 'registerWrappedNative' : 'registerStablecoin'}`;
  if (nonces.length && !prior.successful.includes(listing) && pending > Math.max(...nonces) + 1) {
    throw new Error('STACK_MANAGER_SENDER_NONCE_CONFLICT');
  }
};

module.exports = { assertNativeNonces, assertBroadcastNonce };
