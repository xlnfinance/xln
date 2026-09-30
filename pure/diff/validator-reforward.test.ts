import { afterAll, describe, expect, test } from "bun:test";
// Runtime-loop differential for og forwardValidatorMempool (core/entity/consensus/input/admission.ts:114), which
// admitEntityTransactions runs on every input but account work (admission.ts:197-198). A non-proposer keeps what it
// forwarded in its mempool until the frame carrying it commits (admission.ts:29), so every input it admits meanwhile
// sends that mempool to the proposer again, ahead of the input's own outputs.
//
// A scripted run (fixed inputs, no walk) on the 2-of-3 board B (world.ts, `{ board: true }`), SIGNERS[0] proposing:
//   1. SIGNERS[2] authors a board proposal; its replica forwards it to the proposer (the txs input);
//   2. the proposer proposes the frame carrying it to SIGNERS[1] and SIGNERS[2];
//   3. SIGNERS[2]'s replica receives that proposal while it still holds its propose: og forwards it to the proposer
//      once more, then precommits. The rewrite, before this fix, only precommitted.
// The lane compares og processRuntime with the rewrite's commitRuntimeFrame on every frame.
import { entityLog } from "../../core/entity/consensus/entity-log.ts";
import type { EntityTx } from "../xln.ts";
import { SIGNERS, type User } from "./lane.ts";
import { BOARD, openWorld, type World } from "./world.ts";

const SEED = 0x7e4f0;
/** Idle frames allowed for the board to settle. */
const DRAIN = 10;
const AUTHOR = 2;

/** og's mempool.forwarded_to_proposer fields, captured from its Entity logger (og logs it at debug). */
type Forward = { readonly txs: number; readonly proposer: string };
const forwards: Forward[] = [];
const ogDebug = entityLog.debug;
// monkeypatch og's logger (og is never edited): record the forward, then log as og would
entityLog.debug = (message, fields) => {
  if (message === "mempool.forwarded_to_proposer") forwards.push(fields as unknown as Forward);
  ogDebug(message, fields);
};
afterAll(() => {
  entityLog.debug = ogDebug;
});

/** og EntityReplica, as far as this test reads it. */
type OgReplica = {
  readonly entityId: string;
  readonly signerId: string;
  readonly state: { readonly height: number };
  readonly mempool: readonly unknown[];
  readonly proposal?: unknown;
  readonly lockedFrame?: unknown;
};
const boardReplicas = (w: World): readonly OgReplica[] =>
  [...(w.lane.env.state.eReplicas.values() as Iterable<OgReplica>)].filter((r) => r.entityId === w.ids[BOARD]);
/** Every member's replica of B holds one committed height, an empty mempool and no open frame. */
const settled = (w: World): boolean => {
  const replicas = boardReplicas(w);
  const heights = new Set(replicas.map((r) => r.state.height));
  return replicas.length === w.signersOf(BOARD).length
    && heights.size === 1
    && replicas.every((r) => r.mempool.length === 0 && r.proposal === undefined && r.lockedFrame === undefined);
};
const boardHeight = (w: World): number => boardReplicas(w)[0]?.state.height ?? -1;

describe("validator re-forward: og forwardValidatorMempool on every admitted input", () => {
  test("MATCH: a non-proposer still holding its propose forwards it to the proposer again when the proposal arrives", async () => {
    const w = await openWorld(SEED, "validator-reforward", { board: true });
    const step = async (users: readonly User[]): Promise<readonly string[]> => w.lane.tick([], users);
    /** Idle frames, each compared, until the board settles (at most `left`). */
    const drain = async (left: number): Promise<readonly string[]> => {
      if (left === 0 || settled(w)) return [];
      const diffs = await step([]);
      return diffs.length > 0 ? diffs : drain(left - 1);
    };
    try {
      expect(w.evidence).toEqual([]);
      const [imports, opens] = w.importAll();
      expect(await w.lane.tick(imports, [])).toEqual([]);
      expect(await step(opens)).toEqual([]);
      expect(await drain(DRAIN)).toEqual([]);
      expect(settled(w)).toBe(true);
      const before = boardHeight(w);
      forwards.splice(0);
      const propose = {
        type: "propose",
        data: {
          proposer: SIGNERS[AUTHOR]!.toLowerCase(),
          action: { type: "collective_message", data: { message: "re-forward" } },
        },
      } as unknown as EntityTx;
      expect(await step([w.user(BOARD, [propose], AUTHOR)])).toEqual([]);
      expect(await drain(DRAIN)).toEqual([]);
      expect(settled(w)).toBe(true);
      expect(boardHeight(w)).toBeGreaterThan(before);
      // og forwarded the author's mempool on admitting its own command, and again on admitting the proposal
      console.log(`og forwards ${JSON.stringify(forwards)}`);
      expect(forwards.length).toBeGreaterThanOrEqual(2);
      expect(w.refusals()).toEqual([]);
    } finally {
      await w.close();
    }
  }, 600_000);
});
