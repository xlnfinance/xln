import type { Page } from '@playwright/test';
import type { RuntimeAdapterViewFrame, XLNModule } from '../../../core/api/public/runtime-module';
import type { RuntimeAdapterInspection } from '../../../ui/src/runtime/adapter';

/** Read the committed Account through the same view and capacity derivation as React. */
export async function outCap(page: Page, entityId: string, cpId: string): Promise<bigint> {
  return page.evaluate(
    async ({ entityId, cpId }) => {
      const debug = (
        window as Window & {
          __xln?: { adapter(): RuntimeAdapterInspection | null; xln(): Promise<XLNModule> };
        }
      ).__xln;
      const adapter = debug?.adapter();
      if (!debug || !adapter) throw new Error('CURRENT_WALLET_RUNTIME_MISSING');
      const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
      const account = frame.activeEntity?.accounts.items.find(
        row => row.state.leftEntity === cpId || row.state.rightEntity === cpId,
      );
      const delta = account?.state.deltas.get(1);
      if (!account || !delta) throw new Error(`CURRENT_WALLET_ACCOUNT_DELTA_MISSING:${entityId}:${cpId}:1`);
      return (await debug.xln()).deriveDelta(delta, account.state.leftEntity === entityId).outCapacity;
    },
    { entityId, cpId },
  );
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
