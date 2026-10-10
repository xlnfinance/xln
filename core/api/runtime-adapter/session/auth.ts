import type { RuntimeReplica } from '../../../runtime/types';
import { RuntimeAdapterError } from '../errors';
import { getRuntimeCommandReadiness } from '../../../runtime/replica/lifecycle';
import {
  resolveRuntimeAdapterAuthAudience,
  resolveRuntimeAdapterAuthSeed,
  runtimeAdapterRevokedTokenIds,
  verifyRuntimeAdapterAuthCredential,
} from '../security/auth';
import {
  normalizeRuntimeAdapterIdentityChallenge,
} from '../security/server-identity';
import { signRuntimeAdapterServerIdentity } from '../security/server-identity-signer';
import {
  readRuntimeAdapterCommandFrontier,
  runtimeAdapterCommandLaneId,
  runtimeAdapterOwnerCommandLaneId,
} from '../../../runtime/command/frontier';
import {
  buildRuntimeAdapterOwnerBindingDigest,
  verifyRuntimeAdapterOwnerBinding,
} from '../security/owner-binding';
import {
  sendOk,
  type AdapterClientState,
  type RuntimeAdapterDiagnostic,
  type RuntimeAdapterRequestByOp,
  type RuntimeAdapterSocket,
} from './context';
import { prunePendingCommands } from './command-lane';

// The `auth` op: verifies the capability, signs the server identity for the
// client challenge, admits an owner binding once, and binds the command lane.

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

export const handleRuntimeAdapterAuth = (
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
