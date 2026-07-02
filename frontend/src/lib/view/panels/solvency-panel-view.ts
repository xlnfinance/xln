export type SolvencyProjection = {
  m1: bigint;
  m2: bigint;
  m3: bigint;
  total: bigint;
  delta: bigint;
  isValid: boolean;
};

type SolvencyDelta = {
  collateral?: unknown;
};

type SolvencyAccount = {
  deltas?: Map<unknown, SolvencyDelta> | null;
  pendingFrame?: {
    deltas?: SolvencyDelta[] | null;
  } | null;
};

type SolvencyReplica = {
  state?: {
    reserves?: Map<unknown, unknown> | null;
    accounts?: Map<unknown, SolvencyAccount> | null;
  } | null;
};

export type SolvencyFrame = {
  eReplicas?: Map<unknown, SolvencyReplica> | null;
};

function readAmount(value: unknown, context: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`${context} must be a bigint-compatible amount`);
}

function addMapAmounts(values: Map<unknown, unknown> | null | undefined, context: string): bigint {
  if (!(values instanceof Map)) return 0n;
  let total = 0n;
  for (const [key, value] of values.entries()) {
    total += readAmount(value, `${context}.${String(key)}`);
  }
  return total;
}

function deltaCollateral(delta: SolvencyDelta | null | undefined, context: string): bigint {
  if (!delta || delta.collateral === undefined || delta.collateral === null) return 0n;
  return readAmount(delta.collateral, context);
}

export function buildSolvencyProjection(frame: SolvencyFrame | null | undefined): SolvencyProjection | null {
  const replicas = frame?.eReplicas;
  if (!(replicas instanceof Map)) return null;

  let totalReserves = 0n;
  let confirmedCollateral = 0n;
  let pendingCollateral = 0n;

  for (const [replicaKey, replica] of replicas.entries()) {
    totalReserves += addMapAmounts(replica?.state?.reserves, `replica.${String(replicaKey)}.reserves`);

    const accounts = replica?.state?.accounts;
    if (!(accounts instanceof Map)) continue;
    for (const [accountKey, account] of accounts.entries()) {
      const accountContext = `replica.${String(replicaKey)}.account.${String(accountKey)}`;
      const deltas = account?.deltas;
      if (deltas instanceof Map) {
        for (const [tokenId, delta] of deltas.entries()) {
          confirmedCollateral += deltaCollateral(delta, `${accountContext}.delta.${String(tokenId)}.collateral`);
        }
      }
      for (const [index, delta] of (account?.pendingFrame?.deltas ?? []).entries()) {
        pendingCollateral += deltaCollateral(delta, `${accountContext}.pendingDelta.${index}.collateral`);
      }
    }
  }

  confirmedCollateral = confirmedCollateral / 2n;
  pendingCollateral = pendingCollateral / 2n;

  const total = confirmedCollateral + pendingCollateral;
  const delta = totalReserves - total;

  return {
    m1: totalReserves,
    m2: confirmedCollateral,
    m3: pendingCollateral,
    total,
    delta,
    isValid: delta === 0n,
  };
}
