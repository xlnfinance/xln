import type { AccountTx } from '../../types/account';
import { decodeAccountPeerInput } from '../../account/validation/input-validation';
import { parseAccountJClaimNode } from '../../account/j-claims/j-claim-codec';
import { validateJReplicas } from '../../storage/wal/runtime-machine-schema/j';
import { normalizeTsWorkerAccountId } from './sharding';
import { requireWorkerAccount, type TsAccountWorkerState } from './worker-state';
import type {
  TsAccountWorkerInboundPayload,
  TsAccountWorkerInitPayload,
  TsAccountWorkerOutboundPayload,
  TsAccountWorkerPhasePayload,
} from './protocol';

const requireRecord = (value: unknown, code: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const requireArray = (value: unknown, code: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
};

const requireString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
};

const requireInteger = (value: unknown, code: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
};

const requireBoolean = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

const pairs = (input: Record<string, unknown>, field: string): Array<readonly [unknown, unknown]> =>
  requireArray(input[field], `TS_ACCOUNT_WORKER_INIT_${field.toUpperCase()}`).map((entry, index) => {
    const pair = requireArray(entry, `TS_ACCOUNT_WORKER_INIT_${field.toUpperCase()}_${index}`);
    if (pair.length !== 2) throw new Error(`TS_ACCOUNT_WORKER_INIT_${field.toUpperCase()}_${index}_PAIR`);
    return [pair[0], pair[1]] as const;
  });

export const decodeWorkerInitPayload = (value: unknown): TsAccountWorkerInitPayload => {
  const input = requireRecord(value, 'TS_ACCOUNT_WORKER_INIT_INVALID');
  const workerIndex = requireInteger(input['workerIndex'], 'TS_ACCOUNT_WORKER_INIT_INDEX');
  const workerCount = requireInteger(input['workerCount'], 'TS_ACCOUNT_WORKER_INIT_COUNT');
  if (workerCount === 0 || workerIndex >= workerCount) throw new Error('TS_ACCOUNT_WORKER_INIT_SLOT');
  return {
    workerIndex,
    workerCount,
    ownedShardIds: requireArray(
      input['ownedShardIds'],
      'TS_ACCOUNT_WORKER_INIT_OWNED_SHARDS',
    ).map((shardId, index) => requireInteger(
      shardId,
      `TS_ACCOUNT_WORKER_INIT_OWNED_SHARD_${index}`,
    )),
    ownerEntityId: normalizeTsWorkerAccountId(requireString(
      input['ownerEntityId'],
      'TS_ACCOUNT_WORKER_INIT_OWNER',
    )),
    accounts: pairs(input, 'accounts').map(([accountId, account]) => [
      normalizeTsWorkerAccountId(requireString(accountId, 'TS_ACCOUNT_WORKER_INIT_ACCOUNT_ID')),
      requireRecord(account, 'TS_ACCOUNT_WORKER_INIT_ACCOUNT'),
    ]),
    jReplicas: pairs(input, 'jReplicas').map(([key, replica], index) => {
      const decoded = validateJReplicas(
        [[requireString(key, 'TS_ACCOUNT_WORKER_INIT_J_KEY'), replica]],
        `TS_ACCOUNT_WORKER_INIT_J_REPLICA_${index}`,
      )[0];
      if (decoded === undefined) throw new Error(`TS_ACCOUNT_WORKER_INIT_J_REPLICA_${index}`);
      return decoded;
    }),
    jClaimNodes: pairs(input, 'jClaimNodes').map(([hash, node]) => [
      requireString(hash, 'TS_ACCOUNT_WORKER_INIT_JCLAIM_HASH'),
      parseAccountJClaimNode(node),
    ]),
    settlementBoardAuthorities: pairs(input, 'settlementBoardAuthorities').map(([entityId, boardHash]) => [
      normalizeTsWorkerAccountId(requireString(entityId, 'TS_ACCOUNT_WORKER_INIT_BOARD_ENTITY')),
      requireString(boardHash, 'TS_ACCOUNT_WORKER_INIT_BOARD_HASH').toLowerCase(),
    ]),
  };
};

const decodeInboundPayload = (
  worker: TsAccountWorkerState,
  input: Record<string, unknown>,
): TsAccountWorkerInboundPayload => {
  const frameId = requireString(input['frameId'], 'TS_ACCOUNT_WORKER_INBOUND_FRAME');
  const restorePrevious = requireBoolean(
    input['restorePrevious'],
    'TS_ACCOUNT_WORKER_INBOUND_RESTORE_PREVIOUS',
  );
  const entityTimestamp = requireInteger(input['entityTimestamp'], 'TS_ACCOUNT_WORKER_INBOUND_TIMESTAMP');
  const finalizedJHeight = requireInteger(input['finalizedJHeight'], 'TS_ACCOUNT_WORKER_INBOUND_JHEIGHT');
  const inputs = requireArray(input['inputs'], 'TS_ACCOUNT_WORKER_INBOUND_INPUTS').map((entry, index) => {
    const row = requireRecord(entry, `TS_ACCOUNT_WORKER_INBOUND_${index}`);
    const accountId = requireWorkerAccount(
      worker,
      requireString(row['accountId'], `TS_ACCOUNT_WORKER_INBOUND_${index}_ACCOUNT`),
    );
    const peerInput = decodeAccountPeerInput(row['input'], `TS_ACCOUNT_WORKER_INBOUND_${index}_INPUT`);
    if (
      peerInput.fromEntityId.toLowerCase() !== accountId
      || peerInput.toEntityId.toLowerCase() !== worker.ownerEntityId
    ) throw new Error(`TS_ACCOUNT_WORKER_INBOUND_PARTICIPANTS:${accountId}`);
    return {
      order: requireInteger(row['order'], `TS_ACCOUNT_WORKER_INBOUND_${index}_ORDER`),
      accountId,
      input: peerInput,
    };
  });
  return { phase: 'inbound', frameId, restorePrevious, entityTimestamp, finalizedJHeight, inputs };
};

const decodeOutboundPayload = (
  worker: TsAccountWorkerState,
  input: Record<string, unknown>,
): TsAccountWorkerOutboundPayload => {
  const txs = requireArray(input['txs'], 'TS_ACCOUNT_WORKER_OUTBOUND_TXS').map((entry, index) => {
    const row = requireRecord(entry, `TS_ACCOUNT_WORKER_OUTBOUND_TXS_${index}`);
    return {
      order: requireInteger(row['order'], `TS_ACCOUNT_WORKER_OUTBOUND_TXS_${index}_ORDER`),
      accountId: requireWorkerAccount(
        worker,
        requireString(row['accountId'], `TS_ACCOUNT_WORKER_OUTBOUND_TXS_${index}_ACCOUNT`),
      ),
      // These are already-typed Entity-owned Account transactions crossing an
      // internal isolate boundary, not a new protocol admission boundary.
      // Preserve the sequential path exactly: enqueue first, then let the one
      // canonical Account transition accept or reject the candidate frame.
      txs: requireArray(
        row['txs'],
        `TS_ACCOUNT_WORKER_OUTBOUND_TXS_${index}_VALUE`,
      ) as AccountTx[],
    };
  });
  const proposals = requireArray(input['proposals'], 'TS_ACCOUNT_WORKER_OUTBOUND_PROPOSALS')
    .map((entry, index) => {
      const row = requireRecord(entry, `TS_ACCOUNT_WORKER_OUTBOUND_PROPOSAL_${index}`);
      return {
        order: requireInteger(row['order'], `TS_ACCOUNT_WORKER_OUTBOUND_PROPOSAL_${index}_ORDER`),
        accountId: requireWorkerAccount(
          worker,
          requireString(row['accountId'], `TS_ACCOUNT_WORKER_OUTBOUND_PROPOSAL_${index}_ACCOUNT`),
        ),
      };
    });
  if (new Set(proposals.map(proposal => proposal.accountId)).size !== proposals.length) {
    throw new Error('TS_ACCOUNT_WORKER_OUTBOUND_PROPOSAL_DUPLICATE');
  }
  return {
    phase: 'outbound',
    frameId: requireString(input['frameId'], 'TS_ACCOUNT_WORKER_OUTBOUND_FRAME'),
    restorePrevious: requireBoolean(
      input['restorePrevious'],
      'TS_ACCOUNT_WORKER_OUTBOUND_RESTORE_PREVIOUS',
    ),
    timestamp: requireInteger(input['timestamp'], 'TS_ACCOUNT_WORKER_OUTBOUND_TIMESTAMP'),
    jHeight: requireInteger(input['jHeight'], 'TS_ACCOUNT_WORKER_OUTBOUND_JHEIGHT'),
    txs,
    proposals,
    checkpointDue: requireBoolean(input['checkpointDue'], 'TS_ACCOUNT_WORKER_OUTBOUND_CHECKPOINT'),
  };
};

export const decodeWorkerPhasePayload = (
  worker: TsAccountWorkerState,
  value: unknown,
): TsAccountWorkerPhasePayload => {
  const input = requireRecord(value, 'TS_ACCOUNT_WORKER_PHASE_INVALID');
  const phase = requireString(input['phase'], 'TS_ACCOUNT_WORKER_PHASE_KIND');
  if (phase === 'inbound') return decodeInboundPayload(worker, input);
  if (phase === 'outbound') return decodeOutboundPayload(worker, input);
  throw new Error(`TS_ACCOUNT_WORKER_PHASE_UNKNOWN:${phase}`);
};
