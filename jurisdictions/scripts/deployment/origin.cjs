/** The sealed pre-send origin is needed after journal loss and for exact native
 * balance accounting; neither the post-crash wallet nor a truncated tail can derive it. */
const captureOrigin = async (provider, signer) => {
  const block = await provider.getBlock('latest');
  if (!block) throw new Error('STACK_MANAGER_ORIGIN_BLOCK_INVALID');
  const nonce = await provider.getTransactionCount(signer, block.number);
  if ((await provider.getTransactionCount(signer, 'pending')) !== nonce)
    throw new Error('STACK_MANAGER_SENDER_NONCE_CONFLICT');
  return {
    blockNumber: block.number,
    blockHash: block.hash,
    nonce,
    balanceWei: String(await provider.getBalance(signer, block.number)),
  };
};

const verifyOrigin = async (origin, provider, signer) => {
  if (
    !origin ||
    Object.keys(origin).sort().join() !== 'balanceWei,blockHash,blockNumber,nonce' ||
    !Number.isSafeInteger(origin.blockNumber) ||
    origin.blockNumber < 0 ||
    !Number.isSafeInteger(origin.nonce) ||
    origin.nonce < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(origin.blockHash) ||
    typeof origin.balanceWei !== 'string' ||
    !/^\d+$/.test(origin.balanceWei)
  ) {
    throw new Error('STACK_MANAGER_EXECUTION_IDENTITY_INVALID');
  }
  const block = await provider.getBlock(origin.blockNumber);
  if (
    !block ||
    block.hash !== origin.blockHash ||
    (await provider.getTransactionCount(signer, origin.blockNumber)) !== origin.nonce ||
    String(await provider.getBalance(signer, origin.blockNumber)) !== origin.balanceWei
  )
    throw new Error('STACK_MANAGER_ORIGIN_CONFLICT');
  return origin;
};

module.exports = { captureOrigin, verifyOrigin };
