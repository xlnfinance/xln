import { authorityDriverEnabled } from '../../../runtime/config/account-execution';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  authoritySessionIdentityFor,
} from '../../../rscore/authority-driver';
import { createEmptyEnv } from '../../../runtime';
import { installTsAccountWorkerAuthority } from '../../../runtime/workers/account/provider';

const H1 = `0x${'11'.repeat(20)}`;
const LANE = `0x${'22'.repeat(20)}`;
const OWNER_A = `0x${'33'.repeat(32)}`;
const OWNER_B = `0x${'44'.repeat(32)}`;
const previousAuthority = process.env['XLN_RSCORE_AUTHORITY'];
const previousTarget = process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
const previousRecord = process.env['XLN_RSCORE_AUTHORITY_RECORD'];
const previousShadow = process.env['XLN_RSCORE_SHADOW'];

beforeEach(() => {
  process.env['XLN_RSCORE_AUTHORITY'] = '1';
  delete process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
  delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
  delete process.env['XLN_RSCORE_SHADOW'];
});

afterEach(() => {
  if (previousAuthority === undefined) delete process.env['XLN_RSCORE_AUTHORITY'];
  else process.env['XLN_RSCORE_AUTHORITY'] = previousAuthority;
  if (previousTarget === undefined) delete process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
  else process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = previousTarget;
  if (previousRecord === undefined) delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
  else process.env['XLN_RSCORE_AUTHORITY_RECORD'] = previousRecord;
  if (previousShadow === undefined) delete process.env['XLN_RSCORE_SHADOW'];
  else process.env['XLN_RSCORE_SHADOW'] = previousShadow;
});

describe('rscore authority Runtime scope', () => {
  test('retired embedded authority cannot install an executor or reach its first Account WAL commit', () => {
    const env = createEmptyEnv(null, 0);
    expect(() => installTsAccountWorkerAuthority(env)).toThrow(
      'RUNTIME_EMBEDDED_RSCORE_AUTHORITY_RETIRED:use native xlnrs',
    );
    expect(env.state.height).toBe(0);
    expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
  });

  test('retired recorder rejects before installing either a fresh or configured executor', () => {
    delete process.env['XLN_RSCORE_AUTHORITY'];
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    for (const configured of [false, true]) {
      const env = createEmptyEnv(null, 0);
      if (configured) env.accountAuthorityExecutionMode = 'cutover';
      expect(() => installTsAccountWorkerAuthority(env)).toThrow('RUNTIME_RSCORE_RECORD_RETIRED');
      expect(env.state.height).toBe(0);
      expect(env.state.eReplicas.size).toBe(0);
      expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
      expect(env.accountAuthorityExecutionMode).toBe(configured ? 'cutover' : undefined);
    }
  });

  test('an absent or disabled recorder permits the installed TS executor', () => {
    delete process.env['XLN_RSCORE_AUTHORITY'];
    for (const configured of [undefined, '0']) {
      if (configured === undefined) delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
      else process.env['XLN_RSCORE_AUTHORITY_RECORD'] = configured;
      const env = createEmptyEnv(null, 0);
      env.accountAuthorityExecutionMode = 'cutover';
      expect(() => installTsAccountWorkerAuthority(env)).not.toThrow();
      expect(env.state.height).toBe(0);
      expect(env.accountAuthorityExecutionMode).toBe('cutover');
    }
  });

  test('retired recorder cannot be hidden by Runtime targeting or read-only suppression', () => {
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = H1;
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    const env = createEmptyEnv(null, 0);
    env.runtimeId = LANE;
    env.accountAuthoritySuppressed = true;
    expect(() => installTsAccountWorkerAuthority(env)).toThrow('RUNTIME_RSCORE_RECORD_RETIRED');
    expect(env.accountAuthorityExecutionMode).toBeUndefined();
  });

  test('replay rejects retired recorder before parsing or opening a recording', async () => {
    const child = Bun.spawn([process.execPath, new URL(
      '../../../scripts/operations/hlt/replay/replay-hub-recording.ts', import.meta.url,
    ).pathname], {
      env: { ...process.env, XLN_RSCORE_AUTHORITY: '0', XLN_RSCORE_AUTHORITY_RECORD: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, output, errors] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(errors).toContain('RUNTIME_RSCORE_RECORD_RETIRED');
    expect(errors).not.toContain('HLT_REPLAY_ARGUMENT_REQUIRED');
    expect(output).not.toContain('HLT_REPLAY_REPORT');
  });

  test('retired shadow configuration cannot silently run a TS-only comparison', () => {
    delete process.env['XLN_RSCORE_AUTHORITY'];
    process.env['XLN_RSCORE_SHADOW'] = '1';
    const env = createEmptyEnv(null, 0);

    expect(() => installTsAccountWorkerAuthority(env)).toThrow(
      'RUNTIME_RSCORE_SHADOW_RETIRED:use immutable Runtime WAL replay',
    );
    expect(env.state.height).toBe(0);
    expect(env.accountAuthorityEntityStageProvider).toBeUndefined();
  });

  test('an unscoped single-Runtime process keeps authority enabled', () => {
    expect(authorityDriverEnabled({ runtimeId: H1 })).toBe(true);
  });

  test('a packed host enables only the named H1 Runtime', () => {
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = H1;
    expect(authorityDriverEnabled({ runtimeId: H1 })).toBe(true);
    expect(authorityDriverEnabled({ runtimeId: LANE })).toBe(false);
  });

  test('suppression still wins for exact read-only recovery', () => {
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = H1;
    expect(
      authorityDriverEnabled({
        runtimeId: H1,
        accountAuthoritySuppressed: true,
      }),
    ).toBe(false);
  });

  test('a malformed target is rejected before any Runtime is driven', () => {
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = 'H1';
    expect(() => authorityDriverEnabled({ runtimeId: H1 })).toThrow('RSCORE_AUTHORITY_RUNTIME_ID_INVALID:H1');
  });

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
