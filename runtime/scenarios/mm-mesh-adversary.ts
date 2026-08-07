/**
 * Post-bootstrap adversary profiles for the real orchestrator MM mesh.
 * Injected only from scenario/smoke harness — never forks production MM paths.
 *
 * Profiles:
 *   none        — no injection (happy path)
 *   hub-kill    — SIGKILL H2 by health PID; wait for orchestrator replace + books
 *   mm-restart  — SIGKILL MM child; wait for replace + same/cross books again
 */

export type AdversaryProfile = 'none' | 'hub-kill' | 'mm-restart';

export type MeshHealthProcessChild = {
  role?: string;
  name?: string;
  pid?: number;
  online?: boolean;
  restartCount?: number;
};

export type MeshHealthPayload = {
  systemOk?: boolean;
  marketMaker?: {
    ok?: boolean;
    startupPhase?: string | null;
    cross?: { ok?: boolean };
  };
  process?: {
    children?: MeshHealthProcessChild[];
  };
  hubs?: Array<{ name?: string; online?: boolean }>;
};

export const parseAdversaryProfile = (raw: string | undefined | null): AdversaryProfile => {
  const value = String(raw || 'none').trim().toLowerCase();
  if (value === '' || value === 'none' || value === 'off' || value === '0') return 'none';
  if (value === 'hub-kill' || value === 'hub_kill' || value === 'h2-kill') return 'hub-kill';
  if (value === 'mm-restart' || value === 'mm_restart' || value === 'mm-kill') return 'mm-restart';
  throw new Error(`XLN_ADVERSARY_PROFILE_UNKNOWN:${value}`);
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const findChild = (
  health: MeshHealthPayload,
  role: string,
  name: string,
): MeshHealthProcessChild | undefined =>
  health.process?.children?.find(
    child => child.role === role && String(child.name || '').toUpperCase() === name.toUpperCase(),
  );

export type AdversaryContext = {
  apiBaseUrl: string;
  fetchHealth: () => Promise<MeshHealthPayload>;
  booksReady: (health: MeshHealthPayload) => boolean;
  timeoutMs?: number;
};

const waitUntil = async (
  label: string,
  pred: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(250);
  }
  throw new Error(`MM_MESH_ADVERSARY_TIMEOUT:${label}`);
};

const killChildByHealth = async (
  ctx: AdversaryContext,
  role: string,
  name: string,
): Promise<{ oldPid: number; oldRestartCount: number }> => {
  const before = await ctx.fetchHealth();
  const child = findChild(before, role, name);
  const pid = Number(child?.pid ?? 0);
  if (!(pid > 0)) {
    throw new Error(`MM_MESH_ADVERSARY_CHILD_PID_MISSING:${role}:${name}`);
  }
  const oldRestartCount = Number(child?.restartCount ?? 0);
  process.kill(pid, 'SIGKILL');
  console.log(`[mm-mesh-adversary] killed ${role}/${name} pid=${pid}`);
  return { oldPid: pid, oldRestartCount };
};

const runHubKill = async (ctx: AdversaryContext, timeoutMs: number): Promise<void> => {
  const { oldPid, oldRestartCount } = await killChildByHealth(ctx, 'hub', 'H2');

  await waitUntil('hub-kill-degraded', async () => {
    const health = await ctx.fetchHealth();
    return health.systemOk === false;
  }, Math.min(timeoutMs, 15_000));
  console.log('[OK] phase=ADVERSARY hub-kill degraded');

  await waitUntil('hub-kill-replaced', async () => {
    const health = await ctx.fetchHealth();
    const child = findChild(health, 'hub', 'H2');
    const hub = health.hubs?.find(h => h.name === 'H2');
    return (
      Number(child?.pid ?? 0) > 0 &&
      Number(child?.pid) !== oldPid &&
      Number(child?.restartCount ?? 0) > oldRestartCount &&
      child?.online === true &&
      hub?.online === true &&
      health.systemOk === true
    );
  }, timeoutMs);
  console.log('[OK] phase=ADVERSARY hub-kill replaced');

  await waitUntil('hub-kill-books', async () => ctx.booksReady(await ctx.fetchHealth()), timeoutMs);
  console.log('[OK] phase=ADVERSARY hub-kill books restored');
};

const runMmRestart = async (ctx: AdversaryContext, timeoutMs: number): Promise<void> => {
  const { oldPid, oldRestartCount } = await killChildByHealth(ctx, 'market-maker', 'MM');

  await waitUntil('mm-restart-replaced', async () => {
    const health = await ctx.fetchHealth();
    const child = findChild(health, 'market-maker', 'MM');
    return (
      Number(child?.pid ?? 0) > 0 &&
      Number(child?.pid) !== oldPid &&
      Number(child?.restartCount ?? 0) > oldRestartCount &&
      child?.online === true
    );
  }, timeoutMs);
  console.log('[OK] phase=ADVERSARY mm-restart replaced');

  await waitUntil('mm-restart-books', async () => ctx.booksReady(await ctx.fetchHealth()), timeoutMs);
  console.log('[OK] phase=ADVERSARY mm-restart books restored');
};

export const runAdversaryProfile = async (
  profile: AdversaryProfile,
  ctx: AdversaryContext,
): Promise<void> => {
  const timeoutMs = ctx.timeoutMs ?? 120_000;
  console.log(`CROSS_J_PHASE_ADVERSARY profile=${profile}`);
  if (profile === 'none') {
    console.log('[OK] phase=ADVERSARY skipped profile=none');
    return;
  }
  if (profile === 'hub-kill') {
    await runHubKill(ctx, timeoutMs);
    return;
  }
  if (profile === 'mm-restart') {
    await runMmRestart(ctx, timeoutMs);
    return;
  }
  throw new Error(`MM_MESH_ADVERSARY_UNHANDLED:${profile}`);
};
