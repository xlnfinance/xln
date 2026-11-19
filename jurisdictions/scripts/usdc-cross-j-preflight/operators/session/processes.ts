import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';

export type ManagedChild = { name: string; child: ChildProcess; error: Error | null };

export const launchSessionChild = (
  children: ManagedChild[],
  runDirectory: string,
  name: string,
  entry: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ManagedChild => {
  const fd = openSync(join(runDirectory, `${name}.log`), 'wx', 0o600);
  const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const managed: ManagedChild = { name, child, error: null };
  child.on('error', error => {
    managed.error = error;
  });
  children.push(managed);
  return managed;
};

export const assertSessionChildrenLive = (children: readonly ManagedChild[]): void => {
  for (const { name, child, error } of children) {
    if (error) throw new Error(`USDC_SESSION_CHILD_ERROR:${name}`, { cause: error });
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`USDC_SESSION_CHILD_EXIT:${name}:${child.exitCode}:${child.signalCode}`);
  }
};

export const waitSessionChild = async (managed: ManagedChild): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (managed.child.exitCode === null && managed.child.signalCode === null) {
    if (managed.error) throw managed.error;
    if (Date.now() >= deadline) throw new Error(`USDC_SESSION_INSPECTION_TIMEOUT:${managed.name}`);
    await Bun.sleep(25);
  }
  if (managed.child.exitCode !== 0)
    throw new Error(
      `USDC_SESSION_INSPECTION_FAILED:${managed.name}:${managed.child.exitCode}:${managed.child.signalCode}`,
    );
};

export const stopSessionChildren = async (children: readonly ManagedChild[]): Promise<void> => {
  const requested = children.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  const failures: Error[] = [];
  for (const { name, child } of [...requested].reverse()) {
    child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await Bun.sleep(25);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      failures.push(new Error(`USDC_SESSION_FORCED_STOP:${name}`));
    }
    if (child.exitCode !== null && child.exitCode !== 0)
      failures.push(new Error(`USDC_SESSION_SHUTDOWN_EXIT:${name}:${child.exitCode}`));
  }
  const deadline = Date.now() + 2_000;
  while (children.some(({ child }) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline)
    await Bun.sleep(25);
  if (children.some(({ child }) => child.exitCode === null && child.signalCode === null))
    throw new Error('USDC_SESSION_CHILD_STOP_INCOMPLETE');
  if (failures.length > 0) throw new AggregateError(failures, 'USDC_SESSION_SHUTDOWN_FAILED');
};

export const waitSessionReady = async (
  children: readonly ManagedChild[],
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> => {
  const startedAt = performance.now();
  while (true) {
    assertSessionChildrenLive(children);
    if (await predicate()) return;
    if (performance.now() - startedAt >= timeoutMs) throw new Error(`USDC_SESSION_READINESS_TIMEOUT:${label}`);
    await Bun.sleep(100);
  }
};

export const readSessionStatus = async (port: number, path: '/api/info' | '/api/health') => {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return requireBoundaryRecord(
    await response.json(),
    path === '/api/info' ? 'USDC_SESSION_HUB_INFO_INVALID' : 'USDC_SESSION_HEALTH_INVALID',
  );
};
