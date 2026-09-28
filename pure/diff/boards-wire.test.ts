import { describe, expect, test } from "bun:test";
// The boards area's txs on og's wire: the rewrite's command hash and collective action hash for an EntityProvider
// transfer against og's own encoders (command/command-codec.ts:106, auth/authorization.ts:147). og keeps the
// transfer's token id a bigint (types/entity-tx.ts:479); a number there changes both hashes.
import { hashEntityCommandTxs } from "../../core/entity/command/command-codec.ts";
import { buildEntityTransactionProposalAction } from "../../core/entity/auth/authorization.ts";
import { entityTransactionAction, hashCommandTxs, type EntityTx } from "../xln.ts";
import { unwrap } from "../xln_run.ts";
import { lcg31, seedOf, seedTag } from "./seed.ts";

type Transfer = Extract<EntityTx, { type: "entityProviderTransfer" }>;
const RECIPIENTS = [
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
] as const;
const CASES = 64;

/** One transfer per seed step: a recipient, a token id and a positive amount, each wide enough to cross 2^53. */
const transferAt = (step: number): Transfer => {
  const a = lcg31(step);
  const b = lcg31(a);
  const c = lcg31(b);
  return {
    type: "entityProviderTransfer",
    data: {
      to: RECIPIENTS[a % RECIPIENTS.length]!,
      tokenId: BigInt(b % 3 === 0 ? b : b % 5),
      amount: 1n + BigInt(c) * BigInt(c),
    },
  };
};
const transfers: readonly Transfer[] = Array.from({ length: CASES }, (_, i) =>
  transferAt(lcg31(seedOf(0x1b0a2d) + i)));
/** og's own copy of the tx: the same fields, the same bigint types. */
const ogTx = (t: Transfer) => ({ type: t.type, data: { ...t.data } });

describe(seedTag("boards wire: EntityProvider transfer hashes, rewrite vs og"), () => {
  test(`MATCH: ${CASES} transfers give og's command hash (hashEntityCommandTxs)`, () => {
    const rewrite = transfers.map((t) => unwrap(hashCommandTxs([t])));
    const og = transfers.map((t) => hashEntityCommandTxs([ogTx(t) as never]));
    expect(rewrite).toEqual(og);
  });
  test(`MATCH: ${CASES} transfers give og's collective action hash (buildEntityTransactionProposalAction)`, () => {
    const actionHash = (t: Transfer): string => {
      const action = unwrap(entityTransactionAction([t]));
      return action.type === "entity_transaction" ? action.data.actionHash : "";
    };
    const rewrite = transfers.map(actionHash);
    const og = transfers.map((t) => buildEntityTransactionProposalAction([ogTx(t) as never]).data.actionHash);
    expect(rewrite).toEqual(og);
  });
});
