import { expect, type Page } from '@playwright/test';

const DEFAULT_CREDIT_AMOUNT = 10_000n * 10n ** 18n;
const DEFAULT_TOKEN_IDS = [1, 3, 2] as const;
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

async function isAccountReady(
  page: Page,
  entityId: string,
  hubId: string,
  tokenIds: readonly number[],
  timeoutMs = 0,
): Promise<boolean> {
  return page.evaluate(
    async ({ entityId, hubId, tokenIds, timeoutMs }) => {
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
          const hasDelta = tokenIds.every((tokenId) => Boolean(account.deltas?.get?.(tokenId)));
          const noPending = !account.pendingFrame;
          const hasFrame = Number(account.currentHeight || 0) > 0;
          if (hasDelta && noPending && hasFrame) return true;
        }
        if (timeoutMs <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return false;
    },
    { entityId, hubId, tokenIds: [...tokenIds], timeoutMs },
  );
}

type AccountOpenStatus = {
  exists: boolean;
  hasDelta: boolean;
  pendingHeight: number | null;
  currentHeight: number;
};

async function getAccountOpenStatus(page: Page, entityId: string, hubId: string): Promise<AccountOpenStatus> {
  return page.evaluate(
    ({ entityId, hubId }) => {
      const env = (window as typeof window & {
        isolatedEnv?: {
          eReplicas?: Map<string, {
            state?: {
              accounts?: Map<string, {
                deltas?: Map<number, unknown>;
                pendingFrame?: { height?: number };
                currentHeight?: number;
              }>;
            };
          }>;
        };
      }).isolatedEnv;
      if (!env?.eReplicas) {
        return { exists: false, hasDelta: false, pendingHeight: null, currentHeight: 0 };
      }

      for (const [replicaKey, replica] of env.eReplicas.entries()) {
        if (!String(replicaKey).startsWith(`${entityId}:`)) continue;
        const account = replica.state?.accounts?.get(hubId);
        if (!account) continue;
        return {
          exists: true,
          hasDelta: Boolean(account.deltas?.get?.(1)),
          pendingHeight: account.pendingFrame ? Number(account.pendingFrame.height || 0) : null,
          currentHeight: Number(account.currentHeight || 0),
        };
      }

      return { exists: false, hasDelta: false, pendingHeight: null, currentHeight: 0 };
    },
    { entityId, hubId },
  );
}

export async function connectRuntimeToHub(
  page: Page,
  identity: { entityId: string; signerId: string },
  hubId: string,
): Promise<void> {
  if (await isAccountReady(page, identity.entityId, hubId, DEFAULT_TOKEN_IDS)) {
    return;
  }
  const initialStatus = await getAccountOpenStatus(page, identity.entityId, hubId);

  if (!initialStatus.exists) {
    const openResult = await page.evaluate(
      async ({ entityId, signerId, hubId, creditAmount, tokenIds }) => {
        const maybeWindow = window as typeof window & {
          vaultOperations?: {
            enqueueEntityInputs?: (
              env: {
                eReplicas?: Map<string, {
                  state?: {
                    accounts?: Map<string, {
                      deltas?: Map<number, unknown>;
                      pendingFrame?: unknown;
                      currentHeight?: number;
                    }>;
                  };
                }>;
              },
              inputs: Array<{
                entityId: string;
                signerId: string;
                entityTxs: Array<
                  | {
                      type: 'openAccount';
                      data: {
                        targetEntityId: string;
                        creditAmount: bigint;
                        tokenId: number;
                      };
                    }
                  | {
                      type: 'extendCredit';
                      data: {
                        counterpartyEntityId: string;
                        tokenId: number;
                        amount: bigint;
                      };
                    }
                >;
              }>,
            ) => Promise<unknown>;
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
        const vaultOperations = maybeWindow.vaultOperations;
        const p2p = env?.runtimeState?.p2p;
        if (!env || !vaultOperations?.enqueueEntityInputs || !env.eReplicas) {
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

        const normalizedTokenIds = Array.isArray(tokenIds) ? tokenIds.filter((value) => Number.isFinite(value)) : [];
        const primaryTokenId = normalizedTokenIds[0];
        if (typeof primaryTokenId !== 'number') {
          return { ok: false, error: 'tokenIds missing' };
        }

        await vaultOperations.enqueueEntityInputs(env, [{
          entityId,
          signerId: liveSignerId,
          entityTxs: [
            {
              type: 'openAccount',
              data: {
                targetEntityId: hubId,
                creditAmount: BigInt(creditAmount),
                tokenId: primaryTokenId,
              },
            },
            ...normalizedTokenIds.slice(1).map((tokenId) => ({
              type: 'extendCredit' as const,
              data: {
                counterpartyEntityId: hubId,
                tokenId,
                amount: BigInt(creditAmount),
              },
            })),
          ],
        }]);

        return { ok: true };
      },
      {
        entityId: identity.entityId,
        signerId: identity.signerId,
        hubId,
        creditAmount: DEFAULT_CREDIT_AMOUNT.toString(),
        tokenIds: DEFAULT_TOKEN_IDS,
      },
    );

    expect(openResult?.ok, `connectHub failed: ${openResult?.error ?? 'unknown'}`).toBe(true);
  }

  const opened = await isAccountReady(page, identity.entityId, hubId, DEFAULT_TOKEN_IDS, DEFAULT_OPEN_TIMEOUT_MS);
  const finalStatus = await getAccountOpenStatus(page, identity.entityId, hubId);

  expect(
    opened,
    `account open must converge for ${hubId.slice(0, 10)} ` +
      `(exists=${finalStatus.exists} hasDelta=${finalStatus.hasDelta} height=${finalStatus.currentHeight} pending=${finalStatus.pendingHeight})`,
  ).toBe(true);
}

export async function connectHub(page: Page, hubId: string): Promise<void> {
  await ensureRuntimeOnline(page, 'connect-hub');

  const identity = await page.evaluate(() => {
    const env = (window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        eReplicas?: Map<string, unknown>;
      };
    }).isolatedEnv;
    if (!env?.eReplicas) return null;

    const runtimeId = String(env.runtimeId || '').toLowerCase();
    for (const replicaKey of env.eReplicas.keys()) {
      const [entityId, signerId] = String(replicaKey).split(':');
      if (!entityId?.startsWith('0x') || entityId.length !== 66 || !signerId) continue;
      if (runtimeId && String(signerId).toLowerCase() !== runtimeId) continue;
      return { entityId, signerId };
    }

    return null;
  });

  expect(identity, 'runtime must expose a local entity before opening an account').not.toBeNull();
  await connectRuntimeToHub(page, identity!, hubId);
}
