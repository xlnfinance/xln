// The walk's hookup of each property that judges every frame (P2, P4, P-BELIEF), killed by planting a fault in the Runtime the properties read: the
// lane still agrees (og and the rewrite are untouched), so only a property wired into the walk can say so, and it must say so on the frame the
// fault appears (review A of #69, F3). P1 and the at-rest check have no per-frame hook: a walk that never ran them raises no counter, and
// rig/properties/fired.ts turns that red (model.test.ts). The plant stays in from its frame on, so a hookup that judges only some frames shows too (the P4 memory is judged across frames 8 and 9).
import { expect, test } from "bun:test";
import type { AccountReplica, DisputeHanko, EntityReplica, Runtime } from "../../xln.ts";
import { drawnIn, worldIn } from "../draws/index.ts";
import type { Plant } from "../rig/frame-checks.ts";
import { walk } from "../walk.ts";

/** One seed a test, none the model walk uses: a walk run twice in one process meets its own persisted storage. */
const SEEDS = [0x30dea, 0x30deb, 0x30dec] as const;
/** The first frame whose Runtime each plant changes: every Account has opened by then. One is odd and two are even, so a hookup that judges only the even or only the odd frames shows. */
const FRAME = { P2: 9, BELIEF: 8, P4: 8 } as const;

/** The same change to every replica of every Account, so the two sides of an Account never disagree with each other. */
const onAccounts = (rt: Runtime, change: (replica: AccountReplica) => AccountReplica): Runtime => ({
  ...rt,
  entities: new Map([...rt.entities].map(([key, entity]): [string, EntityReplica] => [
    key,
    { ...entity, accountReplicas: new Map([...entity.accountReplicas].map(([peer, replica]) => [peer, change(replica)] as const)) },
  ])),
});
const onRows = (change: (row: AccountReplica["state"]["account"]["deltas"] extends ReadonlyMap<infer _K, infer V> ? V : never) => unknown) => (replica: AccountReplica): AccountReplica => ({
  ...replica,
  state: { ...replica.state, account: { ...replica.state.account, deltas: new Map([...replica.state.account.deltas].map(([token, row]) => [token, change(row)] as const)) } },
}) as AccountReplica;
const witness = (proofBodyHash: string): DisputeHanko =>
  ({ hanko: "0x", hash: `0x${"0".repeat(64)}`, proofBodyHash, proofNonce: 7, proposerIsLeft: true });

const walked = async (seed: number, plant: Plant): Promise<readonly string[]> =>
  (await walk(seed, drawnIn(["core"]), worldIn(["core"]), "core", plant)).diffs;

/** Only the properties spoke: the lane's own lines carry `frame=`, theirs `frame <n>`. */
const spoken = (lines: readonly string[]): readonly string[] => lines.filter((l) => !l.includes(" frame="));

test("P2 is wired into the walk: Left owing past its credit is red on the frame it appears", async () => {
  const lines = await walked(SEEDS[0], (rt, frame) => (frame < FRAME.P2 ? rt : onAccounts(rt, onRows((row) => ({ ...(row as object), offdelta: -(10n ** 9n) })))));
  expect(spoken(lines).length).toBeGreaterThan(0);
  expect(lines[0]).toContain(` frame ${FRAME.P2} `);
  expect(lines[0]).toContain(": P2 ");
}, 600_000);

test("P-BELIEF is wired into the walk: an Account believing a collateral the chain never held is red on the frame it appears", async () => {
  const lines = await walked(SEEDS[1], (rt, frame) => (frame < FRAME.BELIEF ? rt : onAccounts(rt, onRows((row) => ({ ...(row as { collateral: bigint }), collateral: (row as { collateral: bigint }).collateral + 777n })))));
  expect(spoken(lines).length).toBeGreaterThan(0);
  expect(lines[0]).toContain(` frame ${FRAME.BELIEF} `);
  expect(lines[0]).toContain("P-BELIEF");
}, 600_000);

test("P4 is wired into the walk, with its memory kept from frame to frame: one signer, one proof nonce, two bodies is red on the second frame", async () => {
  const body = (frame: number): string => `0x${(frame === FRAME.P4 ? "a" : "b").repeat(64)}`;
  const lines = await walked(SEEDS[2], (rt, frame) =>
    frame < FRAME.P4 ? rt : onAccounts(rt, (replica) => ({ ...replica, dispute: { ...replica.dispute, current: witness(body(frame)) } }) as AccountReplica));
  expect(spoken(lines).length).toBeGreaterThan(0);
  expect(lines[0]).toContain(` frame ${FRAME.P4 + 1} `);
  expect(lines[0]).toContain(": P4 ");
}, 600_000);
