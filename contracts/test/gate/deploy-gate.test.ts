// N3: the deploy gate refuses the testnet response-window floor on anything that is not a named testnet.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
// @ts-expect-error CommonJS script without types
import gate from "../../scripts/deploy-gate.cjs";
// @ts-expect-error CommonJS script without types
import matrix from "../../scripts/deploy-chain-matrix.cjs";

const src = (value: string) => `uint256 private constant MIN_RESPONSE_SECONDS = ${value};`;
const sepolia = { id: "ethereum-sepolia" }, mainnet = { id: "ethereum-mainnet" }, nile = { id: "tron-nile" };

describe("deploy gate", () => {
  test("reads the constant in seconds and with units", () => {
    expect(gate.parseMinResponseSeconds(src("60"))).toBe(60);
    expect(gate.parseMinResponseSeconds(src("6 hours"))).toBe(21600);
    expect(gate.parseMinResponseSeconds("no constant here")).toBeNull();
  });

  test("named testnets may carry the testnet floor", () => {
    expect(gate.assertResponseFloor([sepolia, nile], src("60"))).toBe(60);
  });

  test("mainnet is refused below the mainnet floor, and mixed selections are refused as a whole", () => {
    expect(() => gate.assertResponseFloor([mainnet], src("60"))).toThrow(/below the mainnet floor/);
    expect(() => gate.assertResponseFloor([sepolia, mainnet], src("60"))).toThrow(/ethereum-mainnet/);
  });

  test("mainnet passes at or above the mainnet floor", () => {
    expect(gate.assertResponseFloor([mainnet], src("6 hours"))).toBe(21600);
    expect(gate.assertResponseFloor([mainnet], src("2 days"))).toBe(172800);
  });

  test("an unreadable constant fails closed on mainnet and does not block a testnet", () => {
    expect(() => gate.assertResponseFloor([mainnet], "// nothing")).toThrow(/cannot read/);
    expect(gate.assertResponseFloor([sepolia], "// nothing")).toBeNull();
  });

  test("every chain the matrix can deploy is either a named testnet or gated", () => {
    const ids = Object.values(matrix.profiles).flatMap((p: any) => [p.ethereum.id, p.tron.id]) as string[];
    const testnets = ids.filter((id) => gate.NAMED_TESTNETS.has(id));
    expect(testnets.sort()).toEqual(["ethereum-sepolia", "tron-nile"]);
  });

  test("the real deploy entry point refuses mainnet before touching any network", () => {
    const run = spawnSync("bun", ["scripts/deploy-chain-matrix.cjs", "--profile=mainnet", "--dry-run"], {
      cwd: path.join(import.meta.dir, "..", ".."), encoding: "utf8", env: { ...process.env, DEPLOYER_PRIVATE_KEY: "" },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Deploy gate: MIN_RESPONSE_SECONDS is 60s");
  });
});
