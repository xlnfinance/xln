// What the Account's other signed messages say, so a signature on one can never pass for another. The head of a frame
// is signed as the dispute proof (signing.ts) and the contract checks it. Two messages are not on the chain and are
// signed here under digests of their own: a frame by its content name, so a receiver can check who proposed a frame it
// cannot apply, and a refusal, so a proposer can check who refused. Each digest is tagged with its kind and scoped to
// the deployment and the Account, so none is valid as the other, as a dispute proof, or on another Account. Every field
// is written as text, so a digest exists whatever a peer put on the wire (R-X1); the Runtime signs and verifies these,
// and checks the signature before the receiver's refusal memory or the proposer's rollback is consulted.
import { bytesToHex, keccak256, utf8 } from "../../kernel/encoding/bytes.ts";
import { rlp, type Rlp } from "../../kernel/encoding/rlp.ts";
import type { FrameHash, Refusal } from "../frame/frame.ts";
import type { SigningContext } from "./signing.ts";

const scope = (c: SigningContext): readonly Rlp[] =>
  [utf8(c.deployment.chainId.toString()), utf8(c.deployment.depository), utf8(c.accountKey)];

const digest = (kind: string, c: SigningContext, fields: readonly string[]): string =>
  bytesToHex(keccak256(rlp([utf8(kind), ...scope(c), ...fields.map(utf8)])));

/** The digest the author of a frame signs over its content name. */
export const frameAuthDigest = (c: SigningContext, name: FrameHash): string =>
  digest("xln/account/frame/v1", c, [name]);

/** The digest the refuser signs over a refusal: the frame it names, the tx, the fault and the mark it reports. */
export const refusalAuthDigest = (c: SigningContext, r: Refusal): string =>
  digest("xln/account/refusal/v1", c, [r.hash, String(r.index), r.fault, String(r.mark)]);
