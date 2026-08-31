import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEntityEncryptionPublicKey } from '../../../entity/auth/crypto';
import { safeStringify } from '../../../protocol/serialization';
import { canonicalEntitySeed } from '../../../runtime/registration/entity-creation';
import { deriveEntityEncryptionPrivateKey } from '../../../runtime/registration/entity-creation/crypto';
import { sanitizeChildProcessEnv } from '../../../api/server/child-process-env';
import { writeInheritedChildSecrets } from '../../../support/process/child-secrets';
import { deriveManagedEntityIdentity } from '../../daemon-control';
import type { Args, HubChild, ManagedRuntimeSpec, MarketMakerChild } from '../../orchestrator-types';
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
import { buildRustHubProcessPlan, parseRustHubStatus } from '../hub-engine-plan';
import {
  buildRustHubGenesisConfig,
  resolveRustHubGenesisEntitySigners,
} from '../rust-hub-genesis';
import { createManagedRuntimeLeaseManager } from '../managed-runtime-leases';

type MarketMakerSupportPeerIdentity = {
  entityId: string;
  signerId: string;
};

type RustIdentity = ReturnType<typeof deriveManagedEntityIdentity>;
type LeaseManager = ReturnType<typeof createManagedRuntimeLeaseManager>;

export type HubSpawnerDeps = {
  args: Pick<Args, 'host' | 'publicWsBaseUrl' | 'rpcUrl' | 'rpcUrls'>;
  relayUrl: string;
  shardJurisdictionsPath: string;
  orchestratorOwnerId: string;
  startupTimeoutMs: number;
  hubChildren: readonly HubChild[];
  marketMakerChild: Pick<MarketMakerChild, 'seed'>;
  getHubSpecsArg(): string;
  getMarketMakerIdentities(): MarketMakerSupportPeerIdentity[];
  runtimeSeedFor(name: string): string;
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
  rustIdentity: RustIdentity | null;
};

const buildRustHubInvocation = (
  child: HubChild,
  deps: HubSpawnerDeps,
  rustIdentity: RustIdentity,
): HubInvocation => {
  const runtimeSeedFile = join(child.dbPath, 'runtime.seed');
  const entityKeyFile = join(child.dbPath, 'entity-encryption.key');
  const routesFile = join(child.dbPath, 'entity-routes.json');
  const genesisFile = join(child.dbPath, 'rscore-genesis.json');
  const custodySeed = Buffer.from(canonicalEntitySeed(child.seed).slice(2), 'hex');
  const entityEncryptionPrivateKey = deriveEntityEncryptionPrivateKey(
    custodySeed,
    rustIdentity.entityId,
  );
  writeFileSync(runtimeSeedFile, `${child.seed}\n`, { mode: 0o600 });
  writeFileSync(entityKeyFile, `${entityEncryptionPrivateKey}\n`, { mode: 0o600 });
  const hubRoutes = deps.hubChildren
    .filter(peer => peer.name !== child.name)
    .map(peer => {
      const identity = deriveManagedEntityIdentity({
        name: peer.name,
        seed: peer.seed,
        signerLabel: peer.signerLabel,
      });
      return {
        targetEntityId: identity.entityId,
        targetRuntimeId: deriveSignerAddressSync(peer.seed, '1').toLowerCase(),
        targetSignerId: identity.signerId,
        websocketUrl: null,
      };
    });
  const marketMakerRuntimeId = deriveSignerAddressSync(deps.marketMakerChild.seed, '1').toLowerCase();
  const supportRoutes = deps.getMarketMakerIdentities().map(identity => ({
    targetEntityId: identity.entityId,
    targetRuntimeId: marketMakerRuntimeId,
    targetSignerId: identity.signerId,
    websocketUrl: null,
  }));
  const custodyRuntimeSeed = deps.runtimeSeedFor('CUSTODY');
  const custodyIdentity = deriveManagedEntityIdentity({
    name: 'Custody',
    seed: custodyRuntimeSeed,
    signerLabel: 'custody-mesh-1',
  });
  const routes = [...hubRoutes, ...supportRoutes, {
    targetEntityId: custodyIdentity.entityId,
    targetRuntimeId: deriveSignerAddressSync(`${custodyRuntimeSeed}:runtime`, '1').toLowerCase(),
    targetSignerId: custodyIdentity.signerId,
    websocketUrl: null,
  }];
  writeFileSync(routesFile, `${safeStringify(routes)}\n`, { mode: 0o600 });
  const jurisdictionsJson = readFileSync(deps.shardJurisdictionsPath, 'utf8');
  const entityEncryptionPublicKeys = Object.fromEntries(
    resolveRustHubGenesisEntitySigners(jurisdictionsJson, child.signerLabel).map(binding => {
      const identity = deriveManagedEntityIdentity({
        name: child.name,
        seed: child.seed,
        signerLabel: binding.signerLabel,
      });
      const privateKey = deriveEntityEncryptionPrivateKey(custodySeed, identity.entityId);
      return [
        binding.jurisdictionName,
        deriveEntityEncryptionPublicKey(privateKey, identity.entityId),
      ];
    }),
  );
  const genesis = buildRustHubGenesisConfig({
    name: child.name,
    runtimeId: deriveSignerAddressSync(child.seed, '1').toLowerCase(),
    primaryEntitySignerLabel: child.signerLabel,
    entityEncryptionPublicKeys,
    jurisdictionsJson,
    rpcUrls: deps.args.rpcUrls,
    minFrameDelayMs: Math.max(0, Number(process.env['XLN_HUB_MIN_FRAME_DELAY_MS'] || '0')),
  });
  writeFileSync(genesisFile, `${safeStringify(genesis)}\n`, { mode: 0o600 });
  const plan = buildRustHubProcessPlan({
    name: child.name,
    apiHost: deps.args.host,
    apiPort: child.apiPort,
    directHost: deps.args.host,
    directPort: child.publicPort,
    dbPath: child.dbPath,
    runtimeSeedFile,
    entityKeyFile,
    routesFile,
    genesisFile,
    jurisdictionsPath: deps.shardJurisdictionsPath,
    runtimeSignerLabel: '1',
    entitySignerLabel: child.signerLabel,
    primaryEntityId: rustIdentity.entityId,
    workers: Number(process.env['XLN_RSCORE_AUTHORITY_WORKERS'] || '8'),
    ...(process.env['XLN_RSCORE_BINARY']
      ? { binary: process.env['XLN_RSCORE_BINARY'] }
      : {}),
  });
  return { executable: plan.executable, processArgs: plan.args, rustIdentity };
};

const buildHubInvocation = (child: HubChild, deps: HubSpawnerDeps): HubInvocation => {
  const engineArgs = buildHubEngineArgs(child.name);
  const processArgs = [
    ...engineArgs,
    'core/orchestrator/hub-node.ts',
    '--name', child.name,
    '--region', child.region,
    '--signer-label', child.signerLabel,
    '--relay-url', deps.relayUrl,
    '--api-host', deps.args.host,
    '--api-port', String(child.apiPort),
    '--direct-ws-url', buildPublicDirectWsUrl(deps.args.publicWsBaseUrl, child.publicPort),
    '--rpc-url', deps.args.rpcUrl,
    ...deps.buildSecondaryRpcArgs(),
    '--mesh-hub-names', deps.getHubSpecsArg(),
    '--support-peer-identities-json', safeStringify(deps.getMarketMakerIdentities()),
    '--db-path', child.dbPath,
    ...(child.deployTokens ? ['--deploy-tokens'] : []),
  ];
  const rustIdentity = child.engine === 'rust'
    ? deriveManagedEntityIdentity({ name: child.name, seed: child.seed, signerLabel: child.signerLabel })
    : null;
  return rustIdentity
    ? buildRustHubInvocation(child, deps, rustIdentity)
    : { executable: 'bun', processArgs, rustIdentity: null };
};

const projectRustHubStatus = (
  child: HubChild,
  rustIdentity: RustIdentity,
  line: string,
  deps: HubSpawnerDeps,
): void => {
  const status = parseRustHubStatus(line);
  if (!status) return;
  if (status.status === 'ready') {
    child.lastInfo = {
      name: child.name,
      entityId: rustIdentity.entityId,
      hubEntities: [{
        entityId: rustIdentity.entityId,
        signerId: rustIdentity.signerId,
        name: child.name,
        primary: true,
      }],
      ...(status.runtimeId ? { runtimeId: status.runtimeId } : {}),
      apiUrl: `http://${deps.args.host}:${String(child.apiPort)}`,
      relayUrl: deps.relayUrl,
      directWsUrl: `ws://${status.listen}/ws`,
    };
  }
  child.lastHealth = {
    ...(child.lastHealth ?? {}),
    ok: true,
    name: child.name,
    height: status.height,
    entityId: rustIdentity.entityId,
    runtimeId: status.runtimeId ?? child.lastHealth?.runtimeId ?? null,
    runtime: { halted: false, lifecyclePhase: status.status },
    gossip: { ready: false, visibleHubNames: [], visibleHubIds: [] },
    mesh: { ready: false, pairs: [] },
  };
};

const attachHubProcess = (
  child: HubChild,
  proc: ChildProcess,
  rustIdentity: RustIdentity | null,
  spec: ManagedRuntimeSpec,
  deps: HubSpawnerDeps,
): void => {
  const stdoutPrefixState: PrefixLogState = { pending: '' };
  const stderrPrefixState: PrefixLogState = { pending: '' };
  let rustStatusPending = '';
  proc.stdout?.on('data', chunk => {
    pushChildLogLines(child.recentStdout, chunk);
    if (rustIdentity) {
      rustStatusPending += String(chunk);
      const lines = rustStatusPending.split(/\r?\n/);
      rustStatusPending = lines.pop() ?? '';
      for (const line of lines) projectRustHubStatus(child, rustIdentity, line, deps);
    }
    writePrefixedLogChunk(process.stdout, `[${child.name}]`, stdoutPrefixState, chunk);
  });
  proc.stderr?.on('data', chunk => {
    pushChildLogLines(child.recentStderr, chunk);
    writePrefixedLogChunk(
      process.stderr,
      `[${child.name}:err]`,
      stderrPrefixState,
      chunk,
      line => deps.captureManagedChildErrorLine(child, line),
    );
  });
  proc.once('exit', (code, signal) => {
    flushPrefixedLogChunk(process.stdout, `[${child.name}]`, stdoutPrefixState);
    flushPrefixedLogChunk(
      process.stderr,
      `[${child.name}:err]`,
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
      deps.handleUnexpectedHubFailure(child, {
        role: 'hub',
        name: child.name,
        code: code ?? null,
        signal: signal ?? null,
        reason: selectChildFailureReason(
          child.recentStderr,
          child.recentStdout,
          `${child.name}_UNEXPECTED_EXIT code=${String(code)} signal=${String(signal)}`,
        ),
      });
    }
  });
};

export const createHubSpawner = (deps: HubSpawnerDeps) => async (child: HubChild): Promise<void> => {
  await deps.reapStaleHubProcess(child);
  mkdirSync(child.dbPath, { recursive: true });
  if (child.restartTimer) clearTimeout(child.restartTimer);
  child.restartTimer = null;
  const spec = deps.managedSpecForHub(child);
  const invocation = buildHubInvocation(child, deps);
  deps.resetSupervisedChildForSpawn(child);
  const proc = spawn(invocation.executable, invocation.processArgs, {
    cwd: process.cwd(),
    stdio: invocation.rustIdentity ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'ipc'],
    env: sanitizeChildProcessEnv(buildHubChildProcessEnv({
      hubName: child.name,
      dbPath: child.dbPath,
      brainvaultOwnerPath: join(child.dbPath, 'brainvault-owner.json'),
      jurisdictionsPath: deps.shardJurisdictionsPath,
      rpcEnv: deps.buildRpcChildEnv(),
      orchestratorPid: process.pid,
      orchestratorOwnerId: deps.orchestratorOwnerId,
      startupTimeoutMs: deps.startupTimeoutMs,
      hubDelayMs: process.env['XLN_HUB_MIN_FRAME_DELAY_MS'],
    })),
  });
  child.proc = proc;
  if (!proc.pid) throw new Error(`${child.name}_SPAWN_FAILED_NO_PID`);
  if (!invocation.rustIdentity) {
    attachManagedChildFatalIpc(proc, report => deps.persistManagedChildFatalReport(child, report));
  }
  await deps.managedRuntimeLeases.writeLease(spec, proc.pid, child.startedAt ?? Date.now());
  attachHubProcess(child, proc, invocation.rustIdentity, spec, deps);
  await writeInheritedChildSecrets(proc, {
    runtimeSeed: child.seed,
    radapterAuthSeed: child.authSeed,
  });
};
