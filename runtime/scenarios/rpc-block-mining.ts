type RpcBlockMiningProvider = {
  send: (method: string, params: unknown[]) => Promise<unknown>;
};

export type ExactBlockMiningResult = {
  startBlock: bigint;
  finalBlock: bigint;
  minedBlocks: bigint;
  method: 'anvil_mine' | 'hardhat_mine' | null;
};

const parseRpcBlockNumber = (value: unknown): bigint => {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return BigInt(value);
  throw new Error(`RPC_BLOCK_NUMBER_INVALID:${String(value)}`);
};

const readRpcBlockNumber = async (provider: RpcBlockMiningProvider): Promise<bigint> =>
  parseRpcBlockNumber(await provider.send('eth_blockNumber', []));

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Mine one exact contiguous block range without running a runtime frame per block. */
export const mineRpcToBlockExact = async (
  provider: RpcBlockMiningProvider,
  targetBlock: bigint,
): Promise<ExactBlockMiningResult> => {
  if (targetBlock < 0n) throw new Error(`RPC_BLOCK_TARGET_INVALID:${targetBlock}`);
  const startBlock = await readRpcBlockNumber(provider);
  if (startBlock >= targetBlock) {
    return { startBlock, finalBlock: startBlock, minedBlocks: 0n, method: null };
  }

  const minedBlocks = targetBlock - startBlock;
  const quantity = `0x${minedBlocks.toString(16)}`;
  const failures: string[] = [];
  for (const method of ['anvil_mine', 'hardhat_mine'] as const) {
    try {
      await provider.send(method, [quantity]);
    } catch (error) {
      const afterFailure = await readRpcBlockNumber(provider);
      if (afterFailure !== startBlock) {
        throw new Error(
          `RPC_BATCH_MINE_PARTIAL:${method}:start=${startBlock}:after=${afterFailure}:target=${targetBlock}:error=${errorMessage(error)}`,
        );
      }
      failures.push(`${method}=${errorMessage(error)}`);
      continue;
    }

    const finalBlock = await readRpcBlockNumber(provider);
    if (finalBlock !== targetBlock) {
      throw new Error(
        `RPC_BATCH_MINE_COUNT_MISMATCH:${method}:start=${startBlock}:requested=${minedBlocks}:final=${finalBlock}:target=${targetBlock}`,
      );
    }
    return { startBlock, finalBlock, minedBlocks, method };
  }

  throw new Error(`RPC_BATCH_MINE_UNSUPPORTED:${failures.join('|')}`);
};
