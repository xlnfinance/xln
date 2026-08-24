import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  authorityRecordReport,
  beginAuthorityFrame,
  flushAuthorityFrame,
  noteRawAccountInput,
  resetAuthorityRecordForTests,
} from '../../rscore/authority-record';
import type { AccountInput, AccountReplica } from '../../types/account';

/**
 * One process hosts up to two hundred Runtimes in a load run, and their frames
 * overlap. Everything here is about attribution: an input recorded against the
 * wrong Runtime is an input the authoritative engine for that Runtime never
 * receives, and the divergence would surface as a wrong frame hash somewhere
 * else entirely.
 */

const replica = (owner: string, counterparty: string): AccountReplica =>
  ({ proofHeader: { fromEntity: owner, toEntity: counterparty } } as unknown as AccountReplica);

const enqueue = (): AccountInput => ({ kind: 'enqueue', accountTxs: [] } as unknown as AccountInput);

const A = `0x${'aa'.repeat(32)}`;
const B = `0x${'bb'.repeat(32)}`;
const C = `0x${'cc'.repeat(32)}`;

describe('authority record', () => {
  beforeEach(() => {
    process.env['XLN_RSCORE_AUTHORITY_RECORD'] = '1';
    resetAuthorityRecordForTests();
  });
  afterEach(() => {
    delete process.env['XLN_RSCORE_AUTHORITY_RECORD'];
    resetAuthorityRecordForTests();
  });

  test('two Runtimes with overlapping frames keep their own inputs', () => {
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput('runtime-a', replica(A, B), enqueue());
    beginAuthorityFrame('runtime-b');
    noteRawAccountInput('runtime-b', replica(A, C), enqueue());
    // Back to A while B is still open: an active-Runtime pointer would have
    // put this in B's frame.
    noteRawAccountInput('runtime-a', replica(A, B), enqueue());
    flushAuthorityFrame('runtime-b');
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.frames).toBe(2);
    expect(report.inputs).toBe(3);
    expect(report.skippedNoFrame).toBe(0);
  });

  test('a frame abandoned by a throw is dropped, not merged into the next', () => {
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput('runtime-a', replica(A, B), enqueue());
    // No flush: the reducer threw. The next frame for the same Runtime finds
    // the old one still open.
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput('runtime-a', replica(A, C), enqueue());
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.abandonedFrames).toBe(1);
    expect(report.frames).toBe(1);
    expect(report.inputs).toBe(1);
  });

  test('an input with no Runtime is counted, never attributed to another', () => {
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput(undefined, replica(A, B), enqueue());
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.skippedNoFrame).toBe(1);
    expect(report.inputs).toBe(0);
  });

  test('a frame touching two owner Entities is reported as such', () => {
    // Each Entity carries its own enforcement clock, so this frame cannot be
    // one wave with one clock.
    beginAuthorityFrame('runtime-a');
    noteRawAccountInput('runtime-a', replica(A, B), enqueue());
    noteRawAccountInput('runtime-a', replica(C, B), enqueue());
    flushAuthorityFrame('runtime-a');

    const report = authorityRecordReport();
    expect(report.framesWithMultipleOwners).toBe(1);
    expect(report.maxOwnersPerFrame).toBe(2);
  });
});
