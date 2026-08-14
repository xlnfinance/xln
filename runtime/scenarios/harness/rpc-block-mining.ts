type RpcBlockMiningProvider = {
  send: (method: string, params: unknown[]) => Promise<unknown>;
};

/** Require the JSON-RPC method surface before any scenario mutates chain time. */
export const requireRpcBlockMiningProvider = (value: unknown): RpcBlockMiningProvider => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('RPC_BLOCK_MINING_PROVIDER_INVALID');
  }
  const send = Reflect.get(value, 'send');
  if (typeof send !== 'function') {
    throw new Error('RPC_BLOCK_MINING_PROVIDER_SEND_MISSING');
  }
  return {
    send: (method, params) => Reflect.apply(send, value, [method, params]),
  };
};

export type ExactBlockMiningResult = {
  startBlock: bigint;
  finalBlock: bigint;
  minedBlocks: bigint;
  method: 'anvil_mine' | 'hardhat_mine' | null;
};

export type ExactUnixAdvanceResult = {
  startUnix: number;
  finalUnix: number;
  advancedSeconds: number;
};

const parseRpcBlockNumber = (value: unknown): bigint => {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return BigInt(value);
  throw new Error(`RPC_BLOCK_NUMBER_INVALID:${String(value)}`);
};

const parseRpcUnixSeconds = (value: unknown): number => {
  const asNumber = typeof value === 'bigint'
    ? Number(value)
    : typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)
        ? Number(BigInt(value))
        : NaN;
  if (!Number.isSafeInteger(asNumber) || asNumber < 0) {
    throw new Error(`RPC_UNIX_SECONDS_INVALID:${String(value)}`);
  }
  return asNumber;
};

const readRpcBlockNumber = async (provider: RpcBlockMiningProvider): Promise<bigint> =>
  parseRpcBlockNumber(await provider.send('eth_blockNumber', []));

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Latest block.timestamp as absolute unix seconds (L1 dispute clock). */
export const readRpcUnixSeconds = async (provider: RpcBlockMiningProvider): Promise<number> => {
  const block = await provider.send('eth_getBlockByNumber', ['latest', false]) as
    | { timestamp?: unknown }
    | null;
  if (!block || block.timestamp === undefined) {
    throw new Error('RPC_LATEST_BLOCK_TIMESTAMP_MISSING');
  }
  return parseRpcUnixSeconds(block.timestamp);
};

/**
 * Advance the jurisdiction wall-clock to an absolute unix deadline.
 * Dispute challenge windows are seconds, not block heights.
 */
export const advanceRpcToUnixSeconds = async (
  provider: RpcBlockMiningProvider,
  targetUnixSeconds: number,
): Promise<ExactUnixAdvanceResult> => {
  if (!Number.isSafeInteger(targetUnixSeconds) || targetUnixSeconds < 0) {
    throw new Error(`RPC_UNIX_TARGET_INVALID:${targetUnixSeconds}`);
  }
  const startUnix = await readRpcUnixSeconds(provider);
  if (startUnix >= targetUnixSeconds) {
    return { startUnix, finalUnix: startUnix, advancedSeconds: 0 };
  }
  const advancedSeconds = targetUnixSeconds - startUnix;
  await provider.send('evm_increaseTime', [advancedSeconds]);
  await provider.send('evm_mine', []);
  const finalUnix = await readRpcUnixSeconds(provider);
  if (finalUnix < targetUnixSeconds) {
    throw new Error(
      `RPC_UNIX_ADVANCE_SHORT:` +
      `start=${startUnix}:target=${targetUnixSeconds}:final=${finalUnix}`,
    );
  }
  return { startUnix, finalUnix, advancedSeconds };
};

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
