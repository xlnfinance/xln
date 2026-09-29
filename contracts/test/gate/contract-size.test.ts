// EIP-170: every deployed contract must fit in 24,576 bytes. Hardhat's local networks set allowUnlimitedContractSize, so
// no BrowserVM or Hardhat test would ever notice an oversize Account; this reads the compiled artifacts instead.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const EIP_170 = 24_576;
const artifact = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf8"));
const deployedSize = (name: string): number => (artifact(name).deployedBytecode.length - 2) / 2;

describe("EIP-170 contract size", () => {
  test.each(["Account", "Depository", "EntityProvider", "DeltaTransformer", "HankoVerifier"])("%s fits in 24,576 bytes", (name) => {
    const size = deployedSize(name);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(EIP_170);
  });
});
