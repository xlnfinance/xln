import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isLocalOperatorRequest } from '../server/health-redaction';

const readBearer = (request: Request): string => {
  const match = String(request.headers.get('authorization') || '').trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
};

const equalSecret = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

export const loadOrCreateOperatorToken = (path: string, configuredToken?: string): string => {
  const configured = String(configuredToken || '').trim();
  if (configured) {
    if (configured.length < 32) throw new Error('ORCHESTRATOR_OPERATOR_TOKEN_TOO_SHORT');
    return configured;
  }
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length < 32) throw new Error('ORCHESTRATOR_OPERATOR_TOKEN_FILE_INVALID');
    chmodSync(path, 0o600);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const generated = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length < 32) throw new Error('ORCHESTRATOR_OPERATOR_TOKEN_FILE_INVALID');
    chmodSync(path, 0o600);
    return existing;
  }
};

export const isOperatorRequest = (
  request: Request,
  peerAddress: string | null | undefined,
  operatorToken: string,
): boolean => isLocalOperatorRequest(request, peerAddress) || equalSecret(readBearer(request), operatorToken);
