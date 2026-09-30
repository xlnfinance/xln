// Which contracts the test rig's BrowserVM deploys. The default is the fork in contracts/; WALK_CONTRACTS=jurisdictions
// keeps the frozen og bytecode for comparison. og's BrowserVM deploys whatever its typechain factories carry, so the
// fork is installed by overwriting those factories' bytecode, ABI and library linker before the stack is deployed.
import { Contract, Interface } from "ethers";
import {
  Account__factory as ogAccount,
  Depository__factory as ogDepository,
  EntityProvider__factory as ogEntityProvider,
  HankoVerifier__factory as ogHankoVerifier,
  DeltaTransformer__factory as ogDeltaTransformer,
  DepositoryBounds__factory as ogDepositoryBounds,
  HashLadderRegistry__factory as ogHashLadderRegistry,
  NftCustody__factory as ogNftCustody,
} from "../../jurisdictions/typechain-types/index.ts";
import {
  Account__factory as forkAccount,
  Depository__factory as forkDepository,
  EntityProvider__factory as forkEntityProvider,
  HankoVerifier__factory as forkHankoVerifier,
  DeltaTransformer__factory as forkDeltaTransformer,
  DepositoryBounds__factory as forkDepositoryBounds,
  HashLadderRegistry__factory as forkHashLadderRegistry,
  NftCustody__factory as forkNftCustody,
} from "../../contracts/typechain-types/index.ts";

export type ContractSet = "contracts" | "jurisdictions";

export const contractSet = (): ContractSet =>
  process.env["WALK_CONTRACTS"] === "jurisdictions" ? "jurisdictions" : "contracts";

const PAIRS = [
  [ogAccount, forkAccount], [ogDepository, forkDepository], [ogEntityProvider, forkEntityProvider],
  [ogHankoVerifier, forkHankoVerifier], [ogDeltaTransformer, forkDeltaTransformer],
  // The linked libraries too (J5): the bounds check reads the fork's Batch, which starts with the signed gasBudget; the registry and custody are the fork's code.
  [ogDepositoryBounds, forkDepositoryBounds], [ogHashLadderRegistry, forkHashLadderRegistry], [ogNftCustody, forkNftCustody],
] as const;

const FIELDS = ["bytecode", "abi", "linkBytecode", "createInterface", "connect"] as const;
type Factory = Record<string, unknown>;

/** The og factories exactly as jurisdictions/typechain-types shipped them, captured once before any overwrite. */
const shipped = PAIRS.map(([og]) => Object.fromEntries(FIELDS.map((f) => [f, (og as unknown as Factory)[f]])));

/**
 * Install the chosen contract set into og's factories; idempotent, and reversible by choosing the other set.
 * A typechain factory keeps its ABI in a module constant that createInterface and connect close over, and og's
 * watcher decodes logs with interfaces made that way, so those two are redirected too: without it the fork's new
 * events (AccountEpochAdvanced) decode to nothing and og's watcher halts.
 */
export const installContracts = (which: ContractSet = contractSet()): ContractSet => {
  PAIRS.forEach(([og, fork], i) => {
    const target = og as unknown as Factory;
    const source = which === "contracts" ? (fork as unknown as Factory) : shipped[i]!;
    FIELDS.forEach((f) => {
      if (source[f] !== undefined) target[f] = source[f];
    });
    target["createInterface"] = () => new Interface(target["abi"] as never);
    target["connect"] = (address: string, runner?: never) => new Contract(address, target["abi"] as never, runner);
  });
  return which;
};

/** og's Depository ABI as jurisdictions/ shipped it, whatever is installed now: og-shaped calldata is built from it. */
export const shippedDepositoryAbi = shipped[1]!["abi"] as readonly unknown[];

/**
 * Load og code that must see the shipped ABI. og's modules make their interfaces from these factories once, at import,
 * so a module first evaluated after installContracts carries the fork's ABI for the rest of the process, and a test of
 * og's own decoding then compares the fork with itself. `load` evaluates a fresh copy of the module (an import with
 * its own query string) while the shipped set is installed; the set that was chosen is put back afterwards.
 */
export const withShippedOg = <T>(load: () => Promise<T>): Promise<T> => {
  installContracts("jurisdictions");
  return load().finally(() => installContracts(contractSet()));
};

/** og's dispute-evidence decoders (rpc-public) read the Depository interface once, at import. */
export type RpcPublic = typeof import("../../core/jurisdiction/adapter/rpc-public.ts");
export const RPC_PUBLIC = "../../core/jurisdiction/adapter/rpc-public.ts";

/** A fresh copy of og's rpc-public, made while the shipped ABI is installed. */
export const loadShippedRpcPublic = (): Promise<RpcPublic> =>
  withShippedOg(async () => (await import(`${RPC_PUBLIC}?shipped`)) as RpcPublic);

// Before og's modules load: some of them make their interfaces once, at import.
installContracts();
