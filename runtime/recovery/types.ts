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
  runtimeId: string;
  runtimeHeight: number;
  runtimeTimestamp: number;
  createdAt: number;
  signers: RuntimeRecoverySignerV1[];
  checkpoint: Record<string, unknown>;
  checkpointHash: string;
  meta?: RuntimeRecoveryMetaV1;
};

export type EncryptedRuntimeRecoveryBundleV1 = {
  version: 1;
  runtimeId: string;
  lookupKey: string;
  height: number;
  createdAt: number;
  bundleHash: string;
  iv: string;
  ciphertext: string;
  compression?: 'gzip';
};

export type TowerModeV1 =
  | 'blind_backup'
  | 'active_watchtower'
  | 'delayed_last_resort';

export type TowerActionKindV1 = 'counter_dispute_only';

export type TowerFinalDisputeProofV2 = {
  counterentity: string;
  finalNonce: number;
  finalProofbody: Record<string, unknown>;
  leftArguments: string;
  rightArguments: string;
  starterIncrementedArguments: string;
  sig: string;
};

export type TowerCounterDisputeRemedyV2 = {
  version: 2;
  type: 'counter_dispute_remedy';
  rpcUrl: string;
  chainId: number;
  depositoryAddress: string;
  watchedEntityId: string;
  towerAddress: string;
  lastResortWindowBlocks: number;
  appointmentSequence: number;
  ownerAuthorizationHanko: string;
  latestProof: TowerFinalDisputeProofV2;
};

export type TowerEncryptedPayloadV1 = {
  version: 1;
  type: 'tower_encrypted_payload';
  alg: 'secp256k1-aes-256-gcm';
  epk: string;
  iv: string;
  ciphertext: string;
  plaintextHash: string;
};

export type TowerActivePayloadV1 = {
  triggerHint: string;
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
  activePayload?: TowerActivePayloadV1;
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
};

export type TowerDiscoverResponseV1 = {
  ok: true;
  lookupKey: string;
  available: boolean;
  latestReceipt: TowerReceiptV1 | null;
};
