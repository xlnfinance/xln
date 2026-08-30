import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type HubEngineKind = 'rust' | 'typescript';

export const canonicalHubEngine = (hubName: string): HubEngineKind => {
  const normalized = hubName.trim().toUpperCase();
  if (!/^H[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`HUB_ENGINE_NAME_INVALID:${hubName}`);
  }
  return normalized === 'H1' ? 'rust' : 'typescript';
};

export type RustHubProcessConfig = Readonly<{
  name: string;
  apiHost: string;
  apiPort: number;
  directHost: string;
  directPort: number;
  dbPath: string;
  runtimeSeedFile: string;
  entityKeyFile: string;
  routesFile: string;
  genesisFile: string;
  jurisdictionsPath: string;
  runtimeSignerLabel: string;
  entitySignerLabel: string;
  primaryEntityId: string;
  workers: number;
  metricsMs?: number;
  binary?: string;
}>;

export type RustHubProcessPlan = Readonly<{
  executable: string;
  args: readonly string[];
  nativeDb: string;
}>;

export const RSCORE_RUNTIME_BUILD_COMMAND =
  'cargo --config rscore/.cargo/config.toml build --release --locked --manifest-path rscore/Cargo.toml -p xln-rscore-process --bin xlnrs';

const newestRustBuildInputMs = (path: string): number => {
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === '.git' || entry.name === 'db') continue;
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestRustBuildInputMs(entryPath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:rs|toml|lock)$/.test(entry.name)) continue;
    newest = Math.max(newest, statSync(entryPath).mtimeMs);
  }
  return newest;
};

/**
 * Dev must never launch a release binary that predates its Rust inputs. The
 * This function only proves the executable freshness invariant. The canonical
 * dev preflight owns the single bounded release build when this check fails.
 */
export const assertRustHubBinaryFresh = (
  repositoryRoot: string,
  binary = 'rscore/target/release/xlnrs',
): string => {
  const root = resolve(repositoryRoot);
  const executable = resolve(root, binary);
  if (!existsSync(executable)) {
    throw new Error(`RUST_HUB_BINARY_MISSING:${executable}:run=${RSCORE_RUNTIME_BUILD_COMMAND}`);
  }
  const rustRoot = join(root, 'rscore');
  const binaryMs = statSync(executable).mtimeMs;
  const inputMs = newestRustBuildInputMs(rustRoot);
  if (inputMs > binaryMs) {
    throw new Error(`RUST_HUB_BINARY_STALE:${executable}:run=${RSCORE_RUNTIME_BUILD_COMMAND}`);
  }
  return executable;
};

const positivePort = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`RUST_HUB_${field}_INVALID:${String(value)}`);
  }
};

/**
 * Canonical production process plan for H1. Marker arguments (`--name`,
 * `--api-port`, `--db-path`) also bind stale-process discovery to this exact
 * database owner; they are native CLI fields, not a TypeScript sidecar.
 */
export const buildRustHubProcessPlan = (config: RustHubProcessConfig): RustHubProcessPlan => {
  if (canonicalHubEngine(config.name) !== 'rust') {
    throw new Error(`RUST_HUB_ROLE_INVALID:${config.name}`);
  }
  positivePort(config.apiPort, 'API_PORT');
  positivePort(config.directPort, 'DIRECT_PORT');
  if (config.apiHost === config.directHost && config.apiPort === config.directPort) {
    throw new Error(`RUST_HUB_LISTENER_COLLISION:${config.apiHost}:${String(config.apiPort)}`);
  }
  if (!Number.isSafeInteger(config.workers) || config.workers < 1) {
    throw new Error(`RUST_HUB_WORKERS_INVALID:${String(config.workers)}`);
  }
  const primaryEntityId = config.primaryEntityId.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(primaryEntityId)) {
    throw new Error(`RUST_HUB_PRIMARY_ENTITY_ID_INVALID:${config.primaryEntityId}`);
  }
  const binary = resolve(config.binary || 'rscore/target/release/xlnrs');
  if (!existsSync(binary)) throw new Error(`RUST_HUB_BINARY_MISSING:${binary}`);
  const nativeDb = join(resolve(config.dbPath), 'rscore-native');
  return {
    executable: binary,
    nativeDb,
    args: [
      'live',
      '--name', 'H1',
      '--api-bind', `${config.apiHost}:${String(config.apiPort)}`,
      '--api-port', String(config.apiPort),
      '--db-path', resolve(config.dbPath),
      '--native-db', nativeDb,
      '--runtime-seed-file', resolve(config.runtimeSeedFile),
      '--entity-encryption-private-key-file', resolve(config.entityKeyFile),
      '--runtime-signer-label', config.runtimeSignerLabel,
      '--entity-signer-label', config.entitySignerLabel,
      '--primary-entity-id', primaryEntityId,
      '--bind', `${config.directHost}:${String(config.directPort)}`,
      '--routes', resolve(config.routesFile),
      '--genesis-config', resolve(config.genesisFile),
      '--jurisdictions', resolve(config.jurisdictionsPath),
      '--workers', String(config.workers),
      '--metrics-ms', String(config.metricsMs ?? 1_000),
    ],
  };
};

export type RustHubStatus = Readonly<{
  status: 'ready' | 'metrics';
  runtimeId?: string;
  height: number;
  listen?: string;
}>;

export const parseRustHubStatus = (line: string): RustHubStatus | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['status'] !== 'ready' && row['status'] !== 'metrics') return null;
  if (!Number.isSafeInteger(row['height']) || Number(row['height']) < 0) {
    throw new Error(`RUST_HUB_STATUS_HEIGHT_INVALID:${String(row['height'])}`);
  }
  if (row['status'] === 'ready') {
    const runtimeId = String(row['runtimeId'] || '').toLowerCase();
    const listen = String(row['listen'] || '');
    if (!/^0x[0-9a-f]{40}$/.test(runtimeId) || !listen) {
      throw new Error('RUST_HUB_READY_IDENTITY_INVALID');
    }
    return { status: 'ready', runtimeId, height: Number(row['height']), listen };
  }
  return { status: 'metrics', height: Number(row['height']) };
};
