import { ethers } from 'ethers';

// Storage slots of the canonical EVM contracts, taken from
// `forge inspect <contract> storageLayout`. Any reorder of state variables in
// Depository.sol or EntityProvider.sol must update this table; the real-chain
// test compares every derived slot with the contract getter.
const DEPOSITORY_SLOTS = {
  reserves: 1n,
  debts: 5n,
  debtIndex: 6n,
  debtOutstanding: 7n,
  activeDebts: 8n,
  tokens: 9n,
  entityNonces: 11n,
  inActiveDebts: 12n,
} as const;

const ENTITY_PROVIDER_SLOTS = {
  entities: 3n,
  nextNumber: 4n,
  entityActionNonces: 5n,
  boardEpochs: 7n,
  committedBoards: 11n,
} as const;

// Word offsets inside EntityProvider.Entity.
export const ENTITY_FIELD_OFFSETS = {
  currentBoardHash: 0n,
  previousBoardHash: 1n,
  previousBoardValidUntil: 2n,
  proposedBoardHash: 3n,
  activateAt: 4n,
  registrationBlock: 5n,
  previousBoardHash2: 8n,
  previousBoardValidUntil2: 9n,
} as const;

const ABI = ethers.AbiCoder.defaultAbiCoder();

const word = (value: bigint): bigint => {
  if (value < 0n || value >= 1n << 256n) throw new Error(`STORAGE_SLOT_OUT_OF_RANGE:${value.toString()}`);
  return value;
};

const bytes32Key = (key: string): string => {
  const normalized = key.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`STORAGE_SLOT_KEY_INVALID:${key}`);
  return normalized;
};

/** Slot of `mapping(bytes32 => V)` at `slot`. */
const bytes32MappingSlot = (key: string, slot: bigint): bigint =>
  BigInt(ethers.keccak256(ABI.encode(['bytes32', 'uint256'], [bytes32Key(key), word(slot)])));

/** Slot of `mapping(uint256 => V)` at `slot`. */
const uintMappingSlot = (key: bigint, slot: bigint): bigint =>
  BigInt(ethers.keccak256(ABI.encode(['uint256', 'uint256'], [word(key), word(slot)])));

export const depositoryReserveSlot = (entityId: string, tokenId: bigint): bigint =>
  uintMappingSlot(tokenId, bytes32MappingSlot(entityId, DEPOSITORY_SLOTS.reserves));

/** Length slot of `_debts[debtor][tokenId]`; elements start at keccak256(lengthSlot). */
export const depositoryDebtQueueSlot = (debtor: string, tokenId: bigint): bigint =>
  uintMappingSlot(tokenId, bytes32MappingSlot(debtor, DEPOSITORY_SLOTS.debts));

// Types.Debt is { bytes32 creditor; Uint512 { high; low } amount; uint64 createdBlock; uint192 createdSeq }:
// four words, the last packing createdBlock in its low 64 bits and createdSeq above it.
const DEBT_ENTRY_WORDS = 4n;

/** Word `offset` (0 creditor, 1 amount.high, 2 amount.low, 3 generation) of queue entry `index`. */
export const depositoryDebtEntrySlot = (debtor: string, tokenId: bigint, index: bigint, offset: 0n | 1n | 2n | 3n): bigint =>
  word(BigInt(ethers.keccak256(ABI.encode(['uint256'], [depositoryDebtQueueSlot(debtor, tokenId)]))) + index * DEBT_ENTRY_WORDS + offset);

export const depositoryDebtIndexSlot = (debtor: string, tokenId: bigint): bigint =>
  uintMappingSlot(tokenId, bytes32MappingSlot(debtor, DEPOSITORY_SLOTS.debtIndex));

/** Word `offset` (0 high, 1 middle, 2 low) of the Uint768 `debtOutstanding[debtor][tokenId]`. */
export const depositoryDebtOutstandingSlot = (debtor: string, tokenId: bigint, offset: 0n | 1n | 2n): bigint =>
  word(uintMappingSlot(tokenId, bytes32MappingSlot(debtor, DEPOSITORY_SLOTS.debtOutstanding)) + offset);

export const depositoryActiveDebtsSlot = (debtor: string): bigint =>
  bytes32MappingSlot(debtor, DEPOSITORY_SLOTS.activeDebts);

/** `inActiveDebts[creditor]`: live debt entries owed to `creditor` across all debtors and tokens. */
export const depositoryInActiveDebtsSlot = (creditor: string): bigint =>
  bytes32MappingSlot(creditor, DEPOSITORY_SLOTS.inActiveDebts);

export const depositoryEntityNonceSlot = (entityId: string): bigint =>
  bytes32MappingSlot(entityId, DEPOSITORY_SLOTS.entityNonces);

export const depositoryTokenCountSlot = (): bigint => DEPOSITORY_SLOTS.tokens;

export const entityProviderFieldSlot = (
  entityId: string,
  field: keyof typeof ENTITY_FIELD_OFFSETS,
): bigint => word(bytes32MappingSlot(entityId, ENTITY_PROVIDER_SLOTS.entities) + ENTITY_FIELD_OFFSETS[field]);

export const entityProviderNextNumberSlot = (): bigint => ENTITY_PROVIDER_SLOTS.nextNumber;

export const entityProviderBoardEpochSlot = (entityId: string): bigint =>
  bytes32MappingSlot(entityId, ENTITY_PROVIDER_SLOTS.boardEpochs);

export const entityProviderActionNonceSlot = (entityId: string): bigint =>
  bytes32MappingSlot(entityId, ENTITY_PROVIDER_SLOTS.entityActionNonces);

export const entityProviderCommittedBoardSlot = (boardHash: string): bigint =>
  bytes32MappingSlot(boardHash, ENTITY_PROVIDER_SLOTS.committedBoards);
