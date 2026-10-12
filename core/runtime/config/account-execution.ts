import { runtimeProcessEnv } from '../../support/process/runtime-process';

/** Reject retired execution selectors before creating a replica or opening storage. */
export const assertTypeScriptAccountExecution = (
  env: Readonly<Record<string, string | undefined>> = runtimeProcessEnv ?? {},
): void => {
  const selected = String(env['XLN_HLT_ENGINE'] || 'ts').trim();
  if (selected !== 'ts') {
    throw new Error(selected === 'rust'
      ? 'RUNTIME_ACCOUNT_ENGINE_RETIRED:XLN_HLT_ENGINE:typescript-only'
      : `RUNTIME_ACCOUNT_ENGINE_INVALID:${selected}`);
  }
  const retiredFlag = Object.keys(env).find(key => env[key] === '1' && (
    key === 'XLN_RSCORE_AUTHORITY' || key === 'XLN_RSCORE_SHADOW' ||
    key === 'XLN_RSCORE_AUTHORITY_RECORD' || key === 'XLN_RSCORE_AUTHORITY_REPLAY' ||
    key === 'XLN_RSCORE_AUTHORITY_IMPORT' || key === 'XLN_RSCORE_ENTITY_AUTHORITY' ||
    key.startsWith('XLN_HUB_RSCORE_AUTHORITY_')
  ));
  if (retiredFlag) throw new Error(`RUNTIME_ACCOUNT_ENGINE_RETIRED:${retiredFlag}:typescript-only`);
};
