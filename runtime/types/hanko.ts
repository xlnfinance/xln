// Hanko in string format (hex-encoded ABI bytes).
export type HankoString = string;

export type HankoHex = `0x${string}`;

export interface HankoBoardDelays {
  readonly boardChangeDelay: bigint;
  readonly controlChangeDelay: bigint;
  readonly dividendChangeDelay: bigint;
}

export interface HankoWireClaim extends HankoBoardDelays {
  readonly entityId: HankoHex;
  readonly entityIndexes: readonly bigint[];
  readonly weights: readonly bigint[];
  readonly threshold: bigint;
}

export interface HankoEnvelope {
  readonly placeholders: readonly HankoHex[];
  readonly packedSignatures: HankoHex;
  readonly claims: readonly HankoWireClaim[];
}

export interface HankoRecoveredSignature {
  readonly signerEntityId: HankoHex;
  readonly signature: HankoHex;
}

export interface HankoBoardMemberClaim {
  readonly entityId: HankoHex;
  readonly weight: bigint;
}

export interface HankoSemanticClaim {
  readonly entityId: HankoHex;
  readonly members: readonly HankoBoardMemberClaim[];
  readonly threshold: bigint;
  readonly delays: HankoBoardDelays;
}

export type CanonicalHankoMergeResult =
  | Readonly<{
      complete: false;
      targetEntityId: HankoHex;
      power: bigint;
      threshold: bigint;
      missingEntityIds: readonly HankoHex[];
    }>
  | Readonly<{
      complete: true;
      targetEntityId: HankoHex;
      hanko: HankoString;
    }>;
