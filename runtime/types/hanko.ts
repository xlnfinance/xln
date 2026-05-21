// Hanko in string format (hex-encoded ABI bytes).
export type HankoString = string;

// === HANKO BYTES SYSTEM (Final Design) ===
export interface HankoBytes {
  placeholders: Buffer[];
  packedSignatures: Buffer;
  claims: HankoClaim[];
}

export interface HankoClaim {
  entityId: Buffer;
  entityIndexes: number[];
  weights: number[];
  threshold: number;
}

export interface HankoVerificationResult {
  valid: boolean;
  entityId: Buffer;
  signedHash: Buffer;
  yesEntities: Buffer[];
  noEntities: Buffer[];
  completionPercentage: number;
  errors?: string[];
}

export interface HankoMergeResult {
  merged: HankoBytes;
  addedSignatures: number;
  completionBefore: number;
  completionAfter: number;
  log: string[];
}

export interface HankoContext {
  timestamp: number;
  blockNumber?: number;
  networkId?: number;
}
