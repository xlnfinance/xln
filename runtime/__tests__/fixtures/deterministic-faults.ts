const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(seed, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 0x9e3779b9;
};

export const RETAINED_FAULT_SEEDS = [
  'xln-fault-0001',
  'xln-fault-0013',
  'xln-fault-0021',
  'xln-fault-0034',
  'xln-fault-0055',
  'xln-fault-0089',
  'xln-fault-0144',
  'xln-fault-0233',
] as const;

export const faultMatrixSeeds = (): readonly string[] => {
  const requestedSeed = process.env['XLN_FAULT_SEED']?.trim();
  return requestedSeed ? [requestedSeed] : RETAINED_FAULT_SEEDS;
};

export class DeterministicFaults {
  private state: number;

  constructor(readonly seed: string) {
    this.state = hashSeed(seed);
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  pick(size: number): number {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`FAULT_PICK_SIZE_INVALID:${size}`);
    }
    return this.nextUint32() % size;
  }

  oneIn(divisor: number): boolean {
    if (!Number.isSafeInteger(divisor) || divisor <= 0) {
      throw new Error(`FAULT_DIVISOR_INVALID:${divisor}`);
    }
    return this.nextUint32() % divisor === 0;
  }
}

export const withFaultSeed = async <T>(
  seed: string,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FAULT_MATRIX_SEED=${seed}:${message}`, { cause: error });
  }
};
