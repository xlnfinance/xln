import type { TowerAppointmentV1 } from '../../storage/recovery/bundle/types';
import { closeWatchtowerStore, createWatchtowerStoreContext } from './db';
import { getLatest, getLatestReceipt, listLatestLastResortAppointments, upsertAppointment } from './appointments';
import { appendActionReceipt, appendComplaint, getStats, listActionReceipts, pruneExpired } from './actions';
import type { StoredTowerActionReceipt, WatchtowerStoreOptions } from './types';

export type {
  LastResortTowerAppointment,
  StoredTowerActionReceipt,
  WatchtowerStoreOptions,
} from './types';

export const createWatchtowerStore = (options: WatchtowerStoreOptions = {}) => {
  const context = createWatchtowerStoreContext(options);
  return {
    towerId: context.towerId,
    dbPath: context.dbPath,
    maxBundlesPerLookupKey: context.maxBundlesPerLookupKey,
    maxStoredBytesPerLookupKey: context.maxStoredBytesPerLookupKey,
    signerAddress: context.signer.address.toLowerCase(),
    upsertAppointment: (appointment: TowerAppointmentV1) => upsertAppointment(context, appointment),
    getLatest: (lookupKey: string) => getLatest(context, lookupKey),
    getLatestReceipt: (lookupKey: string) => getLatestReceipt(context, lookupKey),
    listLatestLastResortAppointments: () => listLatestLastResortAppointments(context),
    appendActionReceipt: (receipt: StoredTowerActionReceipt) => appendActionReceipt(context, receipt),
    listActionReceipts: (lookupKey: string) => listActionReceipts(context, lookupKey),
    appendComplaint: (payload: Record<string, unknown>) => appendComplaint(context, payload),
    getStats: () => getStats(context),
    pruneExpired: () => pruneExpired(context),
    close: () => closeWatchtowerStore(context),
  };
};

export type WatchtowerStore = ReturnType<typeof createWatchtowerStore>;
