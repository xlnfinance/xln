// The scenario, in the order money flows. Each step does as much as main allows on the real contracts and says, by
// name, what it needed that main does not have (lib/gaps.ts). A step that cannot run at all throws `Blocked`.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { CONTRACT_NAMES, deployedManifest } from "../contracts/deploy/manifest.ts";
import { clockParams, jHeight, ownView } from "../pure/account/clause/clock.ts";
import { allocation, deposit } from "../pure/account/ledger.ts";
import { holdId, tokenId, type Side, type TokenId } from "../pure/account/model.ts";
import { ledgerOf } from "../pure/account/state.ts";
import { proofBodyOf } from "../pure/account/proof/body.ts";
import type { SigningContext } from "../pure/account/proof/signing.ts";
import { proofBodyHash } from "../pure/chain/proof/proof.ts";
import { accountMessageHash } from "../pure/chain/proof/payload.ts";
import { keccakHex } from "../pure/kernel/encoding/bytes.ts";
import { startAnvil, assertLoopback, scrubbedEnv, type Anvil } from "./lib/anvil.ts";
import {
  accountKeyOf, accountOnChain, advanceTime, collateralOf, connect, eid, hankoOf, heldBy, leftOf, must, partyOf, reserveOf, sendOps,
  unit, type Chain, type Manifest, type Party,
} from "./lib/chain.ts";
import { GAPS, REPO } from "./lib/gaps.ts";
import { Blocked, type Step } from "./lib/runner.ts";
import type { EntityId } from "../pure/entity/model.ts";
import type { ClockParams, JView } from "../pure/account/clause/clock.ts";
import { Cluster } from "./lib/cluster.ts";
import { Seat } from "./lib/seat.ts";
import { openWal } from "../pure/host/shell/disk/store.ts";
import { fileDisk } from "../pure/host/shell/node/file-disk.ts";
import { scanJournal, type JournalRecord } from "../pure/host/shell/submit/journal.ts";
import type { Setup } from "../pure/runtime/model.ts";

export type Options = Readonly<{ rpc: string | null; fork: string }>;

/** What the steps share: the node, the parties and the Accounts as they stand. */
export type World = {
  options: Options;
  anvil: Anvil | null;
  manifest: Manifest;
  chain: Chain | null;
  facts: { mode: string; chainId: string; block: string };
  parties: Record<"alice" | "hubX" | "hubY" | "bob", Party> | null;
  /** The four nodes, each with its own J loop, and where their frames are signed. */
  net: Cluster | null;
  signing: SigningContext | null;
  held: bigint | null;
};

/** The clock rule's parameters and the J view the Runtimes start at. */
type View = Readonly<{ clock: ClockParams; view: JView }>;


const loadManifest = (): Manifest =>
  deployedManifest(JSON.parse(readFileSync(join(REPO, "contracts/deploy/sepolia.manifest.json"), "utf8")));

export const newWorld = (options: Options): World =>
  ({ options, anvil: null, manifest: loadManifest(), chain: null, facts: { mode: "", chainId: "", block: "" }, parties: null, net: null, signing: null, held: null });

const chainOf = (w: World): Chain => w.chain ?? (() => { throw new Error("no chain: the fork step did not finish"); })();
const partiesOf = (w: World) => w.parties ?? (() => { throw new Error("no parties"); })();
const netOf = (w: World): Cluster => w.net ?? (() => { throw new Error("no Runtimes: the open step did not finish"); })();
const fmt = (chain: Chain, n: bigint): string => `${ethers.formatUnits(n, chain.manifest.token.decimals)} ${chain.manifest.token.symbol}`;
const token = (chain: Chain): TokenId => must(tokenId(chain.tokenId), "token id");
const DEPOSIT = 500n;
const COLLATERAL = 100n;

// ---- S0 ----------------------------------------------------------------------------------------------------------
const fork: Step<World> = {
  id: "fork", title: "Fork Sepolia and find the deployed contracts", needs: [],
  run: async (w) => {
    if (w.options.rpc !== null) assertLoopback(w.options.rpc);
    const rpc = w.options.rpc ?? (w.anvil = await startAnvil(w.options.fork)).url;
    const chain = await connect(rpc, w.manifest);
    w.chain = chain;
    // Only an anvil node answers this; a tunnel on 127.0.0.1 to a real node would fail here, before any transaction.
    await chain.provider.send("anvil_nodeInfo", []).catch(() => { throw new Error(`${rpc} is not an anvil node (anvil_nodeInfo): this run only sends to a throw-away node`); });
    const block = await chain.provider.getBlockNumber();
    const mode = w.options.rpc !== null ? `existing loopback node ${rpc}` : `anvil fork of ${new URL(w.options.fork).hostname}`;
    w.facts = { mode, chainId: chain.chainId.toString(), block: block.toString() };
    if (chain.chainId !== BigInt(w.manifest.chainId)) throw new Error(`the node is chain ${chain.chainId}, the manifest is ${w.manifest.chainId}`);
    const checks: string[] = [`node ${rpc} answers as chain ${chain.chainId} at block ${block} (the manifest's chain)`];
    const wrong = (await Promise.all(CONTRACT_NAMES.map(async (name) => {
      const entry = w.manifest.contracts[name]!;
      const code = await chain.provider.getCode(entry.address);
      return ethers.keccak256(code) === entry.codeHash ? null : name;
    }))).filter((n) => n !== null);
    if (wrong.length > 0) throw new Error(`deployed code differs from the manifest's code hash for: ${wrong.join(", ")}`);
    checks.push(`${CONTRACT_NAMES.length} of ${CONTRACT_NAMES.length} contracts hold the code hash the manifest records (contracts/deploy/sepolia.manifest.json)`);
    const verify = Bun.spawnSync(["bun", "contracts/deploy/verify.ts", "--rpc", rpc], { cwd: REPO, env: scrubbedEnv() });
    const verdict = ({ 0: "equals", 1: "DIFFERS from", 2: "could not be compared with" } as Record<number, string>)[verify.exitCode] ?? `exit ${verify.exitCode}`;
    checks.push(`contracts/deploy/verify.ts: the code on the node ${verdict} this checkout's build (exit ${verify.exitCode})`);
    if (verify.exitCode === 1) throw new Error("verify.ts: the deployed code differs from this build");
    if (verify.exitCode !== 0) throw new Error("verify.ts could not compare the deployed code with a build: run `bash contracts/scripts/build.sh` first, a run that did not compare it is not DONE");
    return { checks, gaps: [] };
  },
};

// ---- S1 ----------------------------------------------------------------------------------------------------------
const world: Step<World> = {
  id: "world", title: "Two users and two hubs get entities, gas and test tokens", needs: ["fork"],
  run: async (w) => {
    const chain = chainOf(w);
    const parties = { alice: partyOf("alice", chain.provider), hubX: partyOf("hub-x", chain.provider), hubY: partyOf("hub-y", chain.provider), bob: partyOf("bob", chain.provider) };
    w.parties = parties;
    const all = Object.values(parties);
    await Promise.all(all.map((p) => chain.provider.send("anvil_setBalance", [p.wallet.address, ethers.toQuantity(ethers.parseEther("10"))])));
    // The fork's faucet token has an unrestricted mint(), so no key besides these is involved.
    await Promise.all(all.map(async (p) => (await chain.token.connect(p.wallet).mint(p.wallet.address, DEPOSIT * unit(chain))).wait()));
    const balances = await Promise.all(all.map((p) => chain.token.balanceOf(p.wallet.address)));
    if (balances.some((b) => b < DEPOSIT * unit(chain))) throw new Error("a party did not receive its test tokens");
    return {
      checks: [
        `entities (lazy, one signer each; ids from pure/chain/hanko lazyEntityId): ${all.map((p) => `${p.name} ${p.id.slice(0, 10)}`).join(", ")}`,
        `each wallet got 10 ETH (anvil_setBalance) and ${fmt(chain, DEPOSIT * unit(chain))} from the token's open mint; the keys are derived from fixed strings and hold nothing outside this node`,
      ],
      gaps: [],
    };
  },
};

// ---- S2 ----------------------------------------------------------------------------------------------------------
/** Where each party's seat keeps its WAL and its journal: real files, new for every run. */
const seatsDir = (): string => mkdtempSync(join(tmpdir(), "xln-e2e-seats-"));

/** What the files of a seat hold after the run: the WAL's rows and the journal's records, read back by the shell's own readers. */
const filesOf = async (dir: string, name: string): Promise<Readonly<{ rows: number; journal: readonly JournalRecord[] }>> => {
  const wal = must(await fileDisk(join(dir, "wal.log")), `${name}'s WAL`);
  const rows = must(await openWal(wal), `${name}'s WAL rows`);
  must(await wal.close(), "close WAL");
  const held = must(scanJournal(readFileSync(join(dir, "journal.log"))), `${name}'s journal`);
  return { rows: rows.length, journal: held.items };
};

const deposits: Step<World> = {
  id: "deposit", title: "Everyone moves tokens into the Depository as reserve", needs: ["world"],
  run: async (w) => {
    const chain = chainOf(w);
    const parties = Object.values(partiesOf(w));
    const { alice, hubX } = partiesOf(w);
    const signing = await signingFor(chain, alice, hubX);
    const setup: Setup = { ...(await view(chain)), anchor: { deployment: signing.deployment, terms: signing.terms } };
    const amount = DEPOSIT * unit(chain);
    const t = token(chain);
    const root = seatsDir();
    const checks = await parties.reduce<Promise<string[]>>(async (done, p) => {
      const lines = await done;
      // The wallet's own approval: the Depository pulls the tokens from the key that signs the batch.
      await (await chain.token.connect(p.wallet).approve(chain.manifest.contracts.depository.address, amount)).wait();
      const before = await reserveOf(chain, p);
      const dir = join(root, p.name);
      const seat = await Seat.open(chain, p, eid(p), setup, dir);
      const turn = await seat.tell({ _tag: "fund", token: t, amount });
      await seat.close();
      const gained = (await reserveOf(chain, p)) - before;
      if (gained !== amount) throw new Error(`${p.name}: reserve rose by ${gained}, not ${amount}`);
      const queued = turn.taken.filter((x) => x._tag === "queued").length;
      if (queued !== 1 || turn.returned.length > 0 || turn.skipped.length > 0) {
        throw new Error(`${p.name}: the builder took ${queued} asks, returned ${turn.returned.length}, skipped ${turn.skipped.length}`);
      }
      const files = await filesOf(dir, p.name);
      const [sealed, answered] = files.journal;
      if (files.journal.length !== 2 || sealed?._tag !== "sealed" || answered?._tag !== "answered" || answered.outcome !== "landed" || sealed.digest !== answered.digest) {
        throw new Error(`${p.name}: the journal holds ${JSON.stringify(files.journal, (_, x) => (typeof x === "bigint" ? x.toString() : x))}, not one sealed record and its landed answer`);
      }
      if (files.rows < 1) throw new Error(`${p.name}: the WAL on disk holds no row for the fund command`);
      return [...lines, `${p.name}: fund command, WAL ${files.rows} row(s) on disk, journal sealed then landed (nonce ${sealed.nonce}), reserve +${fmt(chain, gained)}`];
    }, Promise.resolve([]));
    return {
      checks: [
        ...checks,
        "each fund went from a Runtime command to a durable WAL row, to a batch the Host sealed (simulated at the head through eth_simulateV1), signed with the party's key and sent over JSON-RPC, and was read back as landed",
      ],
      gaps: [],
    };
  },
};

// ---- S3 ----------------------------------------------------------------------------------------------------------
/** Where an Account's frames are signed: the deployment, the Account's key, its epoch and the first nonce above the baseline (R-IMPLICIT-BASELINE), the terms the chain's dispute floor gives. */
const signingFor = async (chain: Chain, a: Party, b: Party): Promise<SigningContext> => {
  const ts = BigInt((await chain.provider.getBlock("latest"))!.timestamp);
  const height = BigInt(await chain.provider.getBlockNumber());
  const onChain = await accountOnChain(chain, a, b);
  const floor = BigInt(chain.manifest.dispute.responseFloorSeconds);
  return {
    deployment: chain.dep, accountKey: accountKeyOf(a, b), ondeltaEpoch: onChain.epoch, firstNonce: onChain.nonce + 2n,
    terms: {
      watchSeed: ethers.ZeroHash, leftResponseSeconds: floor, rightResponseSeconds: floor,
      transformer: chain.manifest.contracts.deltaTransformer.address,
      // a J height to the seconds the contract judges a reveal by: 12 s a block from the fork's latest block
      secondsOf: (deadline) => ts + 12n * (BigInt(deadline) - height),
    },
  };
};

const view = async (chain: Chain): Promise<View> => {
  const height = must(jHeight(BigInt(await chain.provider.getBlockNumber())), "height");
  return { clock: must(clockParams(2n, 4n, 100n), "clock params"), view: ownView(height, height) };
};

/** What a node's journal file holds, read back by the shell's own reader. */
const journalOf = (dir: string, name: string): readonly JournalRecord[] =>
  must(scanJournal(readFileSync(join(dir, "journal.log"))), `${name}'s journal`).items;

const quiet = (net: Cluster, parties: readonly Party[], what: string): void => {
  const noticed = parties.flatMap((p) => net.noticesOf(eid(p)).map((n) => `${p.name}: ${n}`));
  if (noticed.length > 0) throw new Error(`${what}: the Runtimes noticed ${noticed.join(", ")}`);
  const cut = parties.flatMap((p) => net.refusedBy(eid(p)).map((n) => `${p.name}: ${n}`));
  if (cut.length > 0) throw new Error(`${what}: the nodes cut connections for ${cut.join(", ")}`);
  if (net.inFlight() > 0) throw new Error(`${what}: ${net.inFlight()} lines are still on their way`);
};

const open: Step<World> = {
  id: "open", title: "Open three Accounts along the route and fund them: alice-hubX, hubX-hubY, hubY-bob", needs: ["deposit"],
  run: async (w) => {
    const chain = chainOf(w);
    const parties = partiesOf(w);
    const { alice, hubX, hubY, bob } = parties;
    const all = Object.values(parties);
    const t = token(chain);
    const v = await view(chain);
    const legs = [[alice, hubX], [hubX, hubY], [hubY, bob]] as const;
    // The Runtimes sign each Account under its own key, epoch and first nonce (R-FRAME-SIGNATURE-NAMES-ACCOUNT); the
    // harness keeps alice-hubX's context to rebuild the digest of the head that Account's chain proof names.
    const signing = await signingFor(chain, alice, hubX);
    w.signing = signing;
    const members = [{ party: alice, peers: [hubX] }, { party: hubX, peers: [alice, hubY] }, { party: hubY, peers: [hubX, bob] }, { party: bob, peers: [hubY] }];
    const net = w.net = await Cluster.open(chain, { clock: v.clock, view: v.view, anchor: { deployment: signing.deployment, terms: signing.terms } }, members);
    for (const [a, b] of legs) { await net.tell(eid(a), { _tag: "open_account", peer: eid(b) }); await net.tell(eid(b), { _tag: "open_account", peer: eid(a) }); }
    await net.settle();
    // The first frame of each Account: credit from the receiving side (a deposit waits for the first co-signed frame, R-NO-DEPOSIT-BEFORE-COSIGN).
    const credits = [[hubX, alice, 100n], [hubY, hubX, 100n], [bob, hubY, 50n]] as const;
    for (const [from, to, limit] of credits) { await net.tell(eid(from), { _tag: "set_credit", peer: eid(to), token: t, limit: limit * unit(chain) }); await net.settle(); }
    // Fundings in order, each as the funder's node is told: the deposit command becomes a chain action, the node's builder seals, signs and sends it, and the chain's answer closes it.
    // bob also funds 20 against hubY, so that one Account has a deposit from each side (the four ids sort alice < hubX < hubY < bob).
    const fundings = [...legs.map(([funder, peer]) => ({ funder, peer, amount: COLLATERAL * unit(chain) })), { funder: bob, peer: hubY, amount: 20n * unit(chain) }];
    const checks: string[] = [];
    // The Account rule's own account of the chain: what pure/account/ledger `deposit` makes of each funding, to be equal to what the chain holds.
    const expected = new Map<string, ReturnType<typeof ledgerOf>>();
    for (const { funder, peer, amount } of fundings) {
      const key = accountKeyOf(funder, peer);
      const before = net.askedBy(eid(funder)).length;
      const base = expected.get(key) ?? ledgerOf(net.account(eid(funder), eid(peer)).state, t);
      await net.tell(eid(funder), { _tag: "deposit", peer: eid(peer), token: t, amount });
      const asked = net.askedBy(eid(funder)).slice(before);
      const action = asked[0];
      if (asked.length !== 1 || action?._tag !== "deposit" || action.peer !== eid(peer) || action.token !== t || action.amount !== amount) {
        throw new Error(`${funder.name}'s deposit command did not ask the chain for exactly one deposit of ${amount} against ${peer.name}: ${JSON.stringify(asked, (_, x) => (typeof x === "bigint" ? x.toString() : x))}`);
      }
      await net.settle();
      // The Runtimes act on a chain fact only at the confirmation depth (D9): mine until the batch's block is final.
      await net.reach(BigInt(await chain.provider.getBlockNumber()));
      const side = net.account(eid(funder), eid(peer)).side;
      const ledger = must(deposit(base, side, amount), "deposit rule");
      expected.set(key, ledger);
      const onChain = await collateralOf(chain, funder, peer);
      if (onChain.collateral !== ledger.collateral || onChain.ondelta !== ledger.ondelta) {
        throw new Error(`${funder.name}-${peer.name}: the ledger rule says collateral ${ledger.collateral} ondelta ${ledger.ondelta}, the Depository says ${onChain.collateral} and ${onChain.ondelta}`);
      }
      const unlearned = [{ self: funder, other: peer }, { self: peer, other: funder }]
        .map(({ self, other }) => ({ self, ledger: ledgerOf(net.account(eid(self), eid(other)).state, t) }))
        .filter(({ ledger }) => ledger.collateral !== onChain.collateral || ledger.ondelta !== onChain.ondelta);
      if (unlearned.length > 0) {
        throw new Error(`${funder.name}-${peer.name}: the Depository holds collateral ${onChain.collateral} and ondelta ${onChain.ondelta}, but ${unlearned.map(({ self, ledger }) => `${self.name} holds ${ledger.collateral} and ${ledger.ondelta}`).join(" and ")}`);
      }
      checks.push(`${funder.name} deposit command (${side === "left" ? "Left" : "Right"}) asks for ${fmt(chain, amount)} against ${peer.name}; the Depository holds collateral ${onChain.collateral}, ondelta ${onChain.ondelta}, as the ledger rule says, and both Runtimes' ledgers hold the same, learned from the chain's AccountSettled event at the confirmation depth`);
    }
    const journals = all.map((p) => ({ p, held: journalOf(net.dirOf(eid(p)), p.name) }));
    const wrong = journals.filter(({ held }) => held.length === 0 || held.length % 2 !== 0 || held.some((r, i) => r._tag !== (i % 2 === 0 ? "sealed" : "answered") || (r._tag === "answered" && r.outcome !== "landed")));
    if (wrong.length > 0) throw new Error(`a journal does not hold a sealed record and its landed answer, pair by pair: ${wrong.map(({ p, held }) => `${p.name} ${held.map((r) => r._tag).join(",")}`).join("; ")}`);
    w.held = await heldBy(chain, all, legs.map(([a, b]) => [a, b] as const));
    if (w.held !== BigInt(all.length) * DEPOSIT * unit(chain)) throw new Error(`reserves plus collateral are ${w.held}, the deposits were ${BigInt(all.length) * DEPOSIT * unit(chain)}`);
    quiet(net, all, "open");
    return {
      checks: [
        `four nodes of the Host shell (WAL and journal on real files, a key, a chain port, a listening port on loopback) linked as the three Accounts need: ${[...net.counts()].map(([name, c]) => `${name} ${c.sent} lines sent, ${c.heard} heard, ${c.dropped} dropped`).join("; ")}; no connection was cut, no notice`,
        `open_account on both sides of three Accounts and one set_credit frame each, signed and acked over the sockets: ${all.map((p) => `${p.name} WAL ${net.rowsOf(eid(p)).length} rows`).join(", ")}`,
        ...checks,
        `each deposit went from a Runtime command to a batch its node sealed, signed and sent, and read back as landed: every journal holds sealed then answered, pair by pair (${journals.map(({ p, held }) => `${p.name} ${held.length / 2}`).join(", ")})`,
        `money held for the four entities (reserves plus collateral) is ${fmt(chain, w.held)}, equal to what they deposited`,
      ],
      gaps: [],
    };
  },
};

// ---- S4 ----------------------------------------------------------------------------------------------------------
const pay: Step<World> = {
  id: "pay", title: "alice pays hubX 30 through the Runtimes (signed frames over the link)", needs: ["open"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { alice, hubX, hubY, bob } = partiesOf(w);
    const t = token(chain);
    const [a, x] = [eid(alice), eid(hubX)];
    const before = allocation(ledgerOf(net.account(a, x).state, t));
    await net.tell(a, { _tag: "pay", peer: x, token: t, amount: 30n * unit(chain) });
    await net.settle();
    const [ra, rx] = [net.account(a, x), net.account(x, a)];
    if (ra.head !== rx.head || ra.pending !== undefined || rx.pending !== undefined) throw new Error("the two Runtimes do not hold the same committed head after the payment");
    const moved = allocation(ledgerOf(ra.state, t)) - before;
    const expected = ra.side === "left" ? -30n * unit(chain) : 30n * unit(chain);
    if (moved !== expected) throw new Error(`alice-hubX allocation moved ${moved}, expected ${expected}`);
    const limit = ledgerOf(net.account(eid(hubY), eid(bob)).state, t).limit[net.account(eid(hubY), eid(bob)).side];
    if (limit !== 50n * unit(chain)) throw new Error(`hubY's credit from bob is ${limit}, expected 50`);
    quiet(net, Object.values(partiesOf(w)), "pay");
    return {
      checks: [
        `alice pay 30 to hubX: one frame, both Runtimes committed head ${ra.head.slice(0, 12)} (the digest of the dispute proof of the state, slot ${ra.used}), allocation moved ${moved} for the ${ra.side} side`,
        `hubY-bob: bob's credit of 50 from the opening frame is in both ledgers (hubY may owe bob ${limit})`,
      ],
      gaps: [],
    };
  },
};

// ---- S5 ----------------------------------------------------------------------------------------------------------
const htlc: Step<World> = {
  id: "htlc", title: "HTLC of 10 from alice across hubX and hubY to bob, resolved back", needs: ["pay"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { alice, hubX, hubY, bob } = partiesOf(w);
    const t = token(chain);
    const hops = [[alice, hubX], [hubX, hubY], [hubY, bob]] as const;
    const secret = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes("xln-testnet-e2e-skeleton/secret")));
    const hashlock = keccakHex(secret);
    const amount = 10n * unit(chain);
    const at = net.view();
    const deadline = at + 30n;
    const offBefore = hops.map(([a, b]) => ledgerOf(net.account(eid(a), eid(b)).state, t).offdelta);
    // Bob asks for the payment (an invoice: the hashlock, his secret, what he wants and from whom), and alice's one lock,
    // which names the route after its first hop, is all that is sent: each hub's Entity forwards by itself.
    await net.tell(eid(bob), { _tag: "expect", hashlock, from: eid(hubY), token: t, amount, secret });
    const hold = { id: holdId(1n), payer: net.account(eid(alice), eid(hubX)).side, amount, hashlock, deadline: must(jHeight(deadline), "deadline") };
    await net.tell(eid(alice), { _tag: "lock", peer: eid(hubX), token: t, hold, route: [eid(hubY), eid(bob)] });
    await net.settle();
    const checks = hops.map(([payer, payee], i) => {
      const [rp, rq] = [net.account(eid(payer), eid(payee)), net.account(eid(payee), eid(payer))];
      const l = ledgerOf(rp.state, t);
      const expected = offBefore[i]! + (rp.side === "left" ? -amount : amount);
      if (rp.head !== rq.head || l.holds.length !== 0 || l.offdelta !== expected) throw new Error(`${payer.name}-${payee.name}: holds ${l.holds.length}, offdelta ${l.offdelta}, expected ${expected}`);
      return `${payer.name} to ${payee.name}: locked by the Entity of ${payer.name}, resolved by ${payee.name}, both Runtimes at head ${rp.head.slice(0, 12)}, offdelta moved ${fmt(chain, amount)} toward the payee`;
    });
    const left = [hubX, hubY, bob].map((p) => net.entity(eid(p)).paybook.size);
    if (left.some((n) => n !== 0)) throw new Error(`paybook entries left after the payment: ${left.join(",")}`);
    quiet(net, [alice, hubX, hubY, bob], "htlc");
    return { checks: [`hashlock ${hashlock.slice(0, 12)}: alice's one lock at J view ${at} (deadline view+${deadline - at}) named the route hubY, bob and became a lock on each hop made by the hubs' own Entities (their deadlines one hop apart are checked by the paybook tests, not here: the holds are gone when this step looks), and bob's resolve came back hop by hop`, ...checks, "hubs end flat: each received 10 on one Account and paid 10 on the next (no fee modelled)"], gaps: [] };
  },
};

// ---- S6 ----------------------------------------------------------------------------------------------------------
const reveal: Step<World> = {
  id: "reveal", title: "Payee reveals the secret on chain when its resolve is not acked in time", needs: ["open"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { hubY, bob } = partiesOf(w);
    const t = token(chain);
    const [y, b] = [eid(hubY), eid(bob)];
    const secret = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes("xln-testnet-e2e-skeleton/secret-2")));
    const amount = 5n * unit(chain);
    const deadline = net.view() + 30n;
    const lag = (await view(chain)).clock.lag;
    // hubY locks 5 for bob on hubY-bob; bob resolves, and the frame never reaches hubY.
    await net.tell(y, { _tag: "lock", peer: b, token: t, hold: { id: holdId(2n), payer: net.account(y, b).side, amount, hashlock: keccakHex(secret), deadline: must(jHeight(deadline), "deadline") } });
    await net.settle();
    const sinceLock = net.askedBy(b).length;
    const transformer = new ethers.Contract(chain.manifest.contracts.deltaTransformer.address, ["function hashToTimestamp(bytes32) view returns (uint256)"], chain.provider);
    const hash = keccakHex(secret);
    // Only bob's sends are lost, until the reveal is on the chain; every other node behaves normally: the node's resend timer would otherwise end the wait.
    const asked = await net.losing((message) => message.from === b, async () => {
      await net.tell(b, { _tag: "resolve", peer: y, token: t, id: holdId(2n), secret });
      await net.settle({ pending: true });
      if (net.account(b, y).pending === undefined) throw new Error("bob's resolve frame is not pending: it was acked");
      await net.reach(deadline - lag - 1n, { pending: true });
      const early = net.askedBy(b).slice(sinceLock);
      if (early.length !== 0) throw new Error(`bob asked the chain at view ${net.view()} (deadline ${deadline}, LAG ${lag}): ${JSON.stringify(early.map((x) => x._tag))}`);
      if ((await transformer.hashToTimestamp!(hash)) !== 0n) throw new Error("the secret was revealed on chain before bob asked");
      // The row of this frame carries the reveal; bob's node seals, signs and sends it by itself, and settle waits for it to land.
      await net.reach(deadline - lag, { pending: true });
      return net.askedBy(b).slice(sinceLock);
    });
    const action = asked[0];
    if (asked.length !== 1 || action?._tag !== "reveal") throw new Error(`at view ${net.view()} bob should ask for exactly one reveal: ${JSON.stringify(asked.map((x) => x._tag))}`);
    const at = await transformer.hashToTimestamp!(hash);
    if (at === 0n) throw new Error("the transformer holds no reveal time for the secret after bob's node sent the batch");
    const held = journalOf(net.dirOf(b), "bob");
    const [sealed, answered] = held.slice(-2);
    if (sealed?._tag !== "sealed" || answered?._tag !== "answered" || answered.outcome !== "landed" || sealed.digest !== answered.digest) {
      throw new Error(`bob's journal ends with ${JSON.stringify(held.slice(-2), (_, x) => (typeof x === "bigint" ? x.toString() : x))}, not a sealed reveal and its landed answer`);
    }
    // The link works again, and the node's resend timer ends the wait: the peer that was out of reach acks, and the clause is resolved off chain too.
    await net.settle();
    const [rb, ry] = [net.account(b, y), net.account(y, b)];
    if (rb.head !== ry.head || rb.pending !== undefined || ledgerOf(rb.state, t).holds.length !== 0) throw new Error("hubY-bob did not settle after the resend");
    return {
      checks: [
        `hubY locks 5 for bob (deadline ${deadline}); bob resolves and the frame is lost on the link, so it stays pending`,
        `at view ${deadline - lag - 1n} bob asks nothing; at view ${deadline - lag} (deadline minus LAG ${lag}) its WAL row carries one reveal action for the clause (R-HTLC-CLOCK c)`,
        `bob's node sealed, signed and sent the reveal itself (journal: sealed then landed, nonce ${sealed.nonce}); the transformer holds the secret's hash from block time ${at}`,
        "after the resend timer hubY acks the resolve: the Account is at one head with no open clause",
      ],
      gaps: [],
    };
  },
};

const swap: Step<World> = {
  id: "swap", title: "Two-party swap inside an Account: offer, partial fill, cancel", needs: ["open"],
  run: async () => { throw new Blocked(["entitySwapCommands", "hubMatching"], `AccountTx has offer, fill, retract and lapse (pure/account/swap, #111), but the Entity has no command that queues them and no hub turns a matched pair into them, so a Runtime cannot make a swap frame: ${GAPS.entitySwapCommands.supplier}`); },
};

// ---- S8 ----------------------------------------------------------------------------------------------------------
const dispute: Step<World> = {
  id: "dispute", title: "Forced dispute on alice-hubX from the signed proof of the last committed frame; the chain pays what the ledger says", needs: ["htlc"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const signing = w.signing ?? (() => { throw new Error("no signing context"); })();
    const { alice, hubX } = partiesOf(w);
    const t = token(chain);
    const [a, x] = [eid(alice), eid(hubX)];
    const replica = net.account(a, x);
    if (replica.head !== net.account(x, a).head) throw new Error("the two Runtimes hold different heads on alice-hubX");
    const ledger = ledgerOf(replica.state, t);
    if (ledger.holds.length !== 0) throw new Error("the Account still has an open clause; this step starts from a state with none (the open-clause dispute is its own step)");
    const floor = BigInt(chain.manifest.dispute.responseFloorSeconds);
    // The proof is the one the Account's rules signed: the body from the state, the nonce from the slot, the digest is the frame's head.
    const body = must(proofBodyOf(signing.terms, replica.state), "proof body of the committed state");
    const bodyHash = must(proofBodyHash(body), "proof body hash");
    const onChain = await accountOnChain(chain, alice, hubX);
    if (onChain.epoch !== signing.ondeltaEpoch) throw new Error(`the chain's epoch is ${onChain.epoch}, the frames were signed at ${signing.ondeltaEpoch}`);
    const nonce = signing.firstNonce + BigInt(replica.used - 1);
    if (nonce <= onChain.nonce) throw new Error(`the frame's nonce ${nonce} is not above the chain's stored ${onChain.nonce}`);
    const digestFor = (proposerIsLeft: boolean): string => must(accountMessageHash(chain.dep, { accountKey: signing.accountKey, ondeltaEpoch: onChain.epoch, nonce }, {
      _tag: "dispute_proof", proposerIsLeft, proofBodyHash: bodyHash, watchSeed: body.watchSeed,
    }), "dispute proof digest");
    // The head names whoever authored the frame: exactly one of the two readings is the head the Runtimes committed.
    const authorIsLeft = [true, false].find((left) => digestFor(left) === replica.head);
    if (authorIsLeft === undefined) throw new Error(`the head ${replica.head} is the dispute-proof digest of neither author: the frame was not signed as the chain reads it`);
    const digest = digestFor(authorIsLeft);
    const left = leftOf(alice, hubX);
    const signer = authorIsLeft ? left : left === alice ? hubX : alice;
    const starter = signer.id === alice.id ? hubX : alice;
    const sig = hankoOf(signer, digest);
    const aliceBefore = await reserveOf(chain, alice);
    const hubBefore = await reserveOf(chain, hubX);
    const held = await collateralOf(chain, alice, hubX);
    const start = await sendOps(chain, starter, [{
      _tag: "dispute_start",
      start: {
        counterentity: signer.id, nonce, ondeltaEpoch: onChain.epoch, proposerIsLeft: authorIsLeft, proofbodyHash: bodyHash, initialProofbody: body,
        watchSeed: body.watchSeed, sig, starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: ethers.ZeroHash,
      },
    }], `${starter.name} starts a dispute with ${signer.name}'s proof`);
    if (!(await accountOnChain(chain, alice, hubX)).disputeOpen) throw new Error("no dispute is open after the start");
    await advanceTime(chain, Number(2n * floor + 10n));
    const end = await sendOps(chain, starter, [{
      _tag: "dispute_finalize",
      finalization: {
        counterentity: signer.id, initialNonce: nonce, finalNonce: nonce, proposerIsLeft: authorIsLeft, initialProofbodyHash: bodyHash, finalProofbody: body,
        starterArguments: "0x", otherArguments: "0x", sig: "0x", startedByLeft: starter.id === left.id, cooperative: false,
      },
    }], `${starter.name} finalizes after both windows`);
    // What both sides believed: delta = ondelta + offdelta; Left takes delta clamped to the collateral, Right the rest. The chain's ondelta and collateral, the Runtimes' offdelta.
    const delta = held.ondelta + ledger.offdelta;
    const leftShare = delta < 0n ? 0n : delta > held.collateral ? held.collateral : delta;
    const share = (side: Side): bigint => (side === "left" ? leftShare : held.collateral - leftShare);
    const aliceGot = (await reserveOf(chain, alice)) - aliceBefore;
    const hubGot = (await reserveOf(chain, hubX)) - hubBefore;
    const sideA = replica.side;
    if (aliceGot !== share(sideA) || hubGot !== share(sideA === "left" ? "right" : "left")) {
      throw new Error(`payout: alice got ${aliceGot} and hubX ${hubGot}; the ledger (ondelta ${held.ondelta} + offdelta ${ledger.offdelta}, collateral ${held.collateral}) says ${share(sideA)} and ${share(sideA === "left" ? "right" : "left")}`);
    }
    const after = await accountOnChain(chain, alice, hubX);
    const rest = await collateralOf(chain, alice, hubX);
    if (rest.collateral !== 0n || after.epoch !== onChain.epoch + 1n || after.disputeOpen) throw new Error(`after the finalize: collateral ${rest.collateral}, epoch ${after.epoch}, dispute open ${after.disputeOpen}`);
    const parties = partiesOf(w);
    const now = await heldBy(chain, Object.values(parties), [[alice, hubX], [parties.hubX, parties.hubY], [parties.hubY, parties.bob]]);
    if (now !== w.held) throw new Error(`money is not conserved: ${w.held} before the dispute, ${now} after`);
    return {
      checks: [
        `${signer.name} signed the head of the last committed frame (slot ${replica.used}, nonce ${nonce}, epoch ${onChain.epoch}; body from pure/account/proof/body.ts, offdelta ${ledger.offdelta}, one token, no clause); its digest equals the dispute-proof digest the chain computes; ${starter.name} started with it (gas ${start.gasUsed})`,
        `after both ${floor} s windows (anvil clock jump) ${starter.name} finalized (gas ${end.gasUsed}); the chain paid alice ${fmt(chain, aliceGot)} and hubX ${fmt(chain, hubGot)}, which is what the chain's ondelta ${held.ondelta} plus the Runtimes' offdelta ${ledger.offdelta} says`,
        `collateral 0, epoch ${onChain.epoch} to ${after.epoch}, dispute closed; money held by the four entities is unchanged at ${fmt(chain, now)}`,
      ],
      gaps: ["harnessSend"],
    };
  },
};

const disputeClause: Step<World> = {
  id: "dispute-clause", title: "Forced dispute while an HTLC is open in the signed proof", needs: ["htlc"],
  run: async () => { throw new Blocked(["disputeWithClause"], `the proof body can carry a clause per open hold, but no Runtime duty starts the dispute or holds a lock that a signed proof carries (R-SIGNED-IS-LIVE): ${GAPS.disputeWithClause.supplier}`); },
};

// ---- S9 ----------------------------------------------------------------------------------------------------------
const rebase: Step<World> = {
  id: "rebase", title: "The Runtimes learn from the chain's logs that the dispute ran and ended", needs: ["dispute"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { alice, hubX } = partiesOf(w);
    const [a, x] = [eid(alice), eid(hubX)];
    const before = ledgerOf(net.account(a, x).state, token(chain)).offdelta;
    await chain.provider.send("evm_mine", []);
    await net.settle();
    const onChain = await accountOnChain(chain, alice, hubX);
    const facts = [a, x].map((id) => {
      const f = net.entity(id).chain.get(id === a ? x : a);
      if (f === undefined) throw new Error(`${id} holds no chain facts for alice-hubX`);
      return f;
    });
    const wrong = facts.filter((f) => f.epoch !== onChain.epoch || f.stored !== onChain.nonce || f.disputed || f.frames !== 0n);
    if (wrong.length > 0) throw new Error(`chain facts after the dispute: ${JSON.stringify(facts, (_, v) => (typeof v === "bigint" ? v.toString() : v))}; the chain: epoch ${onChain.epoch}, stored nonce ${onChain.nonce}`);
    // What each node's own J loop told its Entity, from the WAL rows the events are in.
    const told = (id: EntityId): readonly string[] => net.rowsOf(id).flatMap((r) => (r.input._tag === "entity" ? r.input.inputs.flatMap((i) => (i._tag.startsWith("j_") ? [i._tag] : [])) : []));
    const names = [alice, hubX].flatMap((p) => told(eid(p)).map((tag) => `${p.name} ${tag}`));
    ["j_epoch", "j_dispute_over"].forEach((tag) => {
      [alice.name, hubX.name].forEach((who) => { if (!names.includes(`${who} ${tag}`)) throw new Error(`${who} was told no ${tag} (${names.join(", ")})`); });
    });
    if (!names.some((n) => n.endsWith("j_dispute"))) throw new Error(`nobody was told of the dispute (${names.join(", ")})`);
    const after = ledgerOf(net.account(a, x).state, token(chain)).offdelta;
    return {
      checks: [
        `each node's own J loop (pure/host/shell/watch, the watcher core pure/j/watch.ts: blocks and logs by number, readings by block hash) read the Depository's logs at depth 1 up to height ${net.view()} and told its Entity ${names.length} J events, in the WAL before the height: ${names.join(", ")}`,
        `both Runtimes hold chain facts epoch ${onChain.epoch}, stored nonce ${onChain.nonce}, no dispute open, frames 0 for alice-hubX: the same as the chain`,
        `the Account itself is not rebased: its ledger still says offdelta ${after} (${after === before ? "as before" : `it was ${before}`}) with the chain's collateral at 0 and its frames not restarted for the new epoch`,
      ],
      gaps: ["ledgerRebase"],
    };
  },
};

// ---- S10 ---------------------------------------------------------------------------------------------------------
const nodes: Step<World> = {
  id: "nodes", title: "A node crashes and comes back from its WAL; the others carry on", needs: ["htlc"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { alice, hubX, hubY, bob } = partiesOf(w);
    const t = token(chain);
    const [y, b] = [eid(hubY), eid(bob)];
    const everyone = [alice, hubX, hubY, bob];
    const fingerprint = (id: EntityId): string => JSON.stringify([...net.entity(id).accounts].map(([peer, r]) => [peer, r.head, r.height, r.used, [...r.state.ledgers].map(([k, l]) => [k.toString(), l])]), (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    const asked = (id: EntityId): string => JSON.stringify(net.askedBy(id), (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    const [prints, actions, rows] = [fingerprint(y), asked(y), net.rowsOf(y).length];
    if (rows === 0) throw new Error("hubY has no committed rows to replay");
    quiet(net, everyone, "nodes, before the crash");
    const noticed = everyone.map((p) => net.noticesOf(eid(p)).length);
    // hubY dies: its Host and queue are gone, only the rows its disk holds are left.
    await net.restart(y);
    const resent = net.inFlight();
    await net.settle();
    if (fingerprint(y) !== prints) throw new Error("hubY's Accounts after the replay differ from what they were before the crash");
    if (asked(y) !== actions) throw new Error("hubY was not asked again for every chain action of its committed rows");
    // The peers drop what they already hold, and the work goes on.
    await net.tell(b, { _tag: "set_credit", peer: y, token: t, limit: 60n * unit(chain) });
    await net.settle();
    const [rb, ry] = [net.account(b, y), net.account(y, b)];
    if (rb.head !== ry.head || ledgerOf(ry.state, t).limit[ry.side] !== 60n * unit(chain)) throw new Error("bob's new credit did not reach hubY after its restart");
    // A copy of a frame a peer already holds is refused in place with a notice that names it (refused_not_next), and nothing else is.
    const copies = everyone.flatMap((p, i) => net.noticesOf(eid(p)).slice(noticed[i]!).map((n) => `${p.name}: ${n}`));
    const other = copies.filter((n) => !n.includes("refused_not_next"));
    if (other.length > 0 || copies.length === 0) throw new Error(`after the restart the peers noticed ${copies.length === 0 ? "nothing, but each copy is refused with a notice" : other.join(", ")}`);
    if (net.inFlight() > 0) throw new Error("messages are still on the link");
    return {
      checks: [
        `hubY restarted from its ${rows} durable rows alone: its Accounts (heads, slots, ledgers) are equal to what they were, and its ${net.askedBy(y).length} chain actions are asked again`,
        `the ${resent} committed outputs it re-sent were dropped by the peers as copies they already hold (${copies.length} refused_not_next notices, no other), and the link went quiet`,
        `bob then extended hubY 60 of credit over the link: one frame, both at head ${rb.head.slice(0, 12)}`,
      ],
      gaps: [],
    };
  },
};

export const STEPS: readonly Step<World>[] = [fork, world, deposits, open, pay, htlc, reveal, swap, dispute, disputeClause, rebase, nodes];
