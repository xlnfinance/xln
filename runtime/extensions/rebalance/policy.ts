export interface RebalancePolicySnapshot {
  policyVersion: number;
  baseFee: bigint;
  liquidityFeeBps: bigint;
  gasFee: bigint;
}

export interface RebalancePolicyMemo extends RebalancePolicySnapshot {
  reason: string;
}

export type RebalanceMatchingStrategy = 'amount' | 'time' | 'fee';

const PREFIX = 'rebalance-policy:';

export function normalizeRebalanceMatchingStrategy(
  strategy: unknown,
): RebalanceMatchingStrategy {
  return strategy === 'time' || strategy === 'fee' ? strategy : 'amount';
}

export function encodeRebalancePolicyMemo(reason: string, snapshot: RebalancePolicySnapshot): string {
  return (
    `${PREFIX}` +
    `reason=${reason};` +
    `v=${snapshot.policyVersion};` +
    `base=${snapshot.baseFee.toString()};` +
    `liq=${snapshot.liquidityFeeBps.toString()};` +
    `gas=${snapshot.gasFee.toString()}`
  );
}

export function decodeRebalancePolicyMemo(description?: string): RebalancePolicyMemo | null {
  if (!description || !description.startsWith(PREFIX)) return null;
  const body = description.slice(PREFIX.length);
  const pairs = body.split(';');
  const kv = new Map<string, string>();
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    kv.set(key, value);
  }

  const reason = kv.get('reason') || 'unknown';
  const versionRaw = kv.get('v');
  const baseRaw = kv.get('base');
  const liqRaw = kv.get('liq');
  const gasRaw = kv.get('gas');
  if (!versionRaw || !baseRaw || !liqRaw || !gasRaw) return null;

  let policyVersion: number;
  let baseFee: bigint;
  let liquidityFeeBps: bigint;
  let gasFee: bigint;
  try {
    policyVersion = Number(versionRaw);
    baseFee = BigInt(baseRaw);
    liquidityFeeBps = BigInt(liqRaw);
    gasFee = BigInt(gasRaw);
  } catch {
    return null;
  }
  if (!Number.isFinite(policyVersion) || policyVersion < 1) return null;
  if (liquidityFeeBps < 0n || baseFee < 0n || gasFee < 0n) return null;

  return {
    reason,
    policyVersion,
    baseFee,
    liquidityFeeBps,
    gasFee,
  };
}
