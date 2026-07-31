import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const repoRoot = new URL('../..', import.meta.url).pathname;
const readSource = (path: string): string =>
  path === 'runtime/jurisdiction/adapter/rpc-adapter.ts'
    ? [
        'rpc-public.ts',
        'rpc-adapter.ts',
        'rpc-lifecycle.ts',
        'rpc-reads.ts',
        'rpc-wallet-writes.ts',
        'rpc-watcher-canonical.ts',
        'rpc-watcher-controller.ts',
        'rpc-watcher-ingress.ts',
        'rpc-watcher-poll.ts',
        'rpc-watcher-types.ts',
      ]
        .map(file => readFileSync(`${repoRoot}/runtime/jurisdiction/adapter/${file}`, 'utf8'))
        .join('\n')
    : readFileSync(`${repoRoot}/${path}`, 'utf8');

describe('determinism cleanup lifecycle', () => {
  test('determinism harness stops runtime loop and managed anvil after each run', () => {
    const source = readSource('runtime/scenarios/determinism-test.ts');

    expect(source).toContain("import { stopManagedScenarioAnvil } from './boot'");
    expect(source).toContain('const { closeRuntimeDb, closeInfraDb, stopRuntimeLoopAndWait } = await import');
    expect(source).toContain('await stopRuntimeLoopAndWait(env, 5_000);');
    expect(source).toContain('await stopManagedScenarioAnvil();');
  });

  test('scenario boot exposes an explicit managed anvil shutdown', () => {
    const source = readSource('runtime/scenarios/boot.ts');

    expect(source).toContain('export const stopManagedScenarioAnvil');
    expect(source).toContain('managedAnvil = null;');
    expect(source).toContain('managedAnvilRpc = null;');
    expect(source).toContain("child.kill('SIGTERM')");
    expect(source).toContain("child.kill('SIGKILL')");
    expect(source).toContain('await stopManagedScenarioAnvil();');
    expect(source).toContain('getLiveJAdapterEntries(env)');
  });

  test('rpc adapter close waits for an in-flight watcher poll before returning', () => {
    const source = readSource('runtime/jurisdiction/adapter/rpc-adapter.ts');

    expect(source).toContain('const inFlight = state.inFlight;');
    expect(source).toContain('this.stopWatching();');
    expect(source).toContain('if (inFlight) await inFlight;');
    expect(source).not.toContain('inFlight.catch(() => undefined)');
  });

  test('rpc watcher cancellation keeps in-flight poll tracked and blocks late event ingress', () => {
    const source = readSource('runtime/jurisdiction/adapter/rpc-adapter.ts');
    const stopStart = source.indexOf('stopWatching(): void {');
    const stopEnd = source.indexOf('async stopWatchingAndWait(): Promise<void> {', stopStart);
    const stopSource = source.slice(stopStart, stopEnd);

    expect(source).toContain('const isCancelled = (): boolean =>');
    expect(source).toContain('if (request.isCancelled()) return false;');
    expect(source).toContain("step: 'before-process-event-batch'");
    expect(source).toContain("'before-authenticated-history-range-ingress'");
    expect(source).toContain("'before-authenticated-empty-range-ingress'");
    const historyIngress = source.lastIndexOf('commitAuthenticatedRange(');
    expect(source.lastIndexOf('if (request.isPaused()) {', historyIngress)).toBeGreaterThan(0);
    expect(stopSource).not.toContain('state.inFlight = null;');
  });

  test('determinism check command exits explicitly after a successful gate', () => {
    const source = readSource('runtime/scripts/check-determinism.ts');

    expect(source).toContain('main()');
    expect(source).toContain('.then(() =>');
    expect(source).toContain('process.exit(0);');
    expect(source).toContain('process.exit(1);');
  });

  test('determinism oracle replays external J inputs without masking consensus evidence', () => {
    const source = readSource('runtime/scenarios/determinism-test.ts');
    expect(source).toContain('createJEventTraceTransform(jEventTraceMode, jEventTrace)');
    expect(source).toContain('createJBlockHeadersTraceTransform(jEventTraceMode, jEventTrace)');
    expect(source).toContain('createJHistoryRangeTraceTransform(jEventTraceMode, jEventTrace)');
    expect(source).toContain('return cloneJHistoryRangeIngress(expected);');
    expect(source).not.toContain("'<external-block-hash>'");
    expect(source).not.toContain("'<external-j-event-signature>'");
    expect(source).toContain('logs: snapshot.logs ?? [],');
  });

  test('determinism oracle uses canonical J replica snapshots', () => {
    const source = readSource('runtime/scenarios/determinism-test.ts');
    const projectStart = source.indexOf('const projectJReplicas =');
    const projectEnd = source.indexOf('const snapshotEnvProjection =', projectStart);
    expect(projectStart).toBeGreaterThan(0);
    expect(projectEnd).toBeGreaterThan(projectStart);
    const projectSource = source.slice(projectStart, projectEnd);

    expect(source).toContain("import { buildCanonicalJReplicaSnapshot } from '../storage/wal/snapshot';");
    expect(projectSource).toContain('buildCanonicalJReplicaSnapshot(replica)');
    expect(projectSource).not.toContain('blockNumber: replica.blockNumber');
    expect(projectSource).not.toContain('lastBlockTimestamp: replica.lastBlockTimestamp');
  });

  test('RPC scenarios use explicit polling and a wall-clock-independent chain', () => {
    const rpcSource = readSource('runtime/jurisdiction/adapter/rpc-adapter.ts');
    const bootSource = readSource('runtime/scenarios/boot.ts');

    expect(rpcSource).toContain('manualPolling: env.scenarioMode === true,');
    expect(rpcSource).toContain('if (!session.manualPolling) {');
    expect(bootSource).toContain("'--timestamp', '4102444800'");
  });
});
