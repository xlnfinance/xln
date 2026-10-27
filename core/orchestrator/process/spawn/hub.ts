import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';
import { sanitizeChildProcessEnv } from '../../../api/server/child-process-env';
import { writeInheritedChildSecrets } from '../../../support/process/child-secrets';
import type { ManagedPeerIdentity } from '../../market-maker/identity-resolver';
import type { Args, HubChild, ManagedRuntimeSpec } from '../../orchestrator-types';
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
import { buildHubChildProcessEnv, buildHubEngineArgs } from '../hub-runtime-env';
import { canonicalHubEngine } from '../hub-engine-plan';
import { createManagedRuntimeLeaseManager } from '../managed-runtime-leases';

type LeaseManager = ReturnType<typeof createManagedRuntimeLeaseManager>;

export type HubSpawnerDeps = {
  args: Pick<Args, 'host' | 'publicWsBaseUrl' | 'rpcUrl' | 'rpcUrls' | 'manualDisputeHub'>;
  relayUrl: string;
  shardJurisdictionsPath: string;
  orchestratorOwnerId: string;
  startupTimeoutMs: number;
  getHubIdentities(): ManagedPeerIdentity[];
  getMarketMakerIdentities(): ManagedPeerIdentity[];
  buildSecondaryRpcArgs(): string[];
  buildRpcChildEnv(): Record<string, string>;
  managedSpecForHub(child: HubChild): ManagedRuntimeSpec;
  reapStaleHubProcess(child: HubChild): Promise<void>;
  resetSupervisedChildForSpawn(child: HubChild): void;
  managedRuntimeLeases: LeaseManager;
  persistManagedChildFatalReport(child: HubChild, report: ManagedChildFatalReport): string;
  captureManagedChildErrorLine(child: HubChild, line: string): void;
  consumeControlledStop(pid: number | null | undefined): boolean;
  isOrchestratorShutdownStarted(): boolean;
  handleUnexpectedHubFailure(child: HubChild, observation: ChildFailureObservation): void;
};

type HubInvocation = {
  executable: string;
  processArgs: readonly string[];
};

const buildHubInvocation = (child: HubChild, deps: HubSpawnerDeps): HubInvocation => {
  const engineArgs = buildHubEngineArgs(child.name);
  const processArgs = [
    ...engineArgs,
    'core/orchestrator/hub-node.ts',
    '--name',
    child.name,
    '--region',
    child.region,
    '--signer-label',
    child.signerLabel,
    '--relay-url',
    deps.relayUrl,
    '--api-host',
    deps.args.host,
    '--api-port',
    String(child.apiPort),
    '--direct-ws-url',
    buildPublicDirectWsUrl(deps.args.publicWsBaseUrl, child.publicPort),
    '--rpc-url',
    deps.args.rpcUrl,
    ...deps.buildSecondaryRpcArgs(),
    '--hub-identities-json',
    safeStringify(deps.getHubIdentities()),
    '--support-peer-identities-json',
    safeStringify(deps.getMarketMakerIdentities()),
    '--db-path',
    child.dbPath,
    ...(child.deployTokens ? ['--deploy-tokens'] : []),
    ...(child.name === deps.args.manualDisputeHub ? ['--manual-dispute-finalize'] : []),
  ];
  return { executable: 'bun', processArgs };
};

const attachHubProcess = (
  child: HubChild,
  proc: ChildProcess,
  spec: ManagedRuntimeSpec,
  deps: HubSpawnerDeps,
): void => {
  const stdoutPrefixState: PrefixLogState = { pending: '' };
  const stderrPrefixState: PrefixLogState = { pending: '' };
  proc.stdout?.on('data', chunk => {
    pushChildLogLines(child.recentStdout, chunk);
    writePrefixedLogChunk(process.stdout, `[${child.name}]`, stdoutPrefixState, chunk);
  });
  proc.stderr?.on('data', chunk => {
    pushChildLogLines(child.recentStderr, chunk);
    writePrefixedLogChunk(process.stderr, `[${child.name}:err]`, stderrPrefixState, chunk, line =>
      deps.captureManagedChildErrorLine(child, line),
    );
  });
  proc.once('exit', (code, signal) => {
    flushPrefixedLogChunk(process.stdout, `[${child.name}]`, stdoutPrefixState);
    flushPrefixedLogChunk(process.stderr, `[${child.name}:err]`, stderrPrefixState, line =>
      deps.captureManagedChildErrorLine(child, line),
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
    if (shouldCaptureUnexpectedChildExit(controlledStop, deps.isOrchestratorShutdownStarted(), isCurrentProc)) {
      deps.handleUnexpectedHubFailure(child, {
        role: 'hub',
        name: child.name,
        code: code ?? null,
        signal: signal ?? null,
        reason: selectChildFailureReason(
          child.recentStderr,
          child.recentStdout,
          `${child.name}_UNEXPECTED_EXIT code=${String(code)} signal=${String(signal)}`,
          signal ?? null,
        ),
      });
    }
  });
};

export const createHubSpawner =
  (deps: HubSpawnerDeps) =>
  async (child: HubChild): Promise<void> => {
    const engine = canonicalHubEngine(child.name);
    if (child.engine !== engine) throw new Error(`HUB_ENGINE_SELECTION_MISMATCH:${child.name}:${child.engine}`);
    await deps.reapStaleHubProcess(child);
    mkdirSync(child.dbPath, { recursive: true });
    if (child.restartTimer) clearTimeout(child.restartTimer);
    child.restartTimer = null;
    const spec = deps.managedSpecForHub(child);
    const invocation = buildHubInvocation(child, deps);
    deps.resetSupervisedChildForSpawn(child);
    const proc = spawn(invocation.executable, invocation.processArgs, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: sanitizeChildProcessEnv(
        buildHubChildProcessEnv({
          hubName: child.name,
          dbPath: child.dbPath,
          brainvaultOwnerPath: join(child.dbPath, 'brainvault-owner.json'),
          jurisdictionsPath: deps.shardJurisdictionsPath,
          rpcEnv: deps.buildRpcChildEnv(),
          orchestratorPid: process.pid,
          orchestratorOwnerId: deps.orchestratorOwnerId,
          startupTimeoutMs: deps.startupTimeoutMs,
        }),
      ),
    });
    child.proc = proc;
    if (!proc.pid) throw new Error(`${child.name}_SPAWN_FAILED_NO_PID`);
    attachManagedChildFatalIpc(proc, report => deps.persistManagedChildFatalReport(child, report));
    await deps.managedRuntimeLeases.writeLease(spec, proc.pid, child.startedAt ?? Date.now());
    attachHubProcess(child, proc, spec, deps);
    await writeInheritedChildSecrets(proc, {
      runtimeSeed: child.seed,
      radapterAuthSeed: child.authSeed,
    });
  };
