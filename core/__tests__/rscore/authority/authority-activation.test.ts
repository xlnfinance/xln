import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { authoritySessionIdentityFor } from '../../../rscore/process/session-identity';
import { createEmptyEnv, loadEnvFromDB } from '../../../runtime';
import { installTsAccountWorkerAuthority } from '../../../runtime/workers/account/provider';

const H1 = `0x${'11'.repeat(20)}`;
const LANE = `0x${'22'.repeat(20)}`;
const OWNER_A = `0x${'33'.repeat(32)}`;
const OWNER_B = `0x${'44'.repeat(32)}`;
const retiredFlags = [
  'XLN_RSCORE_AUTHORITY', 'XLN_RSCORE_SHADOW', 'XLN_RSCORE_AUTHORITY_RECORD',
  'XLN_RSCORE_AUTHORITY_REPLAY', 'XLN_RSCORE_AUTHORITY_IMPORT', 'XLN_RSCORE_ENTITY_AUTHORITY',
  'XLN_HUB_RSCORE_AUTHORITY_H2',
];
const configurationKeys = [...retiredFlags, 'XLN_RSCORE_AUTHORITY_RUNTIME_ID', 'XLN_HLT_ENGINE'];
const previous = new Map(configurationKeys.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of configurationKeys) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('TS-only Account execution', () => {
  test.each(retiredFlags)('rejects retired selector %s before replica creation or installed executor reuse', key => {
    const env = createEmptyEnv(null, 0);
    env.runtimeId = LANE;
    env.accountAuthorityExecutionMode = 'cutover';
    // A stale host object cannot revive the retired suppression bypass.
    Object.assign(env, { accountAuthoritySuppressed: true });
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = H1;
    process.env[key] = '1';
    const code = `RUNTIME_ACCOUNT_ENGINE_RETIRED:${key}:typescript-only`;
    expect(() => createEmptyEnv(null, 0)).toThrow(code);
    expect(() => installTsAccountWorkerAuthority(env)).toThrow(code);
    expect(env.state.height).toBe(0);
    expect(env.state.eReplicas.size).toBe(0);
    expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
    expect(env.accountAuthorityExecutionMode).toBe('cutover');
  });

  test('rejects native-only replay selector even without the authority switch', () => {
    const env = createEmptyEnv(null, 0);
    env.accountAuthorityExecutionMode = 'cutover';
    process.env['XLN_RSCORE_AUTHORITY_REPLAY'] = '1';
    expect(() => installTsAccountWorkerAuthority(env)).toThrow(
      'RUNTIME_ACCOUNT_ENGINE_RETIRED:XLN_RSCORE_AUTHORITY_REPLAY:typescript-only',
    );
  });

  test('absent or disabled selectors permit the TS executor', () => {
    for (const disabled of [undefined, '0']) {
      for (const key of retiredFlags) {
        if (disabled === undefined) delete process.env[key];
        else process.env[key] = disabled;
      }
      const env = createEmptyEnv(null, 0);
      env.accountAuthorityExecutionMode = 'cutover';
      expect(() => installTsAccountWorkerAuthority(env)).not.toThrow();
      expect(env.state.height).toBe(0);
      expect(env.accountAuthorityExecutionMode).toBe('cutover');
    }
  });

  test('live restore rejects retired configuration before opening storage', async () => {
    process.env['XLN_RSCORE_AUTHORITY'] = '1';
    await expect(loadEnvFromDB('not-a-runtime-id')).rejects.toThrow(
      'RUNTIME_ACCOUNT_ENGINE_RETIRED:XLN_RSCORE_AUTHORITY:typescript-only',
    );
  });

  test.each(['XLN_RSCORE_AUTHORITY_REPLAY', '--require-rust-account-authority'])(
    'replay rejects %s before parsing or opening a recording', async selector => {
      const args = selector.startsWith('--') ? [selector] : [];
      const child = Bun.spawn([process.execPath, new URL(
        '../../../scripts/operations/hlt/replay/replay-hub-recording.ts', import.meta.url,
      ).pathname, ...args], {
        env: { ...process.env, ...(args.length === 0 ? { [selector]: '1' } : {}) },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [exitCode, output, errors] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(errors).toContain(`RUNTIME_ACCOUNT_ENGINE_RETIRED:${selector}:typescript-only`);
      expect(errors).not.toContain('HLT_REPLAY_ARGUMENT_REQUIRED');
      expect(output).not.toContain('HLT_REPLAY_REPORT');
    },
  );

  test('process transcript identity is stable and bound to Runtime plus owner', () => {
    const first = authoritySessionIdentityFor(H1, OWNER_A);
    const same = authoritySessionIdentityFor(H1, OWNER_A);
    const otherRuntime = authoritySessionIdentityFor(LANE, OWNER_A);
    const otherOwner = authoritySessionIdentityFor(H1, OWNER_B);

    expect(first.runtimeId.toString('hex')).toBe('11'.repeat(20));
    expect(first.engineGeneration.byteLength).toBe(8);
    expect(first.sessionId.byteLength).toBe(16);
    expect(first.engineGeneration.toString('hex')).toBe(same.engineGeneration.toString('hex'));
    expect(first.sessionId.toString('hex')).toBe(same.sessionId.toString('hex'));
    expect(first.engineGeneration.toString('hex')).not.toBe(otherRuntime.engineGeneration.toString('hex'));
    expect(first.sessionId.toString('hex')).not.toBe(otherRuntime.sessionId.toString('hex'));
    expect(first.sessionId.toString('hex')).not.toBe(otherOwner.sessionId.toString('hex'));
  });

  test('malformed Runtime and owner bindings fail before process spawn', () => {
    expect(() => authoritySessionIdentityFor('H1', OWNER_A)).toThrow('RSCORE_AUTHORITY_RUNTIME_ID_BYTES:H1');
    expect(() => authoritySessionIdentityFor(H1, 'owner')).toThrow('RSCORE_AUTHORITY_OWNER_ID_BYTES:owner');
  });
});
