/** Hash-domain brands prevent valid bytes32 values crossing authority domains. */
declare const FrameHashBrand: unique symbol;
declare const StateHashBrand: unique symbol;
declare const EvidenceHashBrand: unique symbol;
declare const BoardHashBrand: unique symbol;
declare const BoardProposalHashBrand: unique symbol;
declare const RuntimeOutputsDigestBrand: unique symbol;
declare const EntityContextPayloadHashBrand: unique symbol;
declare const RuntimeMachineRootHashBrand: unique symbol;

export type FrameHash = string & { readonly [FrameHashBrand]: typeof FrameHashBrand };
export type StateHash = string & { readonly [StateHashBrand]: typeof StateHashBrand };
export type EvidenceHash = string & { readonly [EvidenceHashBrand]: typeof EvidenceHashBrand };
export type BoardHash = string & { readonly [BoardHashBrand]: typeof BoardHashBrand };
export type BoardProposalHash = string & { readonly [BoardProposalHashBrand]: typeof BoardProposalHashBrand };
export type RuntimeOutputsDigest = string & {
  readonly [RuntimeOutputsDigestBrand]: typeof RuntimeOutputsDigestBrand;
};
export type EntityContextPayloadHash = string & {
  readonly [EntityContextPayloadHashBrand]: typeof EntityContextPayloadHashBrand;
};
export type RuntimeMachineRootHash = string & {
  readonly [RuntimeMachineRootHashBrand]: typeof RuntimeMachineRootHashBrand;
};

const requireBytes32 = (value: string, code: string): string => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${code}:${value}`);
  return value;
};

export const toFrameHash = (value: string): FrameHash =>
  requireBytes32(value, 'PROTOCOL_FRAME_HASH_INVALID') as FrameHash;

export const toStateHash = (value: string): StateHash =>
  requireBytes32(value, 'PROTOCOL_STATE_HASH_INVALID') as StateHash;

export const toEvidenceHash = (value: string): EvidenceHash =>
  requireBytes32(value, 'PROTOCOL_EVIDENCE_HASH_INVALID') as EvidenceHash;

export const toBoardHash = (value: string): BoardHash =>
  requireBytes32(value, 'PROTOCOL_BOARD_HASH_INVALID').toLowerCase() as BoardHash;

export const toBoardProposalHash = (value: string): BoardProposalHash =>
  requireBytes32(value, 'PROTOCOL_BOARD_PROPOSAL_HASH_INVALID').toLowerCase() as BoardProposalHash;

export const toRuntimeOutputsDigest = (value: string): RuntimeOutputsDigest =>
  requireBytes32(value, 'PROTOCOL_RUNTIME_OUTPUTS_DIGEST_INVALID').toLowerCase() as RuntimeOutputsDigest;

export const toEntityContextPayloadHash = (value: string): EntityContextPayloadHash =>
  requireBytes32(value, 'PROTOCOL_ENTITY_CONTEXT_PAYLOAD_HASH_INVALID').toLowerCase() as EntityContextPayloadHash;

export const toRuntimeMachineRootHash = (value: string): RuntimeMachineRootHash =>
  requireBytes32(value, 'PROTOCOL_RUNTIME_MACHINE_ROOT_HASH_INVALID').toLowerCase() as RuntimeMachineRootHash;
