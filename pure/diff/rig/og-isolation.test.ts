// The fork is installed into og's typechain factories, and og's modules make their interfaces from those factories
// once, at import. So in one process the og decoders carry whichever ABI was installed when they were first loaded,
// and j-layer's "og side" silently became the fork's in the one-process suite. These tests pin the two ways out:
// the shipped ABI is readable whatever is installed, and og code that must see the shipped ABI is loaded through
// withShippedOg, which evaluates a fresh copy of its module inside a window where the shipped ABI is installed.
import { describe, expect, test } from "bun:test";
import { Interface } from "ethers";
import { Depository__factory as ForkDepository__factory } from "../../../contracts/typechain-types/factories/Depository.sol/Depository__factory.ts";
import { Depository__factory as OgDepository__factory } from "../../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory.ts";
import { RPC_PUBLIC, type RpcPublic, contractSet, installContracts, loadShippedRpcPublic, shippedDepositoryAbi } from "./contracts.ts";

const selectorOf = (abi: readonly unknown[]): string => new Interface(abi as never).getFunction("processBatch")!.selector;
const FORK_SELECTOR = selectorOf(ForkDepository__factory.abi);

const ogProcessBatch = (): string =>
  new Interface(shippedDepositoryAbi as never).encodeFunctionData("processBatch", ["0x", "0x", 1n]);

describe("og isolation: the shipped ABI", () => {
  test("is og's three-argument processBatch, and differs from the fork's whatever is installed", () => {
    installContracts("contracts");
    expect(selectorOf(shippedDepositoryAbi)).not.toBe(FORK_SELECTOR);
    expect(selectorOf(OgDepository__factory.abi)).toBe(FORK_SELECTOR);
    installContracts("jurisdictions");
    expect(selectorOf(OgDepository__factory.abi)).toBe(selectorOf(shippedDepositoryAbi));
    installContracts(contractSet());
  });
});

describe("og isolation: withShippedOg", () => {
  test("loads og's decoders with og's ABI while the fork is installed, and puts the installed set back", async () => {
    installContracts("contracts");
    const og = await loadShippedRpcPublic();
    expect(selectorOf(OgDepository__factory.abi)).toBe(FORK_SELECTOR);
    // og's own three-argument calldata is recognised by the shipped decoder: the empty batch is refused by content.
    expect(() => og.decodeDisputeProofBodyEvidenceCalldata(ogProcessBatch())).toThrow("J_DISPUTE_PROOFBODY_BATCH_CALLDATA_MISSING");
  });

  test("a module first loaded with the fork installed does not recognise og's calldata (the pollution this guards)", async () => {
    installContracts("contracts");
    const polluted = (await import(`${RPC_PUBLIC}?installed`)) as RpcPublic;
    expect(() => polluted.decodeDisputeProofBodyEvidenceCalldata(ogProcessBatch())).toThrow("J_DISPUTE_PROOFBODY_CALLDATA_UNKNOWN");
    installContracts(contractSet());
  });
});
