import type { PersistedFrameJournal } from '../wal/store';

export type RuntimeRecoverySignerV1 = {
  index: number;
  derivationIndex?: number;
  address: string;
  name: string;
  entityId?: string;
  jurisdiction?: string;
};

export type RuntimeRecoveryMetaV1 = {
  label?: string;
  activeSignerIndex?: number;
  loginType?: 'manual' | 'demo';
  requiresOnboarding?: boolean;
  createdAt?: number;
};

export type RuntimeRecoveryBundleV1 = {
  version: 1;
  kind?: 'snapshot' | 'journal_tail';
  runtimeId: string;
  runtimeHeight: number;
  runtimeTimestamp: number;
  createdAt: number;
  signers: RuntimeRecoverySignerV1[];
  checkpoint?: Record<string, unknown>;
  checkpointHash?: string;
  baseRuntimeHeight?: number;
  baseCheckpointHash?: string;
  frames?: PersistedFrameJournal[];
  meta?: RuntimeRecoveryMetaV1;
};

export type EncryptedRuntimeRecoveryBundleV1 = {
  version: 1;
  kind?: 'snapshot' | 'journal_tail';
  runtimeId: string;
  lookupKey: string;
  height: number;
  createdAt: number;
  bundleHash: string;
  baseRuntimeHeight?: number;
  baseCheckpointHash?: string;
  iv: string;
  ciphertext: string;
  compression?: 'gzip';
};

export type TowerModeV1 =
  | 'blind_backup'
  | 'delayed_last_resort';

export const normalizeTowerModeV1 = (mode: unknown): TowerModeV1 => {
  const rawMode = String(mode || '').trim();
  if (!rawMode || rawMode === 'blind_backup') return 'blind_backup';
  if (rawMode === 'delayed_last_resort') return 'delayed_last_resort';
  throw new Error(`TOWER_MODE_INVALID:${rawMode}`);
};

export type TowerActionKindV1 = 'counter_dispute_only';

export type TowerFinalDisputeProof = {
  counterentity: string;
  finalNonce: number;
  finalProofbody: Record<string, unknown>;
  leftArguments: string;
  rightArguments: string;
  starterIncrementedArguments: string;
  sig: string;
};

export type TowerCounterDisputeRemedy = {
  version: 1;
  type: 'counter_dispute_remedy';
  rpcUrl: string;
  chainId: number;
  depositoryAddress: string;
  watchedEntityId: string;
  towerAddress: string;
  lastResortWindowBlocks: number;
  appointmentSequence: number;
  ownerAuthorizationHanko: string;
  latestProof: TowerFinalDisputeProof;
};

export type TowerEncryptedPayloadV1 = {
  version: 1;
  type: 'tower_encrypted_payload';
  alg: 'watch-seed-aes-256-gcm';
  iv: string;
  ciphertext: string;
};

export type TowerLastResortWatchV1 = {
  rpcUrl: string;
  chainId: number;
  depositoryAddress: string;
  watchedEntityId: string;
  counterentity: string;
};

export type TowerLastResortPayloadV1 = {
  triggerHint: string;
  watch: TowerLastResortWatchV1;
  encryptedRemedy: string;
  actionKind: TowerActionKindV1;
  appointmentSequence: number;
  proofNonce: number;
  proofBodyHash: string;
  responseMode: 'last_resort';
  lastResortWindowBlocks: number;
  safetyMarginBlocks: number;
  maxFeeToken?: string;
  feeBudget?: string;
};

export type TowerAppointmentOwnerProofV1 = {
  runtimeId: string;
  signedAt: number;
  signature: string;
};

export type TowerAppointmentV1 = {
  type: 'tower_appointment';
  version: 1;
  towerMode?: TowerModeV1;
  lookupKey: string;
  slot?: number;
  bundle: EncryptedRuntimeRecoveryBundleV1;
  lastResortPayload?: TowerLastResortPayloadV1;
  ownerProof: TowerAppointmentOwnerProofV1;
};

export type TowerReceiptV1 = {
  type: 'tower_receipt';
  version: 1;
  towerId: string;
  lookupKey: string;
  runtimeId: string;
  height: number;
  bundleHash: string;
  towerMode?: TowerModeV1;
  slot?: number;
  storedAt?: number;
  receivedAt: number;
  expiresAt?: number;
  sequence: number;
  retainedSlots: number;
  storedBytes?: number;
  maxStoredBytes?: number;
  quotaOk?: boolean;
  appointmentSequence?: number | null;
  towerSignature?: string;
};

export type TowerRestoreRequestV1 = {
  lookupKey: string;
};

export type TowerRestoreResponseV1 = {
  ok: true;
  receipt: TowerReceiptV1;
  bundle: EncryptedRuntimeRecoveryBundleV1;
  bundles?: EncryptedRuntimeRecoveryBundleV1[];
};

export type TowerDiscoverResponseV1 = {
  ok: true;
  lookupKey: string;
  available: boolean;
  latestReceipt: TowerReceiptV1 | null;
};
