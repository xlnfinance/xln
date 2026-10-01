// The scenario, in the order money flows. Each step does as much as main allows on the real contracts and says, by
// name, what it needed that main does not have (lib/gaps.ts). A step that cannot run at all throws `Blocked`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { CONTRACT_NAMES, deployedManifest } from "../contracts/deploy/manifest.ts";
import { clockParams, jHeight, ownView } from "../pure/account/clause/clock.ts";
import { allocation } from "../pure/account/ledger.ts";
import { holdId, tokenId, type Side, type TokenId } from "../pure/account/model.ts";
import type { AccountTx } from "../pure/account/tx.ts";
import type { ProofBody } from "../pure/chain/proof/proof.ts";
import { proofBodyHash } from "../pure/chain/proof/proof.ts";
import { accountMessageHash } from "../pure/chain/proof/payload.ts";
import { keccakHex } from "../pure/kernel/encoding/bytes.ts";
import { startAnvil, assertLoopback, scrubbedEnv, type Anvil } from "./lib/anvil.ts";
import {
  accountKeyOf, accountOnChain, advanceTime, collateralOf, connect, hankoOf, heldBy, leftOf, must, partyOf, reserveOf, sendBatch,
  unit, type Chain, type Manifest, type Party,
} from "./lib/chain.ts";
import { GAPS, REPO } from "./lib/gaps.ts";
import { Blocked, type Step } from "./lib/runner.ts";
import { startRuntime, apply, commit as commitRow, flush } from "../pure/runtime/tick.ts";
import type { Input, Runtime, Timestamp } from "../pure/runtime/model.ts";
import { emptyEntity, entityId, type EntityId, type EntityInput, type Outbound } from "../pure/entity/model.ts";
import { commit, creditDeposit, ledgerIn, openPair, sideOfParty, type Pair, type View } from "./lib/pair.ts";

export type Options = Readonly<{ rpc: string | null; fork: string }>;

/** What the steps share: the node, the parties and the Accounts as they stand. */
export type World = {
  options: Options;
  anvil: Anvil | null;
  manifest: Manifest;
  chain: Chain | null;
  facts: { mode: string; chainId: string; block: string };
  parties: Record<"alice" | "hubX" | "hubY" | "bob", Party> | null;
  pairs: Record<"ax" | "xy" | "yb", Pair> | null;
  held: bigint | null;
  view: View | null;
};


const loadManifest = (): Manifest =>
  deployedManifest(JSON.parse(readFileSync(join(REPO, "contracts/deploy/sepolia.manifest.json"), "utf8")));

export const newWorld = (options: Options): World =>
  ({ options, anvil: null, manifest: loadManifest(), chain: null, facts: { mode: "", chainId: "", block: "" }, parties: null, pairs: null, held: null, view: null });

const chainOf = (w: World): Chain => w.chain ?? (() => { throw new Error("no chain: the fork step did not finish"); })();
const partiesOf = (w: World) => w.parties ?? (() => { throw new Error("no parties"); })();
const pairsOf = (w: World) => w.pairs ?? (() => { throw new Error("no accounts"); })();
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
const deposits: Step<World> = {
  id: "deposit", title: "Everyone moves tokens into the Depository as reserve", needs: ["world"],
  run: async (w) => {
    const chain = chainOf(w);
    const parties = Object.values(partiesOf(w));
    const checks = await parties.reduce<Promise<string[]>>(async (done, p) => {
      const lines = await done;
      await (await chain.token.connect(p.wallet).approve(chain.manifest.contracts.depository.address, DEPOSIT * unit(chain))).wait();
      const before = await reserveOf(chain, p);
      const sent = await sendBatch(chain, p, {
        externalTokenToReserve: [{
          entity: p.id, contractAddress: chain.manifest.token.address!, externalTokenId: 0n, tokenType: 0n,
          internalTokenId: chain.tokenId, amount: DEPOSIT * unit(chain),
        }],
      }, `deposit ${p.name}`);
      const gained = (await reserveOf(chain, p)) - before;
      if (gained !== DEPOSIT * unit(chain)) throw new Error(`${p.name}: reserve rose by ${gained}, not ${DEPOSIT * unit(chain)}`);
      return [...lines, `${p.name}: externalTokenToReserve ${fmt(chain, gained)}, batch nonce ${sent.nonce}, gas ${sent.gasUsed}`];
    }, Promise.resolve([]));
    return { checks, gaps: ["jBatchBuilder"] };
  },
};

// ---- S3 ----------------------------------------------------------------------------------------------------------
const open: Step<World> = {
  id: "open", title: "Open three Accounts along the route: alice-hubX, hubX-hubY, hubY-bob", needs: ["deposit"],
  run: async (w) => {
    const chain = chainOf(w);
    const { alice, hubX, hubY, bob } = partiesOf(w);
    const legs = [["ax", alice, hubX], ["xy", hubX, hubY], ["yb", hubY, bob]] as const;
    // Fundings in order. bob also funds 20 against hubY, so that one Account has a deposit from each side
    // (the four ids sort alice < hubX < hubY < bob, so every first funder is Left and bob is Right).
    const fundings = [
      ...legs.map(([key, funder, peer]) => ({ key, funder, peer, amount: COLLATERAL * unit(chain) })),
      { key: "yb" as const, funder: bob, peer: hubY, amount: 20n * unit(chain) },
    ];
    const t = token(chain);
    const opened = await fundings.reduce<Promise<{ pairs: Record<string, Pair>; checks: string[] }>>(async (done, { key, funder, peer, amount }) => {
      const acc = await done;
      await sendBatch(chain, funder, {
        reserveToCollateral: [{ tokenId: chain.tokenId, receivingEntity: funder.id, pairs: [{ entity: peer.id, amount }] }],
      }, `fund ${funder.name}-${peer.name}`);
      const left = leftOf(funder, peer);
      const right = left === funder ? peer : funder;
      const side: Side = funder.id === left.id ? "left" : "right";
      const pair = creditDeposit(acc.pairs[key] ?? openPair(left, right), t, side, amount);
      const onChain = await collateralOf(chain, funder, peer);
      const ledger = ledgerIn(pair, t);
      if (onChain.collateral !== ledger.collateral || onChain.ondelta !== ledger.ondelta) {
        throw new Error(`${key}: the ledger says collateral ${ledger.collateral} ondelta ${ledger.ondelta}, the Depository says ${onChain.collateral} and ${onChain.ondelta}`);
      }
      const line = `${funder.name} funds ${fmt(chain, amount)} against ${peer.name} (funder is ${side === "left" ? "Left" : "Right"}); the Account's ledger and the Depository agree: collateral ${onChain.collateral}, ondelta ${onChain.ondelta}`;
      return { pairs: { ...acc.pairs, [key]: pair }, checks: [...acc.checks, line] };
    }, Promise.resolve({ pairs: {}, checks: [] }));
    w.pairs = opened.pairs as World["pairs"];
    const parties = Object.values(partiesOf(w));
    w.held = await heldBy(chain, parties, legs.map(([, a, b]) => [a, b] as const));
    if (w.held !== BigInt(parties.length) * DEPOSIT * unit(chain)) throw new Error(`reserves plus collateral are ${w.held}, the deposits were ${BigInt(parties.length) * DEPOSIT * unit(chain)}`);
    return { checks: [...opened.checks, `money held for the four entities (reserves plus collateral) is ${fmt(chain, w.held)}, equal to what they deposited`], gaps: ["entityChainFacts", "jBatchBuilder", "jEvents"] };
  },
};

// ---- S4 ----------------------------------------------------------------------------------------------------------
const view = async (chain: Chain): Promise<View> => {
  const height = must(jHeight(BigInt(await chain.provider.getBlockNumber())), "height");
  return { clock: must(clockParams(2n, 4n, 100n), "clock params"), view: ownView(height, height) };
};

const pay: Step<World> = {
  id: "pay", title: "alice pays hubX 30; bob extends hubY credit (Account frames, driven directly)", needs: ["open"],
  run: async (w) => {
    const chain = chainOf(w);
    const { alice, bob, hubY } = partiesOf(w);
    const t = token(chain);
    const pairs = pairsOf(w);
    w.view = await view(chain);
    const before = ledgerIn(pairs.ax, t);
    const paid = commit(pairs.ax, w.view, sideOfParty(pairs.ax, alice), { _tag: "pay", token: t, amount: 30n * unit(chain) }, "alice pays hubX");
    const credited = commit(pairs.yb, w.view, sideOfParty(pairs.yb, bob), { _tag: "set_credit", token: t, limit: 50n * unit(chain) }, "bob extends credit to hubY");
    w.pairs = { ...pairs, ax: paid, yb: credited };
    const after = ledgerIn(paid, t);
    const moved = allocation(after) - allocation(before);
    const expected = sideOfParty(paid, alice) === "left" ? -30n * unit(chain) : 30n * unit(chain);
    if (moved !== expected) throw new Error(`alice-hubX allocation moved ${moved}, expected ${expected}`);
    const limit = ledgerIn(credited, t).limit[sideOfParty(credited, hubY)];
    if (limit !== 50n * unit(chain)) throw new Error(`hubY's credit from bob is ${limit}, expected 50`);
    return {
      checks: [
        `alice-hubX: one frame (pay 30), both replicas committed head ${paid.replicas.left.head.slice(0, 12)}, allocation moved ${moved} for the Left side, so Left ${expected < 0n ? "paid" : "was paid"}`,
        `hubY-bob: one frame (set_credit 50 by bob), hubY may owe bob ${limit}`,
      ],
      gaps: ["signedFrames"],
    };
  },
};


// ---- S5 ----------------------------------------------------------------------------------------------------------
type Cluster = { readonly hosts: ReadonlyMap<EntityId, Runtime>; readonly inflight: readonly Outbound[]; readonly clock: bigint };

const hostOf = (c: Cluster, id: EntityId): Runtime => c.hosts.get(id) ?? (() => { throw new Error(`no host ${id}`); })();

/** One Host tick: apply, commit, flush. A Halt is a Host bug and stops the run. */
const tick = (rt: Runtime, input: Input): { readonly runtime: Runtime; readonly leaving: readonly Outbound[] } => {
  const staged = apply(rt, input);
  if (!staged.ok) throw new Error(`runtime halted: ${staged.error._tag}`);
  const committed = commitRow(staged.value);
  if (!committed.ok) throw new Error(`runtime halted: ${committed.error._tag}`);
  return flush(committed.value);
};

/** One input into one Runtime; what leaves it joins the in-memory link (gap `host-transport`). */
const feed = (c: Cluster, to: EntityId, ...inputs: readonly EntityInput[]): Cluster => {
  const ticked = tick(hostOf(c, to), { at: c.clock as Timestamp, to, inputs });
  return { hosts: new Map([...c.hosts, [to, ticked.runtime]]), inflight: [...c.inflight, ...ticked.leaving], clock: c.clock + 1n };
};

/** The link delivers the oldest message, then whatever the receiver sent back, until nothing is in flight. */
const settle = (c: Cluster): Cluster => {
  const [next, ...rest] = c.inflight;
  return next === undefined ? c : settle(feed({ ...c, inflight: rest }, next.to, { _tag: "peer_message", from: next.from, msg: next.msg }));
};

const payRuntime: Step<World> = {
  id: "pay-runtime", title: "The same payment through two Runtimes: open, credit, pay over a link", needs: ["pay"],
  run: async (w) => {
    const chain = chainOf(w);
    const { alice, hubX } = partiesOf(w);
    const t = token(chain);
    const v = w.view ?? (w.view = await view(chain));
    const [a, x] = [must(entityId(alice.id), "alice id"), must(entityId(hubX.id), "hubX id")];
    const setup = { clock: v.clock, view: v.view };
    const start: Cluster = { hosts: new Map([[a, startRuntime(setup, [emptyEntity(a)])], [x, startRuntime(setup, [emptyEntity(x)])]]), inflight: [], clock: 1n };
    const unit6 = unit(chain);
    const opened = settle(feed(feed(start, a, { _tag: "open_account", peer: x }), x, { _tag: "open_account", peer: a }));
    const credited = settle(feed(opened, x, { _tag: "set_credit", peer: a, token: t, limit: 100n * unit6 }));
    const settled = settle(feed(credited, a, { _tag: "pay", peer: x, token: t, amount: 30n * unit6 }));
    const ra = hostOf(settled, a).entities.get(a)?.accounts.get(x);
    const rx = hostOf(settled, x).entities.get(x)?.accounts.get(a);
    if (ra === undefined || rx === undefined) throw new Error("an Account is missing after the open");
    if (ra.head !== rx.head || ra.pending !== undefined || rx.pending !== undefined) throw new Error("the two Runtimes do not hold the same committed head");
    const mine = ledgerIn(pairsOf(w).ax, t).offdelta;
    const theirs = ra.state.ledgers.get(t)?.offdelta;
    const notices = [...hostOf(settled, a).wal, ...hostOf(settled, x).wal].flatMap((row) => row.notices);
    if (theirs === undefined || notices.length > 0) throw new Error(`ledger ${String(theirs)}, notices ${JSON.stringify(notices.map((n) => n._tag))}`);
    // alice-hubX had one pay of 30 plus an HTLC of 10 by now; the Runtime made only the 30.
    const sideLeft = ra.side === "left";
    if (theirs !== (sideLeft ? -30n : 30n) * unit6) throw new Error(`the Runtime's ledger moved ${theirs}, expected 30 for ${ra.side}`);
    return {
      checks: [
        `alice and hubX each run a Runtime on an Entity (pure/runtime tick: apply, commit, flush); WAL heights ${hostOf(settled, a).wal.length} and ${hostOf(settled, x).wal.length}, no notice`,
        `open_account on both, hubX set_credit 100, alice pay 30: both replicas committed head ${ra.head.slice(0, 12)}, offdelta ${theirs} (the Account-pair path of S4 had ${mine} after the 30 and the HTLC's 10)`,
        "the Runtime knows nothing of the 100 USDT collateral the chain holds, so the payment runs on credit: it has no deposit command or JEvent",
      ],
      gaps: ["entityChainFacts", "hostTransport", "signedFrames"],
    };
  },
};

// ---- S6 ----------------------------------------------------------------------------------------------------------
const htlc: Step<World> = {
  id: "htlc", title: "HTLC of 10 from alice across hubX and hubY to bob, resolved back", needs: ["pay"],
  run: async (w) => {
    const chain = chainOf(w);
    const { alice, hubX, hubY, bob } = partiesOf(w);
    const t = token(chain);
    const v = w.view ?? (w.view = await view(chain));
    const route = [alice, hubX, hubY, bob];
    const keys = ["ax", "xy", "yb"] as const;
    const secret = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes("xln-testnet-e2e-skeleton/secret")));
    const hashlock = keccakHex(secret);
    const amount = 10n * unit(chain);
    const offBefore = keys.map((k) => ledgerIn(pairsOf(w)[k], t).offdelta);
    const deadlines = [v.view + 30n, v.view + 20n, v.view + 10n];
    // Forward: each payer locks on its hop with a shorter deadline than the hop before (a hand-written forwarder).
    const locked = keys.reduce((pairs, key, i) => {
      const payer = route[i]!;
      const hold = { id: holdId(1n), payer: sideOfParty(pairs[key], payer), amount, hashlock, deadline: must(jHeight(deadlines[i]!), "deadline") };
      return { ...pairs, [key]: commit(pairs[key], v, hold.payer, { _tag: "lock", token: t, hold } as AccountTx, `${payer.name} locks on ${key}`) };
    }, pairsOf(w));
    const open = keys.map((k) => ledgerIn(locked[k], t).holds.length);
    if (open.some((n) => n !== 1)) throw new Error(`expected one open clause on each hop, found ${open.join(",")}`);
    // Backward: the payee of each hop shows the secret, starting with bob.
    const resolved = [...keys].reverse().reduce((pairs, key, back) => {
      const payee = route[3 - back]!;
      return { ...pairs, [key]: commit(pairs[key], v, sideOfParty(pairs[key], payee), { _tag: "resolve", token: t, id: holdId(1n), secret }, `${payee.name} resolves on ${key}`) };
    }, locked);
    w.pairs = resolved;
    const checks = keys.map((k, i) => {
      const l = ledgerIn(resolved[k], t);
      const payerLeft = sideOfParty(resolved[k], route[i]!) === "left";
      const expected = offBefore[i]! + (payerLeft ? -amount : amount);
      if (l.holds.length !== 0 || l.offdelta !== expected) throw new Error(`${k}: holds ${l.holds.length}, offdelta ${l.offdelta}, expected ${expected}`);
      return `${route[i]!.name} to ${route[i + 1]!.name}: clause deadline view+${deadlines[i]! - v.view}, resolved, payer's allocation fell by ${fmt(chain, amount)}`;
    });
    return { checks: [`hashlock ${hashlock.slice(0, 12)} on three hops, J view ${v.view}, deadlines step down toward bob`, ...checks, "hubs end flat: each received 10 on one Account and paid 10 on the next (no fee modelled)"], gaps: ["entityHtlcCommands", "htlcRoute", "signedFrames"] };
  },
};

// ---- blocked steps -----------------------------------------------------------------------------------------------
const reveal: Step<World> = {
  id: "reveal", title: "Payee reveals the secret on chain when its resolve is not acked in time", needs: ["htlc"],
  run: async () => { throw new Blocked(["onChainReveal"], `no code decides when to reveal (view + LAG >= deadline) or builds the revealSecrets op: ${GAPS.onChainReveal.supplier}`); },
};

const swap: Step<World> = {
  id: "swap", title: "Two-party swap inside an Account: offer, partial fill, cancel", needs: ["open"],
  run: async () => { throw new Blocked(["swapTx", "hubMatching"], `AccountTx has no swap offer, fill or cancel (pure/account/tx.ts lists pay, set_credit, lock, resolve, cancel, expire), so there is nothing to commit in a frame and nothing for a proof body to carry; ${GAPS.swapTx.supplier}`); },
};

// ---- S8 ----------------------------------------------------------------------------------------------------------
const dispute: Step<World> = {
  id: "dispute", title: "Forced dispute on alice-hubX from alice's signed proof; the chain pays what the ledger says", needs: ["htlc"],
  run: async (w) => {
    const chain = chainOf(w);
    const { alice, hubX } = partiesOf(w);
    const t = token(chain);
    const pair = pairsOf(w).ax;
    const ledger = ledgerIn(pair, t);
    if (ledger.holds.length !== 0) throw new Error("the Account still has an open clause; the harness builds proof bodies for ledgers without one");
    const floor = BigInt(chain.manifest.dispute.responseFloorSeconds);
    const body: ProofBody = { watchSeed: ethers.ZeroHash, leftResponseSeconds: floor, rightResponseSeconds: floor, offdeltas: [ledger.offdelta], tokenIds: [chain.tokenId], transformers: [] };
    const bodyHash = must(proofBodyHash(body), "proof body hash");
    const onChain = await accountOnChain(chain, alice, hubX);
    const nonce = onChain.nonce + 1n;
    const proposerIsLeft = sideOfParty(pair, alice) === "left";
    const digest = must(accountMessageHash(chain.dep, { accountKey: accountKeyOf(alice, hubX), ondeltaEpoch: onChain.epoch, nonce }, {
      _tag: "dispute_proof", proposerIsLeft, proofBodyHash: bodyHash, watchSeed: body.watchSeed,
    }), "dispute proof digest");
    const sig = hankoOf(alice, digest);
    const aliceBefore = await reserveOf(chain, alice);
    const hubBefore = await reserveOf(chain, hubX);
    const start = await sendBatch(chain, hubX, {
      disputeStarts: [{
        counterentity: alice.id, nonce, ondeltaEpoch: onChain.epoch, proposerIsLeft, proofbodyHash: bodyHash, initialProofbody: body,
        watchSeed: body.watchSeed, sig, starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: ethers.ZeroHash,
      }],
    }, "hubX starts a dispute with alice's proof");
    if (!(await accountOnChain(chain, alice, hubX)).disputeOpen) throw new Error("no dispute is open after the start");
    await advanceTime(chain, Number(2n * floor + 10n));
    const end = await sendBatch(chain, hubX, {
      disputeFinalizations: [{
        counterentity: alice.id, initialNonce: nonce, finalNonce: nonce, proposerIsLeft, initialProofbodyHash: bodyHash, finalProofbody: body,
        starterArguments: "0x", otherArguments: "0x", sig: "0x", startedByLeft: sideOfParty(pair, hubX) === "left", cooperative: false,
      }],
    }, "hubX finalizes after both windows");
    // What both sides believed: delta = ondelta + offdelta; Left takes delta clamped to the collateral, Right the rest.
    const delta = allocation(ledger);
    const leftShare = delta < 0n ? 0n : delta > ledger.collateral ? ledger.collateral : delta;
    const share = (side: Side): bigint => (side === "left" ? leftShare : ledger.collateral - leftShare);
    const aliceGot = (await reserveOf(chain, alice)) - aliceBefore;
    const hubGot = (await reserveOf(chain, hubX)) - hubBefore;
    const sideA = sideOfParty(pair, alice);
    if (aliceGot !== share(sideA) || hubGot !== share(sideA === "left" ? "right" : "left")) {
      throw new Error(`payout: alice got ${aliceGot} and hubX ${hubGot}; the ledger (delta ${delta}, collateral ${ledger.collateral}) says ${share(sideA)} and ${share(sideA === "left" ? "right" : "left")}`);
    }
    const after = await accountOnChain(chain, alice, hubX);
    const rest = await collateralOf(chain, alice, hubX);
    if (rest.collateral !== 0n || after.epoch !== onChain.epoch + 1n || after.disputeOpen) throw new Error(`after the finalize: collateral ${rest.collateral}, epoch ${after.epoch}, dispute open ${after.disputeOpen}`);
    const parties = Object.values(partiesOf(w));
    const now = await heldBy(chain, parties, [[alice, hubX], [hubX, partiesOf(w).hubY], [partiesOf(w).hubY, partiesOf(w).bob]]);
    if (now !== w.held) throw new Error(`money is not conserved: ${w.held} before the dispute, ${now} after`);
    return {
      checks: [
        `alice signed the dispute proof at nonce ${nonce}, epoch ${onChain.epoch} (body: offdelta ${ledger.offdelta}, one token, no clause) with pure/chain payloads and a lazy Hanko; hubX started with it (gas ${start.gasUsed})`,
        `after both ${floor} s windows (anvil clock jump) hubX finalized (gas ${end.gasUsed}); the chain paid alice ${fmt(chain, aliceGot)} and hubX ${fmt(chain, hubGot)}, which is what the ledger's delta ${delta} says`,
        `collateral 0, epoch ${onChain.epoch} to ${after.epoch}, dispute closed; money held by the four entities is unchanged at ${fmt(chain, now)}`,
      ],
      gaps: ["jBatchBuilder", "jEvents", "signedFrames", "proofBody"],
    };
  },
};

const disputeClause: Step<World> = {
  id: "dispute-clause", title: "Forced dispute while an HTLC is open in the signed proof", needs: ["htlc"],
  run: async () => { throw new Blocked(["disputeWithClause", "proofBody"], `the ledger cannot become a proof body with a transformer clause per open hold, and no Runtime duty holds a lock that a signed proof carries (R-SIGNED-IS-LIVE): ${GAPS.disputeWithClause.supplier}`); },
};

const rebase: Step<World> = {
  id: "rebase", title: "Account ledgers follow the chain after the dispute pays out", needs: ["dispute"],
  run: async () => { throw new Blocked(["disputeRebase", "entityChainFacts"], `nothing turns the chain's DisputeFinalized into the Account's new epoch, ledger and frame counter: ${GAPS.disputeRebase.supplier}`); },
};

const nodes: Step<World> = {
  id: "nodes", title: "Four nodes run the Runtime over a transport, survive a restart, and replay their WAL", needs: [],
  run: async () => { throw new Blocked(["hostTransport", "jEvents"], `no Host: ${GAPS.hostTransport.piece} ${GAPS.jEvents.supplier}`); },
};

export const STEPS: readonly Step<World>[] = [fork, world, deposits, open, pay, payRuntime, htlc, reveal, swap, dispute, disputeClause, rebase, nodes];
