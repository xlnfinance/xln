import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Writable } from 'node:stream';

// Managed children are non-interactive, so stdin is the canonical private
// secret pipe. Bun 1.3.x on macOS implements extra stdio pipes as connecting
// Unix sockets, which can fail before the first write. FD 0 is a real anonymous
// pipe and keeps the same no-argv/no-environment secret boundary reliably.
export const XLN_CHILD_SECRET_FD = 0;
export const XLN_CHILD_SECRET_FD_ENV = 'XLN_CHILD_SECRET_FD';
const MAX_CHILD_SECRET_BYTES = 64 * 1024;
const CHILD_SECRET_WRITE_TIMEOUT_MS = 5_000;

export type ChildSecrets = Record<string, string>;

export const childSecretFdEnv = (): NodeJS.ProcessEnv => ({
  [XLN_CHILD_SECRET_FD_ENV]: String(XLN_CHILD_SECRET_FD),
});

const MANAGED_RUNTIME_PARENT_SECRET_ENV = [
  'XLN_RUNTIME_SEED',
  'XLN_MESH_ROOT_SEED',
  'XLN_MESH_RUNTIME_SEEDS_JSON',
  'XLN_MESH_RADAPTER_AUTH_SEEDS_JSON',
  'XLN_RADAPTER_AUTH_SEED',
  'CUSTODY_SEED',
  'CUSTODY_DAEMON_RUNTIME_SEED',
  'CUSTODY_DAEMON_AUTH_SEED',
] as const;

export const buildManagedRuntimeChildSecretEnv = (
  env: NodeJS.ProcessEnv,
  includeSecretFd = true,
): NodeJS.ProcessEnv => {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  // The inherited FD is authoritative for a managed runtime. Keeping the
  // operator/root seed in env both leaks sibling material and makes the
  // fail-closed source check reject correctly derived per-child seeds.
  for (const name of MANAGED_RUNTIME_PARENT_SECRET_ENV) delete childEnv[name];
  delete childEnv[XLN_CHILD_SECRET_FD_ENV];
  if (includeSecretFd) Object.assign(childEnv, childSecretFdEnv());
  return childEnv;
};

export const parseChildSecretPayload = (raw: string): ChildSecrets => {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_CHILD_SECRET_BYTES) {
    throw new Error('CHILD_SECRET_PAYLOAD_SIZE_INVALID');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CHILD_SECRET_PAYLOAD_OBJECT_REQUIRED');
  }
  const secrets: ChildSecrets = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || !value.trim()) {
      throw new Error(`CHILD_SECRET_PAYLOAD_ENTRY_INVALID:${key}`);
    }
    secrets[key] = value;
  }
  return secrets;
};

export const readInheritedChildSecrets = (): ChildSecrets => {
  const rawFd = process.env[XLN_CHILD_SECRET_FD_ENV]?.trim();
  if (!rawFd) return {};
  delete process.env[XLN_CHILD_SECRET_FD_ENV];
  if (rawFd !== String(XLN_CHILD_SECRET_FD)) {
    throw new Error(`CHILD_SECRET_FD_INVALID:${rawFd}`);
  }
  const fd = XLN_CHILD_SECRET_FD;
  return parseChildSecretPayload(readFileSync(fd, 'utf8'));
};

export const resolveChildSecret = (
  secrets: ChildSecrets,
  key: string,
  fallback: string,
): string => {
  const inherited = secrets[key]?.trim() || '';
  const configured = fallback.trim();
  if (inherited && configured && inherited !== configured) {
    throw new Error(`CHILD_SECRET_SOURCE_CONFLICT:${key}`);
  }
  return inherited || configured;
};

export const writeInheritedChildSecrets = async (
  child: ChildProcess,
  secrets: ChildSecrets,
): Promise<void> => {
  const pipe = child.stdio[XLN_CHILD_SECRET_FD] as Writable | null | undefined;
  if (!pipe || typeof pipe.end !== 'function') {
    child.kill('SIGTERM');
    throw new Error('CHILD_SECRET_PIPE_MISSING');
  }
  const payload = JSON.stringify(secrets);
  if (Buffer.byteLength(payload, 'utf8') > MAX_CHILD_SECRET_BYTES) {
    child.kill('SIGTERM');
    throw new Error('CHILD_SECRET_PAYLOAD_TOO_LARGE');
  }
  if (typeof child.pid !== 'number' || child.pid <= 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('CHILD_SECRET_CHILD_SPAWN_TIMEOUT'));
      }, CHILD_SECRET_WRITE_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      const onSpawn = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => {
        cleanup();
        reject(new Error(`CHILD_SECRET_CHILD_SPAWN_FAILED:${error.message}`));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `CHILD_SECRET_CHILD_EXITED_BEFORE_WRITE:code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGTERM');
      reject(new Error('CHILD_SECRET_PIPE_WRITE_TIMEOUT'));
    }, CHILD_SECRET_WRITE_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      pipe.off('error', onPipeError);
      child.off('error', onChildError);
      child.off('exit', onChildExit);
    };
    const fail = (error: Error): void => {
      cleanup();
      child.kill('SIGTERM');
      reject(error);
    };
    const onPipeError = (error: Error): void => {
      fail(new Error(`CHILD_SECRET_PIPE_WRITE_FAILED:${error.message}`));
    };
    const onChildError = (error: Error): void => {
      fail(new Error(`CHILD_SECRET_CHILD_FAILED_DURING_WRITE:${error.message}`));
    };
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      fail(new Error(
        `CHILD_SECRET_CHILD_EXITED_DURING_WRITE:code=${String(code)} signal=${String(signal)}`,
      ));
    };
    pipe.once('error', onPipeError);
    child.once('error', onChildError);
    child.once('exit', onChildExit);
    pipe.end(payload, () => {
      cleanup();
      resolve();
    });
  });
};
