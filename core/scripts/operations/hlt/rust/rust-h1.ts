/**
 * Canonical HLT engine selection and Rust H1 lifecycle.
 *
 * engine=ts   -> the existing sovereign TS stack, unchanged.
 * engine=rust -> H1 is the real zero-JS `rscore-runtime` binary: native WAL/DB,
 * direct socket ingress, deterministic signer derivation from the mesh seed.
 * Transport encryption/authentication identity is derived deterministically
 * from the Runtime seed with the exact canonical TS derivation
 * (`canonicalEntitySeed` + `deriveEncryptionKeyPair`); there is no operator
 * key file and no plaintext bypass. There is no shadow mode, no TS fallback
 * and no sidecar authority: if the Rust process cannot become ready, the HLT
 * run fails loudly.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

import { deriveSignerAddressSync } from '../../../../account/crypto';
import { deriveManagedEntityIdentity } from '../../../../orchestrator/daemon-control';
import { deriveEncryptionKeyPair } from '../../../../protocol/crypto/p2p-crypto';
import { safeStringify } from '../../../../protocol/serialization';
import { canonicalEntitySeed } from '../../../../runtime/registration/entity-creation';

export const HLT_ENGINES = ['ts', 'rust'] as const;
export const HLT_PROFILES = ['smoke', 'medium', 'heavy'] as const;
export type HltEngine = (typeof HLT_ENGINES)[number];
export type HltProfile = (typeof HLT_PROFILES)[number];

export type HltEngineSelection = Readonly<{ engine: HltEngine; profile: HltProfile }>;

/**
 * Live TPS authority (docs/fints/AGENTS): one sovereign H1 run,
 * deliveredPayments/deliveredElapsed. medium = the canonical 1,000 user
 * Runtimes packed 200 per OS process; heavy targets 10,000 active users.
 */
export const HLT_PROFILE_PLAN: Readonly<Record<HltProfile, Readonly<{
  users: number; runtimesPerProcess: number;
}>>> = {
  smoke: { users: 10, runtimesPerProcess: 10 },
  medium: { users: 1_000, runtimesPerProcess: 200 },
  heavy: { users: 10_000, runtimesPerProcess: 200 },
};

export const parseHltEngineSelection = (env: Record<string, string | undefined>): HltEngineSelection => {
  const engineRaw = String(env['XLN_HLT_ENGINE'] || 'ts').trim();
  if (!HLT_ENGINES.includes(engineRaw as HltEngine)) {
    throw new Error(`HLT_ENGINE_INVALID:${engineRaw}`);
  }
  const profileRaw = String(env['XLN_HLT_PROFILE'] || 'smoke').trim();
  if (!HLT_PROFILES.includes(profileRaw as HltProfile)) {
    throw new Error(`HLT_PROFILE_INVALID:${profileRaw}`);
  }
  return { engine: engineRaw as HltEngine, profile: profileRaw as HltProfile };
};

/**
 * H1 Entity HTLC encryption private key, in the exact wire format expected by
 * rscore-runtime (0x-prefixed lowercase 32-byte hex). Same canonical
 * derivation as the TS stack: the Runtime seed yields the canonical Entity
 * seed, and the X25519 identity is `sha256('xln-p2p-encryption-v1' || seed)`
 * clamped — byte-identical to Rust `transport::crypto::encryption_identity`
 * (pinned vector in transport/tests.rs and hlt-rust-engine.test.ts).
 */
export const deriveEntityEncryptionPrivateKeyHex = (runtimeSeed: string): string => {
  const seed = runtimeSeed.trim();
  if (!seed) throw new Error('HLT_RUST_H1_RUNTIME_SEED_EMPTY');
  const keyPair = deriveEncryptionKeyPair(canonicalEntitySeed(seed));
  return `0x${Buffer.from(keyPair.privateKey).toString('hex')}`;
};

/**
 * One row of the rscore-runtime EntityRoute table. User Runtime nodes dial
 * H1 inbound over the encrypted direct socket; the H1 route table names the
 * peer Entities H1 may contact outbound. Rows are generated from the real
 * HLT topology, never hand-scaffolded.
 */
export type HltEntityRoute = Readonly<{
  targetEntityId: string;
  targetRuntimeId: string;
  targetSignerId: string;
  websocketUrl: string;
}>;

const ENTITY_ID = /^0x[0-9a-f]{64}$/;
const RUNTIME_OR_SIGNER_ID = /^0x[0-9a-f]{40}$/;
const WEBSOCKET_URL = /^wss?:\/\/[^\s]+$/;

export const validateHltEntityRoute = (route: HltEntityRoute, index: number): HltEntityRoute => {
  if (!ENTITY_ID.test(route.targetEntityId)) {
    throw new Error(`HLT_ROUTE_ENTITY_ID_INVALID:${index}:${route.targetEntityId}`);
  }
  if (!RUNTIME_OR_SIGNER_ID.test(route.targetRuntimeId)) {
    throw new Error(`HLT_ROUTE_RUNTIME_ID_INVALID:${index}:${route.targetRuntimeId}`);
  }
  if (!RUNTIME_OR_SIGNER_ID.test(route.targetSignerId)) {
    throw new Error(`HLT_ROUTE_SIGNER_ID_INVALID:${index}:${route.targetSignerId}`);
  }
  if (!WEBSOCKET_URL.test(route.websocketUrl)) {
    throw new Error(`HLT_ROUTE_URL_INVALID:${index}:${route.websocketUrl}`);
  }
  return route;
};

export const serializeHltEntityRoutes = (routes: readonly HltEntityRoute[]): string => {
  const validated = routes.map((route, index) => validateHltEntityRoute(route, index));
  return `${safeStringify(validated)}\n`;
};

/**
 * One sovereign TS user node in the HLT topology. Its Runtime id uses the
 * exact canonical derivation enforced by `createDirectRuntimeWsRoute`
 * (`deriveSignerAddressSync(seed, '1')`), and its Entity identity uses
 * `deriveManagedEntityIdentity` — the same pair the lane host validates when
 * the user Runtime opens its encrypted direct socket listener.
 */
export type HltUserNode = Readonly<{
  name: string;
  runtimeSeed: string;
  signerLabel: string;
  listenHost: string;
  listenPort: number;
}>;

export const deriveUserRuntimeId = (runtimeSeed: string): string => {
  const seed = runtimeSeed.trim();
  if (!seed) throw new Error('HLT_USER_RUNTIME_SEED_EMPTY');
  return deriveSignerAddressSync(seed, '1').toLowerCase();
};

export const deriveUserNodeRoute = (node: HltUserNode): HltEntityRoute => {
  const identity = deriveManagedEntityIdentity({
    name: node.name,
    seed: node.runtimeSeed.trim(),
    signerLabel: node.signerLabel,
  });
  if (!Number.isSafeInteger(node.listenPort) || node.listenPort < 1 || node.listenPort > 65_535) {
    throw new Error(`HLT_USER_NODE_PORT_INVALID:${node.name}:${String(node.listenPort)}`);
  }
  return validateHltEntityRoute({
    targetEntityId: identity.entityId,
    targetRuntimeId: deriveUserRuntimeId(node.runtimeSeed),
    targetSignerId: identity.signerId,
    // `/ws` is the direct-runtime route path used by both stacks.
    websocketUrl: `ws://${node.listenHost}:${String(node.listenPort)}/ws`,
  }, 0);
};

/**
 * H1's outbound route table over the real HLT user topology: one validated
 * row per sovereign user Runtime. User nodes dial H1 inbound; H1 pushes
 * Account outputs/ACKs to them over these exact routes.
 */
export const deriveHltTopologyRoutes = (nodes: readonly HltUserNode[]): HltEntityRoute[] =>
  nodes.map(deriveUserNodeRoute);

export type RustH1Config = Readonly<{
  /** HLT work directory; native DB and derived key/route files live here. */
  workDir: string;
  /** Deterministic Runtime seed (mesh root child seed `runtime:h1`). */
  runtimeSeed: string;
  /** Peer-Entity routes for H1 outbound, generated from the HLT topology. */
  routes: readonly HltEntityRoute[];
  bindHost: string;
  bindPort: number;
  runtimeSignerLabel: string;
  entitySignerLabel: string;
  workers?: number;
  offlineTsImport?: boolean;
}>;

export type RustH1Command = Readonly<{
  argv: readonly string[];
  runtimeSeedFile: string;
  entityKeyFile: string;
  routesFile: string;
  nativeDb: string;
  bind: string;
}>;

export const RSCORE_RUNTIME_BINARY = 'rscore/target/release/rscore-runtime';
const SIGNER_LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Pure command derivation: identical inputs always produce identical argv. */
export const deriveRustH1Command = (config: RustH1Config): RustH1Command => {
  const workDir = resolve(config.workDir);
  if (!existsSync(workDir)) throw new Error(`HLT_RUST_H1_WORK_DIR_MISSING:${workDir}`);
  const seed = config.runtimeSeed.trim();
  if (!seed) throw new Error('HLT_RUST_H1_RUNTIME_SEED_EMPTY');
  if (!Number.isSafeInteger(config.bindPort) || config.bindPort < 1 || config.bindPort > 65_535) {
    throw new Error(`HLT_RUST_H1_BIND_PORT_INVALID:${String(config.bindPort)}`);
  }
  if (!SIGNER_LABEL.test(config.runtimeSignerLabel) || !SIGNER_LABEL.test(config.entitySignerLabel)) {
    throw new Error(
      `HLT_RUST_H1_SIGNER_LABEL_INVALID:${config.runtimeSignerLabel}:${config.entitySignerLabel}`,
    );
  }
  config.routes.forEach((route, index) => validateHltEntityRoute(route, index));
  const runtimeSeedFile = join(workDir, 'rust-h1-runtime.seed');
  const entityKeyFile = join(workDir, 'rust-h1-entity-htlc.key');
  const routesFile = join(workDir, 'rust-h1-routes.json');
  const nativeDb = join(workDir, 'rust-h1-db');
  const bind = `${config.bindHost}:${String(config.bindPort)}`;
  return {
    argv: [
      '--native-db', nativeDb,
      '--runtime-seed-file', runtimeSeedFile,
      '--entity-encryption-private-key-file', entityKeyFile,
      '--runtime-signer-label', config.runtimeSignerLabel,
      '--entity-signer-label', config.entitySignerLabel,
      '--bind', bind,
      '--routes', routesFile,
      '--workers', String(config.workers ?? 8),
      ...(config.offlineTsImport === true ? ['--offline-ts-import'] : []),
    ],
    runtimeSeedFile,
    entityKeyFile,
    routesFile,
    nativeDb,
    bind,
  };
};

export type RustH1Ready = Readonly<{ runtimeId: string; listen: string; workers: number }>;

export type RustH1Handle = Readonly<{
  ready: RustH1Ready;
  pid: number;
  stop: () => Promise<void>;
  /** Bounded stderr tail for HLT result surfacing. */
  errorTail: () => string;
}>;

const READY_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 5_000;
const MAX_TAIL = 8_192;

const parseReadyLine = (line: string): RustH1Ready | null => {
  if (!line.includes('"status":"ready"')) return null;
  const record = JSON.parse(line) as Record<string, unknown>;
  if (record['status'] !== 'ready') return null;
  if (typeof record['runtimeId'] !== 'string' || typeof record['listen'] !== 'string') {
    throw new Error(`HLT_RUST_H1_READY_MALFORMED:${line.slice(0, 200)}`);
  }
  return {
    runtimeId: record['runtimeId'],
    listen: record['listen'],
    workers: typeof record['workers'] === 'number' ? record['workers'] : 0,
  };
};

export const spawnRustH1 = async (
  config: RustH1Config,
  binary: string = resolve(RSCORE_RUNTIME_BINARY),
  spawnFn: typeof spawn = spawn,
): Promise<RustH1Handle> => {
  if (!existsSync(binary)) throw new Error(`HLT_RUST_H1_BINARY_MISSING:${binary}`);
  const command = deriveRustH1Command(config);
  mkdirSync(config.workDir, { recursive: true });
  writeFileSync(command.runtimeSeedFile, `${config.runtimeSeed.trim()}\n`, { mode: 0o600 });
  writeFileSync(
    command.entityKeyFile,
    `${deriveEntityEncryptionPrivateKeyHex(config.runtimeSeed)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(command.routesFile, serializeHltEntityRoutes(config.routes), { mode: 0o600 });
  let tail = '';
  const appendTail = (chunk: Buffer | string): void => {
    tail = (tail + chunk.toString()).slice(-MAX_TAIL);
  };
  const proc = spawnFn(binary, [...command.argv], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcess;
  proc.stderr?.on('data', appendTail);
  return await new Promise<RustH1Handle>((resolveReady, rejectReady) => {
    let stdoutBuffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      rejectReady(new Error(`HLT_RUST_H1_READY_TIMEOUT:${tail.slice(-2_000)}`));
    }, READY_TIMEOUT_MS);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill('SIGKILL');
      rejectReady(error);
    };
    proc.once('error', error => fail(new Error(`HLT_RUST_H1_SPAWN:${error.message}`)));
    proc.once('exit', (code, signal) => fail(new Error(
      `HLT_RUST_H1_EXIT:${String(code)}:${String(signal)}:${tail.slice(-2_000)}`,
    )));
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      let ready: RustH1Ready | null = null;
      try {
        ready = parseReadyLine(line);
      } catch (error) {
        fail(error as Error);
        return;
      }
      if (!ready || settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.on('data', appendTail);
      const pid = proc.pid;
      if (pid === undefined) {
        fail(new Error('HLT_RUST_H1_PID_MISSING'));
        return;
      }
      resolveReady({
        ready,
        pid,
        errorTail: () => tail,
        stop: async () => {
          if (proc.exitCode !== null) return;
          proc.kill('SIGTERM');
          const exited = Promise.race([
            once(proc, 'exit'),
            new Promise(done => setTimeout(done, STOP_GRACE_MS).unref()),
          ]);
          await exited;
          if (proc.exitCode === null) proc.kill('SIGKILL');
        },
      });
    });
  });
};
