import { constants, cpSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Level } from 'level';
import { runOrderId } from '../../../../../core/scenarios/usdc-poc/journey/context';
import { dbRootPath } from '../../../../../core/runtime/replica/platform';
import {
  closeInfraDb,
  closeRuntimeDb,
  getRuntimeWalDb,
  loadEnvFromStorageByReplay,
  readPersistedStorageFrameRecord,
} from '../../../../../core/runtime';
import type { RuntimeReplica } from '../../../../../core/runtime/types';
import { evmAttemptSlot, readEvmAttemptHistory } from '../../../../../core/storage/queries/evm-attempts';
import { acquireStoreOwnership, SessionStoreBusyError } from '../../operators/session/stores';
import { ObservationUnavailable } from '../boundary';
import type { ExecutionAuthority } from '../authority';
import type { StatusConfig } from '../config';
import { committedAttemptHashes, receiptSlots } from '../receipt-event';
import { observeEntityPosition } from './position';

type ReceiptSlot = ReturnType<typeof receiptSlots>[number];

const historyBudgetError = 'USDC_STATUS_WAL_ATTEMPT_HISTORY_BUDGET';

const copyStoppedData = (role: 'user' | 'hub', store: string, relative: string, destination: string): void => {
  const release = acquireStoreOwnership([[role, store]], true);
  try {
    cpSync(join(store, relative), destination, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter(path) {
        const entry = lstatSync(path);
        if (!entry.isDirectory() && !entry.isFile()) throw new Error('USDC_STATUS_WAL_ENTRY_INVALID');
        return true;
      },
    });
  } finally {
    release();
  }
};

const readStates = (env: RuntimeReplica, authority: ExecutionAuthority, runId: string) => {
  if (env.state.jReplicas.size !== 2 || env.state.eReplicas.size !== 2)
    throw new Error('USDC_STATUS_WAL_STACK_MISMATCH');
  const orderId = runOrderId(authority.chains[0]!.userEntity, runId);
  return authority.chains.map(chain => {
    const jurisdiction = [...env.state.jReplicas.values()].find(replica => replica.chainId === chain.chainId);
    const entity = [...env.state.eReplicas.values()].find(
      replica =>
        replica.entityId.toLowerCase() === chain.userEntity && replica.signerId.toLowerCase() === chain.userSigner,
    );
    if (
      !entity ||
      jurisdiction?.contracts?.depository?.toLowerCase() !== chain.depository ||
      jurisdiction.contracts.entityProvider?.toLowerCase() !== chain.entityProvider
    )
      throw new Error('USDC_STATUS_WAL_STACK_MISMATCH');
    return observeEntityPosition(entity.state, chain, orderId);
  });
};

export const inspectUserWal = async (
  authority: ExecutionAuthority,
  runId: string,
  slots: readonly ReceiptSlot[],
  source?: RuntimeReplica,
) => {
  const runtimeId = authority.chains[0]!.userSigner;
  const restored = await loadEnvFromStorageByReplay(runtimeId, null, undefined, {
    readOnly: true,
    materializedOnly: true,
    ...(source ? { borrowRuntimeWalFrom: source } : {}),
  });
  if (!restored) throw new ObservationUnavailable('USDC_STATUS_WAL_EMPTY');
  const { env } = restored;
  try {
    const height = env.state.height;
    const frame = await readPersistedStorageFrameRecord(env, height);
    if (!frame?.materializedState) throw new Error('USDC_STATUS_WAL_FRAME_MISSING');
    const isHead = height === restored.latestHeight;
    const hashes = committedAttemptHashes(env);
    const keys = new Set(slots.map(([, , chain, payer, nonce]) => evmAttemptSlot(chain.chainId, payer.address, nonce)));
    const historyComplete = await readEvmAttemptHistory(getRuntimeWalDb(env), keys, hashes, restored.latestHeight);
    return {
      heights: { materialized: height, head: restored.latestHeight },
      state: isHead ? { height, entities: readStates(env, authority, runId) } : null,
      hashes,
      error: isHead ? null : 'USDC_STATUS_WAL_HEAD_NOT_MATERIALIZED',
      historyError: historyComplete ? null : historyBudgetError,
    };
  } finally {
    await Promise.all([closeRuntimeDb(env), closeInfraDb(env)]);
  }
};

export const observeWal = async (
  config: StatusConfig,
  authority: ExecutionAuthority,
  scratch: string,
  slots: readonly ReceiptSlot[],
) => {
  const database = join(scratch, 'db');
  const store = config.stand.stores.user;
  try {
    if (dbRootPath !== database) throw new Error('USDC_STATUS_WAL_SNAPSHOT_PATH_UNBOUND');
    if (!store) throw new ObservationUnavailable('USDC_STATUS_WAL_STORE_MISSING');
    try {
      copyStoppedData('user', store, 'db', database);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new ObservationUnavailable('USDC_STATUS_WAL_STORE_MISSING');
      throw error;
    }
    return await inspectUserWal(authority, config.runId, slots);
  } catch (error) {
    if (!(error instanceof ObservationUnavailable || error instanceof SessionStoreBusyError)) throw error;
    return { state: null, heights: null, hashes: new Map<string, string[]>(), error: error.code, historyError: null };
  }
};

export const observeHubCover = async (
  store: string | null,
  scratch: string,
  runtimeId: string,
  slot: ReturnType<typeof receiptSlots>[3],
) => {
  const [, , chain, payer, nonce] = slot;
  const key = evmAttemptSlot(chain.chainId, payer.address, nonce);
  const path = join(scratch, 'hub-wal');
  try {
    if (!store) throw new ObservationUnavailable('USDC_STATUS_HUB_WAL_STORE_MISSING');
    copyStoppedData('hub', store, join('db', `${runtimeId}-wal`), path);
    const db = new Level<Buffer, Buffer>(path, {
      createIfMissing: false,
      keyEncoding: 'binary',
      valueEncoding: 'buffer',
    });
    try {
      await db.open();
      const hashes = new Map<string, string[]>();
      const complete = await readEvmAttemptHistory(db, new Set([key]), hashes);
      return {
        key,
        hashes: hashes.get(key) ?? [],
        error: complete ? null : historyBudgetError,
      };
    } finally {
      await db.close();
    }
  } catch (error) {
    const unavailable = error instanceof ObservationUnavailable || error instanceof SessionStoreBusyError;
    if (!unavailable && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return {
      key,
      hashes: [],
      error: unavailable ? error.message : 'USDC_STATUS_HUB_WAL_STORE_MISSING',
    };
  }
};
