import { expect, type Page } from '@playwright/test';

const DEFAULT_CREDIT_AMOUNT = 10_000n * 10n ** 18n;
const DEFAULT_TOKEN_ID = 1;
const DEFAULT_OPEN_TIMEOUT_MS = 45_000;

async function ensureRuntimeOnline(page: Page, tag: string): Promise<void> {
  const ok = await page.evaluate(async () => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeState?: {
          p2p?: {
            isConnected?: () => boolean;
            connect?: () => void;
            reconnect?: () => void;
          };
        };
      };
    }).isolatedEnv;
    const p2p = env?.runtimeState?.p2p;
    if (!env || !p2p) return false;

    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      if (typeof p2p.isConnected === 'function' && p2p.isConnected()) return true;
      if (typeof p2p.connect === 'function') {
        try { p2p.connect(); } catch {}
      } else if (typeof p2p.reconnect === 'function') {
        try { p2p.reconnect(); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return typeof p2p.isConnected === 'function' && p2p.isConnected();
  });

  expect(ok, `[${tag}] runtime must be online`).toBe(true);
}

async function isAccountReady(page: Page, entityId: string, hubId: string, timeoutMs = 0): Promise<boolean> {
  return page.evaluate(
    async ({ entityId, hubId, timeoutMs }) => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          eReplicas?: Map<string, {
            state?: {
              accounts?: Map<string, {
                deltas?: Map<number, unknown>;
                pendingFrame?: unknown;
                currentHeight?: number;
              }>;
            };
          }>;
        };
      }).isolatedEnv;
      if (!env?.eReplicas) return false;

      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        for (const [replicaKey, replica] of env.eReplicas.entries()) {
          if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
          const account = replica.state?.accounts?.get(hubId);
          if (!account) continue;
          const hasDelta = Boolean(account.deltas?.get?.(1));
          const noPending = !account.pendingFrame;
          const hasFrame = Number(account.currentHeight || 0) > 0;
          if (hasDelta && noPending && hasFrame) return true;
        }
        if (timeoutMs <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return false;
    },
    { entityId, hubId, timeoutMs },
  );
}

export async function connectHub(page: Page, hubId: string): Promise<void> {
  await ensureRuntimeOnline(page, 'connect-hub');

  const identity = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;

    for (const replicaKey of env.eReplicas.keys()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      if (entityId && signerId) {
        return { entityId, signerId };
      }
    }

    return null;
  });

  expect(identity, 'runtime must expose a local entity before opening an account').not.toBeNull();

  if (await isAccountReady(page, identity!.entityId, hubId)) {
    return;
  }

  const openResult = await page.evaluate(
    async ({ entityId, signerId, hubId, creditAmount, tokenId }) => {
      const maybeWindow = window as typeof window & {
        XLN?: {
          enqueueRuntimeInput?: (env: unknown, input: unknown) => void;
        };
        isolatedEnv?: {
          eReplicas?: Map<string, {
            state?: {
              accounts?: Map<string, {
                deltas?: Map<number, unknown>;
                pendingFrame?: unknown;
                currentHeight?: number;
              }>;
            };
          }>;
          gossip?: {
            getProfiles?: () => Array<{ entityId: string; runtimeId?: string; metadata?: { runtimeId?: string } }>;
          };
          runtimeState?: {
            p2p?: {
              refreshGossip?: () => Promise<void> | void;
              ensureProfiles?: (ids: string[]) => Promise<boolean>;
            };
          };
        };
      };

      const env = maybeWindow.isolatedEnv;
      const xln = maybeWindow.XLN;
      const p2p = env?.runtimeState?.p2p;
      if (!env || !xln?.enqueueRuntimeInput || !env.eReplicas) {
        return { ok: false, error: 'runtime env missing' };
      }

      let hubRuntimeId: string | null = null;
      const lookupStartedAt = Date.now();
      while (Date.now() - lookupStartedAt < 12_000) {
        const profiles = env.gossip?.getProfiles?.() ?? [];
        const hubProfile = profiles.find((profile) =>
          String(profile.entityId || '').toLowerCase() === String(hubId).toLowerCase(),
        );
        const candidateRuntimeId = hubProfile?.runtimeId ?? hubProfile?.metadata?.runtimeId ?? null;
        if (typeof candidateRuntimeId === 'string' && candidateRuntimeId.length > 0) {
          hubRuntimeId = candidateRuntimeId;
          break;
        }
        if (typeof p2p?.ensureProfiles === 'function') {
          try { await p2p.ensureProfiles([hubId]); } catch {}
        }
        if (typeof p2p?.refreshGossip === 'function') {
          try { await p2p.refreshGossip(); } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!hubRuntimeId) {
        return { ok: false, error: 'hub runtimeId unresolved in gossip' };
      }

      let liveSignerId = signerId;
      for (const replicaKey of env.eReplicas.keys()) {
        const [replicaEntityId, replicaSignerId] = String(replicaKey).split(':');
        if (String(replicaEntityId).toLowerCase() === String(entityId).toLowerCase() && replicaSignerId) {
          liveSignerId = replicaSignerId;
          break;
        }
      }

      xln.enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [{
          entityId,
          signerId: liveSignerId,
          entityTxs: [{
            type: 'openAccount',
            data: {
              targetEntityId: hubId,
              creditAmount: BigInt(creditAmount),
              tokenId,
            },
          }],
        }],
      });

      return { ok: true };
    },
    {
      entityId: identity!.entityId,
      signerId: identity!.signerId,
      hubId,
      creditAmount: DEFAULT_CREDIT_AMOUNT.toString(),
      tokenId: DEFAULT_TOKEN_ID,
    },
  );

  expect(openResult?.ok, `connectHub failed: ${openResult?.error ?? 'unknown'}`).toBe(true);

  const opened = await isAccountReady(page, identity!.entityId, hubId, DEFAULT_OPEN_TIMEOUT_MS);

  expect(opened, `account open must converge for ${hubId.slice(0, 10)}`).toBe(true);
}
