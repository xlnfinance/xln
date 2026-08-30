/** CPU isolation inside one sovereign Runtime OS process. */
// Each sovereign user executes full Runtime/Entity/Account consensus and its
// direct socket; it is not a one-shot client. Keeping 200 such Runtime loops on
// one event loop starves that same worker's authenticated batch endpoint.
export const SOVEREIGN_RUNTIMES_PER_WORKER = (() => {
  const raw = process.env['XLN_HLT_RUNTIMES_PER_WORKER'] ?? '100';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`HLT_RUNTIMES_PER_WORKER_INVALID:${raw}`);
  }
  return value;
})();

export const sovereignRuntimeWorkerStart = (runtimeIndex: number): number => {
  if (!Number.isSafeInteger(runtimeIndex) || runtimeIndex < 0) {
    throw new Error(`HLT_SOVEREIGN_RUNTIME_INDEX_INVALID:${runtimeIndex}`);
  }
  return Math.floor(runtimeIndex / SOVEREIGN_RUNTIMES_PER_WORKER) * SOVEREIGN_RUNTIMES_PER_WORKER;
};

const SEED_BYTES = 32;

/** One private pipe value, not a JSON array with 1,000 duplicated `0x` wrappers. */
export const encodeSovereignRuntimeSeeds = (seeds: readonly string[]): string => {
  if (seeds.length < 1 || seeds.length > 1_000) throw new Error('HLT_SOVEREIGN_HOST_LANE_SEEDS_INVALID');
  const bytes = Buffer.allocUnsafe(seeds.length * SEED_BYTES);
  seeds.forEach((seed, index) => {
    if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error(`HLT_SOVEREIGN_HOST_LANE_SEED_INVALID:${index}`);
    bytes.set(Buffer.from(seed, 'hex'), index * SEED_BYTES);
  });
  return bytes.toString('base64');
};

export const decodeSovereignRuntimeSeeds = (encoded: string | undefined): string[] => {
  const value = String(encoded || '');
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('HLT_SOVEREIGN_HOST_LANE_SEEDS_INVALID');
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.toString('base64') !== value || bytes.length < SEED_BYTES ||
    bytes.length > 1_000 * SEED_BYTES || bytes.length % SEED_BYTES !== 0
  ) throw new Error('HLT_SOVEREIGN_HOST_LANE_SEEDS_INVALID');
  return Array.from({ length: bytes.length / SEED_BYTES }, (_, index) =>
    bytes.subarray(index * SEED_BYTES, (index + 1) * SEED_BYTES).toString('hex'),
  );
};
