export type MarketSubscriptionLimitFailure = {
  ok: false;
  code: 'E_RATE_LIMITED';
  error: string;
};

export type MarketSubscriptionLimitDecision = { ok: true } | MarketSubscriptionLimitFailure;

export type MarketSubscriptionLimiterSnapshot = {
  total: number;
  byIp: Record<string, number>;
  maxTotal: number;
  maxPerIp: number;
  maxCellsPerSubscription: number;
};

const normalizeIpKey = (ip: string): string => String(ip || '').trim() || 'unknown';

export class MarketSubscriptionLimiter {
  private total = 0;
  private readonly byIp = new Map<string, number>();

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerIp: number,
    private readonly maxCellsPerSubscription: number,
  ) {}

  canOpen(ip: string): MarketSubscriptionLimitDecision {
    const ipKey = normalizeIpKey(ip);
    if (this.total >= this.maxTotal) {
      return { ok: false, code: 'E_RATE_LIMITED', error: 'market subscription capacity exceeded' };
    }
    if ((this.byIp.get(ipKey) ?? 0) >= this.maxPerIp) {
      return {
        ok: false,
        code: 'E_RATE_LIMITED',
        error: `market subscription IP capacity exceeded: max=${this.maxPerIp}`,
      };
    }
    return { ok: true };
  }

  add(ip: string): void {
    const ipKey = normalizeIpKey(ip);
    this.total += 1;
    this.byIp.set(ipKey, (this.byIp.get(ipKey) ?? 0) + 1);
  }

  remove(ip: string): void {
    const ipKey = normalizeIpKey(ip);
    this.total = Math.max(0, this.total - 1);
    const next = (this.byIp.get(ipKey) ?? 0) - 1;
    if (next > 0) this.byIp.set(ipKey, next);
    else this.byIp.delete(ipKey);
  }

  clear(): void {
    this.total = 0;
    this.byIp.clear();
  }

  snapshot(): MarketSubscriptionLimiterSnapshot {
    return {
      total: this.total,
      byIp: Object.fromEntries(Array.from(this.byIp.entries()).sort()),
      maxTotal: this.maxTotal,
      maxPerIp: this.maxPerIp,
      maxCellsPerSubscription: this.maxCellsPerSubscription,
    };
  }
}
