import { describe, expect, test } from 'bun:test';
import {
  advanceBootstrapProgress,
  assertBootstrapNotStalled,
  beginBootstrapProgress,
  buildBootstrapProgressHealth,
} from '../orchestrator/bootstrap-progress-watchdog';

describe('bootstrap progress watchdog', () => {
  test('allows long bootstrap work while bounded steps keep completing', () => {
    let progress = beginBootstrapProgress(1_000);
    progress = advanceBootstrapProgress(progress, 'local-reserve:H1:primary-applied', 100_000);
    progress = advanceBootstrapProgress(progress, 'local-reserve:H1:secondary-read:3', 200_000);
    expect(() => assertBootstrapNotStalled(progress, 250_000, 120_000)).not.toThrow();
    expect(buildBootstrapProgressHealth(progress, true, 250_000, 120_000)).toMatchObject({
      active: true,
      idleMs: 50_000,
      totalMs: 249_000,
      stallTimeoutMs: 120_000,
      step: 'local-reserve:H1:secondary-read:3',
    });
  });

  test('fails the exact step after its progress deadline', () => {
    const progress = advanceBootstrapProgress(
      beginBootstrapProgress(1_000),
      'local-reserve:H1:secondary-apply',
      30_000,
    );
    expect(() => assertBootstrapNotStalled(progress, 150_001, 120_000)).toThrow(
      'MESH_BOOTSTRAP_STALLED step=local-reserve:H1:secondary-apply idleMs=120001 totalMs=149001 timeoutMs=120000',
    );
  });

  test('rejects regressed time instead of hiding watchdog corruption', () => {
    const progress = advanceBootstrapProgress(beginBootstrapProgress(1_000), 'rpc-ready', 2_000);
    expect(() => advanceBootstrapProgress(progress, 'rpc-regressed', 1_999)).toThrow(
      'BOOTSTRAP_PROGRESS_TIME_REGRESSED:previous=2000:next=1999',
    );
  });
});
