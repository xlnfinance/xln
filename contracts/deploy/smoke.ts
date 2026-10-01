// Smoke test of a DEPLOYED contract set over JSON-RPC, with plain ethers (no BrowserVM, no repository helpers): two fresh lazy entities
// open an Account, deposit, sign batches, settle cooperatively, and fight two disputes to the end, one started from the implicit proof
// (R-IMPLICIT-BASELINE) and one from a signed proof. Every payload is re-derived here from the encodings pinned by contracts/vectors, so a
// deployment whose bytecode disagrees with them fails here and not later in a node.
//
//   bun contracts/deploy/smoke.ts --rpc http://127.0.0.1:8545 --manifest <deployed manifest> [--live]
//
// Fresh entities (a salt in their keys) are made on every run, so it can run again on a chain that keeps state. The deployer key pays for them.
// Time: a node that speaks evm_increaseTime (anvil, including a fork) jumps over the dispute windows; any other node is waited on in real time.
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { Depository__factory, DepositoryBounds__factory, ERC20Mock__factory } from "../typechain-types/index.ts";
import { deployedManifest, type Manifest } from "./manifest.ts";
import { assertGatedChain, refuseRemoteWithoutLive, resolveDeployerKey } from "./deploy-set.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const TOKEN_ID = 1n;
const GAS_BUDGET = 3_000_000n;
const TX_GAS_LIMIT = 8_000_000n;

// ---- payloads, from the encodings in contracts/vectors/README.md ----
const batchParam = DepositoryBounds__factory.createInterface().getFunction("assertBatch")!.inputs[0]!;
const component = (param: ethers.ParamType, name: string): ethers.ParamType => param.components!.find((c) => c.name === name)!;
const itemOf = (param: ethers.ParamType): ethers.ParamType => param.arrayChildren!;
const bodyParam = component(itemOf(component(batchParam, "disputeStarts")), "initialProofbody");
const diffsParam = component(itemOf(component(batchParam, "settlements")), "diffs");

const BOARD = ["tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)"];
export const lazyEntityId = (address: string): string => ethers.keccak256(coder.encode(BOARD, [[1, [ethers.zeroPadValue(address, 32)], [1], 0, 0, 0]]));
const sign = (hash: string, key: string): string => new ethers.SigningKey(key).sign(ethers.getBytes(hash)).serialized;

const int512 = (n: bigint) => ({ high: n >> 256n, low: n & ((1n << 256n) - 1n) });
const signedAmount = (n: bigint) => ({ negative: n < 0n, magnitude: n < 0n ? -n : n });

type Body = { readonly watchSeed: string; readonly leftResponseSeconds: number; readonly rightResponseSeconds: number; readonly offdeltas: readonly bigint[]; readonly tokenIds: readonly bigint[] };
const bodyStruct = (b: Body) => ({ ...b, offdeltas: b.offdeltas.map(int512), transformers: [] });
const bodyHash = (b: Body): string => ethers.keccak256(coder.encode([bodyParam], [bodyStruct(b)]));

const emptyBatch = (patch: Record<string, unknown>): Record<string, unknown> => ({
  gasBudget: GAS_BUDGET,
  ...Object.fromEntries(batchParam.components!.filter((c) => c.baseType === "array").map((c) => [c.name, []])),
  ...patch,
});

type Party = { readonly wallet: ethers.Wallet; readonly id: string };

export type SmokeReport = {
  readonly entities: { readonly left: string; readonly right: string };
  readonly steps: readonly { readonly step: string; readonly gasUsed: string }[];
  readonly final: { readonly leftReserve: string; readonly rightReserve: string; readonly collateral: string; readonly epoch: string };
};

export type SmokeOptions = {
  readonly rpcUrl: string;
  readonly manifest: Manifest;
  readonly privateKey?: string;
  readonly salt?: string;
  readonly live?: boolean;
  readonly log?: (line: string) => void;
};

export const smokeSet = async ({ rpcUrl, manifest: given, privateKey, salt = ethers.hexlify(ethers.randomBytes(8)), live = false, log = () => undefined }: SmokeOptions): Promise<SmokeReport> => {
  const manifest = deployedManifest(given);
  assertGatedChain(manifest);
  refuseRemoteWithoutLive(rpcUrl, live, "a live smoke test");
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const chainId = (await provider.getNetwork()).chainId;
  if (Number(chainId) !== manifest.chainId) throw new Error(`the node reports chain id ${chainId}, the manifest is for ${manifest.chainId}`);
  const funder = new ethers.Wallet(privateKey ?? resolveDeployerKey(process.env, rpcUrl), provider);
  const depositoryAddress = manifest.contracts.depository.address;
  const depository = Depository__factory.connect(depositoryAddress, provider);
  const token = ERC20Mock__factory.connect(manifest.token.address!, provider);
  const steps: { step: string; gasUsed: string }[] = [];

  const party = (name: string): Party => {
    const wallet = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`xln-smoke-${salt}-${name}`)), provider);
    return { wallet, id: lazyEntityId(wallet.address) };
  };
  const [one, two] = [party("a"), party("b")];
  const [L, R] = BigInt(one.id) < BigInt(two.id) ? [one, two] : [two, one];
  const acctKey = ethers.solidityPacked(["bytes32", "bytes32"], [L.id, R.id]);

  // Pay for the entities and give them tokens (the deployer holds the faucet's supply). Each transaction is mined before the next.
  const unit = 10n ** BigInt(manifest.token.decimals);
  for (const p of [L, R]) {
    await (await funder.sendTransaction({ to: p.wallet.address, value: ethers.parseEther("0.05") })).wait();
    await (await token.connect(funder).transfer(p.wallet.address, 1000n * unit)).wait();
    await (await token.connect(p.wallet).approve(depositoryAddress, 1000n * unit)).wait();
  }

  const reserveOf = (p: Party): Promise<bigint> => depository._reserves(p.id, TOKEN_ID);
  const collateralOf = async (): Promise<bigint> => (await depository._collaterals(acctKey, TOKEN_ID)).collateral;
  const epochOf = (): Promise<bigint> => depository.ondeltaEpoch(L.id, R.id);
  const storedNonce = async (): Promise<bigint> => (await depository._accounts(acctKey)).nonce;
  const expectEqual = (what: string, actual: bigint, expected: bigint): void => {
    if (actual !== expected) throw new Error(`smoke: ${what} is ${actual}, expected ${expected}`);
  };

  const batchHash = (entity: string, encoded: string, nonce: bigint): string => ethers.keccak256(ethers.solidityPacked(
    ["bytes32", "uint256", "address", "bytes32", "bytes", "uint256"], [ethers.id("XLN_DEPOSITORY_HANKO_V2"), chainId, depositoryAddress, entity, encoded, nonce]));
  const proofHash = (epoch: bigint, nonce: bigint, proposerIsLeft: boolean, b: Body): string => ethers.keccak256(coder.encode(
    ["uint256", "uint256", "address", "bytes", "uint256", "uint256", "bool", "bytes32", "bytes32"], [1, chainId, depositoryAddress, acctKey, epoch, nonce, proposerIsLeft, bodyHash(b), b.watchSeed]));
  const coopHash = (epoch: bigint, nonce: bigint, diffs: unknown[]): string => ethers.keccak256(coder.encode(
    ["uint256", "uint256", "address", "bytes", "uint256", "uint256", diffsParam, "uint256[]"], [0, chainId, depositoryAddress, acctKey, epoch, nonce, diffs, []]));

  /** One signed batch of `who`, sent from its own wallet; it must apply: any BatchFailed, BatchGasStarved or skip is a failed smoke test. */
  const submit = async (step: string, who: Party, patch: Record<string, unknown>, expectEvents: readonly string[]): Promise<void> => {
    const encoded = coder.encode([batchParam], [emptyBatch(patch)]);
    const nonce = (await depository.entityNonces(who.id)) + 1n;
    const hanko = sign(batchHash(who.id, encoded, nonce), who.wallet.privateKey);
    const receipt = await (await depository.connect(who.wallet).processBatch(who.id, encoded, hanko, nonce, { gasLimit: TX_GAS_LIMIT })).wait();
    if (receipt === null || receipt.status !== 1) throw new Error(`smoke: ${step}: the transaction failed`);
    const names = receipt.logs.filter((log) => log.address.toLowerCase() === depositoryAddress.toLowerCase())
      .map((log) => depository.interface.parseLog(log)?.name ?? "?");
    const bad = names.filter((name) => ["BatchFailed", "BatchGasStarved", "DisputeOpSkipped"].includes(name));
    if (bad.length > 0) throw new Error(`smoke: ${step}: ${bad.join(", ")}`);
    for (const wanted of expectEvents) if (!names.includes(wanted)) throw new Error(`smoke: ${step}: no ${wanted} event (saw ${names.join(", ")})`);
    steps.push({ step, gasUsed: receipt.gasUsed.toString() });
    log(`  ${step.padEnd(52)} gas ${receipt.gasUsed}`);
  };

  /** Jump the chain's clock over a dispute window where the node allows it; otherwise wait it out. */
  const waitSeconds = async (seconds: number): Promise<void> => {
    const before = (await provider.getBlock("latest"))!.timestamp;
    try {
      await provider.send("evm_increaseTime", [seconds]);
      await provider.send("evm_mine", []);
    } catch {
      await new Promise((done) => setTimeout(done, seconds * 1000 + 2000));
    }
    if ((await provider.getBlock("latest"))!.timestamp < before + seconds) throw new Error(`smoke: the clock did not move ${seconds}s`);
  };

  // 1. Deposit: both entities pay tokens in through a signed batch (the chain pulls them from the sender's wallet).
  const deposit = 500n * unit;
  for (const p of [L, R]) {
    const before = await reserveOf(p);
    await submit(`deposit ${p === L ? "left" : "right"}`, p, {
      externalTokenToReserve: [{ entity: p.id, contractAddress: manifest.token.address, externalTokenId: 0, tokenType: 0, internalTokenId: TOKEN_ID, amount: deposit }],
    }, ["HankoBatchProcessed"]);
    expectEqual("reserve after deposit", (await reserveOf(p)) - before, deposit);
  }

  // 2. Open the Account: Left moves 100 from its reserve into collateral against Right.
  const collateral = 100n * unit;
  const fund = (): Promise<void> => submit("reserve to collateral (open / fund)", L, {
    reserveToCollateral: [{ tokenId: TOKEN_ID, receivingEntity: L.id, pairs: [{ entity: R.id, amount: collateral }] }],
  }, ["HankoBatchProcessed"]);
  const leftBefore = await reserveOf(L);
  await fund();
  expectEqual("left reserve after funding", leftBefore - (await reserveOf(L)), collateral);
  expectEqual("collateral", await collateralOf(), collateral);

  // 3. Cooperative settlement at epoch 0: Left withdraws 10 of its collateral, signed by Right.
  const withdraw = 10n * unit;
  const diffs = [{ tokenId: TOKEN_ID, leftDiff: signedAmount(withdraw), rightDiff: signedAmount(0n), collateralDiff: signedAmount(-withdraw), ondeltaDiff: signedAmount(-withdraw) }];
  const epoch0 = await epochOf();
  await submit("cooperative settlement (epoch 0 -> 1)", L, {
    settlements: [{ leftEntity: L.id, rightEntity: R.id, diffs, forgiveDebtsInTokenIds: [], sig: sign(coopHash(epoch0, 5n, diffs), R.wallet.privateKey), nonce: 5n }],
  }, ["HankoBatchProcessed"]);
  expectEqual("epoch after settlement", await epochOf(), epoch0 + 1n);
  expectEqual("stored nonce after settlement", await storedNonce(), 5n);
  expectEqual("collateral after settlement", await collateralOf(), collateral - withdraw);

  // 4. Dispute from the IMPLICIT proof: Right holds no signed proof of epoch 1 and starts from the empty state, with no signature.
  const floor = manifest.dispute.responseFloorSeconds;
  const implicit: Body = { watchSeed: ethers.ZeroHash, leftResponseSeconds: floor, rightResponseSeconds: floor, offdeltas: [0n], tokenIds: [TOKEN_ID] };
  const epoch1 = await epochOf();
  const startOp = (other: Party, nonce: bigint, proposerIsLeft: boolean, b: Body, sig: string, epoch: bigint) => ({
    counterentity: other.id, nonce, ondeltaEpoch: epoch, proposerIsLeft, proofbodyHash: bodyHash(b), initialProofbody: bodyStruct(b), watchSeed: b.watchSeed,
    sig, starterInitialArguments: "0x", starterCounterArguments: "0x", starterCounterProofCommitment: ethers.ZeroHash,
  });
  const finalizeOp = (other: Party, nonce: bigint, proposerIsLeft: boolean, b: Body, startedByLeft: boolean) => ({
    counterentity: other.id, initialNonce: nonce, finalNonce: nonce, proposerIsLeft, initialProofbodyHash: bodyHash(b), finalProofbody: bodyStruct(b),
    starterArguments: "0x", otherArguments: "0x", sig: "0x", startedByLeft, cooperative: false,
  });
  const rightBefore = await reserveOf(R);
  const leftBeforeDispute = await reserveOf(L);
  await submit("dispute start from the implicit proof", R, { disputeStarts: [startOp(L, 6n, false, implicit, "0x", epoch1)] }, ["HankoBatchProcessed"]);
  if ((await depository._accounts(acctKey)).disputeHash === ethers.ZeroHash) throw new Error("smoke: no dispute is open after the start");
  await waitSeconds(2 * floor + 10);
  await submit("dispute finalize by timeout (implicit)", R, { disputeFinalizations: [finalizeOp(L, 6n, false, implicit, false)] }, ["HankoBatchProcessed"]);
  // Delta = ondelta (90): Left takes the whole collateral, Right gets nothing from it.
  expectEqual("left reserve after the implicit dispute", (await reserveOf(L)) - leftBeforeDispute, collateral - withdraw);
  expectEqual("right reserve after the implicit dispute", (await reserveOf(R)) - rightBefore, 0n);
  expectEqual("collateral after the implicit dispute", await collateralOf(), 0n);
  const epoch2 = await epochOf();
  expectEqual("epoch after the finalize", epoch2, epoch1 + 1n);

  // 5. Fund again, then a dispute from a SIGNED proof: Left signed "Left owes Right 10" at nonce 8, Right starts with it and the timeout settles it.
  await fund();
  const owed = 10n * unit;
  const signedBody: Body = { watchSeed: ethers.id(`xln-smoke-${salt}-seed`), leftResponseSeconds: floor, rightResponseSeconds: floor, offdeltas: [-owed], tokenIds: [TOKEN_ID] };
  const stored = await storedNonce();
  const nonce = stored + 1n;
  const leftBeforeSigned = await reserveOf(L);
  const rightBeforeSigned = await reserveOf(R);
  await submit("dispute start from a signed proof", R, {
    disputeStarts: [startOp(L, nonce, true, signedBody, sign(proofHash(epoch2, nonce, true, signedBody), L.wallet.privateKey), epoch2)],
  }, ["HankoBatchProcessed"]);
  await waitSeconds(2 * floor + 10);
  await submit("dispute finalize by timeout (signed)", R, { disputeFinalizations: [finalizeOp(L, nonce, true, signedBody, false)] }, ["HankoBatchProcessed"]);
  // ondelta 100 + offdelta -10: Left takes 90 of the collateral, Right takes 10.
  expectEqual("left reserve after the signed dispute", (await reserveOf(L)) - leftBeforeSigned, collateral - owed);
  expectEqual("right reserve after the signed dispute", (await reserveOf(R)) - rightBeforeSigned, owed);
  expectEqual("collateral after the signed dispute", await collateralOf(), 0n);

  return {
    entities: { left: L.id, right: R.id }, steps,
    final: { leftReserve: (await reserveOf(L)).toString(), rightReserve: (await reserveOf(R)).toString(), collateral: (await collateralOf()).toString(), epoch: (await epochOf()).toString() },
  };
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | null => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] ?? null : null; };
  const rpc = value("--rpc") ?? process.env["XLN_DEPLOY_RPC"], file = value("--manifest");
  if (rpc === undefined || file === null) throw new Error("--rpc <url> and --manifest <deployed manifest> are required");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const report = await smokeSet({ rpcUrl: rpc, manifest, live: argv.includes("--live"), log: console.log });
  console.log(`smoke test passed: ${report.steps.length} signed batches; final reserves left ${report.final.leftReserve}, right ${report.final.rightReserve}, epoch ${report.final.epoch}`);
}
