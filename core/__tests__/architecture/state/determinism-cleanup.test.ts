import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const repoRoot = new URL('../../../..', import.meta.url).pathname;
const readSource = (path: string): string =>
  path === 'core/jurisdiction/adapter/rpc/rpc-adapter.ts'
    ? [
        'rpc-public.ts',
        'rpc/rpc-adapter.ts',
        'rpc/rpc-lifecycle.ts',
        'rpc/rpc-reads.ts',
        'rpc/wallet/rpc-wallet-writes.ts',
        'rpc/watcher/rpc-watcher-canonical.ts',
        'rpc/watcher/rpc-watcher-controller.ts',
        'rpc/watcher/rpc-watcher-ingress.ts',
        'rpc/watcher/rpc-watcher-poll.ts',
        'rpc/watcher/rpc-watcher-types.ts',
      ]
        .map(file => readFileSync(`${repoRoot}/core/jurisdiction/adapter/${file}`, 'utf8'))
        .join('\n')
    : readFileSync(`${repoRoot}/${path}`, 'utf8');

describe('determinism cleanup lifecycle', () => {
  test('determinism harness stops runtime loop and managed anvil after each run', () => {
    const source = readSource('core/scenarios/runner/determinism.ts');

    expect(source).toContain("import { stopManagedScenarioAnvil } from '../harness/boot'");
    expect(source).toContain('const { closeRuntimeDb, closeInfraDb, stopRuntimeLoopAndWait } = await import');
    expect(source).toContain('await stopRuntimeLoopAndWait(env, 5_000);');
    expect(source).toContain('await stopManagedScenarioAnvil();');
  });

  test('scenario boot exposes an explicit managed anvil shutdown', () => {
    const source = readSource('core/scenarios/harness/boot.ts');

    expect(source).toContain('export const stopManagedScenarioAnvil');
    expect(source).toContain('const managedAnvils = new Map<string, ManagedAnvilProcess>()');
    expect(source).toContain('managedAnvils.delete(url)');
    expect(source).toContain("child.kill('SIGTERM')");
    expect(source).toContain("child.kill('SIGKILL')");
    expect(source).toContain('await stopManagedScenarioAnvil(3_000, rpcUrl)');
    expect(source).toContain('getLiveJAdapterEntries(env)');
  });

  test('rpc adapter close waits for an in-flight watcher poll before returning', () => {
    const source = readSource('core/jurisdiction/adapter/rpc/rpc-adapter.ts');

    expect(source).toContain('const inFlight = state.inFlight;');
    expect(source).toContain('this.stopWatching();');
    expect(source).toContain('if (inFlight) await inFlight;');
    expect(source).not.toContain('inFlight.catch(() => undefined)');
  });

  test('rpc watcher cancellation keeps in-flight poll tracked and blocks late event ingress', () => {
    const source = readSource('core/jurisdiction/adapter/rpc/rpc-adapter.ts');
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
    const source = readSource('core/scripts/checks/architecture/check-determinism.ts');

    expect(source).toContain('main()');
    expect(source).toContain('.then(() =>');
    expect(source).toContain('process.exit(0);');
    expect(source).toContain('process.exit(1);');
  });

  test('determinism oracle records accepted WAL inputs instead of repeating external submissions', () => {
    const source = readSource('core/scenarios/runner/determinism.ts');
    const replay = readSource('core/scenarios/runner/recorded-replay.ts');
    expect(source).toContain('buildPersistedRuntimeRecording(activeEnv');
    expect(source).toContain('replayRecordedScenario(recording, runtimeSeed, 1, directory)');
    expect(source).toContain('replayRecordedScenario(recording, runtimeSeed, 4, directory)');
    expect(source).not.toContain('setJEventIngressTransform');
    expect(replay).toContain('replayRecoveryFrameJournals(env, [frame], { verify: true })');
    expect(replay).toContain('finishRuntimeParityEvidence(env)');
    expect(replay).not.toContain('submitPreparedJBatch');
    expect(replay).not.toContain("'<external-block-hash>'");
    expect(replay).not.toContain("'<external-j-event-signature>'");
  });

  test('determinism replay preserves complete canonical checkpoint and first divergent frame evidence', () => {
    const source = readSource('core/scenarios/runner/recorded-replay.ts');
    expect(source).toContain('validateRuntimeRecording(recording)');
    expect(source).toContain('actual: buildRuntimeRecoveryCheckpointSnapshot(env)');
    expect(source).toContain('expected: frame');
    expect(source).toContain('computeCanonicalStateHashFromEnv(env)');
  });

  test('RPC scenarios use explicit polling and a wall-clock-independent chain', () => {
    const rpcSource = readSource('core/jurisdiction/adapter/rpc/rpc-adapter.ts');
    const bootSource = readSource('core/scenarios/harness/boot.ts');

    expect(rpcSource).toContain('manualPolling: env.scenarioMode === true,');
    expect(rpcSource).toContain('if (!session.manualPolling) {');
    expect(bootSource).toContain("'--timestamp', '4102444800'");
    expect(bootSource).toContain("await provider.send('anvil_setBlockTimestampInterval', [1])");
  });

  test('dispute transformer pins the economically relevant RPC block before broadcasting', () => {
    const source = readSource('core/scenarios/disputes/transformer.ts');
    const debugMarker = source.indexOf('DISPUTE_DEBUG:before-start-broadcast');
    const timestampPin = source.indexOf('pinScenarioJurisdictionUnix(', debugMarker);
    const startBroadcast = source.indexOf("entityTxs: [{ type: 'j_broadcast'", debugMarker);

    expect(debugMarker).toBeGreaterThan(0);
    expect(timestampPin).toBeGreaterThan(debugMarker);
    expect(startBroadcast).toBeGreaterThan(timestampPin);
  });
});
