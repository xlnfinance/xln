// H5 (R-REGISTRY-AT-VIEW): the Entity decides on `DeltaTransformer.hashToTimestamp` read at its view, compared with the
// second a lock's body signs, and never with heights. This is the vector that pins the comparison to the deployed code:
// the real Depository stack in BrowserVM pays a clause iff the registry holds a value that is not 0 and not after the
// signed second (DeltaTransformer.sol applyPayment: `revealedAt != 0 && revealedAt <= revealedUntilTimestamp`), at the
// exact second and one past, and `paid` of the Entity layer (pure/entity/paybook/registry.ts) says the same for the
// value the registry reads back.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party, type Body } from "../rig.ts";
import { BATCH_ABI } from "../../../../core/protocol/dispute/proof-body.ts";
import { encodeSignedAmount } from "../../../../core/protocol/crypto/abi-money.ts";
import { paid } from "../../../../pure/entity/paybook/registry.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const T0 = 1_800_000_000;
const WINDOWS = 60;
const DEADLINE = 1000;
const secret = ethers.id("h5-preimage");
const hashlock = ethers.keccak256(coder.encode(["bytes32"], [secret]));

const world = async () => {
  const w = await boot("h5");
  const [A, H] = ["h5-a", "h5-h"].map(party);
  const up = w.accountOf(A, H, "h5-up");
  const transformer = w.chain.addresses.deltaTransformer;
  const payeeIsLeft = up.L.id !== A.id;
  const batch = coder.encode([ethers.ParamType.from(BATCH_ABI as never)], [{
    payment: [{
      deltaIndex: 0, amount: encodeSignedAmount(payeeIsLeft ? 50n : -50n), revealedUntilTimestamp: T0 + DEADLINE,
      hash: hashlock,
    }],
    swap: [], pull: [],
  }]);
  const body: Body = {
    ...up.body(0n, WINDOWS),
    transformers: [{ transformerAddress: transformer, encodedBatch: batch, allowances: [{ deltaIndex: 0, rightAllowance: 50n, leftAllowance: 50n }] }],
  };
  for (const p of [A, H]) await w.chain.debugFundReserves(p.id, w.TOKEN, 1000n);
  const upLeft = up.L.id === A.id;
  const sig = up.proofSig(H, await up.epochOf(), 1, upLeft, body);
  const registry = async (): Promise<bigint> => {
    const { DeltaTransformer__factory: F } = await import("../../../typechain-types/index.ts");
    const { createAddressFromString } = await import("@ethereumjs/util");
    const iface = F.createInterface();
    const data = iface.encodeFunctionData("hashToTimestamp", [hashlock]);
    const r = await w.vm.runReadOnlyCall({ to: createAddressFromString(transformer), caller: w.vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 500_000n });
    return BigInt(iface.decodeFunctionResult("hashToTimestamp", r.execResult.returnValue)[0]);
  };
  /** The secret is shown at second `T0 + at`, a dispute opens after it, and the payee H gets what the chain pays. */
  const revealedAt = async (at: number): Promise<Readonly<{ seconds: bigint; paidToH: bigint }>> => {
    w.at(at);
    expect(await w.submit(H, { revealSecrets: [{ transformer, secret }] })).toBe("ok");
    const seconds = await registry();
    w.at(Math.max(at, 100) + 10);
    expect(await w.start(A, H, 1, upLeft, body, sig)).toBe("ok");
    w.at(DEADLINE + 300);
    expect(await w.finalize(A, H, { nonce: 1, body, startedByLeft: upLeft }, { nonce: 1, proposerIsLeft: upLeft, body, sig: "0x" }, {})).toBe("ok");
    const reserve = await w.chain.getReserves(H.id, w.TOKEN);
    return { seconds, paidToH: reserve - 1000n };
  };
  return { revealedAt };
};

describe("H5 the registry's second against the second a lock signs", () => {
  test("R-REGISTRY-AT-VIEW a secret shown at the signed second pays, and the Entity layer reads the same", async () => {
    const { revealedAt } = await world();
    const got = await revealedAt(DEADLINE);
    expect(got.seconds).toBe(BigInt(T0 + DEADLINE));
    expect(got.paidToH).toBe(50n);
    expect(paid(got.seconds, BigInt(T0 + DEADLINE))).toBe(true);
  });

  test("R-REGISTRY-AT-VIEW a secret shown one second past the signed second pays nothing, and the Entity layer reads the same", async () => {
    const { revealedAt } = await world();
    const got = await revealedAt(DEADLINE + 1);
    expect(got.seconds).toBe(BigInt(T0 + DEADLINE + 1));
    expect(got.paidToH).toBe(0n);
    expect(paid(got.seconds, BigInt(T0 + DEADLINE))).toBe(false);
  });

  test("R-REGISTRY-AT-VIEW a secret shown before the lock existed pays, and an unrevealed hashlock reads as 0 and pays nothing", async () => {
    const { revealedAt } = await world();
    const got = await revealedAt(50);
    expect(got.seconds).toBe(BigInt(T0 + 50));
    expect(got.paidToH).toBe(50n);
    expect(paid(got.seconds, BigInt(T0 + DEADLINE))).toBe(true);
    expect(paid(0n, BigInt(T0 + DEADLINE))).toBe(false);
  });
});
