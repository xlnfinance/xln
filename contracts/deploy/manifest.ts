// The deploy manifest: one JSON file per network that holds everything a node and a reviewer need to know about a deployment of the frozen
// contract set. It is both the INPUT of deploy-set.ts (status "prepared": parameters set, `contracts` and `token` null) and its OUTPUT (status
// "deployed": addresses, blocks, transaction hashes, code hashes). It never holds a key.
//
// Fields that are parameters, not results, are checked against the compiled build before anything is sent (deploy-set.ts): a manifest whose
// floors or HANKO_PRELUDE_GAS drifted from the contracts is refused.

export const CONTRACT_NAMES = [
  "account", "hankoVerifier", "entityProvider", "deltaTransformer", "depositoryBounds", "hashLadderRegistry", "nftCustody", "depository",
] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

export type Deployed = {
  readonly address: string;
  readonly deploymentBlock: number;
  readonly transactionHash: string;
  readonly gasUsed: string;
  /** keccak256 of the code the chain holds at the address: compare it with a fresh build before trusting the address. */
  readonly codeHash: string;
};

/** One row of the static peer table (Q-T-4): which host speaks for which entity. The transport spec owns the meaning; the slot only carries it. */
export type PeerEntry = { readonly entityId: string; readonly endpoint: string };

export type Manifest = {
  readonly manifestVersion: 1;
  readonly stack: "xln-contracts-v1";
  readonly status: "prepared" | "deployed";
  readonly network: string;
  readonly chainId: number;
  /** The faucet token is a testnet convenience; a real token address is taken as it is. */
  readonly token: { readonly symbol: string; readonly decimals: number; readonly address: string | null; readonly deployFaucet: boolean; readonly tokenId: number | null };
  readonly dispute: {
    /** The response-window floor of THIS build (Account.MIN_RESPONSE_SECONDS, read from the compiled build); a testnet number. */
    readonly responseFloorSeconds: number;
    /** What any chain that is not a named testnet needs (deploy-gate.cjs). */
    readonly mainnetResponseFloorSeconds: number;
  };
  readonly gas: {
    readonly hankoPreludeGas: number;
    /** The gas one batch transaction must carry: prelude + smallest signed budget * 64/63 + post-call reserve. The deploy gate's total. */
    readonly requiredTxGas: number;
    /** The ceiling this manifest accepts for requiredTxGas; the check fails if the build needs more. */
    readonly maxRequiredTxGas: number;
  };
  readonly deployer: string | null;
  readonly foundationRecipient: string | null;
  readonly contracts: Readonly<Record<ContractName, Deployed>> | null;
  readonly deploymentGasTotal: string | null;
  /** The slot for the static peer table (Q-T-4). */
  readonly peers: readonly PeerEntry[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isBytes32 = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export type Verdict<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

const deployedProblems = (name: string, value: unknown): string[] => {
  if (!isRecord(value)) return [`contracts.${name} is missing`];
  return [
    ...(isAddress(value["address"]) ? [] : [`contracts.${name}.address is not an address`]),
    ...(isCount(value["deploymentBlock"]) ? [] : [`contracts.${name}.deploymentBlock is not a block number`]),
    ...(isBytes32(value["transactionHash"]) ? [] : [`contracts.${name}.transactionHash is not a hash`]),
    ...(typeof value["gasUsed"] === "string" && /^[0-9]+$/.test(value["gasUsed"]) ? [] : [`contracts.${name}.gasUsed is not a decimal string`]),
    ...(isBytes32(value["codeHash"]) ? [] : [`contracts.${name}.codeHash is not a hash`]),
  ];
};

/** Every way a manifest can be wrong, as a list (empty when it is well formed). A deployed manifest must carry the full set. */
export const manifestProblems = (value: unknown): string[] => {
  if (!isRecord(value)) return ["the manifest is not an object"];
  const token = value["token"], dispute = value["dispute"], gas = value["gas"], contracts = value["contracts"], peers = value["peers"];
  const deployed = value["status"] === "deployed";
  return [
    ...(value["manifestVersion"] === 1 ? [] : ["manifestVersion is not 1"]),
    ...(value["stack"] === "xln-contracts-v1" ? [] : ["stack is not xln-contracts-v1"]),
    ...(value["status"] === "prepared" || deployed ? [] : ["status is neither prepared nor deployed"]),
    ...(typeof value["network"] === "string" && value["network"] !== "" ? [] : ["network is missing"]),
    ...(isCount(value["chainId"]) && value["chainId"] > 0 ? [] : ["chainId is not a positive integer"]),
    ...(isRecord(token) && typeof token["symbol"] === "string" && isCount(token["decimals"]) && typeof token["deployFaucet"] === "boolean"
      && (token["address"] === null || isAddress(token["address"])) && (token["tokenId"] === null || isCount(token["tokenId"]))
      ? [] : ["token is malformed"]),
    ...(isRecord(token) && token["address"] === null && token["deployFaucet"] !== true && !deployed ? ["token has neither an address nor deployFaucet"] : []),
    ...(isRecord(dispute) && isCount(dispute["responseFloorSeconds"]) && isCount(dispute["mainnetResponseFloorSeconds"]) ? [] : ["dispute floors are malformed"]),
    ...(isRecord(gas) && isCount(gas["hankoPreludeGas"]) && isCount(gas["requiredTxGas"]) && isCount(gas["maxRequiredTxGas"]) ? [] : ["gas is malformed"]),
    ...(Array.isArray(peers) && peers.every((peer) => isRecord(peer) && isBytes32(peer["entityId"]) && typeof peer["endpoint"] === "string" && peer["endpoint"] !== "")
      ? [] : ["peers is not a list of { entityId, endpoint }"]),
    ...(deployed
      ? [
          ...(isAddress(value["deployer"]) ? [] : ["a deployed manifest names its deployer"]),
          ...(isAddress(value["foundationRecipient"]) ? [] : ["a deployed manifest names its foundationRecipient"]),
          ...(isRecord(token) && isAddress(token["address"]) && isCount(token["tokenId"]) ? [] : ["a deployed manifest names its token address and id"]),
          ...(typeof value["deploymentGasTotal"] === "string" ? [] : ["a deployed manifest has a deploymentGasTotal"]),
          ...CONTRACT_NAMES.flatMap((name) => deployedProblems(name, isRecord(contracts) ? contracts[name] : undefined)),
        ]
      : contracts === null ? [] : ["a prepared manifest has no contracts"]),
  ];
};

export const parseManifest = (value: unknown): Verdict<Manifest> => {
  const problems = manifestProblems(value);
  return problems.length === 0 ? { ok: true, value: value as Manifest } : { ok: false, problems };
};

/** A deployed manifest, or a thrown list of what is wrong with it. */
export const deployedManifest = (value: unknown): Manifest & { readonly contracts: Readonly<Record<ContractName, Deployed>> } => {
  const verdict = parseManifest(value);
  if (!verdict.ok) throw new Error(`manifest: ${verdict.problems.join("; ")}`);
  if (verdict.value.status !== "deployed" || verdict.value.contracts === null) throw new Error("manifest: not deployed");
  return verdict.value as Manifest & { readonly contracts: Readonly<Record<ContractName, Deployed>> };
};
