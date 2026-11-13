const { readNativeTransactions } = require('./transactions.cjs');

const assertNativeReceipts = async (directory, provider) => {
  for (const tx of await readNativeTransactions(directory)) {
    if (!tx.inclusion) continue;
    const receipt = await provider.send('eth_getTransactionReceipt', [tx.txHash]);
    const expected = tx.inclusion;
    const number = `0x${expected.blockNumber.toString(16)}`;
    const block = await provider.send('eth_getBlockByNumber', [number, false]);
    // Ignition owns the original confirmation. Re-inclusion is deliberately
    // fail-stop: an address map or the same signed hash cannot silently replace
    // its recorded old-chain evidence, even if the new transaction succeeds.
    if (!receipt || receipt.transactionHash !== tx.txHash || receipt.blockNumber !== number
      || receipt.blockHash !== expected.blockHash || block?.hash !== expected.blockHash) {
      throw new Error(`STACK_MANAGER_IGNITION_RECEIPT_CONFLICT:${tx.txHash}:expected=${number}/${expected.blockHash}:actual=${receipt?.blockNumber}/${receipt?.blockHash}`);
    }
    if (receipt.status !== '0x1') throw new Error('STACK_MANAGER_NATIVE_TRANSACTION_REVERTED');
  }
};

module.exports = { assertNativeReceipts };
