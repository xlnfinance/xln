import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { hexToBytes } from "../encoding/bytes.ts";
import { none, some } from "../core/option.ts";
import { HALF_ORDER, addressOf, checksum, recoverPublicKey, signDigest } from "./signature.ts";

const bytes = (hex: string): Uint8Array => {
  const parsed = hexToBytes(hex);
  return parsed.ok ? parsed.value : new Uint8Array();
};
const key = ethers.id("kernel-signature-key");
const digest = ethers.id("kernel-signature-digest");

describe("kernel/signature", () => {
  test("a signature is low-s and recovers the signer's public key", () => {
    const sig = signDigest(bytes(digest), bytes(key));
    expect(sig.s <= HALF_ORDER).toBe(true);
    const r = bytes(`0x${sig.r.toString(16).padStart(64, "0")}`);
    const s = bytes(`0x${sig.s.toString(16).padStart(64, "0")}`);
    expect(recoverPublicKey(bytes(digest), r, s, sig.recovery)).toEqual(some(sig.publicKey));
  });

  test("the address equals ethers' for the same key, checksummed", () => {
    const sig = signDigest(bytes(digest), bytes(key));
    expect(addressOf(sig.publicKey)).toBe(new ethers.Wallet(key).address);
  });

  test("the signature equals ethers' serialization for the same digest", () => {
    const sig = signDigest(bytes(digest), bytes(key));
    const theirs = new ethers.SigningKey(key).sign(digest);
    expect([sig.r, sig.s, sig.recovery + 27]).toEqual([BigInt(theirs.r), BigInt(theirs.s), theirs.v]);
  });

  test("a recovery failure is nothing, not an exception", () => {
    const zero = new Uint8Array(32);
    expect(recoverPublicKey(bytes(digest), zero, zero, 0)).toEqual(none);
    const ones = bytes(`0x${"ff".repeat(32)}`);
    expect(recoverPublicKey(bytes(digest), ones, ones, 1)).toEqual(none);
  });

  test("EIP-55: the specification's test addresses", () => {
    [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
      "0x52908400098527886E0F7030069857D2E4169EE7", "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    ].forEach((address) => {
      expect(checksum(address.toLowerCase())).toBe(address);
      expect(checksum(address)).toBe(address);
      expect(ethers.getAddress(address.toLowerCase())).toBe(checksum(address.toLowerCase()));
    });
  });
});
