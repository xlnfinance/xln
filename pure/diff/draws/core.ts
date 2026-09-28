// Core draws: the base world every area walks on (Accounts, credit, payments, reserves, the J batch, chat, profile
// and hub config). Owner: thread "Independent review of main".
import { drawn, arises, pending, type Moves, type Step, type WorldMoves } from "./areas.ts";
import { PARTIES, activePairs, pick, amount, one, tx, sealed, queued } from "./world-view.ts";
import { HUB, SPOKES, TOKEN } from "../world.ts";
import { SIGNERS } from "../lane.ts";

export const CORE: Moves<"core"> = {
  openAccount: drawn(
    (w) => SPOKES.some((s) => SPOKES.some((t) => s !== t && !w.hasAccount(s, t))),
    (w) => {
      const [s, t] = pick(w, SPOKES.flatMap((s) => SPOKES.filter((t) => s !== t && !w.hasAccount(s, t)).map((t) => [s, t] as const)));
      return one(w, s, [w.open(s, t, amount(w, 5_000))]);
    },
  ),
  extendCredit: drawn(
    (w) => activePairs(w).length > 0,
    (w) => {
      const [x, y] = pick(w, activePairs(w));
      return one(w, x, [w.extend(x, y, amount(w, 20_000))]);
    },
  ),
  directPayment: drawn(
    (w) => activePairs(w).length > 0,
    (w) => {
      const [x, y] = pick(w, activePairs(w));
      return one(w, x, [w.direct(x, y, amount(w, 600))]);
    },
  ),
  htlcPayment: drawn(
    (w) => SPOKES.some((s) => SPOKES.some((t) => s !== t && w.routable(s, t))),
    (w) => {
      const [s, t] = pick(w, SPOKES.flatMap((s) => SPOKES.filter((t) => s !== t && w.routable(s, t)).map((t) => [s, t] as const)));
      return one(w, s, [w.htlc(s, t, amount(w, 300))]);
    },
  ),
  r2c: drawn(
    (w) => activePairs(w).some(([x]) => w.reserveOf(x) > 0n && !sealed(w, x)),
    (w) => {
      const [x, y] = pick(w, activePairs(w).filter(([x]) => w.reserveOf(x) > 0n && !sealed(w, x)));
      return one(w, x, [tx("r2c", { counterpartyId: w.ids[y], tokenId: 1, amount: 1n + (w.reserveOf(x) * BigInt(w.ri(30))) / 100n })]);
    },
  ),
  r2r: drawn(
    (w) => PARTIES.some((x) => w.reserveOf(x) > 0n && !sealed(w, x)),
    (w) => {
      const x = pick(w, PARTIES.filter((x) => w.reserveOf(x) > 0n && !sealed(w, x)));
      const y = pick(w, PARTIES.filter((y) => y !== x));
      return one(w, x, [tx("r2r", { toEntityId: w.ids[y], tokenId: 1, amount: 1n + (w.reserveOf(x) * BigInt(w.ri(20))) / 100n })]);
    },
  ),
  j_broadcast: drawn(
    (w) => PARTIES.some((x) => queued(w, x) && !sealed(w, x)),
    (w) => one(w, pick(w, PARTIES.filter((x) => queued(w, x) && !sealed(w, x))), [tx("j_broadcast", {})]),
  ),
  chat: drawn(
    () => true,
    (w) => {
      const x = pick(w, PARTIES);
      return one(w, x, [tx("chat", { from: SIGNERS[x]!.toLowerCase(), message: `hi ${w.ri(1000)}` })]);
    },
  ),
  chatMessage: drawn(
    () => true,
    (w) => one(w, pick(w, PARTIES), [tx("chatMessage", { message: `note ${w.ri(1000)}`, timestamp: Number(w.lane.runtime().timestamp) })]),
  ),
  "profile-update": drawn(
    () => true,
    (w) => {
      const x = pick(w, PARTIES);
      return one(w, x, [tx("profile-update", { profile: { entityId: w.ids[x], name: `E${w.ri(100)}`, bio: "walk" } })]);
    },
  ),
  setHubConfig: drawn(
    () => true,
    (w) => one(w, HUB, [tx("setHubConfig", { matchingStrategy: "amount", policyVersion: 1, routingFeePPM: w.ri(100), baseFee: 0n })]),
  ),
  setRebalancePolicy: drawn(
    (w) => activePairs(w).length > 0,
    (w) => {
      const [x, y] = pick(w, activePairs(w));
      const soft = amount(w, 10_000);
      return one(w, x, [tx("setRebalancePolicy", {
        counterpartyEntityId: w.ids[y], tokenId: TOKEN, r2cRequestSoftLimit: soft, hardLimit: soft * 2n, maxAcceptableFee: amount(w, 100),
      })]);
    },
  ),
  requestCollateral: pending("the hub's rebalance fee policy and a quote"),
  accountInput: arises("bilateral Account consensus between Entities"),
  entityCommand: arises("admission of locally authored txs"),
  j_event: arises("og's J watcher and the Entity's J-prefix round"),
  j_rebroadcast: pending("a sealed batch the chain has not confirmed"),
  j_abort_sent_batch: pending("a sealed batch the chain has not confirmed"),
  j_clear_batch: pending("an unsealed batch the Entity abandons"),
  e2r: pending("an external ERC token contract"),
  mintReserves: pending("og's admin mint authority"),
  runtimeOutput: arises("cross-j Runtime outputs (scenario-cross-j.test.ts)"),
  scheduledWake: arises("the Runtime's scheduled wakes"),
  proposeAccountsNow: arises("the Account proposal hook"),
  processHtlcTimeouts: arises("the HTLC timeout hook"),
  resolveHtlcLock: arises("an HTLC secret reveal"),
};

/** World moves: the chain funds a random Entity's reserve, which og's watcher reports; or the walk idles a frame. */
export const CORE_WORLD: WorldMoves = {
  fund: {
    enabled: () => true,
    draw: async (w): Promise<Step> => {
      await w.chain.debugFundReserves(w.ids[w.ri(4)]!, 1, BigInt(1 + w.ri(1_000_000)));
      return { runtimeTxs: [], users: [] };
    },
  },
  idle: { enabled: () => true, draw: (): Step => ({ runtimeTxs: [], users: [] }) },
};
