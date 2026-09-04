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
  /**
   * Aligned with `placeholders` or empty (HankoVerifier.HankoBytes). A
   * non-empty entry is an ERC-1271 proof for a contract placeholder. Pure-EOA
   * boards, i.e. everything this runtime signs today, carry `[]`.
   */
  readonly memberSignatures: readonly HankoHex[];
}

/** Envelope as supplied to the encoder; `memberSignatures` defaults to `[]`. */
export type HankoEnvelopeInput = Omit<HankoEnvelope, 'memberSignatures'> & {
  readonly memberSignatures?: readonly HankoHex[];
};

export interface HankoRecoveredSignature {
  readonly signerEntityId: HankoHex;
  readonly signature: HankoHex;
}

interface HankoBoardMemberClaim {
  readonly entityId: HankoHex;
  readonly weight: bigint;
}

export interface HankoSemanticClaim {
  readonly entityId: HankoHex;
  readonly members: readonly HankoBoardMemberClaim[];
  readonly threshold: bigint;
  readonly delays: HankoBoardDelays;
}
