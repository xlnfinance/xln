import { type Page } from '@playwright/test';
import { deriveDelta } from '../../runtime/account-utils';

type DeltaSnapshot = {
  ondelta: string;
  offdelta: string;
  collateral: string;
  leftCreditLimit: string;
  rightCreditLimit: string;
  leftAllowance: string;
  rightAllowance: string;
  leftHold: string;
  rightHold: string;
};

export async function outCap(page: Page, entityId: string, cpId: string): Promise<bigint> {
  const delta = await page.evaluate(({ entityId, cpId }) => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas: Map<string, {
          state?: {
            accounts?: Map<string, {
              deltas?: Map<number, Record<string, unknown>>;
            }>;
          };
        }>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;

    for (const [replicaKey, replica] of env.eReplicas.entries()) {
      if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
      const account = replica?.state?.accounts?.get?.(cpId);
      const rawDelta = account?.deltas?.get?.(1);
      if (!rawDelta || typeof rawDelta !== 'object') return null;

      const raw = rawDelta as Record<string, unknown>;
      const readBig = (value: unknown): string => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return String(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
        return '0';
      };

      return {
        ondelta: readBig(raw.ondelta),
        offdelta: readBig(raw.offdelta),
        collateral: readBig(raw.collateral),
        leftCreditLimit: readBig(raw.leftCreditLimit),
        rightCreditLimit: readBig(raw.rightCreditLimit),
        leftAllowance: readBig(raw.leftAllowance),
        rightAllowance: readBig(raw.rightAllowance),
        leftHold: readBig(raw.leftHold),
        rightHold: readBig(raw.rightHold),
      } satisfies DeltaSnapshot;
    }

    return null;
  }, { entityId, cpId });

  if (!delta) return 0n;

  return deriveDelta({
    tokenId: 1,
    ondelta: BigInt(delta.ondelta),
    offdelta: BigInt(delta.offdelta),
    collateral: BigInt(delta.collateral),
    leftCreditLimit: BigInt(delta.leftCreditLimit),
    rightCreditLimit: BigInt(delta.rightCreditLimit),
    leftAllowance: BigInt(delta.leftAllowance),
    rightAllowance: BigInt(delta.rightAllowance),
    leftHold: BigInt(delta.leftHold),
    rightHold: BigInt(delta.rightHold),
  }, String(entityId).toLowerCase() < String(cpId).toLowerCase()).outCapacity;
}

export async function waitForOutCapDelta(
  page: Page,
  entityId: string,
  cpId: string,
  baseline: bigint,
  expectedDelta: bigint,
  timeoutMs = 25_000,
): Promise<bigint> {
  const start = Date.now();
  let latest = baseline;
  while (Date.now() - start < timeoutMs) {
    latest = await outCap(page, entityId, cpId);
    if (latest - baseline === expectedDelta) return latest;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Timed out waiting outCap delta for ${entityId.slice(0, 10)}↔${cpId.slice(0, 10)}: baseline=${baseline} latest=${latest} expectedDelta=${expectedDelta}`,
  );
}
