import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  authorityDriverEnabled,
  authoritySessionIdentityFor,
} from '../../../rscore/authority-driver';
import { authorityRecordEnabled } from '../../../rscore/authority-wave';
import { createEmptyEnv } from '../../../runtime';

const H1 = `0x${'11'.repeat(20)}`;
const LANE = `0x${'22'.repeat(20)}`;
const OWNER_A = `0x${'33'.repeat(32)}`;
const OWNER_B = `0x${'44'.repeat(32)}`;
const ACCOUNT_A = `0x${'55'.repeat(32)}`;
const ACCOUNT_B = `0x${'66'.repeat(32)}`;

const wireId = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value.slice(2), 'hex'));

const operation = (
  encoded: ReturnType<typeof waveAdmitOp>,
  arrivalIndex: number,
): AuthorityWaveOperation => ({
  ...describeAuthorityWaveOperation(encoded),
  arrivalIndex,
  expectedVerdict: describeAuthorityWaveOperation(encoded).resultKind === 'none'
    ? { kind: 'create' }
    : describeAuthorityWaveOperation(encoded).resultKind === 'admission'
      ? { kind: 'admission', admittedCount: 0 }
      : {
          kind: 'input',
          outcome: 'applied',
          committedFrames: [],
          responseAckHanko: null,
          events: [],
        },
});

const previousAuthority = process.env['XLN_RSCORE_AUTHORITY'];
const previousTarget = process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
const previousRecord = process.env['XLN_RSCORE_AUTHORITY_RECORD'];

beforeEach(() => {
  process.env['XLN_RSCORE_AUTHORITY'] = '1';
  delete process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
  delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
});

afterEach(() => {
  if (previousAuthority === undefined) delete process.env['XLN_RSCORE_AUTHORITY'];
  else process.env['XLN_RSCORE_AUTHORITY'] = previousAuthority;
  if (previousTarget === undefined) delete process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
  else process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = previousTarget;
  if (previousRecord === undefined) delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
  else process.env['XLN_RSCORE_AUTHORITY_RECORD'] = previousRecord;
});

describe('rscore authority Runtime scope', () => {
  test('an unscoped single-Runtime process keeps authority enabled', () => {
    expect(authorityDriverEnabled({ runtimeId: H1 })).toBe(true);
  });

  test('a packed host enables only the named H1 Runtime', () => {
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = H1;
    expect(authorityDriverEnabled({ runtimeId: H1 })).toBe(true);
    expect(authorityDriverEnabled({ runtimeId: LANE })).toBe(false);
    expect(authorityRecordEnabled(authorityDriverEnabled({ runtimeId: LANE }))).toBe(false);
  });

  test('explicit recorder mode can still observe a non-authority Runtime', () => {
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = H1;
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    expect(authorityRecordEnabled(authorityDriverEnabled({ runtimeId: LANE }))).toBe(true);
  });

  test('suppression still wins for exact read-only recovery', () => {
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = H1;
    expect(authorityDriverEnabled({
      runtimeId: H1,
      accountAuthoritySuppressed: true,
    })).toBe(false);
  });

  test('a malformed target is rejected before any Runtime is driven', () => {
    process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'] = 'H1';
    expect(() => authorityDriverEnabled({ runtimeId: H1 }))
      .toThrow('RSCORE_AUTHORITY_RUNTIME_ID_INVALID:H1');
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
    expect(first.engineGeneration.toString('hex'))
      .not.toBe(otherRuntime.engineGeneration.toString('hex'));
    expect(first.sessionId.toString('hex')).not.toBe(otherRuntime.sessionId.toString('hex'));
    expect(first.sessionId.toString('hex')).not.toBe(otherOwner.sessionId.toString('hex'));
  });

  test('malformed Runtime and owner bindings fail before process spawn', () => {
    expect(() => authoritySessionIdentityFor('H1', OWNER_A))
      .toThrow('RSCORE_AUTHORITY_RUNTIME_ID_BYTES:H1');
    expect(() => authoritySessionIdentityFor(H1, 'owner'))
      .toThrow('RSCORE_AUTHORITY_OWNER_ID_BYTES:owner');
  });
});
