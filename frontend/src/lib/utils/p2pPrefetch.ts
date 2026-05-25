import type { Env } from '@xln/runtime/xln-api';

const DEFAULT_PROFILE_PREFETCH_TIMEOUT_MS = 1_200;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeEntityId = (value: string): string => String(value || '').trim().toLowerCase();

/**
 * Best-effort profile warmup before user-facing actions that route to a remote
 * entity. Without this, the first action can sit in the local P2P pending
 * queue until gossip eventually delivers the target runtime encryption key.
 */
export async function prewarmCounterpartyProfiles(
  env: Env | null | undefined,
  entityIds: readonly string[],
  timeoutMs = DEFAULT_PROFILE_PREFETCH_TIMEOUT_MS,
): Promise<boolean> {
  const p2p = env?.runtimeState?.p2p;
  if (!p2p?.ensureProfiles) return false;

  const targets = Array.from(new Set(entityIds.map(normalizeEntityId).filter(Boolean)));
  if (targets.length === 0) return false;

  let timedOut = false;
  const boundedTimeoutMs = Math.max(100, Math.floor(Number(timeoutMs) || DEFAULT_PROFILE_PREFETCH_TIMEOUT_MS));

  const timeout = (async (): Promise<boolean> => {
    await sleep(boundedTimeoutMs);
    timedOut = true;
    return false;
  })();

  const warmup = p2p.ensureProfiles(targets).catch(() => false);
  const resolved = await Promise.race([warmup, timeout]);
  return resolved === true && !timedOut;
}
