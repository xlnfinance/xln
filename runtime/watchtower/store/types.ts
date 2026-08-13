import type { Wallet } from 'ethers';
import type { Level } from 'level';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  TowerLastResortPayloadV1,
  TowerModeV1,
  TowerReceiptV1,
} from '../../storage/recovery/bundle/types';

export type StoredLookupDoc = {
  lookupKey: string;
  runtimeId: string;
  updatedAt: number;
  receipts: TowerReceiptV1[];
  bundles: Array<{
    slot: number;
    towerMode: TowerModeV1;
    bundle: EncryptedRuntimeRecoveryBundleV1;
    ownerSignedAt: number;
    encryptedEnvelopeHash: string;
    lastResortPayloadDigest: string;
    lastResortPayload?: TowerLastResortPayloadV1;
  }>;
};

export type StoredTowerMetaStats = {
  actionReceiptCount: number;
};

export type StoredTowerActionReceipt = {
  id: string;
  lookupKey: string;
  runtimeId: string;
  towerMode: TowerModeV1;
  actionKind: 'counter_dispute_only';
  triggerHint: string;
  appointmentSequence: number;
  txHash?: string;
  status: 'submitted' | 'skipped' | 'error';
  blockNumber?: number;
  error?: string;
  createdAt: number;
};

export type LastResortTowerAppointment = {
  lookupKey: string;
  runtimeId: string;
  towerMode: TowerModeV1;
  slot: number;
  bundle: EncryptedRuntimeRecoveryBundleV1;
  lastResortPayload: TowerLastResortPayloadV1;
};

export type WatchtowerStoreStats = {
  lookupCount: number;
  lastResortAppointmentCount: number;
  actionReceiptCount: number;
};

export type WatchtowerStoreOptions = {
  towerId?: string;
  dbPath?: string;
  maxBundlesPerLookupKey?: number;
  maxStoredBytesPerLookupKey?: number;
  maxLookupKeys?: number;
  maxTotalStoredBytes?: number;
  receiptTtlMs?: number;
  towerPrivateKey?: string;
  now?: () => number;
};

export type WatchtowerStoreContext = {
  towerId: string;
  dbPath: string;
  maxBundlesPerLookupKey: number;
  maxStoredBytesPerLookupKey: number;
  maxLookupKeys: number;
  maxTotalStoredBytes: number;
  receiptTtlMs: number;
  now(): number;
  signer: Wallet;
  db: Level<string, string>;
  opened: boolean;
  cachedStats: { cachedAt: number; value: WatchtowerStoreStats } | null;
  lookupUsage: { bytesByKey: Map<string, number>; totalStoredBytes: number } | null;
  appointmentWriteQueue: Promise<void>;
};
