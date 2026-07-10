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
    expect(source).toContain('inFlightWatcherPoll.catch(() => undefined)');
    expect(source).toContain('setTimeout(resolve, 2_500)');
  });

  test('rpc watcher cancellation keeps in-flight poll tracked and blocks late event ingress', () => {
    const source = readSource('runtime/jadapter/rpc.ts');
    const stopStart = source.indexOf('stopWatching(): void {');
    const stopEnd = source.indexOf('getBrowserVM(): BrowserVMProvider | null', stopStart);
    const stopSource = source.slice(stopStart, stopEnd);

    expect(source).toContain('const watcherPollCancelled = (): boolean =>');
    expect(source).toContain('if (watcherPollCancelled()) return;');
    expect(source).toContain("step: 'before-process-event-batch'");
    expect(stopSource).not.toContain('pollInFlight = null;');
  });

  test('determinism check command exits explicitly after a successful gate', () => {
    const source = readSource('runtime/scripts/check-determinism.ts');

    expect(source).toContain('main()');
    expect(source).toContain('.then(() =>');
    expect(source).toContain('process.exit(0);');
    expect(source).toContain('process.exit(1);');
  });

  test('determinism oracle masks external j-event block metadata', () => {
    const source = readSource('runtime/scenarios/determinism-test.ts');
    const normalizeStart = source.indexOf('const normalizeOracleValue =');
    const normalizeEnd = source.indexOf('const toOracleValue =', normalizeStart);
    expect(normalizeStart).toBeGreaterThan(0);
    expect(normalizeEnd).toBeGreaterThan(normalizeStart);
    const normalizeSource = source.slice(normalizeStart, normalizeEnd);

    expect(normalizeSource).toContain("normalized[key] = '<external-block-hash>';");
    expect(normalizeSource).toContain("normalized[key] = '<external-block-number>';");
    expect(normalizeSource).toContain("normalized[key] = '<external-j-event-signature>';");
    expect(normalizeSource).toContain("if (isJEventObservation && key === 'blockNumber')");
    expect(source).toContain('const normalizeFrameLogsForOracle =');
    expect(source).toContain("if (key === 'blockNumber' || key === 'jBlockNumber')");
    expect(source).toContain('logs: normalizeFrameLogsForOracle(snapshot.logs),');
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
});
