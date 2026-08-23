export type CryptoProfileName =
  | '2-sign-2-recover'
  | '4-sign-4-recover'
  | '8-sign-8-recover'
  | '12-sign-12-recover';

export type CryptoProfile = Readonly<{
  name: CryptoProfileName;
  signaturesPerPayment: number;
  recoversPerPayment: number;
  extraHashesPerPayment: number;
}>;

export const CRYPTO_PROFILES: readonly CryptoProfile[] = [
  { name: '2-sign-2-recover', signaturesPerPayment: 2, recoversPerPayment: 2, extraHashesPerPayment: 4 },
  { name: '4-sign-4-recover', signaturesPerPayment: 4, recoversPerPayment: 4, extraHashesPerPayment: 8 },
  { name: '8-sign-8-recover', signaturesPerPayment: 8, recoversPerPayment: 8, extraHashesPerPayment: 16 },
  { name: '12-sign-12-recover', signaturesPerPayment: 12, recoversPerPayment: 12, extraHashesPerPayment: 32 },
];

export type PaymentWorkRequest = Readonly<{
  startPayment: number;
  payments: number;
  profile: CryptoProfile;
}>;

export type PaymentWorkResult = Readonly<{
  startPayment: number;
  payments: number;
  elapsedMs: number;
  signatures: number;
  recovers: number;
  keccaks: number;
  binaryPreimageBytes: number;
  output: Uint8Array;
}>;

export type ComputeMeasurement = Readonly<{
  profile: CryptoProfileName;
  workers: number;
  payments: number;
  wallMs: number;
  workerCpuMs: number;
  reduceMs: number;
  tps: number;
  signatures: number;
  recovers: number;
  keccaks: number;
  binaryPreimageBytes: number;
  outputBytes: number;
  root: string;
}>;

export type StorageMode = 'leveldb-async' | 'leveldb-fsync';

export type StorageMeasurement = Readonly<{
  mode: StorageMode;
  payments: number;
  batchSize: number;
  batches: number;
  valueBytesPerPayment: number;
  logicalBytes: number;
  diskBytes: number;
  wallMs: number;
  tps: number;
}>;

export type PrimitiveRate = Readonly<{
  primitive: 'keccak256-64b' | 'secp256k1-sign' | 'secp256k1-recover';
  operations: number;
  wallMs: number;
  operationsPerSecond: number;
  microsecondsPerOperation: number;
}>;
