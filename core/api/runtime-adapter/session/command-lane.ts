import type { RuntimeReplica, RuntimeInput } from '../../../runtime/types';
import { RuntimeAdapterError } from '../errors';
import { safeStringify } from '../../../protocol/serialization';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  countActiveRuntimeAdapterCommandLanes,
  MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES,
  normalizeRuntimeAdapterCommandSequence,
  readRuntimeAdapterCommandFrontier,
} from '../../../runtime/command/frontier';
import { markLocalRuntimeAdapterCommandTx } from '../../../runtime/command/frontier-auth';
import { withRuntimeCommittedRead } from '../../../runtime/frame/lifecycle/writer-lock';
import {
  requireAuth,
  requireBucket,
  requireMutatingRuntimeAdapterReady,
  sendOk,
  type AdapterClientState,
  type RuntimeAdapterDiagnostic,
  type RuntimeAdapterRequestByOp,
  type RuntimeAdapterServerDeps,
  type RuntimeAdapterSocket,
} from './context';

// The `send` op over the session's auth-bound command lane: a command is
// answered from the committed frontier or its own pending record, or enqueued
// with a server-internal marker; any other sequence is a typed reject.

type PendingRuntimeAdapterCommand = {
  sequence: number;
  commandId: string;
  inputHash: string;
  expiresAtMs: number | null;
  result: {
    height: number;
    status: 'pending';
    commandSequence: number;
  };
};

const pendingRuntimeAdapterCommands = new Map<RuntimeReplica, Map<string, PendingRuntimeAdapterCommand>>();

const pendingCommandsFor = (env: RuntimeReplica): Map<string, PendingRuntimeAdapterCommand> => {
  const existing = pendingRuntimeAdapterCommands.get(env);
  if (existing) return existing;
  const created = new Map<string, PendingRuntimeAdapterCommand>();
  pendingRuntimeAdapterCommands.set(env, created);
  return created;
};

const normalizeCommandId = (value: unknown): string => {
  const commandId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(commandId)) {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter commandId must be 16-128 safe characters');
  }
  return commandId;
};

const runtimeInputHash = (input: RuntimeInput): string => keccak256(toUtf8Bytes(safeStringify(input)));

const commandSequenceOrThrow = (value: unknown): number => {
  try {
    return normalizeRuntimeAdapterCommandSequence(value);
  } catch {
    throw new RuntimeAdapterError('E_BAD_QUERY', 'runtime adapter commandSequence must be a positive safe integer');
  }
};

const reconcilePendingCommand = (env: RuntimeReplica, laneId: string): PendingRuntimeAdapterCommand | undefined => {
  const commands = pendingRuntimeAdapterCommands.get(env);
  if (!commands) return undefined;
  const pending = commands.get(laneId);
  if (!pending) return undefined;
  const committed = readRuntimeAdapterCommandFrontier(env, laneId);
  if (
    (pending.expiresAtMs !== null && pending.expiresAtMs <= Date.now())
    || (committed && committed.lastContiguousSequence >= pending.sequence)
  ) {
    commands.delete(laneId);
    return undefined;
  }
  return pending;
};

export const prunePendingCommands = (env: RuntimeReplica): void => {
  const commands = pendingRuntimeAdapterCommands.get(env);
  if (!commands) return;
  for (const laneId of commands.keys()) reconcilePendingCommand(env, laneId);
  if (commands.size === 0) pendingRuntimeAdapterCommands.delete(env);
};

const countUncommittedPendingLanes = (env: RuntimeReplica): number => {
  let count = 0;
  for (const laneId of pendingRuntimeAdapterCommands.get(env)?.keys() ?? []) {
    if (!readRuntimeAdapterCommandFrontier(env, laneId)) count += 1;
  }
  return count;
};

const sendCommittedRuntimeAdapterCommand = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'send'>,
  env: RuntimeReplica,
  laneId: string,
  commandId: string,
  commandSequence: number,
  inputHash: string,
  diagnostic: RuntimeAdapterDiagnostic,
): boolean => {
  const committed = readRuntimeAdapterCommandFrontier(env, laneId);
  const committedSequence = committed?.lastContiguousSequence ?? 0;
  if (commandSequence > committedSequence) return false;
  if (
    commandSequence === committedSequence &&
    (committed?.lastInputHash !== inputHash ||
      committed.lastCommandId !== commandId)
  ) {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      'runtime adapter commandId was reused with a different payload',
    );
  }
  sendOk(
    ws,
    msg.id,
    {
      height:
        committed?.observedHeight ??
        Math.max(0, Math.floor(Number(env.state.height ?? 0))),
      status: 'observed',
      commandSequence,
    },
    diagnostic(),
  );
  return true;
};

const sendPendingRuntimeAdapterCommand = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'send'>,
  pending: PendingRuntimeAdapterCommand | undefined,
  commandId: string,
  commandSequence: number,
  inputHash: string,
  diagnostic: RuntimeAdapterDiagnostic,
): boolean => {
  if (!pending) return false;
  if (
    pending.sequence === commandSequence &&
    pending.commandId === commandId &&
    pending.inputHash === inputHash
  ) {
    sendOk(ws, msg.id, structuredClone(pending.result), diagnostic());
    return true;
  }
  if (pending.sequence === commandSequence) {
    throw new RuntimeAdapterError(
      'E_COMMAND_PENDING',
      'runtime adapter command sequence is occupied by another pending command',
      true,
      250,
    );
  }
  throw new RuntimeAdapterError(
    'E_COMMAND_PENDING',
    `runtime adapter command ${pending.sequence} is not durable yet`,
    true,
    250,
  );
};

const assertRuntimeAdapterCommandCapacity = (
  env: RuntimeReplica,
  laneId: string,
): void => {
  if (readRuntimeAdapterCommandFrontier(env, laneId)) return;
  const activeLaneCount = countActiveRuntimeAdapterCommandLanes(env);
  const pendingLaneCount = countUncommittedPendingLanes(env);
  if (
    activeLaneCount + pendingLaneCount <
    MAX_ACTIVE_RUNTIME_ADAPTER_COMMAND_LANES
  ) {
    return;
  }
  throw new RuntimeAdapterError(
    'E_RATE_LIMITED',
    `runtime adapter active command lane capacity exceeded: ${activeLaneCount + pendingLaneCount}`,
    true,
    1_000,
  );
};

const enqueueRuntimeAdapterCommand = (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'send'>,
  env: RuntimeReplica,
  deps: RuntimeAdapterServerDeps,
  laneId: string,
  commandId: string,
  commandSequence: number,
  inputHash: string,
  expiresAtMs: number | null,
  diagnostic: RuntimeAdapterDiagnostic,
): void => {
  if (
    msg.input.runtimeTxs.some(
      tx => tx.type === 'recordRuntimeAdapterCommand',
    )
  ) {
    throw new RuntimeAdapterError(
      'E_BAD_QUERY',
      'runtime adapter command marker is server-internal',
    );
  }
  const markedInput = structuredClone(msg.input);
  const commandMarker = markLocalRuntimeAdapterCommandTx({
    type: 'recordRuntimeAdapterCommand',
    data: {
      laneId,
      sequence: commandSequence,
      commandId,
      inputHash,
      expiresAtMs,
    },
  });
  markedInput.runtimeTxs.push(commandMarker);
  deps.validateRuntimeInputAdmission?.(env, markedInput);
  const acceptedHeight = Math.max(0, Math.floor(Number(env.state.height ?? 0)));
  deps.enqueueRuntimeInput(env, markedInput);
  const result = {
    height: acceptedHeight,
    status: 'pending' as const,
    commandSequence,
  };
  pendingCommandsFor(env).set(laneId, {
    sequence: commandSequence,
    commandId,
    inputHash,
    expiresAtMs,
    result: structuredClone(result),
  });
  sendOk(ws, msg.id, result, diagnostic());
};

export const handleRuntimeAdapterSend = async (
  ws: RuntimeAdapterSocket,
  msg: RuntimeAdapterRequestByOp<'send'>,
  env: RuntimeReplica,
  state: AdapterClientState,
  deps: RuntimeAdapterServerDeps,
  diagnostic: RuntimeAdapterDiagnostic,
): Promise<void> => {
  await withRuntimeCommittedRead(env, () => {
    requireAuth(state, 'admin');
    requireBucket(state.sendBucket, 'send');
    requireMutatingRuntimeAdapterReady(env, deps);
    const laneId = state.commandLaneId;
    const expiresAtMs = state.commandFrontierExpiresAtMs;
    if (
      !laneId ||
      !state.commandLaneKind ||
      (state.commandLaneKind === 'capability' && !expiresAtMs)
    ) {
      throw new RuntimeAdapterError(
        'E_UNAUTHORIZED',
        'runtime adapter command lane is unavailable',
      );
    }
    const commandId = normalizeCommandId(msg.commandId);
    const commandSequence = commandSequenceOrThrow(msg.commandSequence);
    const inputHash = runtimeInputHash(msg.input);
    if (
      sendCommittedRuntimeAdapterCommand(
        ws,
        msg,
        env,
        laneId,
        commandId,
        commandSequence,
        inputHash,
        diagnostic,
      )
    ) {
      return;
    }
    const committedSequence =
      readRuntimeAdapterCommandFrontier(env, laneId)?.lastContiguousSequence ?? 0;
    const expectedSequence = committedSequence + 1;
    if (commandSequence !== expectedSequence) {
      throw new RuntimeAdapterError(
        'E_COMMAND_PENDING',
        `runtime adapter command sequence gap: expected=${expectedSequence} actual=${commandSequence}`,
        true,
        250,
      );
    }
    if (
      sendPendingRuntimeAdapterCommand(
        ws,
        msg,
        reconcilePendingCommand(env, laneId),
        commandId,
        commandSequence,
        inputHash,
        diagnostic,
      )
    ) {
      return;
    }
    assertRuntimeAdapterCommandCapacity(env, laneId);
    enqueueRuntimeAdapterCommand(
      ws,
      msg,
      env,
      deps,
      laneId,
      commandId,
      commandSequence,
      inputHash,
      expiresAtMs,
      diagnostic,
    );
  });
};
