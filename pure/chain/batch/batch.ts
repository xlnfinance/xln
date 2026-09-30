// The batch: every operation an Entity asks its Depository to perform in one signed call (Types.sol `Batch`).
//
// The fork's batch opens with the signed gas budget (J5). Each operation list keeps the contract's name and field
// order, because the ABI encoding is positional: moving a field changes every byte after it.
import { A, arrayOf, encode, type Abi, type AbiFault } from "../../kernel/encoding/abi.ts";
import { bytesToHex } from "../../kernel/encoding/bytes.ts";
import { map, type Result } from "../../kernel/core/result.ts";
import { settlementDiffsAbi, type SettlementDiff } from "../money.ts";
import { proofBodyAbi, type ProofBody } from "../proof/proof.ts";

export type ReserveToReserve = Readonly<{ receivingEntity: string; tokenId: bigint; amount: bigint }>;
export type EntityAmount = Readonly<{ entity: string; amount: bigint }>;
export type ReserveToCollateral = Readonly<{
  tokenId: bigint; receivingEntity: string; pairs: readonly EntityAmount[];
}>;
/** Pure C2R: withdraw `amount` from the sender's share of the collateral, authorized by the counterparty's Hanko. */
export type CollateralToReserve = Readonly<{
  counterparty: string; tokenId: bigint; amount: bigint; nonce: bigint; sig: string;
}>;
export type Settlement = Readonly<{
  leftEntity: string; rightEntity: string; diffs: readonly SettlementDiff[];
  forgiveDebtsInTokenIds: readonly bigint[]; sig: string; nonce: bigint;
}>;
export type InitialDisputeProof = Readonly<{
  counterentity: string; nonce: bigint; ondeltaEpoch: bigint; proposerIsLeft: boolean; proofbodyHash: string;
  initialProofbody: ProofBody; watchSeed: string; sig: string; starterInitialArguments: string;
  starterCounterArguments: string; starterCounterProofCommitment: string;
}>;
export type CounterDisputeProof = Readonly<{
  counterentity: string; initialNonce: bigint; initialProofbodyHash: string; counterNonce: bigint;
  proposerIsLeft: boolean; counterProofbody: ProofBody; sig: string;
}>;
export type FinalDisputeProof = Readonly<{
  counterentity: string; initialNonce: bigint; finalNonce: bigint; proposerIsLeft: boolean;
  initialProofbodyHash: string; finalProofbody: ProofBody; starterArguments: string; otherArguments: string;
  sig: string; startedByLeft: boolean; cooperative: boolean;
}>;
export type ExternalTokenToReserve = Readonly<{
  entity: string; contractAddress: string; externalTokenId: bigint; tokenType: bigint; internalTokenId: bigint;
  amount: bigint;
}>;
export type SecretReveal = Readonly<{ transformer: string; secret: string }>;
export type HashLadderWitness = Readonly<{
  fillRatio: bigint; fullSecret: string; reveals: readonly [string, string, string, string];
}>;
export type HashLadderRegistration = Readonly<{
  counterpartyEntity: string; targetRole: boolean; fullHash: string; partialRoot: string; witness: HashLadderWitness;
}>;

export type Batch = Readonly<{
  gasBudget: bigint;
  reserveToReserve: readonly ReserveToReserve[];
  reserveToCollateral: readonly ReserveToCollateral[];
  collateralToReserve: readonly CollateralToReserve[];
  settlements: readonly Settlement[];
  disputeStarts: readonly InitialDisputeProof[];
  counterDisputes: readonly CounterDisputeProof[];
  disputeFinalizations: readonly FinalDisputeProof[];
  externalTokenToReserve: readonly ExternalTokenToReserve[];
  reserveToExternalToken: readonly ReserveToReserve[];
  revealSecrets: readonly SecretReveal[];
  hashLadderRegistrations: readonly HashLadderRegistration[];
}>;

const reserveToReserveAbi = (r: ReserveToReserve): Abi =>
  A.tuple([A.b32(r.receivingEntity), A.u256(r.tokenId), A.u256(r.amount)]);

const entityAmountAbi = (p: EntityAmount): Abi => A.tuple([A.b32(p.entity), A.u256(p.amount)]);

const reserveToCollateralAbi = (r: ReserveToCollateral): Abi =>
  A.tuple([A.u256(r.tokenId), A.b32(r.receivingEntity), arrayOf(r.pairs, entityAmountAbi)]);

const collateralToReserveAbi = (r: CollateralToReserve): Abi =>
  A.tuple([A.b32(r.counterparty), A.u256(r.tokenId), A.u256(r.amount), A.u256(r.nonce), A.bytes(r.sig)]);

const settlementAbi = (r: Settlement): Abi => A.tuple([
  A.b32(r.leftEntity), A.b32(r.rightEntity), settlementDiffsAbi(r.diffs),
  arrayOf(r.forgiveDebtsInTokenIds, A.u256), A.bytes(r.sig), A.u256(r.nonce),
]);

const initialDisputeProofAbi = (r: InitialDisputeProof): Abi => A.tuple([
  A.b32(r.counterentity), A.u256(r.nonce), A.u256(r.ondeltaEpoch), A.bool(r.proposerIsLeft),
  A.b32(r.proofbodyHash), proofBodyAbi(r.initialProofbody), A.b32(r.watchSeed), A.bytes(r.sig),
  A.bytes(r.starterInitialArguments), A.bytes(r.starterCounterArguments), A.b32(r.starterCounterProofCommitment),
]);

const counterDisputeProofAbi = (r: CounterDisputeProof): Abi => A.tuple([
  A.b32(r.counterentity), A.u256(r.initialNonce), A.b32(r.initialProofbodyHash), A.u256(r.counterNonce),
  A.bool(r.proposerIsLeft), proofBodyAbi(r.counterProofbody), A.bytes(r.sig),
]);

const finalDisputeProofAbi = (r: FinalDisputeProof): Abi => A.tuple([
  A.b32(r.counterentity), A.u256(r.initialNonce), A.u256(r.finalNonce), A.bool(r.proposerIsLeft),
  A.b32(r.initialProofbodyHash), proofBodyAbi(r.finalProofbody), A.bytes(r.starterArguments),
  A.bytes(r.otherArguments), A.bytes(r.sig), A.bool(r.startedByLeft), A.bool(r.cooperative),
]);

const externalTokenToReserveAbi = (r: ExternalTokenToReserve): Abi => A.tuple([
  A.b32(r.entity), A.address(r.contractAddress), A.u256(r.externalTokenId), A.u8(r.tokenType),
  A.u256(r.internalTokenId), A.u256(r.amount),
]);

const secretRevealAbi = (r: SecretReveal): Abi => A.tuple([A.address(r.transformer), A.b32(r.secret)]);

const witnessAbi = (w: HashLadderWitness): Abi =>
  A.tuple([A.u16(w.fillRatio), A.b32(w.fullSecret), A.tuple(w.reveals.map(A.b32))]);

const hashLadderRegistrationAbi = (r: HashLadderRegistration): Abi => A.tuple([
  A.b32(r.counterpartyEntity), A.bool(r.targetRole), A.b32(r.fullHash), A.b32(r.partialRoot), witnessAbi(r.witness),
]);

const batchAbi = (b: Batch): Abi => A.tuple([
  A.u64(b.gasBudget),
  arrayOf(b.reserveToReserve, reserveToReserveAbi),
  arrayOf(b.reserveToCollateral, reserveToCollateralAbi),
  arrayOf(b.collateralToReserve, collateralToReserveAbi),
  arrayOf(b.settlements, settlementAbi),
  arrayOf(b.disputeStarts, initialDisputeProofAbi),
  arrayOf(b.counterDisputes, counterDisputeProofAbi),
  arrayOf(b.disputeFinalizations, finalDisputeProofAbi),
  arrayOf(b.externalTokenToReserve, externalTokenToReserveAbi),
  arrayOf(b.reserveToExternalToken, reserveToReserveAbi),
  arrayOf(b.revealSecrets, secretRevealAbi),
  arrayOf(b.hashLadderRegistrations, hashLadderRegistrationAbi),
]);

/** `abi.encode(Batch)`: the bytes `processBatch` decodes, as the hex the batch payload packs. */
export const encodeBatch = (b: Batch): Result<string, AbiFault> => map(encode([batchAbi(b)]), bytesToHex);

export const emptyBatch = (gasBudget: bigint): Batch => ({
  gasBudget, reserveToReserve: [], reserveToCollateral: [], collateralToReserve: [], settlements: [],
  disputeStarts: [], counterDisputes: [], disputeFinalizations: [], externalTokenToReserve: [],
  reserveToExternalToken: [], revealSecrets: [], hashLadderRegistrations: [],
});
