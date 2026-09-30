// Each property check passes an honest Account and goes red on the broken state it exists to catch.
import { expect, test } from "bun:test";
import { unwrap } from "../../xln_run.ts";
import { accountId, genesisReplica, tokenId } from "../../xln.ts";
import type { AccountReplica, DisputeHanko, EntityId, Runtime } from "../../xln.ts";
import { checkProperties, NOTHING_SIGNED } from "./properties.ts";

const L = `0x${"1".padStart(64, "0")}` as EntityId;
const R = `0x${"2".padStart(64, "0")}` as EntityId;
const TK = unwrap(tokenId("1"));
const TERMS = {
  domain: { chainId: 31337, depositoryAddress: `0x${"d".repeat(40)}` },
  watchSeed: `0x${"ab".repeat(32)}`,
  disputeConfig: { leftResponseSeconds: 60, rightResponseSeconds: 60 },
};
const genesis = unwrap(genesisReplica(unwrap(accountId(L, R)), TERMS));

/** An Account whose one token has this collateral, Δ and credit, as each side holds it. */
const replicaWith = (
  delta: { collateral: bigint; offdelta: bigint; leftCreditLimit: bigint; rightCreditLimit: bigint },
  dispute = genesis.dispute,
): AccountReplica => ({
  ...genesis,
  dispute,
  state: {
    ...genesis.state,
    account: { ...genesis.state.account, deltas: new Map([[TK, { tokenId: TK, ondelta: 0n, ...delta }]]) },
  },
});
const runtimeOf = (left: AccountReplica, right: AccountReplica): Runtime => ({
  entities: new Map([
    [`${L}:a`, { state: { id: L }, accountReplicas: new Map([[R, left]]) }],
    [`${R}:b`, { state: { id: R }, accountReplicas: new Map([[L, right]]) }],
  ]),
}) as unknown as Runtime;
const honest = { collateral: 100n, offdelta: -30n, leftCreditLimit: 50n, rightCreditLimit: 0n };
const witness = (proofBodyHash: string): DisputeHanko =>
  ({ hanko: "0x", hash: `0x${"0".repeat(64)}`, proofBodyHash, proofNonce: 4, proposerIsLeft: true });

test("an honest Account breaks no property", () => {
  const a = replicaWith(honest);
  expect(checkProperties(runtimeOf(a, a), NOTHING_SIGNED).violations).toEqual([]);
});

test("P2: Left owing past the credit Right extends is red", () => {
  const a = replicaWith({ ...honest, offdelta: -51n });
  const { violations } = checkProperties(runtimeOf(a, a), NOTHING_SIGNED);
  expect(violations.filter((v) => v.startsWith("P2"))).toHaveLength(2);
});

test("P2: Right owed past collateral plus its credit is red", () => {
  const a = replicaWith({ ...honest, offdelta: 101n });
  expect(checkProperties(runtimeOf(a, a), NOTHING_SIGNED).violations.some((v) => v.startsWith("P2"))).toBe(true);
});

test("P4: one Entity signing two bodies at one proof nonce is red, even frames apart", () => {
  const first = replicaWith(honest, { nextProofNonce: 5, current: witness(`0x${"a".repeat(64)}`) });
  const later = replicaWith(honest, { nextProofNonce: 5, current: witness(`0x${"b".repeat(64)}`) });
  const peer = replicaWith(honest);
  const once = checkProperties(runtimeOf(first, peer), NOTHING_SIGNED);
  expect(once.violations).toEqual([]);
  const twice = checkProperties(runtimeOf(later, peer), once.signed);
  expect(twice.violations.filter((v) => v.startsWith("P4"))).toHaveLength(1);
});

test("P4: the peer's hanko and our own at one nonce may differ (two signers)", () => {
  const a = replicaWith(honest, {
    nextProofNonce: 5, current: witness(`0x${"a".repeat(64)}`), counterparty: witness(`0x${"b".repeat(64)}`),
  });
  expect(checkProperties(runtimeOf(a, replicaWith(honest)), NOTHING_SIGNED).violations).toEqual([]);
});

test("P4: two sides at one frame height holding different deltas is red", () => {
  const { violations } = checkProperties(
    runtimeOf(replicaWith(honest), replicaWith({ ...honest, offdelta: -29n })), NOTHING_SIGNED);
  expect(violations.filter((v) => v.startsWith("P4"))).toHaveLength(1);
});
