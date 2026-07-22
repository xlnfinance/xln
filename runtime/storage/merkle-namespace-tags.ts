export const STORAGE_MERKLE_NAMESPACE_TAG = {
  'runtime-roots': 0x01,
  'entity-core': 0x02,
  accounts: 0x03,
  books: 0x04,
  'lock-book': 0x05,
  'account-deltas': 0x06,
  'account-locks': 0x07,
  'account-swap-offers': 0x08,
  'htlc-routes': 0x09,
} as const;

export type StorageMerkleNamespace = keyof typeof STORAGE_MERKLE_NAMESPACE_TAG;

export const STORAGE_MERKLE_NAMESPACE_BY_TAG = new Map<number, StorageMerkleNamespace>(
  Object.entries(STORAGE_MERKLE_NAMESPACE_TAG).map(([namespace, tag]) => [
    tag,
    namespace as StorageMerkleNamespace,
  ]),
);
