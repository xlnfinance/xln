import type { RuntimeReplica } from '../../runtime/types';
import {
  encodeRuntimeAdapterMessageForBrowser,
  RuntimeAdapterMessageTooLargeError,
} from './codec';
import { RuntimeAdapterError } from './errors';
import { consumeToken, tokenRetryAfterMs } from './security/rate-limit';
import { getRuntimeCommandReadiness } from '../../runtime/replica/lifecycle';
import type {
  RuntimeAdapterRequest,
} from './types';
import {
  resolveRuntimeAdapterAuthAudience,
  resolveRuntimeAdapterAuthSeed,
  runtimeAdapterRevokedTokenIds,
  verifyRuntimeAdapterAuthCredential,
} from './security/auth';
import {
  normalizeRuntimeAdapterIdentityChallenge,
} from './security/server-identity';
import { signRuntimeAdapterServerIdentity } from './security/server-identity-signer';
import {
  readRuntimeAdapterCommandFrontier,
  runtimeAdapterCommandLaneId,
  runtimeAdapterOwnerCommandLaneId,
} from '../../runtime/command/frontier';
import {
  buildRuntimeAdapterOwnerBindingDigest,
  verifyRuntimeAdapterOwnerBinding,
} from './security/owner-binding';
import { XLN_PROTOCOL_VERSION } from '../../protocol/version';
import { withRuntimeCommittedRead } from '../../runtime/frame/lifecycle/writer-lock';
import {
  ensurePendingNumberedRegistrationsResumed,
  registerNumberedEntities,
} from '../../runtime/registration/numbered/numbered-registration-driver';
import {
  createConfiguredBucket,
  errorMessage,
  requireAuth,
  requireBucket,
  requireMutatingRuntimeAdapterReady,
  requireOwnerLane,
  runtimeAdapterLog,
  sendErr,
  sendOk,
  sendPush,
  sendRuntimeAdapterEncoded,
  type AdapterClientState,
  type RuntimeAdapterDiagnostic,
  type RuntimeAdapterRequestByOp,
  type RuntimeAdapterResponseDiagnostic,
  type RuntimeAdapterServerDeps,
  type RuntimeAdapterSocket,
} from './session/context';
import { handleRuntimeAdapterRead } from './session/read';
import { handleRuntimeAdapterSend, prunePendingCommands } from './session/command-lane';

type ActiveBrainVaultJob = Readonly<{ jobId: string; abort: AbortController }>;

const clients = new Map<RuntimeAdapterSocket, AdapterClientState>();
// A process may host many sovereign RuntimeReplicas (the HLT packs up to 200).
// Tick fanout is runtime-local: scanning the process-global client registry on
// every committed frame turns independent replicas into O(runtimes * clients)
// work and makes the control plane throttle the financial state machines.
const clientsByRuntime = new Map<RuntimeReplica, Set<RuntimeAdapterSocket>>();

export const countRuntimeAdapterClients = (env: RuntimeReplica): number =>
  clientsByRuntime.get(env)?.size ?? 0;
const brainVaultJobs = new Map<RuntimeAdapterSocket, ActiveBrainVaultJob>();
const attachedEnvChanges = new Map<RuntimeReplica, () => void>();

/**
 * Owner-signed auth digests seen per Runtime, kept until their capability
 * expires. The owner binding signs a client-chosen challenge, so a captured
 * auth message used to replay the owner lane (mnemonic export included) for
 * the capability's lifetime. In memory only: a restart reopens that window.
 */
const usedOwnerBindings = new Map<RuntimeReplica, Map<string, number>>();

const consumeOwnerBinding = (
  env: RuntimeReplica,
  digest: string,
  expiresAtMs: number | null,
): boolean => {
  const now = Date.now();
  const used = usedOwnerBindings.get(env) ?? new Map<string, number>();
  usedOwnerBindings.set(env, used);
  for (const [seen, expiry] of used) {
    if (expiry <= now) used.delete(seen);
  }
  if (used.has(digest)) return false;
  used.set(digest, expiresAtMs ?? Number.POSITIVE_INFINITY);
  return true;
};

const getClientState = (
  ws: RuntimeAdapterSocket,
  env: RuntimeReplica | null,
): AdapterClientState => {
  let state = clients.get(ws);
  if (!state) {
    state = {
      env,
      authLevel: null,
      authExpiresAtMs: null,
      commandLaneId: null,
      commandLaneKind: null,
      commandFrontierExpiresAtMs: null,
      controlBucket: createConfiguredBucket('CONTROL', 100, 50),
      readBucket: createConfiguredBucket('READ', 100, 50),
      sendBucket: createConfiguredBucket('SEND', 10, 5),
    };
    clients.set(ws, state);
    if (env) {
      const runtimeClients = clientsByRuntime.get(env) ?? new Set<RuntimeAdapterSocket>();
      runtimeClients.add(ws);
      clientsByRuntime.set(env, runtimeClients);
    }
  } else if (state.env === null) {
    state.env = env;
    if (env) {
      const runtimeClients = clientsByRuntime.get(env) ?? new Set<RuntimeAdapterSocket>();
      runtimeClients.add(ws);
      clientsByRuntime.set(env, runtimeClients);
    }
  } else if (env !== null && state.env !== env) {
    throw new Error('RADAPTER_SOCKET_RUNTIME_REBIND_FORBIDDEN');
  }
  return state;
};

export const forgetRuntimeAdapterClient = (ws: RuntimeAdapterSocket): void => {
  brainVaultJobs.get(ws)?.abort.abort();
  brainVaultJobs.delete(ws);
  const env = clients.get(ws)?.env;
  clients.delete(ws);
  if (env) {
    const runtimeClients = clientsByRuntime.get(env);
    runtimeClients?.delete(ws);
    if (runtimeClients?.size === 0) clientsByRuntime.delete(env);
  }
};

export const closeInvalidRuntimeAdapterMessage = (ws: RuntimeAdapterSocket, error: unknown): void => {
  ws.close?.(error instanceof RuntimeAdapterMessageTooLargeError ? 1009 : 1003, 'Invalid runtime adapter message');
};

export const broadcastRuntimeAdapterTick = (env: RuntimeReplica): void => {
  prunePendingCommands(env);
  const runtimeClients = clientsByRuntime.get(env);
  if (!runtimeClients || runtimeClients.size === 0) return;
  const height = Math.max(0, Math.floor(Number(env.state.height ?? 0)));
  const readiness = getRuntimeCommandReadiness(env);
  const message = encodeRuntimeAdapterMessageForBrowser({
    v: XLN_PROTOCOL_VERSION,
    op: 'tick',
    height,
    commandReady: readiness.ready,
    commandReadyReason: readiness.reason,
  });
  const now = Date.now();
  for (const ws of runtimeClients) {
    const state = clients.get(ws);
    if (!state || state.env !== env) {
      throw new Error('RADAPTER_RUNTIME_CLIENT_INDEX_DIVERGED');
    }
    if (state.authExpiresAtMs !== null && state.authExpiresAtMs <= now) {
      state.authLevel = null;
      state.authExpiresAtMs = null;
      state.commandLaneId = null;
      state.commandLaneKind = null;
      state.commandFrontierExpiresAtMs = null;
    }
    if (!state.authLevel) continue;
    try {
      sendRuntimeAdapterEncoded(ws, message);
    } catch (error) {
      runtimeAdapterLog.debug('tick_send_failed', { reason: errorMessage(error) });
      forgetRuntimeAdapterClient(ws);
    }
  }
};

export const attachRuntimeAdapterTicker = (
  env: RuntimeReplica,
  registerEnvChangeCallback: (env: RuntimeReplica, cb: (env: RuntimeReplica) => void) => (() => void),
): void => {
  if (attachedEnvChanges.has(env)) return;
  attachedEnvChanges.set(
    env,
    registerEnvChangeCallback(env, broadcastRuntimeAdapterTick),
  );
};

const handleRuntimeAdapterAuth = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'auth'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  diagnostic: RuntimeAdapterDiagnostic,
): void => {
  state.authLevel = null;
  state.authExpiresAtMs = null;
  state.commandLaneId = null;
  state.commandLaneKind = null;
  state.commandFrontierExpiresAtMs = null;
  const auth = verifyRuntimeAdapterAuthCredential(
    resolveRuntimeAdapterAuthSeed(),
    msg.key,
    {
      audience: resolveRuntimeAdapterAuthAudience(env),
      revokedTokenIds: runtimeAdapterRevokedTokenIds(),
    },
  );
  if (!auth) {
    throw new RuntimeAdapterError(
      'E_UNAUTHORIZED',
      'invalid runtime adapter auth key',
    );
  }
  let challenge: string;
  try {
    challenge = normalizeRuntimeAdapterIdentityChallenge(msg.challenge);
  } catch {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      'runtime adapter auth challenge must be 32-byte hex',
    );
  }
  const identity = signRuntimeAdapterServerIdentity(env, challenge);
  const ownerSignature =
    typeof msg.ownerSignature === 'string' ? msg.ownerSignature.trim() : '';
  if (
    ownerSignature &&
    !verifyRuntimeAdapterOwnerBinding(
      identity.runtimeId,
      challenge,
      String(msg.key || ''),
      ownerSignature,
    )
  ) {
    throw new RuntimeAdapterError(
      'E_UNAUTHORIZED',
      'runtime adapter vault-owner binding is invalid',
    );
  }
  if (
    ownerSignature &&
    !consumeOwnerBinding(
      env,
      buildRuntimeAdapterOwnerBindingDigest(identity.runtimeId, challenge, String(msg.key || '')),
      auth.expiresAtMs,
    )
  ) {
    throw new RuntimeAdapterError(
      'E_UNAUTHORIZED',
      'runtime adapter vault-owner binding was already used',
    );
  }
  const commandLaneKind = ownerSignature ? 'owner' : 'capability';
  state.authLevel = auth.level;
  state.authExpiresAtMs = auth.expiresAtMs;
  state.commandLaneKind = commandLaneKind;
  state.commandLaneId =
    commandLaneKind === 'owner'
      ? runtimeAdapterOwnerCommandLaneId(identity.runtimeId)
      : runtimeAdapterCommandLaneId(auth.keyId, auth.tokenId);
  state.commandFrontierExpiresAtMs =
    commandLaneKind === 'owner' ? null : auth.expiresAtMs;
  prunePendingCommands(env);
  const commandFrontier = readRuntimeAdapterCommandFrontier(
    env,
    state.commandLaneId,
  );
  const readiness = getRuntimeCommandReadiness(env);
  sendOk(
    ws,
    msg.id,
    {
      authLevel: auth.level,
      commandLaneKind,
      expiresAtMs: auth.expiresAtMs,
      currentHeight: Math.max(0, Math.floor(Number(env.state.height ?? 0))),
      commandReady: readiness.ready,
      commandReadyReason: readiness.reason,
      nextCommandSequence:
        (commandFrontier?.lastContiguousSequence ?? 0) + 1,
      ...identity,
    },
    diagnostic(),
  );
};

const handleRuntimeAdapterCrossJIntent = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'cross-j-intent'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireAuth(state, 'admin');
  requireBucket(state.sendBucket, 'send');
  requireMutatingRuntimeAdapterReady(env, deps);
  if (!deps.submitCrossJurisdictionIntent) {
    throw new RuntimeAdapterError(
      'E_INTERNAL',
      'cross-j intent transport is unavailable',
    );
  }
  await deps.submitCrossJurisdictionIntent(env, msg.route);
  sendOk(ws, msg.id, { delivered: true }, diagnostic());
};

const handleRuntimeAdapterNumberedRegistration = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'numbered-registration'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireAuth(state, 'admin');
  requireBucket(state.sendBucket, 'send');
  requireMutatingRuntimeAdapterReady(env, deps);
  // Do not hold a committed-read lease here: the driver waits for two future
  // WAL commits and would otherwise deadlock the Runtime writer it needs.
  await ensurePendingNumberedRegistrationsResumed(env);
  sendOk(ws, msg.id, await registerNumberedEntities(env, msg.input), diagnostic());
};

const handleRuntimeAdapterControl = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'control'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireAuth(state, 'admin');
  requireBucket(state.sendBucket, 'control');
  if (!deps.controlRuntime) {
    throw new RuntimeAdapterError(
      'E_INTERNAL',
      'runtime admin control is unavailable',
    );
  }
  sendOk(
    ws,
    msg.id,
    await deps.controlRuntime(env, msg.action),
    diagnostic(),
  );
};

const handleRuntimeAdapterBrainVaultDerive = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'brainvault-derive'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireAuth(state, 'admin');
  requireBucket(state.sendBucket, 'brainvault');
  if (!deps.deriveBrainVault) throw new RuntimeAdapterError('E_INTERNAL', 'native BrainVault is unavailable');
  if (brainVaultJobs.has(ws)) {
    throw new RuntimeAdapterError('E_COMMAND_PENDING', 'a BrainVault derivation is already running', true, 1_000);
  }
  const abort = new AbortController();
  const job: ActiveBrainVaultJob = { jobId: msg.jobId, abort };
  brainVaultJobs.set(ws, job);
  try {
    const result = await deps.deriveBrainVault(env, msg.input, {
      signal: abort.signal,
      onProgress: progress => sendPush(ws, {
        v: XLN_PROTOCOL_VERSION,
        op: 'brainvault-progress',
        jobId: msg.jobId,
        progress,
      }),
    });
    sendOk(ws, msg.id, result, diagnostic());
  } finally {
    if (brainVaultJobs.get(ws) === job) brainVaultJobs.delete(ws);
  }
};

const handleRuntimeAdapterBrainVaultCancel = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'brainvault-cancel'>,
  state: AdapterClientState,
  diagnostic: RuntimeAdapterDiagnostic,
): void => {
  requireAuth(state, 'admin');
  const job = brainVaultJobs.get(ws);
  const cancelled = job?.jobId === msg.jobId;
  if (cancelled) job.abort.abort();
  sendOk(ws, msg.id, { cancelled }, diagnostic());
};

const handleRuntimeAdapterBrainVaultReveal = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'brainvault-reveal'>,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  requireOwnerLane(state);
  requireBucket(state.sendBucket, 'brainvault');
  if (!deps.revealBrainVaultMnemonic) {
    throw new RuntimeAdapterError('E_INTERNAL', 'BrainVault mnemonic export is unavailable');
  }
  const recovery = await deps.revealBrainVaultMnemonic();
  runtimeAdapterLog.warn('brainvault.mnemonic_exported', { authLevel: state.authLevel });
  sendOk(ws, msg.id, recovery, diagnostic());
};

export const handleRuntimeAdapterMessage = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequest,
  env: RuntimeReplica | null,
  deps: RuntimeAdapterServerDeps,
): Promise<boolean> => {
  const state = getClientState(ws, env);
  const diagnostic = (): RuntimeAdapterResponseDiagnostic => {
    const info: RuntimeAdapterResponseDiagnostic = {
      env,
      op: String(msg.op || ''),
      authLevel: state.authLevel,
    };
    if ('path' in msg) info.path = msg.path;
    if ('query' in msg && msg.query) info.query = msg.query;
    return info;
  };
  if (!consumeToken(state.controlBucket)) {
    sendErr(ws, msg.id, new RuntimeAdapterError(
      'E_RATE_LIMITED',
      'runtime adapter rate limit exceeded',
      true,
      tokenRetryAfterMs(state.controlBucket),
    ), diagnostic());
    return true;
  }
  if (!env) {
    sendErr(ws, msg.id, new RuntimeAdapterError('E_INTERNAL', 'runtime not ready', true), diagnostic());
    return true;
  }

  try {
    if (msg.op === 'auth') {
      await withRuntimeCommittedRead(
        env,
        () => handleRuntimeAdapterAuth(ws, msg, env, state, diagnostic),
      );
      return true;
    }

    if (msg.op === 'read') {
      await handleRuntimeAdapterRead(
        ws,
        msg,
        env,
        state,
        deps,
        diagnostic,
      );
      return true;
    }

    if (msg.op === 'cross-j-intent') {
      await handleRuntimeAdapterCrossJIntent(
        ws,
        msg,
        env,
        state,
        deps,
        diagnostic,
      );
      return true;
    }

    if (msg.op === 'numbered-registration') {
      await handleRuntimeAdapterNumberedRegistration(ws, msg, env, state, deps, diagnostic);
      return true;
    }

    if (msg.op === 'control') {
      await handleRuntimeAdapterControl(
        ws,
        msg,
        env,
        state,
        deps,
        diagnostic,
      );
      return true;
    }

    if (msg.op === 'brainvault-derive') {
      await handleRuntimeAdapterBrainVaultDerive(ws, msg, env, state, deps, diagnostic);
      return true;
    }

    if (msg.op === 'brainvault-cancel') {
      handleRuntimeAdapterBrainVaultCancel(ws, msg, state, diagnostic);
      return true;
    }

    if (msg.op === 'brainvault-reveal') {
      await handleRuntimeAdapterBrainVaultReveal(ws, msg, state, deps, diagnostic);
      return true;
    }

    if (msg.op === 'send') {
      await handleRuntimeAdapterSend(ws, msg, env, state, deps, diagnostic);
      return true;
    }

    return true;
  } catch (error) {
    sendErr(ws, msg.id, error, diagnostic());
    return true;
  }
};
