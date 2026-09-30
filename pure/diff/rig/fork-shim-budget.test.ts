// The fork shim signs every batch og submits with a gas budget of SHIM_GAS_BUDGET (fork-shim.ts), and the Depository will only start a batch
// when the transaction carries budget * 64 / 63 + BATCH_POST_CALL_RESERVE on top of what the outer hanko check has already spent. og's BrowserVM
// sends every processBatch with a fixed gas limit. This pins the three numbers together, so raising the budget, lowering og's gas limit or growing
// a walk's boards past what the budget leaves room for fails here instead of as a BatchGasStarved refusal deep inside a walk.
// Prelude: the outer hanko check plus intrinsic gas, measured by contracts/test/vm/j5-gas-prelude.test.ts (K signing validators, all signing):
// 114,639 gas for 1, 1,528,237 for 64. The check is superlinear, so the chord between two measured points bounds it from above; past the
// last measured point there is no bound, and the test refuses instead of guessing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SHIM_GAS_BUDGET } from "./fork-shim.ts";
import { MAX_BOARD_SIGNERS } from "./world.ts";

const MEASURED: readonly (readonly [number, bigint])[] = [[1, 114_639n], [64, 1_528_237n]];

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

/** og's BrowserVM gas limit for processBatch, read from its source so a change there cannot pass unseen. */
const ogTxGas = (): bigint => {
  const text = source("../../../core/jurisdiction/adapter/browservm/browservm-provider.ts");
  const from = text.indexOf("private async processBatchWithSigner");
  const found = /gasLimit:\s*([\d_]+)n/.exec(text.slice(from));
  if (from < 0 || found === null) throw new Error("SHIM_BUDGET_PIN: og's processBatch gas limit not found");
  return BigInt(found[1]!.replaceAll("_", ""));
};

const depositoryReserve = (): bigint => {
  const found = /BATCH_POST_CALL_RESERVE\s*=\s*([\d_]+)/.exec(source("../../../contracts/contracts/Depository.sol"));
  if (found === null) throw new Error("SHIM_BUDGET_PIN: BATCH_POST_CALL_RESERVE not found");
  return BigInt(found[1]!.replaceAll("_", ""));
};

const preludeBound = (signers: number): bigint => {
  const [[k0, g0], [k1, g1]] = MEASURED as readonly [readonly [number, bigint], readonly [number, bigint]];
  if (signers < k0 || signers > k1) throw new Error(`SHIM_BUDGET_PIN: no measured prelude for ${signers} signers (measured ${k0}..${k1}); measure it in j5-gas-prelude.test.ts and extend MEASURED`);
  return g0 + (BigInt(signers - k0) * (g1 - g0)) / BigInt(k1 - k0) + 1n;
};

const needed = (signers: number): bigint => (SHIM_GAS_BUDGET * 64n + 62n) / 63n + depositoryReserve() + preludeBound(signers);

describe("the shim's signed gas budget fits og's transaction gas limit", () => {
  test("the largest board of the walk's world leaves room", () => {
    const gas = ogTxGas();
    console.log(`og tx gas ${gas}; shim budget ${SHIM_GAS_BUDGET}; largest board ${MAX_BOARD_SIGNERS} signers needs at most ${needed(MAX_BOARD_SIGNERS)}`);
    expect(needed(MAX_BOARD_SIGNERS)).toBeLessThanOrEqual(gas);
  });

  test("the bound says how many signers the budget supports, and a board past it would fail", () => {
    const gas = ogTxGas();
    const supported = Array.from({ length: 64 }, (_, i) => i + 1).filter((k) => needed(k) <= gas).length;
    console.log(`the shim's budget leaves room for boards of up to ${supported} signers`);
    expect(supported).toBeGreaterThanOrEqual(MAX_BOARD_SIGNERS);
    // the pin is not vacuous: one more signer than the bound allows does not fit
    expect(supported).toBeLessThan(64);
    expect(needed(supported + 1)).toBeGreaterThan(gas);
  });

  test("the budget itself is a legal one and the transaction limit cannot carry a larger one for even a lone signer", () => {
    const gas = ogTxGas();
    expect(SHIM_GAS_BUDGET).toBeGreaterThanOrEqual(500_000n);
    expect(needed(1) + ((1_000_000n * 64n) / 63n + 1n)).toBeGreaterThan(gas);
  });
});
