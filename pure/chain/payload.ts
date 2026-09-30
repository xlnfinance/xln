// What a signer signs: the payloads the Depository hashes before it checks a signature (HankoEncoding.sol).
//
// Every payload starts with the deployment it is for. An Account message also carries the Account's key, its ondelta
// epoch and a nonce, so a signature binds one Account, one baseline and one moment in its history (C1). A batch
// payload carries the acting Entity (C2).
import { A, encode, encodePacked, P, type AbiFault } from "../kernel/abi.ts";
import { bytesToHex, keccak256, keccakHex, utf8 } from "../kernel/bytes.ts";
import { map, type Result } from "../kernel/result.ts";
import { match, type Tagged } from "../kernel/tagged.ts";
import type { Deployment } from "./deployment.ts";
import { settlementDiffsAbi, type SettlementDiff } from "./money.ts";

/** Types.sol `MessageType`: the word an Account message opens with. */
const MESSAGE_TYPE = { cooperative_update: 0n, dispute_proof: 1n } as const;

export type AccountMessage =
  | Tagged<"dispute_proof", { proposerIsLeft: boolean; proofBodyHash: string; watchSeed: string }>
  | Tagged<"cooperative_update", { diffs: readonly SettlementDiff[]; forgiveDebtsInTokenIds: readonly bigint[] }>;

/** Where in an Account's history the message is signed. */
export type AccountMoment = Readonly<{ accountKey: string; ondeltaEpoch: bigint; nonce: bigint }>;

const accountHeader = (d: Deployment, at: AccountMoment, type: bigint) => [
  A.u256(type), A.u256(d.chainId), A.address(d.depository), A.bytes(at.accountKey),
  A.u256(at.ondeltaEpoch), A.u256(at.nonce),
];

/** `HankoEncoding.encodeDisputeProof` and `encodeCooperativeUpdate`. */
export const accountMessagePayload = (
  d: Deployment, at: AccountMoment, message: AccountMessage,
): Result<Uint8Array, AbiFault> => encode(match(message, {
  dispute_proof: (m) => [
    ...accountHeader(d, at, MESSAGE_TYPE.dispute_proof),
    A.bool(m.proposerIsLeft), A.b32(m.proofBodyHash), A.b32(m.watchSeed),
  ],
  cooperative_update: (m) => [
    ...accountHeader(d, at, MESSAGE_TYPE.cooperative_update),
    settlementDiffsAbi(m.diffs), A.array(m.forgiveDebtsInTokenIds.map(A.u256)),
  ],
}));

/** The digest an Account message is signed over: the hash of its payload. */
export const accountMessageHash = (
  d: Deployment, at: AccountMoment, message: AccountMessage,
): Result<string, AbiFault> => map(accountMessagePayload(d, at, message), keccakHex);

/** The separator the Depository packs into every batch payload (Depository.DOMAIN_SEPARATOR). */
const BATCH_SEPARATOR = bytesToHex(keccak256(utf8("XLN_DEPOSITORY_HANKO_V2")));

/**
 * `HankoEncoding.encodeBatch`: separator, chain id, Depository, acting Entity, the encoded batch and the Entity's
 * batch nonce, packed. The separator is a parameter here so the codec's vectors, which sample it, can pin this.
 */
export const batchPayloadUnder = (
  separator: string, d: Deployment, entityId: string, encodedBatch: string, nonce: bigint,
): Result<Uint8Array, AbiFault> => encodePacked([
  P.b32(separator), P.u256(d.chainId), P.address(d.depository), P.b32(entityId), P.bytes(encodedBatch), P.u256(nonce),
]);

const batchPayload = (
  d: Deployment, entityId: string, encodedBatch: string, nonce: bigint,
): Result<Uint8Array, AbiFault> => batchPayloadUnder(BATCH_SEPARATOR, d, entityId, encodedBatch, nonce);

/** The digest a batch is signed over; it is also the `batchHash` the Depository emits for the batch. */
export const batchHash = (
  d: Deployment, entityId: string, encodedBatch: string, nonce: bigint,
): Result<string, AbiFault> => map(batchPayload(d, entityId, encodedBatch, nonce), keccakHex);

