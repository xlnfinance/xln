// J5 gas (PR #54, third round), the prelude side. With a FIXED floor a failing batch was reported only if the transaction carried floor + prelude, and for
// an entity with a big board the prelude (the outer hanko check) took it past the EIP-7825 transaction cap (16,777,216) at about 70 validators: J5's
// protection was gone for that entity. With the signed budget the requirement is prelude + budget * 64/63 + reserve, and the signer picks the budget:
// at the smallest allowed budget (500k) a failing batch is reported far under the cap for boards up to 128 signing validators (measured below).
// (A board of 256 cannot even be registered in the rig's gas; the prelude is superlinear, so the deploy gate names 128 as the supported size and the
// Runtime never signs a batch whose prelude + budget requirement exceeds the chain's cap: it simulates first, and splits.)
// This file measures the prelude by board size (EOA validators, all signing); the deploy gate (scripts/deploy-gate.cjs) carries the number it checks
// a chain's transaction gas cap against (SUPPORTED_BOARD_SIGNERS and HANKO_PRELUDE_GAS there come from this measurement).
// One file per process: `bun test contracts/test/vm/j5-gas-prelude.test.ts` (KS=1,64 narrows it).
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party } from "./rig.ts";
import { Depository__factory as forkDepository } from "../../typechain-types/index.ts";
// @ts-expect-error CommonJS script without types
import gate from "../../scripts/deploy-gate.cjs";

const coder = ethers.AbiCoder.defaultAbiCoder();
const BATCH_FAILED = ethers.id("BatchFailed(bytes32,uint256,bytes4)");
const BOARD_ABI = ["tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)"];
const HANKO_ABI = ["tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])"];
/** EIP-7825: the most gas one transaction may carry. */
const TX_GAS_CAP = 16_777_216n;
const MIN_BUDGET = 500_000n;
const RESERVE = 30_000n;
const requirement = (budget: bigint): bigint => (budget * 64n) / 63n + RESERVE;

describe("F1 the outer hanko of a big board no longer decides whether a failing batch can be reported", () => {
  for (const K of (process.env.KS ?? "1,64,128").split(",").map(Number)) test(`board of ${K} validators, all signing`, async () => {
    const w = await boot(`j5p-${K}`);
    const keys = Array.from({ length: K }, (_, i) => ethers.keccak256(ethers.toUtf8Bytes(`j5p-val-${K}-${i}`)));
    const ids = keys.map((k) => ethers.zeroPadValue(new ethers.Wallet(k).address, 32));
    const { entityNumbers } = await w.vm.registerNumberedEntitiesBatch([coder.encode(BOARD_ABI, [[K, ids, ids.map(() => 1), 0, 0, 0]])]);
    const E = ethers.zeroPadValue(ethers.toBeHex(entityNumbers[0]!), 32);
    const sink = party("j5p-sink");
    await w.chain.debugFundReserves(E, w.TOKEN, 1000n);
    // more than the reserve: the batch FAILS, which is the case the old floor made expensive
    const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), gasBudget: MIN_BUDGET, reserveToReserve: [{ receivingEntity: sink.id, tokenId: w.TOKEN, amount: 5000n }] } as never);
    const hash = w.batchHash(E, encoded, 1n);
    const sigs = keys.map((k) => ethers.Signature.from(new ethers.SigningKey(k).sign(ethers.getBytes(hash))));
    const vBits = new Uint8Array(Math.ceil(K / 8));
    sigs.forEach((s, i) => { if (s.v === 28) vBits[Math.floor(i / 8)]! |= 1 << (i % 8); });
    const packed = ethers.concat([...sigs.flatMap((s) => [s.r, s.s]), vBits]);
    const hanko = coder.encode(HANKO_ABI, [[[], packed, [[E, keys.map((_, i) => i), keys.map(() => 1), K, 0, 0, 0]], []]]);
    const data = ethers.getBytes(forkDepository.createInterface().encodeFunctionData("processBatch", [E, encoded, hanko, 1n]));
    const run = async (gasLimit: bigint) => {
      const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data, gasLimit });
      const topics = (r.execResult.logs ?? []).map((l: [Uint8Array, Uint8Array[], Uint8Array]) => ethers.hexlify(l[1][0]!));
      return { ok: r.execResult.exceptionError === undefined, reported: topics.includes(BATCH_FAILED), used: BigInt(r.execResult.executionGasUsed) };
    };
    const search = async (lo: bigint, hi: bigint): Promise<bigint> => (hi - lo <= 1000n ? hi : (await run((lo + hi) / 2n)).reported ? search(lo, (lo + hi) / 2n) : search((lo + hi) / 2n, hi));
    const landing = await search(500_000n, TX_GAS_CAP);
    const intrinsic = 21_000n + 16n * BigInt(data.length);
    const prelude = landing - requirement(MIN_BUDGET); // prelude + intrinsic + the search's 1000 resolution
    console.log(`K=${K}: calldata ${data.length} B; lowest gas limit at which the failing batch is reported ${landing}; requirement of the budget alone ${requirement(MIN_BUDGET)}; `
      + `prelude + intrinsic ~ ${prelude} (intrinsic ~ ${intrinsic}); EIP-7825 cap ${TX_GAS_CAP}, headroom ${TX_GAS_CAP - landing}`);
    expect((await run(landing)).reported).toBe(true);
    expect(landing).toBeGreaterThanOrEqual(requirement(MIN_BUDGET));
    // the deploy gate budgets this prelude for the board size it names: the measurement may not pass its constant
    if (K === gate.SUPPORTED_BOARD_SIGNERS) expect(prelude).toBeLessThanOrEqual(gate.HANKO_PRELUDE_GAS);
    expect(landing).toBeLessThan(TX_GAS_CAP); // under the cap for every board size, at the smallest budget: the entity's failing batch can always be reported
  }, 1_800_000);
});
