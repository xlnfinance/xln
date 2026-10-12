import type { RuntimeReplica } from '../types';
import { readRuntimeEnv } from '../../support/process/runtime-process';

export type AuthorityRuntimeScope = Pick<RuntimeReplica, 'runtimeId' | 'accountAuthoritySuppressed'>;

const authorityTargetRuntimeId = (): string | undefined => {
  const configured = readRuntimeEnv('XLN_RSCORE_AUTHORITY_RUNTIME_ID');
  if (configured === undefined || configured === '') return undefined;
  if (!/^0x[0-9a-f]{40}$/.test(configured)) {
    throw new Error(`RSCORE_AUTHORITY_RUNTIME_ID_INVALID:${configured}`);
  }
  return configured;
};

/**
 * Authority is process-configured but Runtime-scoped. HLT packs hundreds of
 * sovereign Runtime replicas into one process, so inheriting the flag must
 * never silently hand all of them to the H1 engine. Omitting the target keeps
 * the single-Runtime production process behavior; packed hosts name H1
 * explicitly.
 */
export const authorityDriverEnabled = (env?: AuthorityRuntimeScope): boolean => {
  if (readRuntimeEnv('XLN_RSCORE_AUTHORITY') !== '1') return false;
  if (env?.accountAuthoritySuppressed === true) return false;
  const target = authorityTargetRuntimeId();
  if (target === undefined || env === undefined) return true;
  const runtimeId = String(env.runtimeId ?? '');
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) {
    throw new Error(`RSCORE_AUTHORITY_RUNTIME_ID_MISSING:${runtimeId}`);
  }
  return runtimeId === target;
};

/** The removed live collector must never silently report an empty recording. */
export const assertAccountRecorderDisabled = (): void => {
  if (readRuntimeEnv('XLN_RSCORE_AUTHORITY_RECORD') === '1') {
    throw new Error('RUNTIME_RSCORE_RECORD_RETIRED:use immutable Runtime WAL recording and replay');
  }
};
