// Which Depository a signature is for: the address and chain id a payload binds (C1, C2 bind the digest to them).
import { describe, expect, test } from "bun:test";
import { checksum } from "../kernel/signature.ts";
import { deployment } from "./deployment.ts";

const LOWER = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const CHECKED = checksum(LOWER);

describe("R-J2 a Deployment names one chain and one Depository", () => {
  test("a lowercase address is taken as it is, a checksummed one is stored lowercase", () => {
    expect(deployment(31337n, LOWER)).toEqual({ ok: true, value: { chainId: 31337n, depository: LOWER } });
    expect(deployment(31337n, CHECKED)).toEqual({ ok: true, value: { chainId: 31337n, depository: LOWER } });
  });

  test("a mixed-case address with a wrong checksum is refused", () => {
    const wrong = CHECKED.replace(/[a-f]/, (c) => c.toUpperCase()).replace(/[A-F]/, (c) => c.toLowerCase());
    expect(wrong).not.toBe(CHECKED);
    expect(deployment(31337n, wrong)).toEqual({ ok: false, error: { _tag: "bad_checksum" } });
  });

  test("the zero address, a short address and a chain id outside 1..2^256-1 are refused", () => {
    expect(deployment(1n, `0x${"00".repeat(20)}`)).toEqual({ ok: false, error: { _tag: "zero_depository" } });
    expect(deployment(1n, "0x1234")).toEqual({ ok: false, error: { _tag: "bad_depository" } });
    expect(deployment(0n, LOWER)).toEqual({ ok: false, error: { _tag: "bad_chain_id" } });
    expect(deployment(1n << 256n, LOWER)).toEqual({ ok: false, error: { _tag: "bad_chain_id" } });
  });
});
