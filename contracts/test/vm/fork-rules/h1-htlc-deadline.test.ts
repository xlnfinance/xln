// H1 (contracts-decisions.md): an unrevealed HTLC must not settle as "unpaid" while its deadline is still open.
// Decided: finalize waits until the payment deadline unless the secret is public. Real Depository stack in BrowserVM.
//
// The hub scenario: A pays B through H. Upstream A→H 50 (deadline 1000), downstream H→B 50 (deadline 900).
// A and B collude: A finalizes upstream before any secret exists (unpaid), B then claims downstream with the secret.
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party, type Body, type Party } from "../rig.ts";
import { BATCH_ABI } from "../../../../core/protocol/dispute/proof-body.ts";
import { encodeSignedAmount } from "../../../../core/protocol/crypto/abi-money.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const T0 = 1_800_000_000;
const WINDOWS = 60;
const SECRET_ARGS = "tuple(uint16[] fillRatios, bytes32[] secrets)";
const secret = ethers.id("h1-preimage");
const hashlock = ethers.keccak256(coder.encode(["bytes32"], [secret]));
const argsWithSecret = coder.encode(["bytes[]"], [[coder.encode([SECRET_ARGS], [[[], [secret]]])]]);

const hubWorld = async () => {
  const w = await boot("h1");
  const [A, H, B] = ["h1-a", "h1-h", "h1-b"].map(party);
  const up = w.accountOf(A, H, "h1-up");
  const down = w.accountOf(H, B, "h1-down");
  const transformer = w.chain.addresses.deltaTransformer;
  // An HTLC in account (payer, payee): Δ is Left's allocation, so paying Left is +amount.
  const htlcBody = (account: ReturnType<typeof w.accountOf>, payer: Party, amount: bigint, deadline: number): Body => {
    const payeeIsLeft = account.L.id !== payer.id;
    const batch = coder.encode([ethers.ParamType.from(BATCH_ABI as never)], [{
      payment: [{ deltaIndex: 0, amount: encodeSignedAmount(payeeIsLeft ? amount : -amount), revealedUntilTimestamp: T0 + deadline, hash: hashlock }],
      swap: [], pull: [],
    }]);
    return {
      ...account.body(0n, WINDOWS),
      transformers: [{ transformerAddress: transformer, encodedBatch: batch, allowances: [{ deltaIndex: 0, rightAllowance: amount, leftAllowance: amount }] }],
    };
  };
  const upBody = htlcBody(up, A, 50n, 1000);
  const downBody = htlcBody(down, H, 50n, 900);
  for (const p of [A, H, B]) await w.chain.debugFundReserves(p.id, w.TOKEN, 1000n);
  const upLeft = up.L.id === A.id;   // A proposed the upstream proof
  const downLeft = down.L.id === H.id; // H proposed the downstream proof
  const upEpoch = await up.epochOf(), downEpoch = await down.epochOf();
  const upByH = up.proofSig(H, upEpoch, 1, upLeft, upBody);
  const downByB = down.proofSig(B, downEpoch, 1, downLeft, downBody);
  const net = async () => {
    const r = (p: Party) => w.chain.getReserves(p.id, w.TOKEN);
    return { A: (await r(A)) - 1000n, H: (await r(H)) - 1000n, B: (await r(B)) - 1000n };
  };
  // Both disputes open early, so both finalization barriers (start + 2 windows) are long past by t=230.
  const openBoth = async () => {
    w.at(100);
    expect(await w.start(A, H, 1, upLeft, upBody, upByH)).toBe("ok");
    w.at(101);
    expect(await w.start(H, B, 1, downLeft, downBody, downByB)).toBe("ok");
    w.at(230);
  };
  const finalizeUp = (who: Party, other: Party, args = {}) =>
    w.finalize(who, other, { nonce: 1, body: upBody, startedByLeft: up.L.id === A.id }, { nonce: 1, proposerIsLeft: upLeft, body: upBody, sig: "0x" }, args);
  const finalizeDown = (who: Party, other: Party, args = {}) =>
    w.finalize(who, other, { nonce: 1, body: downBody, startedByLeft: down.L.id === H.id }, { nonce: 1, proposerIsLeft: downLeft, body: downBody, sig: "0x" }, args);
  const startUp = () => w.start(A, H, 1, upLeft, upBody, upByH);
  return { w, A, H, B, net, openBoth, startUp, finalizeUp, finalizeDown, deadlineUp: T0 + 1000 };
};

describe("H1 unrevealed HTLC waits for its deadline", () => {
  test("the hub is not robbed: upstream cannot settle unpaid before its deadline", async () => {
    const { w, A, H, B, net, openBoth, finalizeUp, finalizeDown, deadlineUp } = await hubWorld();
    await openBoth();
    // A finalizes upstream with no secret anywhere. It must wait for the deadline, not settle as unpaid.
    const upstream = await finalizeUp(A, H);
    expect(upstream).toBe(`REVERT PaymentRevealWindowActive(${deadlineUp})`);
    // B claims downstream with the secret; the secret is now known to the hub.
    expect(await finalizeDown(B, H, { other: argsWithSecret })).toBe("ok");
    // The hub answers upstream with the same secret and is paid by A.
    expect(await finalizeUp(H, A, { other: argsWithSecret })).toBe("ok");
    expect(await net()).toEqual({ A: -50n, H: 0n, B: 50n });
    void w;
  });

  test("a public secret ends the wait: the payee finalizes without delay", async () => {
    const { w, A, H, net, openBoth, finalizeUp } = await hubWorld();
    await openBoth();
    expect(await w.submit(H, { revealSecrets: [{ transformer: w.chain.addresses.deltaTransformer, secret }] })).toBe("ok");
    expect(await finalizeUp(A, H)).toBe("ok");
    expect((await net()).H).toBe(50n);
  });

  test("after the deadline an unrevealed payment settles as unpaid, and the dispute closes", async () => {
    const { w, A, H, net, openBoth, finalizeUp, deadlineUp } = await hubWorld();
    await openBoth();
    w.at(deadlineUp - T0 + 1);
    expect(await finalizeUp(A, H)).toBe("ok");
    expect(await net()).toEqual({ A: 0n, H: 0n, B: 0n });
  });

  // The reveal time, not the dispute-start time, decides. Upstream deadline is T0 + 1000.
  test("a secret revealed on chain before the deadline is paid even if the dispute starts after the deadline", async () => {
    const { w, A, H, net, startUp, finalizeUp, deadlineUp } = await hubWorld();
    w.at(900);
    expect(await w.submit(H, { revealSecrets: [{ transformer: w.chain.addresses.deltaTransformer, secret }] })).toBe("ok");
    w.at(deadlineUp - T0 + 100);
    expect(await startUp()).toBe("ok");
    w.at(deadlineUp - T0 + 300);
    expect(await finalizeUp(A, H)).toBe("ok");
    expect(await net()).toEqual({ A: -50n, H: 50n, B: 0n });
  });

  test("a secret revealed on chain after the deadline is not paid, even when the dispute is open at the reveal", async () => {
    const { w, A, H, net, startUp, finalizeUp, deadlineUp } = await hubWorld();
    w.at(100);
    expect(await startUp()).toBe("ok");
    w.at(deadlineUp - T0 + 50);
    expect(await w.submit(H, { revealSecrets: [{ transformer: w.chain.addresses.deltaTransformer, secret }] })).toBe("ok");
    w.at(deadlineUp - T0 + 300);
    expect(await finalizeUp(A, H)).toBe("ok");
    expect(await net()).toEqual({ A: 0n, H: 0n, B: 0n });
  });
});
