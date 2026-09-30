// J5 gas, fifth pass (PR #54 at 5df8b59): can a relayer's gas limit change the OUTCOME of a batch that reverts whole?
// The soft path is closed by the signed budget. The revert-whole path (dispute finalize) still has swallowed sub-calls: DeltaTransformer._decodeArguments does
// `try this.decodeArgumentsStrict(encoded) catch { return empty }`, so a decode that runs out of gas reads as "no evidence". This scans every tx gas limit
// around the decode for a finalize whose result depends on the starter's frozen evidence (a secret, plus N junk secrets to make the decode dear), and
// classifies each limit: PAID (evidence counted, the same logs as the full-gas run), UNPAID (logs of a control world with no evidence: the outcome CHANGED),
// or revert. The claim under test: no limit gives UNPAID.
// One file per process: `bun test contracts/test/vm/j5-fifth-transformer-gas.test.ts` (N=junk secrets, default 1700; STEP default 1000, SPAN).
import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { boot, party, signWith, type Body, type Party } from "./rig.ts";
import { BATCH_ABI } from "../../../core/protocol/dispute/proof-body.ts";
import { encodeSignedAmount } from "../../../core/protocol/crypto/abi-money.ts";
import { Depository__factory as forkDepository } from "../../typechain-types/index.ts";

const coder = ethers.AbiCoder.defaultAbiCoder();
const T0 = 1_800_000_000;
const WINDOWS = 60;
const DEADLINE = 1000;
const SECRET_ARGS = "tuple(uint16[] fillRatios, bytes32[] secrets)";
const secret = ethers.id("j5f5-preimage");
const hashlock = ethers.keccak256(coder.encode(["bytes32"], [secret]));
const N = Number(process.env.N ?? 1700);
// The most fill ratios one evidence can carry: Account refuses a side's arguments above 64 KiB (MAX_DISPUTE_STARTER_ARGUMENT_BYTES), each ratio takes a 32-byte word.
const N_RATIOS = Number(process.env.N_RATIOS ?? 2000);
// Two shapes of the same evidence, so both array decoders are scanned. "secrets": the secret plus `junk` more bytes32 (a cheap copy per element).
// "ratios": the secret plus `junk` uint16 fill ratios (validated and copied per element, dearer per byte and the shape that breaks a linear guard).
type Shape = "secrets" | "ratios";
const evidence = (junk: number, shape: Shape = "secrets"): string => coder.encode(["bytes[]"], [[coder.encode([SECRET_ARGS], [shape === "secrets"
  ? [[], [secret, ...Array.from({ length: junk }, (_, i) => ethers.id(`junk-${i}`))]]
  : [Array.from({ length: junk }, (_, i) => 1 + (i % 60_000)), [secret]]])]]);

type World = Awaited<ReturnType<typeof world>>;
/** A pays H 50 through an HTLC (deadline T0+1000). H, the payee, starts the dispute at t=100 with `starterArgs` frozen; A finalizes at t=1200 (after the deadline). */
const world = async (label: string, starterArgs: string) => {
  const w = await boot(label);
  const [A, H] = [party(`${label}-a`), party(`${label}-h`)];
  const up = w.accountOf(A, H, `${label}-acct`);
  const transformer = w.chain.addresses.deltaTransformer;
  const batch = coder.encode([ethers.ParamType.from(BATCH_ABI as never)], [{
    payment: [{ deltaIndex: 0, amount: encodeSignedAmount(up.L.id !== A.id ? 50n : -50n), revealedUntilTimestamp: T0 + DEADLINE, hash: hashlock }], swap: [], pull: [],
  }]);
  const body: Body = { ...up.body(0n, WINDOWS), transformers: [{ transformerAddress: transformer, encodedBatch: batch, allowances: [{ deltaIndex: 0, rightAllowance: 50n, leftAllowance: 50n }] }] };
  for (const p of [A, H]) await w.chain.debugFundReserves(p.id, w.TOKEN, 1000n);
  const hIsLeft = up.L.id === H.id;
  const e0 = await up.epochOf();
  w.at(100);
  const startOp = { ...w.startOp(A, 1, hIsLeft, body, up.proofSig(A, e0, 1, hIsLeft, body), e0), starterInitialArguments: starterArgs };
  const started = await w.submit(H, { disputeStarts: [startOp] });
  expect(started).toBe("ok");
  w.at(1200);
  const finalizeOp = w.finalizeOp(H, { nonce: 1, body, startedByLeft: hIsLeft }, { nonce: 1, proposerIsLeft: hIsLeft, body, sig: "0x" }, { starter: starterArgs });
  const encoded = w.encodeJBatch({ ...w.createEmptyBatch(), disputeFinalizations: [finalizeOp] } as never);
  const nonce = (await w.chain.getEntityNonce(A.id)) + 1n;
  const data = ethers.getBytes(forkDepository.createInterface().encodeFunctionData("processBatch", [A.id, encoded, signWith(A, w.batchHash(A.id, encoded, nonce)), nonce]));
  const block = w.vm.createBlock(w.vm.getBlockTimestamp());
  const run = async (gasLimit: bigint) => {
    const r = await w.vm.runReadOnlyCall({ to: w.vm.depositoryAddress, caller: w.vm.deployerAddress, data, gasLimit, block });
    const logs = (r.execResult.logs ?? []) as [Uint8Array, Uint8Array[], Uint8Array][];
    const ok = r.execResult.exceptionError === undefined;
    const digest = ethers.keccak256(ethers.concat(logs.map((l) => ethers.concat([...l[1], l[2]]))));
    if (process.env.DUMP === String(gasLimit)) {
      const iface = forkDepository.createInterface();
      logs.forEach((l) => { try { const e = iface.parseLog({ topics: l[1].map((t) => ethers.hexlify(t)), data: ethers.hexlify(l[2]) }); console.log("LOG", gasLimit.toString(), e!.name, e!.args.toString().slice(0, 400)); } catch { console.log("LOG", gasLimit.toString(), "?", ethers.hexlify(l[1][0]!).slice(0, 12), ethers.hexlify(l[2]).slice(0, 120)); } });
    }
    return { limit: gasLimit, ok, digest: ok ? digest : "", rv: ethers.hexlify(r.execResult.returnValue ?? new Uint8Array()).slice(0, 10), used: BigInt(r.execResult.executionGasUsed) };
  };
  return { w, A, H, run };
};

describe("relayer gas vs a finalize that reads swallowed evidence", () => {
  const scanShape = async (n: number, shape: Shape) => {
    const paidWorld = await world(`j5f5-paid-${shape}`, evidence(n, shape));
    const control = await world(`j5f5-control-${shape}`, "0x"); // no evidence: what a dropped decode would settle as
    const paid = await paidWorld.run(30_000_000n);
    const unpaid = await control.run(30_000_000n);
    console.log(`full gas: paid ok=${paid.ok} used ${paid.used}; control (no evidence) ok=${unpaid.ok} used ${unpaid.used}; logs differ: ${paid.digest !== unpaid.digest}`);
    expect(paid.ok && unpaid.ok).toBe(true);
    expect(paid.digest).not.toBe(unpaid.digest); // the evidence really decides the outcome
    // scan: from a bit under the point where the transformer's own gas runs out to a bit above the decode's need
    const lo = BigInt(process.env.LO ?? 2_000_000);
    const hi = BigInt(process.env.HI ?? (paid.used + 2_400_000n));
    const step = BigInt(process.env.STEP ?? 1000);
    const seen = new Map<string, { n: number; first: bigint; last: bigint }>();
    for (let g = lo; g <= hi; g += step) {
      const o = await paidWorld.run(g);
      const kind = !o.ok ? `revert ${o.rv}` : o.digest === paid.digest ? "PAID" : o.digest === unpaid.digest ? "UNPAID" : "OTHER";
      const s = seen.get(kind);
      seen.set(kind, s ? { n: s.n + 1, first: s.first, last: g } : { n: 1, first: g, last: g });
    }
    console.log("scan", lo.toString(), "..", hi.toString(), "step", step.toString(), [...seen.entries()].map(([k, v]) => `${k}: ${v.n} limits (${v.first}..${v.last})`).join(" | "));
    expect(seen.get("UNPAID")?.n ?? 0).toBe(0);
    expect(seen.get("OTHER")?.n ?? 0).toBe(0);
  };
  test(`starter evidence = the secret + ${N} junk secrets: every tx gas limit is PAID or reverts, never UNPAID`, () => scanShape(N, "secrets"), 3_000_000);
  test(`starter evidence = the secret + ${N_RATIOS} junk fill ratios (the cap): every tx gas limit is PAID or reverts, never UNPAID`, () => scanShape(N_RATIOS, "ratios"), 3_000_000);
});
