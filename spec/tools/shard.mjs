// Which cases a CI shard runs. `SHARD=k/n node test.mjs` runs the cases of shard k out of n: a heavy case (one that takes over an hour
// alone) is shard 0 by itself, and every other case goes to one of shards 1 to n-1 by its index, so the shards together run each case once.
// n = 1 (or no SHARD) is the whole suite. Shared by test.mjs and the partition test in pure/rules/ci/spec-shards.test.ts.
export const parseShard = (text) => {
  const [shard, shards] = (text ?? "0/1").split("/").map(Number);
  if (!Number.isInteger(shard) || !Number.isInteger(shards) || shards < 1 || shard < 0 || shard >= shards) throw new Error(`SHARD must be k/n with 0 <= k < n, got ${text}`);
  if (shards === 2) throw new Error("SHARD n = 2 would leave shard 1 the whole suite but the heavy case: use 1 or at least 3 shards");
  return { shard, shards };
};

// The shard that runs case `index` (`heavy`: it is a heavy case).
export const shardOf = (index, heavy, shards) => (shards === 1 ? 0 : heavy ? 0 : 1 + (index % (shards - 1)));

export const casesOfShard = (cases, { shard, shards }) => cases.map((_, index) => index).filter((index) => shardOf(index, cases[index].heavy === true, shards) === shard);
