import { buildManagedRuntimeChildSecretEnv } from '../../support/process/child-secrets';
import { buildRuntimeChildGcEnv } from '../../support/process/runtime-gc-env';

const RUNTIME_FRAME_DELAY_KEY = 'XLN_RUNTIME_MIN_FRAME_DELAY_MS';
const HUB_STEADY_FRAME_PERIOD_KEY = 'XLN_HUB_STEADY_FRAME_PERIOD_MS';
// Measured steady-load default. A 250ms period reduced frame count 13.5% but
// regressed delivered payments 7.8%, because Account follow-ups were delayed.
export const DEFAULT_HUB_RUNTIME_FRAME_PERIOD_MS = 0;

/**
 * Hub bootstrap must drain immediately. The requested Hub period becomes live
 * only after mesh bootstrap is complete, so account opening and direct-route
 * readiness cannot be slowed or torn down mid-reset.
 */
export const applyHubRuntimeFrameDelay = (
  env: NodeJS.ProcessEnv,
  hubDelayMs: string | undefined,
): NodeJS.ProcessEnv => {
  const childEnv = { ...env };
  childEnv[RUNTIME_FRAME_DELAY_KEY] = '0';
  childEnv[HUB_STEADY_FRAME_PERIOD_KEY] =
    hubDelayMs ?? String(DEFAULT_HUB_RUNTIME_FRAME_PERIOD_MS);
  return childEnv;
};

export const readHubSteadyRuntimeFramePeriodMs = (
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const raw = env[HUB_STEADY_FRAME_PERIOD_KEY];
  const value = raw === undefined ? DEFAULT_HUB_RUNTIME_FRAME_PERIOD_MS : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`HUB_STEADY_FRAME_PERIOD_MS_INVALID:${String(raw)}`);
  }
  return value;
};

const HUB_PASSTHROUGH_ENV_KEYS = [
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
  hubDelayMs: string | undefined;
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
    XLN_ORCHESTRATOR_STARTUP_TIMEOUT_MS: String(options.startupTimeoutMs),
    XLN_STORAGE_WRITE_TIMEOUT_MS: source['XLN_STORAGE_WRITE_TIMEOUT_MS'] ?? '60000',
    XLN_LOG_LEVEL: source['XLN_HUB_LOG_LEVEL'] ?? source['XLN_LOG_LEVEL'] ?? 'warn',
  };
  if (source[`XLN_HUB_RSCORE_AUTHORITY_${options.hubName.toUpperCase()}`] === '1') {
    child['XLN_RSCORE_AUTHORITY'] = '1';
    if (source['XLN_RSCORE_BINARY']) {
      child['XLN_RSCORE_BINARY'] = source['XLN_RSCORE_BINARY'];
    }
    if (source['XLN_RSCORE_AUTHORITY_WORKERS']) {
      child['XLN_RSCORE_AUTHORITY_WORKERS'] = source['XLN_RSCORE_AUTHORITY_WORKERS'];
    }
    if (source['XLN_RSCORE_AUTHORITY_CUTOVER']) {
      child['XLN_RSCORE_AUTHORITY_CUTOVER'] = source['XLN_RSCORE_AUTHORITY_CUTOVER'];
    }
    if (source['XLN_RSCORE_AUTHORITY_RECORD']) {
      child['XLN_RSCORE_AUTHORITY_RECORD'] = source['XLN_RSCORE_AUTHORITY_RECORD'];
    }
  }
  for (const key of HUB_PASSTHROUGH_ENV_KEYS) {
    if (source[key]) child[key] = source[key];
  }
  return applyHubRuntimeFrameDelay(child, options.hubDelayMs);
};
