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
};

export type TowerAppointmentOwnerProofV1 = {
  runtimeId: string;
  signedAt: number;
  signature: string;
};

export type TowerAppointmentV1 = {
  type: 'tower_appointment';
  version: 1;
  lookupKey: string;
  bundle: EncryptedRuntimeRecoveryBundleV1;
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
  receivedAt: number;
  sequence: number;
  retainedSlots: number;
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
