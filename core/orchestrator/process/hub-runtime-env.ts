import { buildManagedRuntimeChildSecretEnv } from '../../support/process/child-secrets';
import { buildRuntimeChildGcEnv } from '../../support/process/runtime-gc-env';
import { resolveRuntimeMinFrameDelayMs } from '../../runtime/config/frame-cadence';

const RUNTIME_FRAME_DELAY_KEY = 'XLN_RUNTIME_MIN_FRAME_DELAY_MS';

/**
 * Resolve the one Runtime frame delay before genesis. Bootstrap and steady load
 * must not install different scheduler policies: the committed Runtime config
 * is the sole source read by both TypeScript and Rust.
 */
export const resolveHubRuntimeFrameDelayMs = (env: NodeJS.ProcessEnv): number =>
  resolveRuntimeMinFrameDelayMs(env[RUNTIME_FRAME_DELAY_KEY], true);

const HUB_PASSTHROUGH_ENV_KEYS = [
  // Account worker-pool size for the Hub's TypeScript executor. An operator
  // must be able to pin it (1 isolates a suspected parallelism defect, 0
  // selects the inline transition) without editing the orchestrator.
  'XLN_TS_ACCOUNT_WORKERS',
  'XLN_RUNTIME_APPLY_PROFILE',
  'XLN_ENTITY_FRAME_PROFILE',
  'XLN_RUNTIME_PROCESS_PROFILE',
  'XLN_RSCORE_PROFILE_ENTITY',
  'XLN_RSCORE_PROFILE_PROJECTION',
  'XLN_RUNTIME_OP_COUNTERS',
  'XLN_RUNTIME_OP_COUNTERS_DIR',
  'XLN_ENTITY_PROPOSAL_TRACE',
  'XLN_HEAVY_LOGS',
  'XLN_LOG_FORMAT',
  'XLN_ENTITY_STATE_ROOT_PROFILE',
  'XLN_HLT_ENGINE',
  'XLN_MESH_PRIMARY_JURISDICTION_ONLY',
] as const;

// Canonical H1 Runtime intake caps. The authority recorder needs a deeper WAL,
// but its frame policy must not leak into independent H2/H3 Runtime owners.
const H1_RUNTIME_CAP_ENV_KEYS = [
  'XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME',
  'XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME',
] as const;

export const buildHubEngineArgs = (
  hubName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] => String(env[`XLN_HUB_ENGINE_ARGS_${hubName.toUpperCase()}`] ?? '')
  .split(' ')
  .map(part => part.trim())
  .filter(Boolean);

type HubChildProcessEnvOptions = Readonly<{
  hubName: string;
  dbPath: string;
  brainvaultOwnerPath: string;
  jurisdictionsPath: string;
  rpcEnv: Readonly<Record<string, string>>;
  orchestratorPid: number;
  orchestratorOwnerId: string;
  startupTimeoutMs: number;
  sourceEnv?: NodeJS.ProcessEnv;
}>;

/** Build the exact environment inherited by one supervised Hub process. */
export const buildHubChildProcessEnv = (
  options: HubChildProcessEnvOptions,
): NodeJS.ProcessEnv => {
  const source = options.sourceEnv ?? process.env;
  const child: NodeJS.ProcessEnv = {
    ...buildManagedRuntimeChildSecretEnv(source),
    ...buildRuntimeChildGcEnv(source),
    XLN_DB_PATH: options.dbPath,
    XLN_BRAINVAULT_OWNER_PATH: options.brainvaultOwnerPath,
    XLN_JURISDICTIONS_PATH: options.jurisdictionsPath,
    ...options.rpcEnv,
    USE_ANVIL: 'true',
    XLN_ORCHESTRATOR_PID: String(options.orchestratorPid),
    XLN_ORCHESTRATOR_OWNER_ID: options.orchestratorOwnerId,
    XLN_HUB_NAME: options.hubName.toUpperCase(),
    XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(options.startupTimeoutMs),
    XLN_RUNTIME_MIN_FRAME_DELAY_MS: String(resolveHubRuntimeFrameDelayMs(source)),
    XLN_STORAGE_WRITE_TIMEOUT_MS: source['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000',
    XLN_LOG_LEVEL: source['XLN_HUB_LOG_LEVEL'] ?? source['XLN_LOG_LEVEL'] ?? 'warn',
  };
  if (source['XLN_HLT_AUTHORITY_EVIDENCE'] === '1') {
    // Evidence export is owned by TS H1. Do not leak its output path or
    // materialization policy into sibling Runtime processes.
    delete child['XLN_HLT_AUTHORITY_EVIDENCE'];
    delete child['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH'];
    delete child['XLN_STORAGE_MATERIALIZE_PERIOD_FRAMES'];
    delete child['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'];
  }
  if (source[`XLN_HUB_RSCORE_AUTHORITY_${options.hubName.toUpperCase()}`] === '1') {
    child['XLN_RSCORE_AUTHORITY'] = '1';
    if (source['XLN_RSCORE_BINARY']) {
      child['XLN_RSCORE_BINARY'] = source['XLN_RSCORE_BINARY'];
    }
    if (source['XLN_RSCORE_AUTHORITY_WORKERS']) {
      child['XLN_RSCORE_AUTHORITY_WORKERS'] = source['XLN_RSCORE_AUTHORITY_WORKERS'];
    }
    if (source['XLN_RSCORE_AUTHORITY_RECORD']) {
      child['XLN_RSCORE_AUTHORITY_RECORD'] = source['XLN_RSCORE_AUTHORITY_RECORD'];
    }
  }
  if (
    options.hubName.toUpperCase() === 'H1' &&
    source['XLN_HLT_AUTHORITY_EVIDENCE'] === '1' &&
    source['XLN_HLT_ENGINE'] === 'ts'
  ) {
    const outputPath = String(source['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH'] ?? '').trim();
    if (!outputPath) throw new Error('HLT_PARITY_CHECKPOINT_OUTPUT_REQUIRED');
    // The parity base is captured by one explicit checkpointBarrier frame.
    // Ordinary economic frames retain the production materialization cadence.
    child['XLN_HLT_AUTHORITY_EVIDENCE'] = '1';
    child['XLN_RUNTIME_SNAPSHOT_EXPORT_PATH'] = outputPath;
    // Replay compares the canonical Runtime root at every WAL height.
    child['XLN_STORAGE_CANONICAL_HASH_PERIOD_FRAMES'] = '1';
  }
  for (const key of HUB_PASSTHROUGH_ENV_KEYS) {
    if (source[key]) child[key] = source[key];
  }
  if (options.hubName.toUpperCase() === 'H1') {
    for (const key of H1_RUNTIME_CAP_ENV_KEYS) {
      if (source[key]) child[key] = source[key];
    }
  } else {
    for (const key of H1_RUNTIME_CAP_ENV_KEYS) delete child[key];
  }
  return child;
};
