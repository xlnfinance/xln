// The raw transaction bytes, against two transactions signed by an independent library (ethers 6, one fixed key):
// the same fields and key give the same bytes.
import { describe, expect, test } from "bun:test";
import { rawTx, type Tx } from "./tx.ts";

const SECRET = Uint8Array.from({ length: 32 }, () => 0x11);

const TO = "0x7Ce583457fb0bDa973b7d1d5309E7A987317B991";
const CASES: readonly (readonly [Tx, string])[] = [
  [
    { chainId: 11155111n, nonce: 0n, tip: 1_000_000_000n, maxFee: 30_000_000_000n, gas: 21_000n, to: TO, data: "0x" },
    "0x02f86e83aa36a780843b9aca008506fc23ac00825208947ce583457fb0bda973b7d1d5309e7a987317b9918080c001a0f48992b818fadd"
    + "8aa775ab10337128164ed4b186b2025244f5bafd82bcbe97cda012945d23d6e734e7c82e069a186085bb515d1f146991088d972c0e4373c"
    + "19c85",
  ],
  [
    {
      chainId: 1n, nonce: 7n, tip: 0n, maxFee: 2n, gas: 5_437_937n, data: "0xdeadbeef00",
      to: "0xED34A147a0a480B0B006A4266E8bA0d6e995000C",
    },
    "0x02f868010780028352f9f194ed34a147a0a480b0b006a4266e8ba0d6e995000c8085deadbeef00c080a0ae812b950d75e7e1f2851c06"
    + "25cfc149803bc4934932878ac5141fdd99130f03a05efc4fde078884a95f1fd2600514e6b3bc15b10c18a6d6b07a6360eb7c063c90",
  ],
];

describe("host/shell/evm a transaction is signed as the chain reads it", () => {
  test("R-SUBMIT-TX the raw bytes of each signed transaction equal the other library's", () => {
    CASES.forEach(([tx, raw]) => expect(rawTx(tx, SECRET)).toEqual({ ok: true, value: raw }));
  });

  test("R-SUBMIT-TX a recipient or data that is not hex is refused, naming the fault", () => {
    const [tx] = CASES[0] ?? expect.unreachable("case");
    expect(rawTx({ ...tx, to: "7Ce5" }, SECRET)).toMatchObject({ ok: false, error: { _tag: "no_prefix" } });
    expect(rawTx({ ...tx, data: "0xzz" }, SECRET)).toMatchObject({ ok: false, error: { _tag: "not_hex" } });
  });
});
