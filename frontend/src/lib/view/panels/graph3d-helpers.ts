export type ReserveMapLike = Map<string | number, bigint> | Record<string, unknown> | undefined;

export function graphReserveValues(reserves: ReserveMapLike): bigint[] {
  if (!reserves) return [];
  if (reserves instanceof Map) return Array.from(reserves.values());
  if (typeof reserves === 'object') {
    return Object.values(reserves).map((value: unknown) => {
      if (typeof value === 'string') return BigInt(value.replace(/n$/, ''));
      return BigInt(value as bigint);
    });
  }
  return [];
}

export function graphTotalReserves(replica: { state?: { reserves?: ReserveMapLike } } | null | undefined): bigint {
  let total = 0n;
  for (const amount of graphReserveValues(replica?.state?.reserves)) {
    total += amount;
  }
  return total;
}

export function graphReserveValue(reserves: ReserveMapLike, key: string): bigint {
  if (!reserves) return 0n;
  if (reserves instanceof Map) {
    return reserves.get(key) || reserves.get(Number(key)) || 0n;
  }
  if (typeof reserves === 'object') {
    const value = reserves[key];
    if (value === undefined || value === null) return 0n;
    if (typeof value === 'string') return BigInt(value.replace(/n$/, ''));
    return BigInt(value as bigint);
  }
  return 0n;
}

export function formatGraphMempoolTxLabel(tx: any, blockHeight?: number): string {
  if (!tx) return 'batch';
  if (tx.type === 'batch' && tx.data?.batch) {
    const batch = tx.data.batch;
    const parts: string[] = [];
    const reserveToReserveCount = batch.reserveToReserve?.length || 0;
    if (reserveToReserveCount > 0) parts.push(`${reserveToReserveCount}R2R`);
    const reserveToCollateralCount = batch.reserveToCollateral?.length || 0;
    if (reserveToCollateralCount > 0) parts.push(`+${reserveToCollateralCount}R2C`);
    const settlements = batch.settlements || [];
    let withdrawals = 0;
    let deposits = 0;
    for (const settle of settlements) {
      for (const diff of settle.diffs || []) {
        if (diff.collateralDiff < 0) withdrawals++;
        if (diff.collateralDiff > 0) deposits++;
      }
    }
    if (withdrawals > 0) parts.push(`-${withdrawals}W`);
    if (deposits > 0) parts.push(`+${deposits}D`);
    const summary = parts.join(' ') || 'empty';
    const fromEntity = tx.entityId?.slice(-1) || '?';
    return `E${fromEntity}: ${summary}`;
  }
  const blockPrefix = blockHeight !== undefined ? `#${blockHeight} ` : '';
  const type = (tx.type || 'tx').toUpperCase();
  const from = tx.from?.slice(-1) || '?';
  const to = tx.to?.slice(-1) || '?';
  const amount = tx.amount ? `$${Number(tx.amount / (10n ** 18n) / 1_000_000n)}M` : '';
  return `${blockPrefix}${type}: ${from}→${to} ${amount}`.trim();
}
