// The scenario, in the order money flows. Each step does as much as main allows on the real contracts and says, by
// name, what it needed that main does not have (lib/gaps.ts). A step that cannot run at all throws `Blocked`.
import { readFileSync } from "node:fs";
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
  accountKeyOf, accountOnChain, advanceTime, asHex, collateralOf, connect, hankoOf, heldBy, leftOf, must, partyOf, reserveOf, sendOps,
  unit, type Chain, type Manifest, type Party,
} from "./lib/chain.ts";
import { GAPS, REPO } from "./lib/gaps.ts";
import { Blocked, type Step } from "./lib/runner.ts";
import { entityId, type EntityId, type JAction } from "../pure/entity/model.ts";
import type { ClockParams, JView } from "../pure/account/clause/clock.ts";
import { JLoop } from "./lib/jloop.ts";
import { Net } from "./lib/net.ts";

export type Options = Readonly<{ rpc: string | null; fork: string }>;

/** What the steps share: the node, the parties and the Accounts as they stand. */
export type World = {
  options: Options;
  anvil: Anvil | null;
  manifest: Manifest;
  chain: Chain | null;
  facts: { mode: string; chainId: string; block: string };
  parties: Record<"alice" | "hubX" | "hubY" | "bob", Party> | null;
  /** The four Runtimes on their Hosts, the J loop that feeds them, and where their frames are signed. */
  net: Net | null;
  loop: JLoop | null;
  signing: SigningContext | null;
  held: bigint | null;
};

/** The clock rule's parameters and the J view the Runtimes start at. */
type View = Readonly<{ clock: ClockParams; view: JView }>;


const loadManifest = (): Manifest =>
  deployedManifest(JSON.parse(readFileSync(join(REPO, "contracts/deploy/sepolia.manifest.json"), "utf8")));

export const newWorld = (options: Options): World =>
  ({ options, anvil: null, manifest: loadManifest(), chain: null, facts: { mode: "", chainId: "", block: "" }, parties: null, net: null, loop: null, signing: null, held: null });

const chainOf = (w: World): Chain => w.chain ?? (() => { throw new Error("no chain: the fork step did not finish"); })();
const partiesOf = (w: World) => w.parties ?? (() => { throw new Error("no parties"); })();
const netOf = (w: World): Net => w.net ?? (() => { throw new Error("no Runtimes: the open step did not finish"); })();
const eid = (p: Party): EntityId => must(entityId(p.id), `entity id of ${p.name}`);
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
      const sent = await sendOps(chain, p, [{
        _tag: "deposit",
        leg: {
          entity: p.id, contractAddress: chain.manifest.token.address!, externalTokenId: 0n, tokenType: 0n,
          internalTokenId: chain.tokenId, amount: DEPOSIT * unit(chain),
        },
      }], `deposit ${p.name}`);
      const gained = (await reserveOf(chain, p)) - before;
      if (gained !== DEPOSIT * unit(chain)) throw new Error(`${p.name}: reserve rose by ${gained}, not ${DEPOSIT * unit(chain)}`);
      return [...lines, `${p.name}: externalTokenToReserve ${fmt(chain, gained)}, batch nonce ${sent.nonce}, gas ${sent.gasUsed}`];
    }, Promise.resolve([]));
    return { checks, gaps: [] };
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

/** The JActions a node asked for since `from`: what its Runtime put into the WAL for the chain. */
const askedSince = (net: Net, p: Party, from: number): readonly JAction[] => net.askedBy(eid(p)).slice(from);

const quiet = (net: Net, parties: readonly Party[], what: string): void => {
  const noticed = parties.flatMap((p) => net.noticesOf(eid(p)).map((n) => `${p.name}: ${n}`));
  if (noticed.length > 0) throw new Error(`${what}: the Runtimes noticed ${noticed.join(", ")}`);
  if (net.inFlight() > 0) throw new Error(`${what}: ${net.inFlight()} messages are still on the link`);
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
    // Every Account starts at the chain's baseline, so ONE SigningContext fits all of them (gap `per-account-signing`).
    const signing = await signingFor(chain, alice, hubX);
    const starts = await Promise.all(legs.map(([a, b]) => accountOnChain(chain, a, b)));
    if (starts.some((s) => s.epoch !== signing.ondeltaEpoch || s.nonce + 2n !== signing.firstNonce)) throw new Error("the three Accounts do not start at the same chain epoch and nonce");
    w.signing = signing;
    const net = w.net = new Net({ clock: v.clock, view: v.view, signing }, all.map(eid));
    w.loop = await JLoop.at(chain, all);
    legs.forEach(([a, b]) => { net.tell(eid(a), { _tag: "open_account", peer: eid(b) }); net.tell(eid(b), { _tag: "open_account", peer: eid(a) }); });
    net.settle();
    // The first frame of each Account: credit from the receiving side (a deposit waits for the first co-signed frame, R-NO-DEPOSIT-BEFORE-COSIGN).
    const credits = [[hubX, alice, 100n], [hubY, hubX, 100n], [bob, hubY, 50n]] as const;
    credits.forEach(([from, to, limit]) => { net.tell(eid(from), { _tag: "set_credit", peer: eid(to), token: t, limit: limit * unit(chain) }); net.settle(); });
    // Fundings in order, each as the funder's Runtime asks for it: the deposit command becomes a JAction, the harness turns it into the op (gap `j-action-ops`).
    // bob also funds 20 against hubY, so that one Account has a deposit from each side (the four ids sort alice < hubX < hubY < bob).
    const fundings = [...legs.map(([funder, peer]) => ({ funder, peer, amount: COLLATERAL * unit(chain) })), { funder: bob, peer: hubY, amount: 20n * unit(chain) }];
    const checks: string[] = [];
    // The Account rule's own account of the chain: what pure/account/ledger `deposit` makes of each funding, to be equal to what the chain holds.
    const expected = new Map<string, ReturnType<typeof ledgerOf>>();
    for (const { funder, peer, amount } of fundings) {
      const key = accountKeyOf(funder, peer);
      const before = askedSince(net, funder, 0).length;
      net.tell(eid(funder), { _tag: "deposit", peer: eid(peer), token: t, amount });
      const asked = askedSince(net, funder, before);
      const action = asked[0];
      if (asked.length !== 1 || action?._tag !== "deposit" || action.peer !== eid(peer) || action.token !== t || action.amount !== amount) {
        throw new Error(`${funder.name}'s deposit command did not ask the chain for exactly one deposit of ${amount} against ${peer.name}: ${JSON.stringify(asked, (_, x) => (typeof x === "bigint" ? x.toString() : x))}`);
      }
      await sendOps(chain, funder, [{
        _tag: "reserve_to_collateral",
        funding: { tokenId: chain.tokenId, receivingEntity: funder.id, pairs: [{ entity: peer.id, amount: action.amount }] },
      }], `fund ${funder.name}-${peer.name}`);
      const side = net.account(eid(funder), eid(peer)).side;
      const base = expected.get(key) ?? ledgerOf(net.account(eid(funder), eid(peer)).state, t);
      const ledger = must(deposit(base, side, amount), "deposit rule");
      expected.set(key, ledger);
      const onChain = await collateralOf(chain, funder, peer);
      if (onChain.collateral !== ledger.collateral || onChain.ondelta !== ledger.ondelta) {
        throw new Error(`${funder.name}-${peer.name}: the ledger rule says collateral ${ledger.collateral} ondelta ${ledger.ondelta}, the Depository says ${onChain.collateral} and ${onChain.ondelta}`);
      }
      checks.push(`${funder.name} deposit command (${side === "left" ? "Left" : "Right"}) asks for ${fmt(chain, amount)} against ${peer.name}; the Depository holds collateral ${onChain.collateral}, ondelta ${onChain.ondelta}, as the ledger rule says`);
    }
    w.held = await heldBy(chain, all, legs.map(([a, b]) => [a, b] as const));
    if (w.held !== BigInt(all.length) * DEPOSIT * unit(chain)) throw new Error(`reserves plus collateral are ${w.held}, the deposits were ${BigInt(all.length) * DEPOSIT * unit(chain)}`);
    quiet(net, all, "open");
    return {
      checks: [
        `four Runtimes (Host core, in-memory shell): open_account on both sides of three Accounts, one set_credit frame each, no notice, ${all.map((p) => `${p.name} WAL ${net.rowsOf(eid(p)).length} rows`).join(", ")}`,
        ...checks,
        `money held for the four entities (reserves plus collateral) is ${fmt(chain, w.held)}, equal to what they deposited`,
        "the Runtimes' ledgers hold collateral 0: nothing tells an Account about the chain's collateral, so the payments below run on credit",
      ],
      gaps: ["jDepositFacts", "jActionOps", "jLoop", "hostShell", "perAccountSigning"],
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
    net.tell(a, { _tag: "pay", peer: x, token: t, amount: 30n * unit(chain) });
    net.settle();
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
      gaps: ["jDepositFacts", "hostShell", "perAccountSigning"],
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
    const deadlines = [at + 30n, at + 20n, at + 10n];
    const offBefore = hops.map(([a, b]) => ledgerOf(net.account(eid(a), eid(b)).state, t).offdelta);
    // Forward: each payer locks on its hop with a shorter deadline than the hop before (a hand-written forwarder, gap `htlc-route`).
    hops.forEach(([payer, payee], i) => {
      const hold = { id: holdId(1n), payer: net.account(eid(payer), eid(payee)).side, amount, hashlock, deadline: must(jHeight(deadlines[i]!), "deadline") };
      net.tell(eid(payer), { _tag: "lock", peer: eid(payee), token: t, hold });
      net.settle();
    });
    const open = hops.map(([a, b]) => ledgerOf(net.account(eid(a), eid(b)).state, t).holds.length);
    if (open.some((n) => n !== 1)) throw new Error(`expected one open clause on each hop, found ${open.join(",")}`);
    // Backward: the payee of each hop shows the secret, starting with bob.
    [...hops].reverse().forEach(([payer, payee]) => {
      net.tell(eid(payee), { _tag: "resolve", peer: eid(payer), token: t, id: holdId(1n), secret });
      net.settle();
    });
    const checks = hops.map(([payer, payee], i) => {
      const [rp, rq] = [net.account(eid(payer), eid(payee)), net.account(eid(payee), eid(payer))];
      const l = ledgerOf(rp.state, t);
      const expected = offBefore[i]! + (rp.side === "left" ? -amount : amount);
      if (rp.head !== rq.head || l.holds.length !== 0 || l.offdelta !== expected) throw new Error(`${payer.name}-${payee.name}: holds ${l.holds.length}, offdelta ${l.offdelta}, expected ${expected}`);
      return `${payer.name} to ${payee.name}: lock deadline view+${deadlines[i]! - at}, resolved by ${payee.name}, both Runtimes at head ${rp.head.slice(0, 12)}, payer's allocation fell by ${fmt(chain, amount)}`;
    });
    quiet(net, [alice, hubX, hubY, bob], "htlc");
    return { checks: [`hashlock ${hashlock.slice(0, 12)} on three hops through the Entities' lock and resolve commands, J view ${at}, deadlines step down toward bob`, ...checks, "hubs end flat: each received 10 on one Account and paid 10 on the next (no fee modelled)"], gaps: ["htlcRoute", "jDepositFacts", "hostShell", "perAccountSigning"] };
  },
};

// ---- S6 ----------------------------------------------------------------------------------------------------------
const reveal: Step<World> = {
  id: "reveal", title: "Payee reveals the secret on chain when its resolve is not acked in time", needs: ["htlc"],
  run: async (w) => {
    const chain = chainOf(w);
    const net = netOf(w);
    const { hubY, bob } = partiesOf(w);
    const t = token(chain);
    const [y, b] = [eid(hubY), eid(bob)];
    const secret = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes("xln-testnet-e2e-skeleton/secret-2")));
    const amount = 5n * unit(chain);
    const deadline = net.view() + 30n;
    const lag = w.net!.setup.clock.lag;
    // hubY locks 5 for bob on hubY-bob; bob resolves, and the frame never reaches hubY.
    net.tell(y, { _tag: "lock", peer: b, token: t, hold: { id: holdId(2n), payer: net.account(y, b).side, amount, hashlock: keccakHex(secret), deadline: must(jHeight(deadline), "deadline") } });
    net.settle();
    const sinceLock = net.askedBy(b).length;
    net.tell(b, { _tag: "resolve", peer: y, token: t, id: holdId(2n), secret });
    net.settle(() => true);
    if (net.account(b, y).pending === undefined) throw new Error("bob's resolve frame is not pending: it was acked");
    net.rise(must(jHeight(deadline - lag - 1n), "height"));
    const early = askedSince(net, bob, sinceLock);
    if (early.length !== 0) throw new Error(`bob asked the chain at view ${net.view()} (deadline ${deadline}, LAG ${lag}): ${JSON.stringify(early.map((x) => x._tag))}`);
    net.rise(must(jHeight(deadline - lag), "height"));
    const asked = askedSince(net, bob, sinceLock);
    const action = asked[0];
    if (asked.length !== 1 || action?._tag !== "reveal") throw new Error(`at view ${net.view()} bob should ask for exactly one reveal: ${JSON.stringify(asked.map((x) => x._tag))}`);
    // The action becomes a revealSecrets op (gap `j-action-ops`) and the Depository's canonical transformer records the secret.
    const hash = ethers.keccak256(ethers.hexlify(action.secret));
    const transformer = new ethers.Contract(chain.manifest.contracts.deltaTransformer.address, ["function hashToTimestamp(bytes32) view returns (uint256)"], chain.provider);
    if ((await transformer.hashToTimestamp!(hash)) !== 0n) throw new Error("the secret was already revealed on chain before bob asked");
    const sent = await sendOps(chain, bob, [{ _tag: "reveal_secret", reveal: { transformer: chain.manifest.contracts.deltaTransformer.address, secret: asHex(action.secret) } }], "bob reveals");
    if (!sent.events.includes("SecretRevealed")) throw new Error(`no SecretRevealed in ${sent.events.join(", ")}`);
    const at = await transformer.hashToTimestamp!(hash);
    if (at === 0n) throw new Error("the transformer holds no reveal time for the secret after the batch");
    // The resend timer ends the wait: the peer that was out of reach acks, and the clause is resolved off chain too.
    net.tell(b, { _tag: "resend_due", peer: y });
    net.settle();
    const [rb, ry] = [net.account(b, y), net.account(y, b)];
    if (rb.head !== ry.head || rb.pending !== undefined || ledgerOf(rb.state, t).holds.length !== 0) throw new Error("hubY-bob did not settle after the resend");
    return {
      checks: [
        `hubY locks 5 for bob (deadline ${deadline}); bob resolves and the frame is lost on the link, so it stays pending`,
        `at view ${deadline - lag - 1n} bob asks nothing; at view ${deadline - lag} (deadline minus LAG ${lag}) its WAL row carries one reveal action for the clause (R-HTLC-CLOCK c)`,
        `bob's reveal_secret batch (nonce ${sent.nonce}, gas ${sent.gasUsed}) emits SecretRevealed; the transformer holds the secret's hash from block time ${at}`,
        "after the resend timer hubY acks the resolve: the Account is at one head with no open clause",
      ],
      gaps: ["jActionOps", "hostShell", "perAccountSigning"],
    };
  },
};

const swap: Step<World> = {
  id: "swap", title: "Two-party swap inside an Account: offer, partial fill, cancel", needs: ["open"],
  run: async () => { throw new Blocked(["swapTx", "hubMatching"], `AccountTx has no swap offer, fill or cancel (pure/account/tx.ts lists pay, set_credit, lock, resolve, cancel, expire), so there is nothing to commit in a frame and nothing for a proof body to carry; ${GAPS.swapTx.supplier}`); },
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
      gaps: ["jDepositFacts", "hostShell"],
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
    const loop = w.loop ?? (() => { throw new Error("no J loop"); })();
    const { alice, hubX } = partiesOf(w);
    const [a, x] = [eid(alice), eid(hubX)];
    const before = ledgerOf(net.account(a, x).state, token(chain)).offdelta;
    await chain.provider.send("evm_mine", []);
    const delivery = await loop.poll(net);
    const onChain = await accountOnChain(chain, alice, hubX);
    const facts = [a, x].map((id) => {
      const f = net.entity(id).chain.get(id === a ? x : a);
      if (f === undefined) throw new Error(`${id} holds no chain facts for alice-hubX`);
      return f;
    });
    const wrong = facts.filter((f) => f.epoch !== onChain.epoch || f.stored !== onChain.nonce || f.disputed || f.frames !== 0n);
    if (wrong.length > 0) throw new Error(`chain facts after the dispute: ${JSON.stringify(facts, (_, v) => (typeof v === "bigint" ? v.toString() : v))}; the chain: epoch ${onChain.epoch}, stored nonce ${onChain.nonce}`);
    const names = delivery.events;
    ["j_epoch", "j_dispute_over"].forEach((tag) => {
      [alice.name, hubX.name].forEach((who) => { if (!names.includes(`${who} ${tag}`)) throw new Error(`${who} was told no ${tag} (${names.join(", ")})`); });
    });
    if (!names.some((n) => n.endsWith("j_dispute"))) throw new Error(`nobody was told of the dispute (${names.join(", ")})`);
    const after = ledgerOf(net.account(a, x).state, token(chain)).offdelta;
    return {
      checks: [
        `the watcher core (pure/j/watch.ts: prepare, readings by block hash, advance) read the Depository's logs up to height ${delivery.height} at depth 1 and delivered ${names.length} J events: ${names.join(", ")}`,
        `both Runtimes hold chain facts epoch ${onChain.epoch}, stored nonce ${onChain.nonce}, no dispute open, frames 0 for alice-hubX: the same as the chain`,
        `the Account itself is not rebased: its ledger still says offdelta ${after} (${after === before ? "as before" : `it was ${before}`}) with the chain's collateral at 0 and its frames not restarted for the new epoch`,
      ],
      gaps: ["ledgerRebase", "jLoop", "hostShell", "jDepositFacts"],
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
    net.restart(y);
    const resent = net.inFlight();
    net.settle();
    if (fingerprint(y) !== prints) throw new Error("hubY's Accounts after the replay differ from what they were before the crash");
    if (asked(y) !== actions) throw new Error("hubY was not asked again for every chain action of its committed rows");
    // The peers drop what they already hold, and the work goes on.
    net.tell(b, { _tag: "set_credit", peer: y, token: t, limit: 60n * unit(chain) });
    net.settle();
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
      gaps: ["hostShell", "perAccountSigning"],
    };
  },
};

export const STEPS: readonly Step<World>[] = [fork, world, deposits, open, pay, htlc, reveal, swap, dispute, disputeClause, rebase, nodes];
