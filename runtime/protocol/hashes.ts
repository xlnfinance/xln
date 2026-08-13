/** Hash-domain brands prevent valid bytes32 values crossing authority domains. */
declare const FrameHashBrand: unique symbol;
declare const StateHashBrand: unique symbol;
declare const EvidenceHashBrand: unique symbol;

export type FrameHash = string & { readonly [FrameHashBrand]: typeof FrameHashBrand };
export type StateHash = string & { readonly [StateHashBrand]: typeof StateHashBrand };
export type EvidenceHash = string & { readonly [EvidenceHashBrand]: typeof EvidenceHashBrand };

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
