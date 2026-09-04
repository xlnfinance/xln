import {
  combineShards,
  createShardSalt,
  deriveKey,
  deriveShard,
  entropyToMnemonic,
  factorForShardCount,
} from '../../../brainvault/src/core/index';

export type BrainvaultCliOutput = {
  mnemonic24: string;
};

export const normalizeBrainvaultMnemonic = (value: string): string =>
  value.trim().split(/\s+/).join(' ');

export async function deriveBrainvaultOracle(
  name: string,
  passphrase: string,
  shards: number,
): Promise<BrainvaultCliOutput> {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`BRAINVAULT_CLI_SHARDS_INVALID:${String(shards)}`);
  }
  // Automation imports the canonical library so recovery secrets never enter
  // argv or process listings. Pseudo-TTY disclosure stays in the CLI tests.
  const shardResults: Uint8Array[] = [];
  let root: Uint8Array | undefined;
  let entropy: Uint8Array | undefined;
  try {
    for (let index = 0; index < shards; index += 1) {
      shardResults.push(await deriveShard(
        passphrase,
        await createShardSalt(name, index, shards),
      ));
    }
    root = await combineShards(shardResults, factorForShardCount(shards));
    entropy = await deriveKey(root, 'bip39/entropy/v1.0', 32);
    return { mnemonic24: normalizeBrainvaultMnemonic(await entropyToMnemonic(entropy)) };
  } finally {
    for (const shard of shardResults) shard.fill(0);
    root?.fill(0);
    entropy?.fill(0);
  }
}
