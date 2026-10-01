// The Hanko the shell signs a batch with: it verifies for the lazy Entity of the key, over the digest it was made
// for and no other, and a digest that is not 32 bytes of hex is a fault the caller can read (F1: only what was sealed
// is signed).
import { describe, expect, test } from "bun:test";
import { lazyEntityId } from "../../chain/hanko/hanko.ts";
import { entityId } from "../../entity/model.ts";
import { verifyHankoSignature } from "../../chain/hanko/hanko-verify.ts";
import { ok, unwrapOr } from "../../kernel/core/result.ts";
import { keyOf } from "./link.ts";
import { lazySigner } from "./signer.ts";

const KEY = unwrapOr(keyOf(Uint8Array.from({ length: 32 }, (_, i) => i + 1)), () => expect.unreachable("key"));
const ENTITY_HEX = unwrapOr(lazyEntityId(KEY.runtime), () => expect.unreachable("entity"));
const ENTITY = unwrapOr(entityId(ENTITY_HEX), () => expect.unreachable("entity id"));
const DIGEST = `0x${"3c".repeat(32)}`;
const OTHER = `0x${"4d".repeat(32)}`;
const signer = lazySigner(ENTITY, KEY);
const unregistered = () => ok(false);

const verdictOf = (hanko: string, digest: string) => verifyHankoSignature(hanko, digest, unregistered);

describe("host/shell/signer the Hanko of a batch digest, by the key the shell holds", () => {
  test("R-LINK-AUTH the Hanko verifies for the Entity of the key, and its signer is the key's own address", () => {
    const hanko = signer.hanko(DIGEST);
    const verdict = hanko.ok ? verdictOf(hanko.value, DIGEST) : expect.unreachable("hanko");
    expect(verdict.ok && verdict.value.entityId).toBe(ENTITY_HEX);
    expect(verdict.ok && verdict.value.signers.map((s) => s.toLowerCase())).toEqual([KEY.runtime]);
  });

  test("F1 the Hanko is for its digest alone: over another digest it does not name this key", () => {
    const hanko = signer.hanko(DIGEST);
    const other = hanko.ok ? verdictOf(hanko.value, OTHER) : expect.unreachable("hanko");
    expect(other.ok && other.value.signers.map((s) => s.toLowerCase())).not.toEqual([KEY.runtime]);
  });

  test("a digest that is not 32 bytes of hex is refused, and says which", () => {
    expect(signer.hanko("0x12")).toMatchObject({ ok: false, error: { _tag: "cannot_sign", digest: "0x12" } });
    expect(signer.hanko(`0x${"3c".repeat(33)}`)).toMatchObject({ ok: false, error: { _tag: "cannot_sign" } });
    expect(signer.hanko("not hex")).toMatchObject({ ok: false, error: { _tag: "cannot_sign" } });
  });
});
