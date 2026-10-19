#!/usr/bin/env bun

/**
 * Machine-wide semaphore for heavy local stands.
 *
 * Several agents work this repository from separate git worktrees on one Mac.
 * The existing port lease only stops two stands from binding the same socket;
 * it does not stop them from sharing 32 cores, and a contended run produces a
 * number nobody may trust. This lock is the missing serializer.
 *
 * The lock lives next to the main checkout (`<git-common-dir>/../`), so every
 * worktree of this repository resolves the exact same directory. A slot is a
 * directory. A kernel advisory lock serializes its publication, reaping and
 * release, so a stale reader cannot delete a new owner. Capacity is one today;
 * an owner may raise it once concurrent stands are
 * proven not to distort each other.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withStandMetadata } from './stand/metadata';
import { safeStringify } from '../core/protocol/serialization';

export const STAND_LOCK_DIR_NAME = '.xln-stand-lock';
export const STAND_LOCK_SLOTS_ENV = 'XLN_STAND_LOCK_SLOTS';
export const STAND_LOCK_TOKEN_ENV = 'XLN_STAND_LOCK_TOKEN';
export const STAND_LOCK_DISABLE_ENV = 'XLN_STAND_LOCK_DISABLED';

export const buildStandLockChildEnv = (
  env: NodeJS.ProcessEnv,
  token: string,
): NodeJS.ProcessEnv => ({ ...env, [STAND_LOCK_TOKEN_ENV]: token });

export type StandLockHolder = Readonly<{
  pid: number;
  reason: string;
  worktree: string;
  startedAt: string;
  token: string;
  childGroup?: number;
}>;

export const standLockRoot = (): string => {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('STAND_LOCK_GIT_COMMON_DIR_UNAVAILABLE');
  return join(dirname(resolve(String(result.stdout).trim())), STAND_LOCK_DIR_NAME);
};

export const standLockCapacity = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = Number(env[STAND_LOCK_SLOTS_ENV] ?? '1');
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 8) {
    throw new Error(`STAND_LOCK_SLOTS_INVALID:${String(env[STAND_LOCK_SLOTS_ENV])}`);
  }
  return raw;
};

const holderPath = (root: string, slot: number): string => join(root, `slot-${slot}`, 'holder.json');

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EPERM') return true;
      if (error.code === 'ESRCH') return false;
    }
    throw error;
  }
};

export const readStandLockHolder = (root: string, slot: number): StandLockHolder | null => {
  const path = holderPath(root, slot);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.reason !== 'string' || typeof value.worktree !== 'string'
      || typeof value.token !== 'string' || !value.token
      || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
      || (value.childGroup !== undefined && (!Number.isSafeInteger(value.childGroup) || value.childGroup <= 0))) return null;
    return value;
  } catch {
    return null;
  }
};

const holderIsStale = (holder: StandLockHolder | null): boolean => {
  // Missing/corrupt metadata is not evidence of death. In particular another
  // process may have created the directory but not published its holder yet.
  if (!holder) return false;
  if (holder.childGroup && pidAlive(-holder.childGroup)) return false;
  return !pidAlive(holder.pid);
};

/** Drop slots whose owner exited without releasing, so a crash cannot wedge the machine. */
const reapSlots = (root: string): number => {
  if (!existsSync(root)) return 0;
  let reaped = 0;
  for (const entry of readdirSync(root)) {
    if (!/^slot-\d+$/.test(entry)) continue;
    const slot = Number(entry.slice(5));
    if (!holderIsStale(readStandLockHolder(root, slot))) continue;
    rmSync(join(root, entry), { recursive: true, force: true });
    reaped += 1;
  }
  return reaped;
};

export const reapStandLockSlots = (root: string): number =>
  withStandMetadata(root, () => reapSlots(root));

const claimSlot = (root: string, slot: number, holder: StandLockHolder): boolean => {
  try {
    mkdirSync(join(root, `slot-${slot}`), { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
  writeFileSync(holderPath(root, slot), `${safeStringify(holder)}\n`, { mode: 0o600 });
  return true;
};

export type StandLockGrant = Readonly<{ root: string; slot: number; token: string }>;

/** Nested commands share the live parent's lease; a token alone is not a lease. */
export const inheritedStandLock = (
  root = standLockRoot(),
  env: NodeJS.ProcessEnv = process.env,
): StandLockGrant | undefined => {
  const token = env[STAND_LOCK_TOKEN_ENV];
  if (!token) return undefined;
  return withStandMetadata(root, () => {
    for (let slot = 0; slot < standLockCapacity(env); slot += 1) {
      const holder = readStandLockHolder(root, slot);
      if (holder?.token !== token) continue;
      if (!pidAlive(holder.pid) || !holder.childGroup || !pidAlive(-holder.childGroup)) break;
      return { root, slot, token };
    }
    throw new Error('STAND_LOCK_INHERITED_OWNER_INVALID');
  });
};

export const registerStandGroup = (grant: StandLockGrant, pid: number): void => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('STAND_LOCK_CHILD_PID_INVALID');
  withStandMetadata(grant.root, () => {
    const holder = readStandLockHolder(grant.root, grant.slot);
    if (!holder || holder.token !== grant.token) throw new Error('STAND_LOCK_OWNER_LOST');
    writeFileSync(holderPath(grant.root, grant.slot), safeStringify({ ...holder, childGroup: pid }), { mode: 0o600 });
  });
};

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

/**
 * Wait for a free slot. A refused acquisition is a hard failure, never a quiet
 * "run anyway": two concurrent stands invalidate both runs, and a measurement
 * nobody can trust is worse than a run that did not start.
 */
export const acquireStandLock = async (options: Readonly<{
  reason: string;
  waitMs: number;
  pollMs?: number;
  /** Tests pin their own directory; production always resolves the shared one. */
  root?: string;
}>): Promise<StandLockGrant> => {
  const root = options.root ?? standLockRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const capacity = standLockCapacity();
  const token = randomUUID();
  const holder: StandLockHolder = {
    pid: process.pid,
    reason: options.reason,
    worktree: process.cwd(),
    startedAt: new Date().toISOString(),
    token,
  };
  const deadline = Date.now() + options.waitMs;
  let announced = false;
  for (;;) {
    const claimed = withStandMetadata(root, () => {
      reapSlots(root);
      for (let slot = 0; slot < capacity; slot += 1) {
        if (claimSlot(root, slot, holder)) return { root, slot, token };
      }
      return null;
    });
    if (claimed) return claimed;
    if (Date.now() >= deadline) {
      const busy = Array.from({ length: capacity }, (_unused, slot) => readStandLockHolder(root, slot))
        .map(entry => (entry ? `${entry.reason}@${entry.worktree}#${entry.pid}` : 'free'))
        .join(',');
      throw new Error(`STAND_LOCK_BUSY:capacity=${capacity}:holders=${busy}`);
    }
    if (!announced) {
      console.log(`[stand-lock] waiting reason=${options.reason} capacity=${capacity}`);
      announced = true;
    }
    await sleep(options.pollMs ?? 2_000);
  }
};

export const releaseStandLock = (grant: StandLockGrant): void => {
  withStandMetadata(grant.root, () => {
    const holder = readStandLockHolder(grant.root, grant.slot);
    if (!holder || holder.token !== grant.token) return;
    if (holder.childGroup && pidAlive(-holder.childGroup)) throw new Error('STAND_LOCK_CHILDREN_STILL_ALIVE');
    rmSync(join(grant.root, `slot-${grant.slot}`), { recursive: true, force: true });
  });
};

export const standLockStatus = (rootOverride?: string): string => {
  const root = rootOverride ?? standLockRoot();
  const capacity = standLockCapacity();
  const rows = Array.from({ length: capacity }, (_unused, slot) => {
    const holder = readStandLockHolder(root, slot);
    return holder
      ? `slot-${slot} HELD pid=${holder.pid} since=${holder.startedAt} reason=${holder.reason} worktree=${holder.worktree}`
      : existsSync(join(root, `slot-${slot}`)) ? `slot-${slot} BLOCKED unknown owner` : `slot-${slot} free`;
  });
  return [`root=${root}`, `capacity=${capacity}`, ...rows].join('\n');
};

if (import.meta.main) {
  const command = String(process.argv[2] ?? 'status');
  const flag = (name: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? String(process.argv[index + 1] ?? '') : '';
  };
  if (command === 'status') console.log(standLockStatus());
  else if (command === 'reap') console.log(`reaped=${reapStandLockSlots(standLockRoot())}`);
  else if (command === 'acquire') {
    const grant = await acquireStandLock({
      reason: flag('reason') || 'manual',
      waitMs: Number(flag('wait-ms') || '0'),
    });
    console.log(`STAND_LOCK_ACQUIRED slot=${grant.slot} token=${grant.token}`);
  } else if (command === 'run') {
    // The manual primitive: hold the machine for any command that is not yet
    // wired (cargo bench, an ad-hoc profile run), and release it on exit.
    const separator = process.argv.indexOf('--');
    const child = separator >= 0 ? process.argv.slice(separator + 1) : [];
    if (child.length === 0) throw new Error('STAND_LOCK_RUN_COMMAND_REQUIRED');
    const inherited = inheritedStandLock();
    const grant = inherited ?? await acquireStandLock({
      reason: flag('reason') || child.join(' ').slice(0, 60),
      waitMs: Number(flag('wait-ms') || '1800000'),
    });
    const { runStandChild } = await import('./stand/run');
    process.exit(await runStandChild(
      grant, child, Number(flag('timeout-ms') || '30000'), inherited ? 'inherited' : 'owned',
    ));
  } else if (command === 'release') {
    const slot = Number(flag('slot'));
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('STAND_LOCK_RELEASE_SLOT_REQUIRED');
    releaseStandLock({ root: standLockRoot(), slot, token: flag('token') });
    console.log(`STAND_LOCK_RELEASED slot=${slot}`);
  } else throw new Error(`STAND_LOCK_COMMAND_UNKNOWN:${command}`);
}
