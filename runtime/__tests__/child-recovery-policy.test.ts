import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistChildFailureReceipt, type ChildFailureReceipt } from '../orchestrator/child-failure-diagnostics';
import {
  decideChildFailure,
  selectChildFailureReason,
  shouldCaptureUnexpectedChildExit,
} from '../orchestrator/child-recovery-policy';

const crash = (reason: string) => ({
  role: 'hub' as const,
  name: 'H2',
  code: 1,
  signal: null,
  reason,
});

describe('managed child recovery policy', () => {
  test('fail-stops a declared bootstrap stall on its first occurrence', () => {
    const decision = decideChildFailure({}, crash('MESH_BOOTSTRAP_STALLED idleMs=60001'));

    expect(decision).toMatchObject({ action: 'fail-stop', count: 1, backoffMs: 0 });
  });

  test('persists an unhandled Runtime-loop fatal on its first occurrence', () => {
    const decision = decideChildFailure({}, crash(
      '[ERROR][runtime] loop.error {"message":"CROSS_J_LOCAL_EVENT_REJECTED:order=42"}',
    ));

    expect(decision).toMatchObject({
      action: 'fail-stop',
      count: 1,
      backoffMs: 0,
      reasonCode: 'CROSS_J_LOCAL_EVENT_REJECTED',
    });
  });

  test('recovers transient failures twice and fail-stops on the third identical failure', () => {
    const first = decideChildFailure({}, crash('RPC_RESPONSE_JSON_TRUNCATED'));
    const second = decideChildFailure(first.counts, crash('RPC_RESPONSE_JSON_TRUNCATED'));
    const third = decideChildFailure(second.counts, crash('RPC_RESPONSE_JSON_TRUNCATED'));

    expect(first).toMatchObject({ action: 'recover', count: 1, backoffMs: 2_000 });
    expect(second).toMatchObject({ action: 'recover', count: 2, backoffMs: 4_000 });
    expect(third).toMatchObject({ action: 'fail-stop', count: 3, backoffMs: 6_000 });
    expect(new Set([first.fingerprint, second.fingerprint, third.fingerprint]).size).toBe(1);
  });

  test('tracks distinct failure reasons independently', () => {
    const first = decideChildFailure({}, crash('MESH_BOOTSTRAP_STALLED'));
    const different = decideChildFailure(first.counts, crash('JOURNAL_HASH_MISMATCH'));

    expect(different).toMatchObject({ action: 'recover', count: 1 });
    expect(different.fingerprint).not.toBe(first.fingerprint);
  });

  test('does not merge exits with different process semantics', () => {
    const exit = decideChildFailure({}, crash('RUNTIME_FATAL'));
    const signal = decideChildFailure(exit.counts, { ...crash('RUNTIME_FATAL'), code: null, signal: 'SIGKILL' });

    expect(signal).toMatchObject({ action: 'recover', count: 1 });
    expect(signal.fingerprint).not.toBe(exit.fingerprint);
  });

  test('shutdown signal cannot manufacture child failure receipts', () => {
    expect(shouldCaptureUnexpectedChildExit(false, false, true)).toBe(true);
    expect(shouldCaptureUnexpectedChildExit(true, false, true)).toBe(false);
    expect(shouldCaptureUnexpectedChildExit(false, true, true)).toBe(false);
    expect(shouldCaptureUnexpectedChildExit(false, false, false)).toBe(false);
  });

  test('selects a stable fatal code instead of a trailing stack frame', () => {
    const reason = selectChildFailureReason(
      [
        'Error: J_WATCHER_DRAIN_STALLED:idleMs=120000',
        '    at processTicksAndRejections (native:7:39)',
      ],
      [],
      'MM_UNEXPECTED_EXIT',
    );
    expect(reason).toBe('Error: J_WATCHER_DRAIN_STALLED:idleMs=120000');
    expect(decideChildFailure({}, crash(reason)).reasonCode).toBe('J_WATCHER_DRAIN_STALLED');
  });

  test('classifies a structured truncated RPC response instead of its closing brace', () => {
    const reason = selectChildFailureReason(
      [
        '[network] WS_DIRECT_ERROR {',
        '[JAdapter:rpc] fatal watcher error; exiting: {',
        'message: "Unexpected end of JSON input",',
        '}',
      ],
      [],
      'H3_UNEXPECTED_EXIT',
    );
    expect(reason).toBe('message: "Unexpected end of JSON input",');
    expect(decideChildFailure({}, crash(reason)).reasonCode).toBe('RPC_RESPONSE_JSON_TRUNCATED');
  });

  test('classifies the parent cause before nested health failure codes', () => {
    const reason = 'HUB_BASELINE_STALLED hubs=H1 health={"failures":["MARKET_MAKER_CHILD_INACTIVE"]}';
    expect(decideChildFailure({}, crash(reason)).reasonCode).toBe('HUB_BASELINE_STALLED');
  });

  test('atomically preserves both historical and latest fatal diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-child-failure-'));
    const receipt: ChildFailureReceipt = {
      schema: 'xln-child-failure-v1',
      recordedAt: '2026-07-18T12:00:00.000Z',
      role: 'hub',
      name: 'H2',
      pid: 42,
      code: 1,
      signal: null,
      reason: 'MESH_BOOTSTRAP_STALLED',
      reasonCode: 'MESH_BOOTSTRAP_STALLED',
      fingerprint: 'abc',
      identicalFailureCount: 1,
      action: 'fail-stop',
      backoffMs: 0,
      startedAt: 1,
      exitedAt: 2,
      reset: { inProgress: true },
      codeFingerprint: { gitHead: 'deadbeef' },
      lastHealth: { ok: false },
      lastInfo: null,
      recentStdout: ['before'],
      recentStderr: ['fatal'],
    };
    try {
      const paths = persistChildFailureReceipt(root, receipt, 'unit');
      expect(readFileSync(paths.receiptPath, 'utf8')).toBe(readFileSync(paths.latestPath, 'utf8'));
      expect(readdirSync(root).sort()).toEqual([
        '20260718T120000000Z-H2-unit.json',
        'last-fatal.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recoverable child receipt cannot overwrite the latest fatal diagnosis', () => {
    const root = mkdtempSync(join(tmpdir(), 'xln-child-failure-'));
    const base: ChildFailureReceipt = {
      schema: 'xln-child-failure-v1',
      recordedAt: '2026-07-18T12:00:00.000Z',
      role: 'market-maker',
      name: 'MM',
      pid: 42,
      code: 1,
      signal: null,
      reason: 'MARKET_MAKER_BOOTSTRAP_STALLED',
      reasonCode: 'MARKET_MAKER_BOOTSTRAP_STALLED',
      fingerprint: 'fatal',
      identicalFailureCount: 1,
      action: 'fail-stop',
      backoffMs: 0,
      startedAt: 1,
      exitedAt: 2,
      reset: { inProgress: true },
      codeFingerprint: { gitHead: 'deadbeef' },
      lastHealth: { ok: false },
      lastInfo: null,
      recentStdout: [],
      recentStderr: ['fatal'],
    };
    try {
      const fatal = persistChildFailureReceipt(root, base, 'fatal');
      const fatalPayload = readFileSync(fatal.latestPath, 'utf8');
      persistChildFailureReceipt(root, {
        ...base,
        recordedAt: '2026-07-18T12:00:01.000Z',
        role: 'hub',
        name: 'H1',
        signal: 'SIGINT',
        reason: 'H1_TRANSIENT_EXIT',
        reasonCode: 'H1_TRANSIENT_EXIT',
        fingerprint: 'recover',
        action: 'recover',
        backoffMs: 2_000,
      }, 'recover');

      expect(readFileSync(fatal.latestPath, 'utf8')).toBe(fatalPayload);
      expect(readdirSync(root).sort()).toEqual([
        '20260718T120000000Z-MM-fatal.json',
        '20260718T120001000Z-H1-recover.json',
        'last-fatal.json',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
