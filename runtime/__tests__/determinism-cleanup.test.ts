import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const repoRoot = new URL('../..', import.meta.url).pathname;
const readSource = (path: string): string => readFileSync(`${repoRoot}/${path}`, 'utf8');

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
    expect(source).toContain('env.jAdapter = jadapter;');
  });

  test('rpc adapter close waits for an in-flight watcher poll before returning', () => {
    const source = readSource('runtime/jadapter/rpc.ts');

    expect(source).toContain('const inFlightWatcherPoll = pollInFlight;');
    expect(source).toContain('adapter.stopWatching();');
    expect(source).toContain('if (inFlightWatcherPoll) await inFlightWatcherPoll;');
    expect(source).not.toContain('inFlightWatcherPoll.catch(() => undefined)');
  });

  test('rpc watcher cancellation keeps in-flight poll tracked and blocks late event ingress', () => {
    const source = readSource('runtime/jadapter/rpc.ts');
    const stopStart = source.indexOf('stopWatching(): void {');
    const stopEnd = source.indexOf('getBrowserVM(): BrowserVMProvider | null', stopStart);
    const stopSource = source.slice(stopStart, stopEnd);

    expect(source).toContain('const watcherPollCancelled = (): boolean =>');
    expect(source).toContain('if (watcherPollCancelled()) return;');
    expect(source).toContain("step: 'before-process-event-batch'");
    expect(source).toContain("step: 'before-authenticated-history-range-ingress'");
    expect(source).toContain("step: 'before-authenticated-empty-range-ingress'");
    const historyIngress = source.indexOf('const rangeReplicaKeys = enqueueJHistoryRange(');
    const emptyIngress = source.indexOf('const rangeReplicaKeys = enqueueJHistoryRange(', historyIngress + 1);
    expect(source.lastIndexOf('if (isJEventIngressPaused(activeEnv)) {', historyIngress)).toBeGreaterThan(0);
    expect(source.lastIndexOf('if (isJEventIngressPaused(activeEnv)) {', emptyIngress)).toBeGreaterThan(historyIngress);
    expect(stopSource).not.toContain('pollInFlight = null;');
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

    expect(source).toContain("import { buildCanonicalJReplicaSnapshot } from '../wal/snapshot';");
    expect(projectSource).toContain('buildCanonicalJReplicaSnapshot(replica)');
    expect(projectSource).not.toContain('blockNumber: replica.blockNumber');
    expect(projectSource).not.toContain('lastBlockTimestamp: replica.lastBlockTimestamp');
  });

  test('RPC scenarios use explicit polling and a wall-clock-independent chain', () => {
    const rpcSource = readSource('runtime/jadapter/rpc.ts');
    const bootSource = readSource('runtime/scenarios/boot.ts');

    expect(rpcSource).toContain("const manualPolling = env.scenarioMode === true;");
    expect(rpcSource).toContain("if (!manualPolling) {");
    expect(bootSource).toContain("'--timestamp', '4102444800'");
  });
});
