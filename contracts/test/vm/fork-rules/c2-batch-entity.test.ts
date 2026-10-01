// C2 (contracts-review.md): a batch hanko must bind the acting entity. Before the fix, a signature over a batch for the
// signer's lazy entity replayed as any numbered entity with the same board. Runs the real Depository stack in BrowserVM.
import { describe, expect, test } from "bun:test";
import { boot, claimsHanko, party, rawHanko, singleSignerBoard } from "../rig.ts";

const TOKEN = 1;

/** A lazy entity and a numbered entity with the same 1-of-1 board, both funded; the owner's key controls both. */
const sameBoardPair = async (label: string) => {
  const w = await boot(label);
  const owner = party(`${label}-owner`);
  const sink = party(`${label}-sink`);
  const { entityNumbers } = await w.vm.registerNumberedEntitiesBatch([singleSignerBoard(owner.address)]);
  const numbered = `0x${BigInt(entityNumbers[0]).toString(16).padStart(64, "0")}`;
  await w.chain.debugFundReserves(owner.id, TOKEN, 100n);
  await w.chain.debugFundReserves(numbered, TOKEN, 1000n);
  const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), reserveToReserve: [{ receivingEntity: sink.id, tokenId: TOKEN, amount: 100n }] } as never);
  const balances = async () => ({
    lazy: await w.chain.getReserves(owner.id, TOKEN),
    numbered: await w.chain.getReserves(numbered, TOKEN),
    sink: await w.chain.getReserves(sink.id, TOKEN),
  });
  return { w, owner, sink, numbered, encoded, balances };
};

describe("C2 batch hanko binds the entity", () => {
  test("a batch signed for the lazy entity does not replay as a numbered entity with the same board", async () => {
    const { w, owner, numbered, encoded, balances } = await sameBoardPair("c2-replay");
    const signed = rawHanko(w.batchHash(owner.id, encoded, 1n), owner.key);
    // The owner's own batch for its lazy entity runs once.
    expect(await w.sendRaw(owner.id, encoded, signed, 1n)).toBe("ok");
    expect(await balances()).toEqual({ lazy: 0n, numbered: 1000n, sink: 100n });
    // Anyone rewraps the same signature as a claims hanko naming the numbered entity (whose entity nonce is also 0).
    expect(await w.sendRaw(numbered, encoded, claimsHanko(signed, numbered), 1n)).toBe("REVERT E4()");
    expect(await balances()).toEqual({ lazy: 0n, numbered: 1000n, sink: 100n });
  });

  test("the numbered entity's own signature, over its own id, is accepted", async () => {
    const { w, owner, numbered, encoded, balances } = await sameBoardPair("c2-own");
    const signed = rawHanko(w.batchHash(numbered, encoded, 1n), owner.key);
    expect(await w.sendRaw(numbered, encoded, claimsHanko(signed, numbered), 1n)).toBe("ok");
    expect(await balances()).toEqual({ lazy: 100n, numbered: 900n, sink: 100n });
  });

  test("a caller cannot act as an entity the hanko does not name", async () => {
    const { w, owner, numbered, encoded, balances } = await sameBoardPair("c2-mismatch");
    // Signed over the numbered id, but the hanko envelope names the lazy entity's board hash instead.
    const signed = rawHanko(w.batchHash(numbered, encoded, 1n), owner.key);
    expect(await w.sendRaw(numbered, encoded, signed, 1n)).toBe("REVERT E4()");
    expect(await balances()).toEqual({ lazy: 100n, numbered: 1000n, sink: 0n });
  });
});
