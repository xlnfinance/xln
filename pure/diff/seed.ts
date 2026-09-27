// The one source of randomness for the differential tests: every PRNG seed goes through seedOf, so one
// environment variable replays a different sample everywhere. SEEDX=0 (the default) replays the committed
// sample exactly; any other value moves every stream at once:
//   SEEDX=12345 bun test --timeout 600000 ./diff
// Every describe that draws random input is named through seedTag, so a failure names the seed that reproduces it.

const parseSeedx = (raw: string | undefined): number => {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > 0x7fff_ffff) throw new Error(`SEEDX must be an integer in [0, 2^31), got "${raw}"`);
  return n;
};

export const SEEDX: number = parseSeedx(process.env["SEEDX"]);

/**
 * The seed a PRNG starts from. At SEEDX=0 it is `base` itself (every base in diff/ is a non-negative 31-bit
 * literal); otherwise `base` XOR a golden-ratio multiple of SEEDX, kept non-negative and below 2^31 so both
 * the 31-bit LCG streams and the mulberry32 streams accept it, and distinct bases stay distinct.
 */
export const seedOf = (base: number): number => {
  if (!Number.isSafeInteger(base) || base < 0 || base > 0x7fff_ffff) throw new Error(`PRNG base seed must be a 31-bit integer, got ${base}`);
  return (base ^ Math.imul(SEEDX, 0x9e37_79b1)) & 0x7fff_ffff;
};

/**
 * One step of the 31-bit LCG (glibc constants) the older diff files draw from, in exact integer arithmetic.
 * `(seed * 1103515245 + 12345) & 0x7fffffff` in doubles rounds the product once it passes 2^53, so the stream
 * collapses into short cycles (period 10466 from every seed tried; 220 from base 137 at SEEDX=987654, which
 * made one 800-batch test draw the same few batches). Math.imul keeps the low 32 bits exactly: full period 2^31.
 */
export const lcg31 = (seed: number): number => (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fff_ffff;

/** A describe name that carries the seed: a failure reads `... [SEEDX=12345] > test`, which is the command to rerun. */
export const seedTag = (name: string): string => `${name} [SEEDX=${SEEDX}]`;

/**
 * The loop guard of a randomized MATCH loop whose test also asserts coverage (each outcome kind seen, or more
 * than N accepted cases). It runs the nominal count, then keeps drawing fresh cases, every one compared in full,
 * until `covered()` holds or `cap` iterations have run. The coverage assert after the loop stays as strict as it
 * was; the loop only stops being tuned to one seed. At SEEDX=0 every such loop is covered at its nominal count,
 * so the committed sample is unchanged.
 *   for (let i = 0, more = untilCovered(600, () => valid > 100); more(i); i++) { ... }
 */
export const untilCovered = (nominal: number, covered: () => boolean, cap: number = nominal * 10) =>
  (i: number): boolean => i < nominal || (i < cap && !covered());
