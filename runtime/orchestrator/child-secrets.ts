import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Writable } from 'node:stream';

export const XLN_CHILD_SECRET_FD = 3;
export const XLN_CHILD_SECRET_FD_ENV = 'XLN_CHILD_SECRET_FD';
const MAX_CHILD_SECRET_BYTES = 64 * 1024;

export type ChildSecrets = Record<string, string>;

export const childSecretFdEnv = (): NodeJS.ProcessEnv => ({
  [XLN_CHILD_SECRET_FD_ENV]: String(XLN_CHILD_SECRET_FD),
});

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
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < XLN_CHILD_SECRET_FD || fd > 64) {
    throw new Error(`CHILD_SECRET_FD_INVALID:${rawFd}`);
  }
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
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      child.kill('SIGTERM');
      reject(new Error(`CHILD_SECRET_PIPE_WRITE_FAILED:${error.message}`));
    };
    pipe.once('error', onError);
    pipe.end(payload, () => {
      pipe.off('error', onError);
      resolve();
    });
  });
};
