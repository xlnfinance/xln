import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeChildProcessEnv } from '../../../api/server/child-process-env';
import { buildManagedRuntimeChildSecretEnv, writeInheritedChildSecrets } from '../../../support/process/child-secrets';
import { buildRuntimeChildGcEnv } from '../../../support/process/runtime-gc-env';
import type { Args, ManagedRuntimeSpec, MarketMakerChild } from '../../orchestrator-types';
import { buildPublicDirectWsUrl } from '../../replica-import/runtime-import-manifest';
import {
  flushPrefixedLogChunk,
  pushChildLogLines,
  type PrefixLogState,
  writePrefixedLogChunk,
} from '../child-log-buffer';
import {
  selectChildFailureReason,
  shouldCaptureUnexpectedChildExit,
  type ChildFailureObservation,
} from '../child-recovery-policy';
import { attachManagedChildFatalIpc, type ManagedChildFatalReport } from '../managed-child-fatal-ipc';
import { createManagedRuntimeLeaseManager } from '../managed-runtime-leases';

type LeaseManager = ReturnType<typeof createManagedRuntimeLeaseManager>;

type MarketMakerSpawnerDeps = {
  args: Pick<Args, 'host' | 'publicWsBaseUrl' | 'rpcUrl'>;
  relayUrl: string;
  shardJurisdictionsPath: string;
  orchestratorOwnerId: string;
  startupTimeoutMs: number;
  marketMakerChild: MarketMakerChild;
  buildSecondaryRpcArgs(): string[];
  buildRpcChildEnv(): Record<string, string>;
  getHubSpecsArg(): string;
  managedSpecForMarketMaker(): ManagedRuntimeSpec;
  reapStaleMarketMakerProcess(): Promise<void>;
  resetSupervisedChildForSpawn(child: MarketMakerChild): void;
  managedRuntimeLeases: LeaseManager;
  persistManagedChildFatalReport(child: MarketMakerChild, report: ManagedChildFatalReport): string;
  captureManagedChildErrorLine(child: MarketMakerChild, line: string): void;
  consumeControlledStop(pid: number | null | undefined): boolean;
  isOrchestratorShutdownStarted(): boolean;
  handleUnexpectedMarketMakerFailure(observation: ChildFailureObservation): void;
};

const attachMarketMakerProcess = (
  proc: ChildProcess,
  spec: ManagedRuntimeSpec,
  deps: MarketMakerSpawnerDeps,
): void => {
  const child = deps.marketMakerChild;
  const stdoutPrefixState: PrefixLogState = { pending: '' };
  const stderrPrefixState: PrefixLogState = { pending: '' };
  proc.stdout?.on('data', chunk => {
    pushChildLogLines(child.recentStdout, chunk);
    writePrefixedLogChunk(process.stdout, '[MM]', stdoutPrefixState, chunk);
  });
  proc.stderr?.on('data', chunk => {
    pushChildLogLines(child.recentStderr, chunk);
    writePrefixedLogChunk(
      process.stderr,
      '[MM:err]',
      stderrPrefixState,
      chunk,
      line => deps.captureManagedChildErrorLine(child, line),
    );
  });
  proc.once('exit', (code, signal) => {
    flushPrefixedLogChunk(process.stdout, '[MM]', stdoutPrefixState);
    flushPrefixedLogChunk(
      process.stderr,
      '[MM:err]',
      stderrPrefixState,
      line => deps.captureManagedChildErrorLine(child, line),
    );
    const pid = proc.pid ?? null;
    const controlledStop = deps.consumeControlledStop(pid);
    const isCurrentProc = child.proc === proc;
    deps.managedRuntimeLeases.removeLease(spec, pid);
    if (isCurrentProc) {
      child.exitedAt = Date.now();
      child.exitCode = code ?? null;
      child.exitSignal = signal ?? null;
    }
    if (shouldCaptureUnexpectedChildExit(
      controlledStop,
      deps.isOrchestratorShutdownStarted(),
      isCurrentProc,
    )) {
      deps.handleUnexpectedMarketMakerFailure({
        role: 'market-maker',
        name: child.name,
        code: code ?? null,
        signal: signal ?? null,
        reason: selectChildFailureReason(
          child.recentStderr,
          child.recentStdout,
          `MM_UNEXPECTED_EXIT code=${String(code)} signal=${String(signal)} phase=${String(child.lastStartupPhase)}`,
        ),
      });
    }
  });
};

export const createMarketMakerSpawner = (
  deps: MarketMakerSpawnerDeps,
) => async (): Promise<void> => {
  const child = deps.marketMakerChild;
  await deps.reapStaleMarketMakerProcess();
  mkdirSync(child.dbPath, { recursive: true });
  if (child.restartTimer) clearTimeout(child.restartTimer);
  child.restartTimer = null;
  const spec = deps.managedSpecForMarketMaker();
  const command = [
    'core/orchestrator/mm-node.ts',
    '--name', child.name,
    '--signer-label', child.signerLabel,
    '--relay-url', deps.relayUrl,
    '--api-host', deps.args.host,
    '--api-port', String(child.apiPort),
    '--direct-ws-url', buildPublicDirectWsUrl(deps.args.publicWsBaseUrl, child.publicPort),
    '--rpc-url', deps.args.rpcUrl,
    ...deps.buildSecondaryRpcArgs(),
    '--mesh-hub-names', deps.getHubSpecsArg(),
    '--db-path', child.dbPath,
  ];
  deps.resetSupervisedChildForSpawn(child);
  child.lastStartupPhase = null;
  const proc = spawn('bun', command, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: sanitizeChildProcessEnv({
      ...buildManagedRuntimeChildSecretEnv(process.env),
      ...buildRuntimeChildGcEnv(process.env),
      XLN_DB_PATH: child.dbPath,
      XLN_JURISDICTIONS_PATH: deps.shardJurisdictionsPath,
      ...deps.buildRpcChildEnv(),
      USE_ANVIL: 'true',
      XLN_ORCHESTRATOR_PID: String(process.pid),
      XLN_ORCHESTRATOR_OWNER_ID: deps.orchestratorOwnerId,
      XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(deps.startupTimeoutMs),
      XLN_STORAGE_WRITE_TIMEOUT_MS: process.env['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000',
      XLN_STORAGE_SYNC_WRITES: process.env['XLN_STORAGE_SYNC_WRITES'] ?? '1',
      XLN_DISABLE_RUNTIME_RESTORE:
        process.env['XLN_MARKET_MAKER_DISABLE_RESTORE'] ?? process.env['XLN_DISABLE_RUNTIME_RESTORE'] ?? '0',
      XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL:
        process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL'] ?? join(child.dbPath, 'bootstrap-events.jsonl'),
      XLN_LOG_LEVEL: process.env['XLN_MARKET_MAKER_LOG_LEVEL'] ?? process.env['XLN_LOG_LEVEL'] ?? 'warn',
    }),
  });
  child.proc = proc;
  if (!proc.pid) throw new Error('MM_SPAWN_FAILED_NO_PID');
  attachManagedChildFatalIpc(
    proc,
    report => deps.persistManagedChildFatalReport(child, report),
  );
  await deps.managedRuntimeLeases.writeLease(spec, proc.pid, child.startedAt ?? Date.now());
  attachMarketMakerProcess(proc, spec, deps);
  await writeInheritedChildSecrets(proc, {
    runtimeSeed: child.seed,
    radapterAuthSeed: child.authSeed,
  });
};
