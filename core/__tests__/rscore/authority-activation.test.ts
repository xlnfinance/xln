import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  assertAuthorityOperationCoverage,
  assertAuthorityProposalParity,
  assertAuthorityWaveOperationLedger,
  authorityDriverEnabled,
  authoritySessionIdentityFor,
} from '../../rscore/authority-driver';
import {
  authorityRecordEnabled,
  describeAuthorityWaveOperation,
  type AuthorityWave,
  type AuthorityWaveOperation,
} from '../../rscore/authority-wave';
import { waveAdmitOp, waveCreateOp, waveInputOp } from '../../rscore/shadow-wire';
import { createEmptyEnv } from '../../runtime';
import { deriveSignerAddressSync } from '../../account/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { signEntityHashes } from '../../hanko/signing';
import type { AccountFrame } from '../../types/account';

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

  test('proposal parity independently checks structure, hash, candidate, and Hanko', async () => {
    const seed = 'rscore-authority-proposal-gate';
    const signerId = '1';
    const env = createEmptyEnv(seed);
    env.state.timestamp = 1_700_000_000_000;
    const signer = deriveSignerAddressSync(seed, signerId);
    const owner = generateLazyEntityId([signer], 1n).toLowerCase();
    const accountId = `0x${'55'.repeat(32)}`;
    const unsigned: AccountFrame = {
      height: 1,
      timestamp: env.state.timestamp,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: 'genesis',
      accountStateRoot: `0x${'66'.repeat(32)}`,
      stateHash: '',
      byLeft: true,
      deltas: [],
    };
    unsigned.stateHash = computeFrameHash(unsigned);
    const [hanko] = await signEntityHashes(env, owner, signerId, [unsigned.stateHash]);
    if (hanko === undefined) throw new Error('AUTHORITY_PROPOSAL_HANKO_MISSING');
    const signed = { ...unsigned, hanko };

    await expect(assertAuthorityProposalParity(env, owner, accountId, signed, unsigned))
      .resolves.toBeUndefined();
    await expect(assertAuthorityProposalParity(
      env,
      owner,
      accountId,
      { ...signed, height: -1 },
      unsigned,
    )).rejects.toThrow('RSCORE_AUTHORITY_HALT:FRAME_STRUCTURE_INVALID');
    const forgedHash = `0x${'77'.repeat(32)}`;
    await expect(assertAuthorityProposalParity(
      env,
      owner,
      accountId,
      { ...signed, stateHash: forgedHash },
      { ...unsigned, stateHash: forgedHash },
    )).rejects.toThrow('RSCORE_AUTHORITY_HALT:FRAME_SELF_HASH_MISMATCH');
    await expect(assertAuthorityProposalParity(
      env,
      owner,
      accountId,
      signed,
      { ...unsigned, stateHash: `0x${'88'.repeat(32)}` },
    )).rejects.toThrow('RSCORE_AUTHORITY_HALT:FRAME_HASH_MISMATCH');
    await expect(assertAuthorityProposalParity(
      env,
      owner,
      accountId,
      { ...signed, hanko: '0x00' },
      unsigned,
    )).rejects.toThrow('RSCORE_AUTHORITY_HALT:FRAME_HANKO_INVALID');
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

  test('operation ledger is a bijection with Admit/Create/Input wire rows and global arrival', () => {
    const admit = waveAdmitOp(0, ACCOUNT_A, []);
    const create = waveCreateOp(1, [wireId(ACCOUNT_B)]);
    const input = waveInputOp([
      2,
      wireId(ACCOUNT_A),
      wireId(ACCOUNT_A),
      [1, 1, wireId(`0x${'77'.repeat(32)}`), new Uint8Array([1]), null],
    ]);
    const wave: Extract<AuthorityWave, { kind: 'wave' }> = {
      kind: 'wave',
      inputs: [{
        operationIndex: 2,
        arrivalIndex: 0,
        ownerEntityId: OWNER_A,
        accountId: ACCOUNT_A,
        kind: 'ack',
      }],
      entities: [{
        ownerEntityId: OWNER_A,
        timestamp: 1,
        jHeight: 1,
        entityTimestamp: 1,
        finalizedJHeight: 1,
        propose: false,
        ops: [admit, create, input],
        operations: [operation(admit, 1), operation(create, 2), operation(input, 0)],
        expectedOutputs: new Map(),
      }],
    };
    const entity = wave.entities[0];
    if (entity === undefined) throw new Error('AUTHORITY_OPERATION_ENTITY_MISSING');

    expect(() => assertAuthorityWaveOperationLedger(wave)).not.toThrow();
    const duplicateArrival: typeof wave = {
      ...wave,
      entities: [{
        ...entity,
        operations: entity.operations.map(row =>
          row.operationIndex === 1 ? { ...row, arrivalIndex: 1 } : row),
      }],
    };
    expect(() => assertAuthorityWaveOperationLedger(duplicateArrival))
      .toThrow('RSCORE_AUTHORITY_HALT:OPERATION_LEDGER_MISMATCH');
  });

  test('every result-bearing operation is answered exactly once and Create is unanswered', () => {
    const submitted: AuthorityWaveOperation[] = [
      { operationIndex: 0, arrivalIndex: 1, accountId: ACCOUNT_A, resultKind: 'admission' },
      { operationIndex: 1, arrivalIndex: 2, accountId: ACCOUNT_B, resultKind: 'none' },
      { operationIndex: 2, arrivalIndex: 0, accountId: ACCOUNT_A, resultKind: 'applied' },
    ];
    const admission = {
      operationIndex: 0,
      accountId: ACCOUNT_A,
      verdict: { kind: 'admitted' as const, count: 1 },
    };
    const applied = {
      operationIndex: 2,
      accountId: ACCOUNT_A,
      verdict: { kind: 'ackStale' as const, height: 0 },
    };

    expect(() => assertAuthorityOperationCoverage(OWNER_A, submitted, {
      admissions: [admission],
      applied: [applied],
    })).not.toThrow();
    expect(() => assertAuthorityOperationCoverage(OWNER_A, submitted, {
      admissions: [],
      applied: [applied],
    })).toThrow('RSCORE_AUTHORITY_HALT:OPERATION_COVERAGE_MISMATCH');
    expect(() => assertAuthorityOperationCoverage(OWNER_A, submitted, {
      admissions: [admission, {
        operationIndex: 1,
        accountId: ACCOUNT_B,
        verdict: { kind: 'admitted', count: 0 },
      }],
      applied: [applied],
    })).toThrow('RSCORE_AUTHORITY_HALT:OPERATION_COVERAGE_MISMATCH');
    expect(() => assertAuthorityOperationCoverage(OWNER_A, submitted, {
      admissions: [admission],
      applied: [{ ...applied, accountId: ACCOUNT_B }],
    })).toThrow('RSCORE_AUTHORITY_HALT:OPERATION_COVERAGE_MISMATCH');
    expect(() => assertAuthorityOperationCoverage(OWNER_A, submitted, {
      admissions: [admission],
      applied: [applied, applied],
    })).toThrow('RSCORE_AUTHORITY_HALT:OPERATION_COVERAGE_MISMATCH');
  });
});
