// What signs for the Host's Entity, as the one thing the shell holds that can spend (R-LINK-AUTH, F1). The Host's core
// never signs and never sees a key; the shell hands the J path this and nothing else: the Hanko of a batch digest.
// The key itself is read from an owner-only file by node/key-file.ts and kept as bytes in a `Key`.
import { lazyHanko } from "../../../chain/hanko/hanko.ts";
import type { EntityId } from "../../../entity/model.ts";
import { err, mapErr, type Result } from "../../../kernel/core/result.ts";
import { signDigest } from "../../../kernel/crypto/signature.ts";
import type { Tagged } from "../../../kernel/core/tagged.ts";
import { hexToBytes } from "../../../kernel/encoding/bytes.ts";
import type { Key } from "../link/link.ts";

export type SignFault = Tagged<"cannot_sign", { digest: string; reason: string }>;

export type Signer = Readonly<{ hanko: (digest: string) => Result<string, SignFault> }>;

/** A batch digest is a keccak256 hash. */
const DIGEST_BYTES = 32;

const word = (n: bigint): string => n.toString(16).padStart(64, "0");

/** `r || s || v` with v in {27, 28}: what the Hanko packs. */
const packed = (digest: Uint8Array, secret: Uint8Array): string => {
  const sig = signDigest(digest, secret);
  return `0x${word(sig.r)}${word(sig.s)}${(27 + sig.recovery).toString(16)}`;
};

/** The Hanko of a lazy Entity (one signer, threshold 1) over a batch digest, signed with its key. */
export const lazySigner = (entity: EntityId, key: Key): Signer => ({
  hanko: (digest) => {
    const raw = hexToBytes(digest);
    if (!raw.ok) return err({ _tag: "cannot_sign", digest, reason: raw.error._tag });
    if (raw.value.length !== DIGEST_BYTES) return err({ _tag: "cannot_sign", digest, reason: "not_32_bytes" });
    return mapErr(lazyHanko(entity, packed(raw.value, key.secret)),
      (fault): SignFault => ({ _tag: "cannot_sign", digest, reason: fault._tag }));
  },
});
