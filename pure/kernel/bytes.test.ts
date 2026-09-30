import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { bytesToHex, concat, hexToBytes, keccak256, keccakHex, minimalBytes, utf8 } from "./bytes.ts";

describe("kernel/bytes", () => {
  test("hex round trips, either case, and the prefix is required", () => {
    const parsed = hexToBytes("0xAbCd");
    expect(parsed.ok && bytesToHex(parsed.value)).toBe("0xabcd");
    expect(hexToBytes("00ff")).toEqual({ ok: false, error: { _tag: "no_prefix" } });
    expect(hexToBytes(`${"ab".repeat(32)}`)).toEqual({ ok: false, error: { _tag: "no_prefix" } });
    const empty = hexToBytes("0x");
    expect(empty.ok && empty.value.length).toBe(0);
  });

  test("text that is not hex is a value, not an exception", () => {
    expect(hexToBytes("0xabc")).toEqual({ ok: false, error: { _tag: "odd_length", digits: 3 } });
    expect(hexToBytes("0xzz")).toEqual({ ok: false, error: { _tag: "not_hex" } });
    expect(hexToBytes("0x 12")).toEqual({ ok: false, error: { _tag: "not_hex" } });
  });

  test("keccak256 is ethers' keccak256", () => {
    expect(keccakHex(utf8("XLN_DEPOSITORY_HANKO_V2"))).toBe(ethers.id("XLN_DEPOSITORY_HANKO_V2"));
    expect(bytesToHex(keccak256(new Uint8Array()))).toBe(ethers.keccak256("0x"));
  });

  test("concat joins in order and leaves its parts alone", () => {
    const a = Uint8Array.of(1, 2);
    expect([...concat([a, Uint8Array.of(), Uint8Array.of(3)])]).toEqual([1, 2, 3]);
    expect([...a]).toEqual([1, 2]);
  });

  test("minimalBytes: no leading zero byte, zero is one byte", () => {
    expect([...minimalBytes(0n)]).toEqual([0]);
    expect([...minimalBytes(255n)]).toEqual([255]);
    expect([...minimalBytes(256n)]).toEqual([1, 0]);
    expect(bytesToHex(minimalBytes((1n << 200n) + 5n))).toBe(`0x01${"00".repeat(24)}05`);
  });
});
