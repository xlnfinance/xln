// The scenario, in the order money flows. Each step does as much as main allows on the real contracts and says, by
// name, what it needed that main does not have (lib/gaps.ts). A step that cannot run at all throws `Blocked`.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { CONTRACT_NAMES, deployedManifest } from "../contracts/deploy/manifest.ts";
import { clockParams, jHeight, ownView } from "../pure/account/clause/clock.ts";
import { allocation, deposit } from "../pure/account/ledger.ts";
import { holdId, tokenId, type AccountState, type Side, type TokenId } from "../pure/account/model.ts";
import { FULL_FILL, fillOf } from "../pure/account/swap/swap.ts";
import { ledgerOf } from "../pure/account/state.ts";
import { proofBodyOf } from "../pure/account/proof/body.ts";
import type { SigningContext } from "../pure/account/proof/signing.ts";
import { proofBodyHash } from "../pure/chain/proof/proof.ts";
import { accountMessageHash } from "../pure/chain/proof/payload.ts";
import { keccakHex } from "../pure/kernel/encoding/bytes.ts";
import { startAnvil, assertLoopback, scrubbedEnv, type Anvil } from "./lib/anvil.ts";
import {
  accountKeyOf, accountOnChain, advanceTime, collateralOf, connect, eid, heldBy, leftOf, must, partyOf, reserveOf,
  unit, type Chain, type Manifest, type Party,
} from "./lib/chain.ts";
import { GAPS, REPO } from "./lib/gaps.ts";
import { Blocked, type Step } from "./lib/runner.ts";
import type { EntityId } from "../pure/entity/model.ts";
import { lazyCheck } from "../pure/entity/signing/attest.ts";
import type { ClockParams, JView } from "../pure/account/clause/clock.ts";
import { Cluster, shown } from "./lib/cluster.ts";
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
  /** What alice's node did with a dispute ask while its Account was in the new epoch with no proof of it: the dispute step takes it, the rebase step reads it. */
  voidedAsk: Readonly<{ notices: readonly string[]; asks: number }> | null;
};

/** The clock rule's parameters and the J view the Runtimes start at. */
type View = Readonly<{ clock: ClockParams; view: JView }>;


const loadManifest = (): Manifest =>
  deployedManifest(JSON.parse(readFileSync(join(REPO, "contracts/deploy/sepolia.manifest.json"), "utf8")));

export const newWorld = (options: Options): World =>
  ({ options, anvil: null, manifest: loadManifest(), chain: null, facts: { mode: "", chainId: "", block: "" }, parties: null, net: null, signing: null, held: null, voidedAsk: null });

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
    const setup: Setup = { ...(await view(chain)), anchor: { deployment: signing.deployment, terms: signing.terms, check: lazyCheck } };
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

/** The swap quotes and offers an Account holds, to be the same in both Runtimes. */
const swapsOf = (s: AccountState) => [s.quotes, s.offers];

/** No notice, no cut connection, no line on its way; `expected` are the notices an earlier step caused on purpose. */
const quiet = (net: Cluster, parties: readonly Party[], what: string, expected: (notice: string) => boolean = () => false): void => {
  const noticed = parties.flatMap((p) => net.noticesOf(eid(p)).filter((n) => !expected(n)).map((n) => `${p.name}: ${n}`));
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
    const net = w.net = await Cluster.open(chain, { clock: v.clock, view: v.view, anchor: { deployment: signing.deployment, terms: signing.terms, check: lazyCheck } }, members);
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
    // Each Entity holds its peer's signature over that head (R-SIGNED-HEADS-ON-THE-WIRE), the thing a dispute starts with.
    const [pa, px] = [net.entity(a).proofs.get(x), net.entity(x).proofs.get(a)];
    if (pa?.head !== ra.head || px?.head !== ra.head || pa.slot !== ra.used || px.slot !== rx.used) throw new Error("an Entity does not hold its peer's signature over the committed head");
    if (!lazyCheck(x, ra.head, pa.sig) || !lazyCheck(a, ra.head, px.sig)) throw new Error("a signature an Entity holds is not its peer's over the head");
    const moved = allocation(ledgerOf(ra.state, t)) - before;
    const expected = ra.side === "left" ? -30n * unit(chain) : 30n * unit(chain);
    if (moved !== expected) throw new Error(`alice-hubX allocation moved ${moved}, expected ${expected}`);
    const limit = ledgerOf(net.account(eid(hubY), eid(bob)).state, t).limit[net.account(eid(hubY), eid(bob)).side];
    if (limit !== 50n * unit(chain)) throw new Error(`hubY's credit from bob is ${limit}, expected 50`);
    quiet(net, Object.values(partiesOf(w)), "pay");
    return {
      checks: [
        `alice pay 30 to hubX: one frame, both Runtimes committed head ${ra.head.slice(0, 12)} (the digest of the dispute proof of the state, slot ${ra.used}) with the peer's own signature over it kept on each side, allocation moved ${moved} for the ${ra.side} side`,
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
  id: "swap", title: "Two-party swap inside an Account: quote, partial fill, withdrawal", needs: ["htlc"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { hubX, hubY } = partiesOf(w);
    const [maker, taker] = [eid(hubX), eid(hubY)];
    const give = token(chain);
    const want = must(tokenId(chain.tokenId + 1n), "second token");
    const [giveAmount, wantAmount] = [10n * unit(chain), 20n * unit(chain)];
    // The Account has the faucet token and, for this step, a second token of credit alone: each side extends credit in it, so either may pay it.
    await net.tell(maker, { _tag: "set_credit", peer: taker, token: want, limit: 100n * unit(chain) });
    await net.settle();
    await net.tell(taker, { _tag: "set_credit", peer: maker, token: want, limit: 100n * unit(chain) });
    await net.settle();
    const [rm, rt] = [() => net.account(maker, taker), () => net.account(taker, maker)];
    const agree = (what: string): void => {
      if (rm().head !== rt().head || rm().pending !== undefined || rt().pending !== undefined) throw new Error(`${what}: the two Runtimes do not hold one committed head`);
      if (shown(swapsOf(rm().state)) !== shown(swapsOf(rt().state))) throw new Error(`${what}: the two Runtimes hold other quotes or offers: ${shown(swapsOf(rm().state))} against ${shown(swapsOf(rt().state))}`);
    };
    const offdeltas = () => [ledgerOf(rm().state, give).offdelta, ledgerOf(rm().state, want).offdelta];
    const [offGive, offWant] = offdeltas();
    const makerSide = rm().side;
    const deadline = must(jHeight(net.view() + 30n), "deadline");
    // The maker's quote: one command, one frame. It reserves only the maker's give and binds the taker to nothing (R-SWAP-CONSENT).
    await net.tell(maker, { _tag: "offer", peer: taker, id: holdId(10n), give: { token: give, amount: giveAmount }, want: { token: want, amount: wantAmount }, deadline });
    await net.settle();
    agree("quote");
    const quoted = rm().state;
    if (quoted.quotes.length !== 1 || quoted.offers.length !== 0) throw new Error(`after the quote: ${quoted.quotes.length} quotes and ${quoted.offers.length} offers, expected one quote`);
    if (ledgerOf(quoted, give).reserved[makerSide] !== giveAmount) throw new Error(`the quote reserves ${ledgerOf(quoted, give).reserved[makerSide]} of the maker's give, expected ${giveAmount}`);
    const takerReserved = [give, want].map((t) => ledgerOf(quoted, t).reserved[rt().side]);
    if (takerReserved.some((n) => n !== 0n) || shown(offdeltas()) !== shown([offGive, offWant])) throw new Error(`the quote cost the taker room (reserved ${takerReserved.join(",")}) or moved an offdelta: it must bind the taker to nothing`);
    // The taker's first fill is its acceptance: it takes about half, at the chain's own arithmetic, and the rest is an offer.
    const ratio = Math.floor(FULL_FILL / 2);
    await net.tell(taker, { _tag: "fill", peer: maker, id: holdId(10n), ratio });
    await net.settle();
    agree("fill");
    const [paidGive, paidWant] = [fillOf(giveAmount, ratio), fillOf(wantAmount, ratio)];
    const [afterGive, afterWant] = offdeltas();
    const [dGive, dWant] = [afterGive! - offGive!, afterWant! - offWant!];
    const [expectGive, expectWant] = makerSide === "left" ? [-paidGive, paidWant] : [paidGive, -paidWant];
    if (dGive !== expectGive || dWant !== expectWant) throw new Error(`the fill moved the offdeltas by ${dGive} and ${dWant}, expected ${expectGive} and ${expectWant}`);
    const filled = rm().state;
    const left = filled.offers[0];
    if (filled.quotes.length !== 0 || filled.offers.length !== 1 || left === undefined) throw new Error(`after the fill: ${filled.quotes.length} quotes and ${filled.offers.length} offers, expected the remainder as one offer`);
    if (left.give.amount !== giveAmount - paidGive || left.want.amount !== wantAmount - paidWant) throw new Error(`the remainder is ${left.give.amount} for ${left.want.amount}, expected ${giveAmount - paidGive} for ${wantAmount - paidWant}`);
    // The maker withdraws what is left: what was filled stays, both reservations go.
    await net.tell(maker, { _tag: "retract", peer: taker, id: holdId(10n) });
    await net.settle();
    agree("retract");
    const done = rm().state;
    const reserved = [give, want].flatMap((t) => [ledgerOf(done, t).reserved.left, ledgerOf(done, t).reserved.right]);
    if (done.quotes.length !== 0 || done.offers.length !== 0 || reserved.some((n) => n !== 0n)) throw new Error(`after the retract: ${done.quotes.length} quotes, ${done.offers.length} offers, reserved ${reserved.join(",")}; expected none`);
    if (shown(offdeltas()) !== shown([afterGive, afterWant])) throw new Error("the retract moved an offdelta: what was filled must stay");
    quiet(net, Object.values(partiesOf(w)), "swap");
    return {
      checks: [
        `hubX quotes ${fmt(chain, giveAmount)} for ${wantAmount / unit(chain)} of a second token on hubX-hubY: one frame, both Runtimes at head ${rm().head.slice(0, 12)}, the quote reserves only hubX's give: nothing is reserved against hubY and no offdelta moved`,
        `hubY's first fill at ratio ${ratio}/${FULL_FILL} is the acceptance: offdelta moved ${dGive} of the first token and ${dWant} of the second (the chain's floor(amount * ratio / 65535) on each leg), and the remainder ${left.give.amount} for ${left.want.amount} is an offer in both Runtimes`,
        "hubX's retract removes the remainder and both reservations; what was filled stays, and neither Runtime noticed anything",
      ],
      gaps: [],
    };
  },
};

// ---- S8 ----------------------------------------------------------------------------------------------------------
/** The payment alice has pending when the chain finalizes, in whole tokens. */
const PENDING_PAY = 5n;

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
    const aliceBefore = await reserveOf(chain, alice);
    const hubBefore = await reserveOf(chain, hubX);
    const held = await collateralOf(chain, alice, hubX);
    // alice's own node starts the dispute: it holds hubX's signature over the head (R-SIGNED-HEADS-ON-THE-WIRE) and asks the chain
    // for the start itself (R-DISPUTE-START); the harness only reads what the node asked and what the chain did.
    const before = net.askedBy(a).length;
    const fromBlock = (await chain.provider.getBlockNumber()) + 1;
    await net.tell(a, { _tag: "dispute", peer: x });
    await net.settle();
    const asks = net.askedBy(a).slice(before).flatMap((ask) => (ask._tag === "dispute_start" ? [ask] : []));
    const ask = asks[0];
    if (asks.length !== 1 || ask === undefined) throw new Error(`alice's node asked for ${asks.length} dispute starts, expected one`);
    if (ask.nonce !== nonce || ask.epoch !== onChain.epoch || ask.proposerIsLeft !== authorIsLeft || must(proofBodyHash(ask.body), "ask body hash") !== bodyHash) {
      throw new Error("the dispute start alice's node asked for differs from the proof the head names (nonce, epoch, author or body)");
    }
    if (net.account(a, x).used !== replica.used) throw new Error("the dispute start moved alice's Account");
    if (!(await accountOnChain(chain, alice, hubX)).disputeOpen) throw new Error("no dispute is open after the start");
    // The chain's clock runs past both windows (anvil: a clock jump, then blocks to make that second final at depth 1); alice's own
    // node is told by its J loop that the window it waits on is over, and its Entity asks the chain to finalize with what it started from.
    // A payment is pending when the chain finalizes (R-LEDGER-REBASE): alice pays hubX 5 while the window runs and the link loses alice's
    // frame on its way, so hubX never commits it (a payment hubX had committed is a newer signed proof: that one is the counter's case, and
    // hubX would answer the dispute with it). Alice holds the frame pending across the epoch move; it is outside what the chain pays.
    const finals = (): number => net.askedBy(a).slice(before).filter((ask) => ask._tag === "dispute_finalize").length;
    await net.losing((m) => m.from === a && m.to === x, async () => {
      await net.tell(a, { _tag: "pay", peer: x, token: t, amount: PENDING_PAY * unit(chain) });
      await net.settle({ pending: true });
      if (net.account(a, x).pending === undefined) throw new Error("alice's payment is not pending: the link did not lose it");
      if (net.account(x, a).used !== replica.used) throw new Error("hubX committed alice's payment: it holds a newer proof than the one the dispute started from");
      await advanceTime(chain, Number(2n * floor + 10n));
      for (let tries = 0; tries < 6 && (await accountOnChain(chain, alice, hubX)).disputeOpen; tries += 1) {
        await net.reach(BigInt(await chain.provider.getBlockNumber()), { pending: true });
      }
      // The link stays down until both nodes' J loops have told their Entities the epoch moved: a frame committed in the gap between the chain's
      // move and the Entity hearing of it is voided by the finalize with no one told, and that gap is not this step's subject.
      await chain.provider.send("evm_mine", []);
      await net.reach(BigInt(await chain.provider.getBlockNumber()), { pending: true });
      const heard = [a, x].map((id) => net.entity(id).chain.get(id === a ? x : a)?.epoch);
      if (heard.some((epoch) => epoch !== onChain.epoch + 1n)) throw new Error(`the nodes' Entities hold epochs ${shown(heard)} after the finalize, expected ${onChain.epoch + 1n}`);
      // A dispute ask now has no proof of the new epoch to start from (the peer's signature over a head of the old one is forgotten): the node
      // refuses it, and asks the chain nothing. The rebase step reads this.
      const [noticed, asked] = [net.noticesOf(a).length, net.askedBy(a).length];
      await net.tell(a, { _tag: "dispute", peer: x });
      w.voidedAsk = { notices: net.noticesOf(a).slice(noticed), asks: net.askedBy(a).length - asked };
    });
    if (finals() === 0) throw new Error("alice's node never asked the chain to finalize");
    const finalAsk = net.askedBy(a).slice(before).flatMap((ask) => (ask._tag === "dispute_finalize" ? [ask] : []))[0];
    if (finalAsk === undefined || finalAsk.nonce !== nonce || finalAsk.proposerIsLeft !== authorIsLeft || finalAsk.startedByLeft !== (a === eid(left))
      || must(proofBodyHash(finalAsk.body), "finalize body hash") !== bodyHash) {
      throw new Error("the finalize alice's node asked for differs from the start (nonce, author, side or body)");
    }
    // The finalize is alice's node's own, by the three records that cannot be the harness's: the chain's one DisputeFinalized names
    // alice's Entity and was sent from alice's wallet (nothing was skipped, so the restated asks made one transaction), and alice's
    // journal holds the sealed batch of the WAL row that asked for it with its landed answer.
    const finished = await chain.depository.queryFilter(chain.depository.filters.DisputeFinalized(), fromBlock);
    const skipped = await chain.depository.queryFilter(chain.depository.filters.DisputeOpSkipped(), fromBlock);
    if (finished.length !== 1 || finished[0] === undefined) throw new Error(`the chain finalized ${finished.length} disputes after the start, expected one`);
    if (skipped.length !== 0) throw new Error(`the chain skipped ${skipped.length} dispute ops after the start: a restated finalize reached it twice`);
    const [finish] = finished;
    const sender = (await finish.getTransaction()).from;
    if (finish.args.sender !== alice.id || sender.toLowerCase() !== alice.wallet.address.toLowerCase()) {
      throw new Error(`the finalize names ${finish.args.sender} and was sent from ${sender}, expected alice's Entity ${alice.id} from ${alice.wallet.address}`);
    }
    const walRows = net.rowsOf(a);
    const journal = journalOf(net.dirOf(a), "alice");
    const finalizing = journal.flatMap((record) => (record._tag === "sealed" && record.rows.some((id) => walRows.find((r) => r.height === id.height)?.chain[id.index]?._tag === "dispute_finalize") ? [record] : []));
    const [sealedFinal] = finalizing;
    const answer = journal.find((record) => record._tag === "answered" && record.digest === sealedFinal?.digest);
    if (finalizing.length !== 1 || sealedFinal === undefined || answer?._tag !== "answered" || answer.outcome !== "landed") {
      throw new Error(`alice's journal holds ${finalizing.length} sealed batches of a finalize and ${answer === undefined ? "no" : `a ${answer._tag === "answered" ? answer.outcome : "?"}`} answer, expected one sealed batch and its landed answer`);
    }
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
        `the head of the last committed frame (slot ${replica.used}, nonce ${nonce}, epoch ${onChain.epoch}, authored by the ${authorIsLeft ? "left" : "right"} side; body from pure/account/proof/body.ts, offdelta ${ledger.offdelta}, one token, no clause) is the dispute-proof digest the chain computes; alice's own node, holding hubX's signature over it from the frame round, asked for the start (nonce, epoch, author and body as the head names them) and the chain opened the dispute`,
        `after both ${floor} s windows (anvil clock jump) alice's own node was told by its J loop that the window was over (a final block's own second at or past the chain's end for the dispute) and asked the chain to finalize with the state it started from (${finals()} ask${finals() === 1 ? "" : "s"} restated, the nonce, author, side and body of the start), which became one transaction: alice's journal holds the one sealed batch of that finalize with its landed answer (nonce ${sealedFinal.nonce}), the chain's one DisputeFinalized names alice's Entity and was sent from alice's wallet, and nothing was skipped; the chain paid alice ${fmt(chain, aliceGot)} and hubX ${fmt(chain, hubGot)}, which is what the chain's ondelta ${held.ondelta} plus the Runtimes' offdelta ${ledger.offdelta} says`,
        `collateral 0, epoch ${onChain.epoch} to ${after.epoch}, dispute closed; money held by the four entities is unchanged at ${fmt(chain, now)}`,
      ],
      gaps: [],
    };
  },
};

const disputeClause: Step<World> = {
  id: "dispute-clause", title: "Forced dispute while an HTLC is open in the signed proof", needs: ["htlc"],
  run: async () => { throw new Blocked(["disputeWithClause"], `the proof body can carry a clause per open hold, but no Runtime duty starts the dispute or holds a lock that a signed proof carries (R-SIGNED-IS-LIVE): ${GAPS.disputeWithClause.supplier}`); },
};

// ---- S10 ---------------------------------------------------------------------------------------------------------
const rebase: Step<World> = {
  id: "rebase", title: "The Runtimes learn from the chain's logs that the dispute ran and ended, restart the Account from what the chain holds, and carry on", needs: ["dispute"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { alice, hubX } = partiesOf(w);
    const t = token(chain);
    const [a, x] = [eid(alice), eid(hubX)];
    const before = ledgerOf(net.account(a, x).state, t).offdelta;
    await chain.provider.send("evm_mine", []);
    // The frame alice held pending across the finalize is resolved by the nodes' own timers now that the link is whole: hubX committed it
    // before it heard of the epoch move and re-acks it, or refuses it as another epoch's and alice seals its payment anew.
    await net.settle();
    const onChain = await accountOnChain(chain, alice, hubX);
    const facts = [a, x].map((id) => {
      const f = net.entity(id).chain.get(id === a ? x : a);
      if (f === undefined) throw new Error(`${id} holds no chain facts for alice-hubX`);
      return f;
    });
    const wrong = facts.filter((f) => f.epoch !== onChain.epoch || f.stored !== onChain.nonce || f.disputed || f.frames > 1n);
    if (wrong.length > 0) throw new Error(`chain facts after the dispute: ${shown(facts)}; the chain: epoch ${onChain.epoch}, stored nonce ${onChain.nonce}`);
    // What each node's own J loop told its Entity, from the WAL rows the events are in.
    const told = (id: EntityId): readonly string[] => net.rowsOf(id).flatMap((r) => (r.input._tag === "entity" ? r.input.inputs.flatMap((i) => (i._tag.startsWith("j_") ? [i._tag] : [])) : []));
    const names = [alice, hubX].flatMap((p) => told(eid(p)).map((tag) => `${p.name} ${tag}`));
    ["j_epoch", "j_dispute_over"].forEach((tag) => {
      [alice.name, hubX.name].forEach((who) => { if (!names.includes(`${who} ${tag}`)) throw new Error(`${who} was told no ${tag} (${names.join(", ")})`); });
    });
    if (!names.some((n) => n.endsWith("j_dispute"))) throw new Error(`nobody was told of the dispute (${names.join(", ")})`);
    // R-LEDGER-REBASE: each Runtime's ledger is the chain's now: no collateral, no ondelta, offdelta counted from zero, and no open clause.
    const pay = PENDING_PAY * unit(chain);
    const ledgers = [a, x].map((id) => ({ id, replica: net.account(id, id === a ? x : a) }));
    const held = await collateralOf(chain, alice, hubX);
    ledgers.forEach(({ id, replica }) => {
      const l = ledgerOf(replica.state, t);
      if (l.collateral !== held.collateral || l.ondelta !== held.ondelta) throw new Error(`${id}'s ledger holds collateral ${l.collateral} and ondelta ${l.ondelta}, the chain ${held.collateral} and ${held.ondelta}`);
      if (l.holds.length !== 0 || replica.state.offers.length !== 0) throw new Error(`${id}'s Account has open clauses after the finalize: S10 starts with none (the open-clause dispute is S9)`);
      if (replica.pending !== undefined) throw new Error(`${id}'s Account still has a frame pending after the nodes went quiet`);

    });
    if (ledgers[0]!.replica.head !== ledgers[1]!.replica.head) throw new Error("the two Runtimes hold different heads on alice-hubX after the move");
    // The payment alice had pending was never committed by hubX, so it cannot be voided: it ends sealed anew and committed in epoch 1 on both
    // sides, or refused back to alice with a notice (then both ledgers are at zero). The two Runtimes agree which.
    const offdeltas = ledgers.map(({ replica }) => ledgerOf(replica.state, t).offdelta);
    const resealed = offdeltas.every((o) => o === (ledgers[0]!.replica.side === "left" ? -pay : pay));
    const refusedBack = offdeltas.every((o) => o === 0n) && net.noticesOf(a).some((n) => n.startsWith("tx_refused"));
    if (!resealed && !refusedBack) throw new Error(`after the move the two ledgers say offdelta ${shown(offdeltas)}: neither ${pay} (the pending payment committed in epoch 1) nor zero with a refusal told to alice (it was refused back)`);
    // The frames counted in the new epoch are the one that carried the payment sealed anew, or none.
    if (facts.some((f) => f.frames !== (resealed ? 1n : 0n))) throw new Error(`chain facts count frames ${shown(facts.map((f) => f.frames))} in epoch ${onChain.epoch}, expected ${resealed ? 1n : 0n} each`);
    // A dispute needs a signature of the new epoch: while alice had none (the dispute step asked then, with the link still down) the node refused
    // and asked the chain nothing. The signatures kept now are over heads of the new epoch only: none if nothing committed in it, else the
    // peer's signature over the head of the payment sealed anew.
    const probe = w.voidedAsk ?? (() => { throw new Error("the dispute step recorded no dispute ask"); })();
    const said = probe.notices.filter((n) => n.startsWith("command_refused"));
    if (said.length !== 1 || !said[0]!.includes("no_proof") || probe.asks !== 0) throw new Error(`alice's dispute ask after the move was ${said.length === 0 ? "not refused" : `refused as ${said[0]}`} and the node asked the chain ${probe.asks} times, expected no_proof and nothing asked`);
    [a, x].forEach((id) => {
      const kept = net.entity(id).proofs.get(id === a ? x : a);
      const head = net.account(id, id === a ? x : a).head;
      if (resealed ? kept?.head !== head : kept !== undefined) throw new Error(`${id} holds a proof ${kept === undefined ? "of no head" : `of head ${kept.head}`}, the Account's head is ${head}: ${resealed ? "the peer's signature over the new head is expected" : "none is expected"}`);
    });
    // And the Account carries on in epoch 1: a payment commits on both sides under one head, on the ledger the chain holds.
    const next = 10n * unit(chain);
    await net.tell(a, { _tag: "pay", peer: x, token: t, amount: next });
    await net.settle();
    const [alicePays, hubSees] = [net.account(a, x), net.account(x, a)];
    const offdelta = (r: typeof alicePays): bigint => ledgerOf(r.state, t).offdelta;
    const sign = alicePays.side === "left" ? -1n : 1n;
    const expected = (resealed ? pay : 0n) * sign + next * sign;
    if (alicePays.head !== hubSees.head || offdelta(alicePays) !== expected || offdelta(hubSees) !== expected) {
      throw new Error(`after a payment of ${next} in epoch ${onChain.epoch}: heads ${alicePays.head} and ${hubSees.head}, offdeltas ${offdelta(alicePays)} and ${offdelta(hubSees)}, expected ${expected}`);
    }
    const parties = partiesOf(w);
    const legs = [[alice, hubX], [parties.hubX, parties.hubY], [parties.hubY, parties.bob]] as const;
    // The chain's total cannot see what the Runtimes' ledgers lost (nothing was sent to the chain since the finalize), so each ledger of each
    // Account, on both sides, is read against what the chain holds for it, and the two sides' ledgers against each other.
    for (const [p, q] of legs) {
      const onChainNow = await collateralOf(chain, p, q);
      const [lp, lq] = [ledgerOf(net.account(eid(p), eid(q)).state, t), ledgerOf(net.account(eid(q), eid(p)).state, t)];
      if (lp.collateral !== onChainNow.collateral || lp.ondelta !== onChainNow.ondelta || lq.collateral !== onChainNow.collateral || lq.ondelta !== onChainNow.ondelta) {
        throw new Error(`${p.name}-${q.name}: the ledgers hold collateral ${lp.collateral} and ${lq.collateral}, ondelta ${lp.ondelta} and ${lq.ondelta}; the chain ${onChainNow.collateral} and ${onChainNow.ondelta}`);
      }
      if (lp.offdelta !== lq.offdelta || shown([lp.holds, lp.limit]) !== shown([lq.holds, lq.limit])) throw new Error(`${p.name}-${q.name}: the two Runtimes' ledgers differ (offdelta ${lp.offdelta} and ${lq.offdelta})`);
    }
    const now = await heldBy(chain, Object.values(parties), legs.map(([p, q]) => [p, q] as [Party, Party]));
    if (now !== w.held) throw new Error(`money is not conserved: ${w.held} before the dispute, ${now} after the move and one more payment`);
    return {
      checks: [
        `each node's own J loop (pure/host/shell/watch, the watcher core pure/j/watch.ts: blocks and logs by number, readings by block hash) read the Depository's logs at depth 1 up to height ${net.view()} and told its Entity ${names.length} J events, in the WAL before the height: ${names.join(", ")}`,
        `both Runtimes hold chain facts epoch ${onChain.epoch}, stored nonce ${onChain.nonce}, no dispute open, the frames of the new epoch counted, for alice-hubX: the same as the chain`,
        `R-LEDGER-REBASE: both ledgers read collateral ${held.collateral}, ondelta ${held.ondelta} (the chain's), offdelta restarted from zero (it was ${before} before the move), no open clause, no frame pending, one head, and the peer's signature kept is over a head of the new epoch only`,
        `the payment of ${PENDING_PAY} alice had pending when the chain finalized (hubX never committed it: the link lost it) ${resealed ? "was refused by hubX as another epoch's and sealed anew: it committed in epoch 1 on both sides" : "was refused back to alice with a notice (both ledgers at offdelta zero)"}`,
        "each of the three Accounts' ledgers, on both sides, holds the chain's collateral and ondelta, and the two sides agree on offdelta, holds and limits (the chain's total alone cannot see a ledger loss)",
        `alice's dispute ask after the move is refused (no_proof) and the node asks the chain nothing; a payment of 10 then commits in epoch ${onChain.epoch} on both sides under one head, offdelta ${expected} on each; money held by the four entities is unchanged at ${fmt(chain, now)}`,
      ],
      gaps: [],
    };
  },
};

// ---- S11 ---------------------------------------------------------------------------------------------------------
const nodes: Step<World> = {
  id: "nodes", title: "A node crashes with a frame committed and unacked, and comes back from its WAL; the others carry on", needs: ["htlc"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { alice, hubX, hubY, bob } = partiesOf(w);
    const t = token(chain);
    const [y, b] = [eid(hubY), eid(bob)];
    const everyone = [alice, hubX, hubY, bob];
    const fingerprint = (id: EntityId): string => JSON.stringify([...net.entity(id).accounts].map(([peer, r]) => [peer, r.head, r.height, r.used, [...r.state.ledgers].map(([k, l]) => [k.toString(), l])]), (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    const asked = (id: EntityId): string => JSON.stringify(net.askedBy(id), (_, v) => (typeof v === "bigint" ? `${v}n` : v));
    // The rebase step asked alice's node for a dispute from a voided proof on purpose: its refusal is the one notice there is.
    quiet(net, everyone, "nodes, before the crash", (n) => n.startsWith("command_refused") && n.includes('"_tag":"dispute"') && n.includes("no_proof"));
    const noticed = everyone.map((p) => net.noticesOf(eid(p)).length);
    // bob extends hubY 60 of credit and hubY commits the frame, but its ack never reaches bob: bob's frame stays pending, hubY's row is on its disk.
    await net.losing((m) => m.from === y && m.to === b, async () => {
      await net.tell(b, { _tag: "set_credit", peer: y, token: t, limit: 60n * unit(chain) });
      await net.settle({ pending: true });
    });
    const pending = net.account(b, y).pending;
    if (pending === undefined) throw new Error("bob's frame is not pending: hubY's ack was not lost");
    if (ledgerOf(net.account(y, b).state, t).limit[net.account(y, b).side] !== 60n * unit(chain)) throw new Error("hubY did not commit bob's frame before the crash");
    const [prints, actions, rows, headBefore] = [fingerprint(y), asked(y), net.rowsOf(y).length, net.account(y, b).head];
    // hubY dies: its Host and queue are gone, only the rows its disk holds are left.
    await net.restart(y);
    if (fingerprint(y) !== prints) throw new Error("hubY's Accounts after the replay differ from what they were before the crash");
    if (asked(y) !== actions) throw new Error("hubY was not asked again for every chain action of its committed rows");
    // bob's resend timer sends the same frame again: hubY already holds it and answers it, and both end at one head.
    await net.settle();
    const [rb, ry] = [net.account(b, y), net.account(y, b)];
    if (rb.pending !== undefined || rb.head !== ry.head || ledgerOf(rb.state, t).limit[rb.side === "left" ? "right" : "left"] !== 60n * unit(chain)) throw new Error("bob's frame did not settle on one head after hubY's restart");
    if (fingerprint(y) !== prints) throw new Error("hubY's Accounts changed when the copy of the frame arrived: a frame it already holds must change nothing");
    // The copy of bob's frame is a row of its own on hubY's disk, and the ack it answers with names the head hubY committed before the crash.
    // Bob's timer sends the frame again at every second tick until his pending clears, so more than one copy can be on its way before the first ack gets back: each copy is a row, and each is answered the same.
    const after = net.rowsOf(y).slice(rows);
    const answers = after.flatMap((r) => r.outputs.filter((o) => o.to === b && o.msg._tag === "ack"));
    const isCopy = (r: (typeof after)[number]): boolean => r.input._tag === "entity" && r.input.inputs.length === 1 && r.input.inputs.every((i) => i._tag === "peer_message" && i.from === b && i.msg._tag === "frame" && i.msg.frame.parent === pending.frame.parent && i.msg.frame.slot === pending.frame.slot);
    if (after.length === 0 || !after.every(isCopy)) throw new Error(`hubY's rows after the restart are not just bob's frame heard again: ${after.map((r) => (r.input._tag === "entity" ? `entity[${r.input.inputs.map((i) => i._tag).join(" ")}]` : r.input._tag)).join(", ") || "none"}`);
    if (answers.length !== after.length || answers.some((a) => a.msg._tag !== "ack" || a.msg.hash !== headBefore)) throw new Error("hubY did not answer each copy of bob's frame with the ack of the head it committed before the crash");
    if (pending.head !== headBefore || rb.head !== headBefore) throw new Error("bob's pending frame did not clear on the ack of the head it was waiting for");
    const noticesNow = everyone.flatMap((p, i) => net.noticesOf(eid(p)).slice(noticed[i]!).map((n) => `${p.name}: ${n}`));
    if (noticesNow.length > 0) throw new Error(`a copy of a frame a peer already holds is answered, not refused: ${noticesNow.join(", ")}`);
    if (net.inFlight() > 0) throw new Error("messages are still on the link");
    return {
      checks: [
        `hubY lost power (no stop, no clean close of its files) and restarted from its ${rows} durable rows alone with bob's frame committed and its ack lost: its Accounts (heads, slots, ledgers) are equal to what they were, and its ${net.askedBy(y).length} chain actions are asked again`,
        `bob's resend timer sent the same pending frame again (parent and slot equal); hubY heard it ${after.length} time${after.length === 1 ? "" : "s"} (each a row of its own on its disk, the timer repeating until bob's pending clears), each answered by an ack of head ${headBefore.slice(0, 12)}, the head bob was waiting for; no notice: one head on both sides (${rb.head.slice(0, 12)}), nothing pending, and the copy changed no Account`,
      ],
      gaps: [],
    };
  },
};

export const STEPS: readonly Step<World>[] = [fork, world, deposits, open, pay, htlc, reveal, swap, dispute, disputeClause, rebase, nodes];
