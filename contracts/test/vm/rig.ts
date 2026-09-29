// BrowserVM rig for the forked contracts (contracts/typechain-types).
//
// og's BrowserVM deploys whatever bytecode og's typechain factories carry. This rig replaces those factories' bytecode
// and ABI with the fork's, then boots the same real stack (Depository, Account library, EntityProvider, DeltaTransformer)
// through og's own createJAdapter. core/ and jurisdictions/ are not edited: the patch lives here.
//
// Signing follows the fork's ABI, so one test file can be run before a fix (red) and after it (green):
//   features.epoch        the dispute-proof and cooperative-update payloads bind the Account's ondelta epoch (C1)
//   features.batchEntity  processBatch takes the acting entity and the batch payload binds it (C2)
//
// Run one test file per process: `bun test contracts/test/vm/<file>.test.ts`.
import { ethers } from "ethers";
import {
  Account__factory as ogAccount,
  Depository__factory as ogDepository,
  EntityProvider__factory as ogEntityProvider,
  HankoVerifier__factory as ogHankoVerifier,
  DeltaTransformer__factory as ogDeltaTransformer,
} from "../../../jurisdictions/typechain-types/index.ts";
import {
  Account__factory as forkAccount,
  Depository__factory as forkDepository,
  EntityProvider__factory as forkEntityProvider,
  HankoVerifier__factory as forkHankoVerifier,
  DeltaTransformer__factory as forkDeltaTransformer,
} from "../../typechain-types/index.ts";
import { createJAdapter } from "../../../core/jurisdiction/adapter/index.ts";
import type { JAdapter } from "../../../core/jurisdiction/adapter/types.ts";
import { encodeJBatch, createEmptyBatch } from "../../../core/jurisdiction/machine/batch/index.ts";
import { PROOF_BODY_ABI } from "../../../core/protocol/dispute/proof-body.ts";
import { encodeInt512, SIGNED_AMOUNT_ABI_COMPONENTS } from "../../../core/protocol/crypto/abi-money.ts";
import { encodeCooperativeUpdateDiff, type CooperativeUpdateDiff } from "../../../core/hanko/onchain-domain.ts";

process.env["SECP256K1_PREBUILD"] = process.env["SECP256K1_PREBUILD"] ?? "/nonexistent";

const coder = ethers.AbiCoder.defaultAbiCoder();

/** Point og's factories at the fork. Static bytecode/abi feed BrowserVM.init; linkBytecode feeds its library linking. */
const useFork = (): void => {
  const pairs = [
    [ogAccount, forkAccount], [ogDepository, forkDepository], [ogEntityProvider, forkEntityProvider],
    [ogHankoVerifier, forkHankoVerifier], [ogDeltaTransformer, forkDeltaTransformer],
  ] as const;
  pairs.forEach(([og, fork]) => {
    const target = og as unknown as Record<string, unknown>;
    const source = fork as unknown as Record<string, unknown>;
    target["bytecode"] = source["bytecode"];
    target["abi"] = source["abi"];
    if (typeof source["linkBytecode"] === "function") target["linkBytecode"] = source["linkBytecode"];
  });
};

/** Dispute-proof and settlement payloads (HankoEncoding.sol), in the shape the fork's ABI implies. */
export type Features = { readonly epoch: boolean; readonly batchEntity: boolean };

const featuresOf = (): Features => {
  const iface = forkDepository.createInterface();
  const processBatch = iface.getFunction("processBatch");
  return {
    epoch: iface.getFunction("ondeltaEpoch") !== null,
    batchEntity: processBatch !== null && processBatch.inputs.length === 4,
  };
};

const COOPERATIVE_UPDATE_DIFF_PARAM = ethers.ParamType.from({
  type: "tuple[]",
  components: [
    { name: "tokenId", type: "uint256" },
    ...["leftDiff", "rightDiff", "collateralDiff", "ondeltaDiff"].map((name) => ({ name, type: "tuple", components: SIGNED_AMOUNT_ABI_COMPONENTS })),
  ],
});

export const COOPERATIVE_UPDATE_DIFF_PARAM_FOR_TEST = COOPERATIVE_UPDATE_DIFF_PARAM;

const BOARD_ABI = ["tuple(uint16 votingThreshold, bytes32[] entityIds, uint16[] votingPowers, uint32 boardChangeDelay, uint32 controlChangeDelay, uint32 dividendChangeDelay)"];
export const lazyId = (address: string): string =>
  ethers.keccak256(coder.encode(BOARD_ABI, [[1, [ethers.zeroPadValue(address, 32)], [1], 0, 0, 0]]));
export const rawHanko = (hash: string, key: string): string => new ethers.SigningKey(key).sign(ethers.getBytes(hash)).serialized;

export type Party = { readonly key: string; readonly address: string; readonly id: string };
export const party = (seed: string): Party => {
  const key = ethers.keccak256(ethers.toUtf8Bytes(seed));
  const address = new ethers.Wallet(key).address;
  return { key, address, id: lazyId(address) };
};

export type Body = {
  readonly watchSeed: string;
  readonly leftResponseSeconds: number;
  readonly rightResponseSeconds: number;
  readonly offdeltas: readonly bigint[];
  readonly tokenIds: readonly number[];
  readonly transformers?: readonly unknown[];
};
export const bodyStruct = (b: Body) => ({ ...b, offdeltas: b.offdeltas.map(encodeInt512), transformers: b.transformers ?? [] });
export const bodyHash = (b: Body): string => ethers.keccak256(coder.encode([ethers.ParamType.from(PROOF_BODY_ABI)], [bodyStruct(b)]));

const HANKO_ABI = ["tuple(bytes32[],bytes,tuple(bytes32,uint256[],uint256[],uint256,uint32,uint32,uint32)[],bytes[])"];
/** Wrap one raw 65-byte signature as a claims hanko that names `entityId`, whose board is the signer's 1-of-1 board. */
export const claimsHanko = (rawSignature: string, entityId: string): string => {
  const sig = ethers.Signature.from(rawSignature);
  const vBits = new Uint8Array([sig.v === 28 ? 1 : 0]);
  return coder.encode(HANKO_ABI, [[[], ethers.concat([sig.r, sig.s, ethers.hexlify(vBits)]), [[entityId, [0], [1], 1, 0, 0, 0]], []]]);
};
/** The board encoding EntityProvider registers a numbered entity with, for a 1-of-1 board of `address`. */
export const singleSignerBoard = (address: string): string =>
  coder.encode(BOARD_ABI, [[1, [ethers.zeroPadValue(address, 32)], [1], 0, 0, 0]]);

export type Domain = { readonly chainId: bigint; readonly depository: string };

export const acctKeyOf = (a: string, b: string): string =>
  BigInt(a) < BigInt(b) ? ethers.solidityPacked(["bytes32", "bytes32"], [a, b]) : ethers.solidityPacked(["bytes32", "bytes32"], [b, a]);

export type Rig = Awaited<ReturnType<typeof boot>>;

export const boot = async (label: string, chainId = 31337) => {
  useFork();
  const features = featuresOf();
  const chain: JAdapter = await createJAdapter({ mode: "browservm", chainId } as never);
  await chain.deployStack();
  chain.setQuietLogs?.(true);
  const vm = chain.getBrowserVM()! as any;
  const domain: Domain = { chainId: BigInt(chain.chainId), depository: chain.addresses.depository };
  const depositoryIface = forkDepository.createInterface();
  const TOKEN = 1;
  const at = (seconds: number): void => { vm.setBlockTimestamp(1_800_000_000_000 + seconds * 1000); };
  at(0);

  // ---- payloads, mirroring HankoEncoding.sol (the fork's own library) ----
  const batchHash = (entity: string, encodedBatch: string, nonce: bigint): string => ethers.keccak256(
    features.batchEntity
      ? ethers.solidityPacked(["bytes32", "uint256", "address", "bytes32", "bytes", "uint256"],
          [ethers.id("XLN_DEPOSITORY_HANKO_V2"), domain.chainId, domain.depository, entity, encodedBatch, nonce])
      : ethers.solidityPacked(["bytes32", "uint256", "address", "bytes", "uint256"],
          [ethers.id("XLN_DEPOSITORY_HANKO_V1"), domain.chainId, domain.depository, encodedBatch, nonce]));

  const epochOf = async (a: string, b: string): Promise<bigint> => {
    if (!features.epoch) return 0n;
    const data = depositoryIface.encodeFunctionData("ondeltaEpoch", [a, b]);
    const result = await vm.runReadOnlyCall({ to: vm.depositoryAddress, caller: vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 500_000n });
    return BigInt(depositoryIface.decodeFunctionResult("ondeltaEpoch", result.execResult.returnValue)[0]);
  };

  // ---- submission ----
  /** Events decoded from the last accepted transaction (name and args, as og's J watcher sees them). */
  const last: { events: readonly unknown[]; batch: { entityId: string; encodedBatch: string; nonce: bigint; hash: string } | null } = { events: [], batch: null };
  /** Send `encodedBatch` with `hanko` as `entity` through the fork's own ABI. */
  const sendRaw = async (entity: string, encodedBatch: string, hanko: string, nonce: bigint): Promise<string> => {
    const data = features.batchEntity
      ? depositoryIface.encodeFunctionData("processBatch", [entity, encodedBatch, hanko, nonce])
      : depositoryIface.encodeFunctionData("processBatch", [encodedBatch, hanko, nonce]);
    try {
      const done = await vm.executeTx({ to: domain.depository, data, gasLimit: 15_000_000n }, undefined, { emitEvents: true });
      last.events = done.events ?? [];
      return "ok";
    } catch {
      return `REVERT ${await revertName(data)}`;
    }
  };

  /** Replay a failed call read-only to name its custom error (executeTx keeps only "revert"). */
  const revertName = async (data: string): Promise<string> => {
    // A read-only call runs in the EVM's default block; the reason must be replayed at the test clock, or every
    // timing guard (dispute windows, reveal deadlines) reads the wrong time and names the wrong error.
    const block = vm.createBlock(vm.getBlockTimestamp());
    const result = await vm.runReadOnlyCall({ to: vm.depositoryAddress, caller: vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 15_000_000n, block });
    const returned = ethers.hexlify(result.execResult.returnValue ?? new Uint8Array());
    const parsed = returned === "0x" ? null : depositoryIface.parseError(returned) ?? forkAccount.createInterface().parseError(returned) ?? forkDeltaTransformer.createInterface().parseError(returned);
    return parsed ? `${parsed.name}(${parsed.args.join(",")})` : returned;
  };

  /** The entity's own batch: signed by `who`, nonce = its next entity nonce. */
  const submit = async (who: Party, patch: Record<string, unknown>): Promise<string> => {
    const encoded = encodeJBatch({ ...createEmptyBatch(), ...patch } as never);
    const nonce = (await chain.getEntityNonce(who.id)) + 1n;
    const hash = batchHash(who.id, encoded, nonce);
    last.batch = { entityId: who.id, encodedBatch: encoded, nonce, hash };
    return sendRaw(who.id, encoded, rawHanko(hash, who.key), nonce);
  };

  const start = (who: Party, other: Party, nonce: number, proposerIsLeft: boolean, b: Body, sig: string) =>
    submit(who, { disputeStarts: [{
      counterentity: other.id, nonce, proposerIsLeft, proofbodyHash: bodyHash(b), initialProofbody: bodyStruct(b),
      watchSeed: b.watchSeed, sig, starterInitialArguments: "0x", starterCounterArguments: "0x",
      starterCounterProofCommitment: ethers.ZeroHash,
    }] });
  const finalize = (who: Party, other: Party, init: { nonce: number; body: Body; startedByLeft: boolean }, fin: { nonce: number; proposerIsLeft: boolean; body: Body; sig: string },
    args: { readonly starter?: string; readonly other?: string } = {}) =>
    submit(who, { disputeFinalizations: [{
      counterentity: other.id, initialNonce: init.nonce, finalNonce: fin.nonce, proposerIsLeft: fin.proposerIsLeft,
      initialProofbodyHash: bodyHash(init.body), finalProofbody: bodyStruct(fin.body), starterArguments: args.starter ?? "0x",
      otherArguments: args.other ?? "0x", sig: fin.sig, startedByLeft: init.startedByLeft, cooperative: false,
    }] });
  const settle = (who: Party, other: Party, nonce: number, diffs: readonly CooperativeUpdateDiff[], sig: string) =>
    submit(who, { settlements: [{
      leftEntity: BigInt(who.id) < BigInt(other.id) ? who.id : other.id,
      rightEntity: BigInt(who.id) < BigInt(other.id) ? other.id : who.id,
      diffs, forgiveDebtsInTokenIds: [], sig, nonce,
    }] });

  /** Everything that belongs to one Account: the two parties, their key, payloads, signatures, balances, funding. */
  const accountOf = (a: Party, b: Party, seed: string) => {
    const [L, R] = BigInt(a.id) < BigInt(b.id) ? [a, b] : [b, a];
    const acctKey = acctKeyOf(L.id, R.id);
    const currentEpoch = (): Promise<bigint> => epochOf(L.id, R.id);
    const proofHash = (epoch: bigint, nonce: number, proposerIsLeft: boolean, b: Body): string => ethers.keccak256(
      features.epoch
        ? coder.encode(["uint256", "uint256", "address", "bytes", "uint256", "uint256", "bool", "bytes32", "bytes32"],
            [1, domain.chainId, domain.depository, acctKey, epoch, nonce, proposerIsLeft, bodyHash(b), b.watchSeed])
        : coder.encode(["uint256", "uint256", "address", "bytes", "uint256", "bool", "bytes32", "bytes32"],
            [1, domain.chainId, domain.depository, acctKey, nonce, proposerIsLeft, bodyHash(b), b.watchSeed]));

    const coopHash = (epoch: bigint, nonce: number, diffs: readonly CooperativeUpdateDiff[], forgive: readonly number[] = []): string => ethers.keccak256(
      features.epoch
        ? coder.encode(["uint256", "uint256", "address", "bytes", "uint256", "uint256", COOPERATIVE_UPDATE_DIFF_PARAM, "uint256[]"],
            [0, domain.chainId, domain.depository, acctKey, epoch, nonce, diffs.map(encodeCooperativeUpdateDiff), forgive])
        : coder.encode(["uint256", "uint256", "address", "bytes", "uint256", COOPERATIVE_UPDATE_DIFF_PARAM, "uint256[]"],
            [0, domain.chainId, domain.depository, acctKey, nonce, diffs.map(encodeCooperativeUpdateDiff), forgive]));

    const proofSig = (signer: Party, epoch: bigint, nonce: number, proposerIsLeft: boolean, b: Body): string =>
      rawHanko(proofHash(epoch, nonce, proposerIsLeft, b), signer.key);
    const coopSig = (signer: Party, epoch: bigint, nonce: number, diffs: readonly CooperativeUpdateDiff[], forgive: readonly number[] = []): string =>
      rawHanko(coopHash(epoch, nonce, diffs, forgive), signer.key);

    const reserves = async () => ({
      L: await chain.getReserves(L.id, TOKEN), R: await chain.getReserves(R.id, TOKEN),
      collateral: await chain.getCollateral(L.id, R.id, TOKEN),
      nonce: (await chain.getAccountInfo(L.id, R.id)).nonce,
    });
    const body = (offdelta: bigint, windows = 60, rightWindows = windows): Body => ({
      watchSeed: ethers.id(`${seed}-seed`), leftResponseSeconds: windows, rightResponseSeconds: rightWindows,
      offdeltas: [offdelta], tokenIds: [TOKEN],
    });
    /** Both parties funded, Left's 100 in collateral (ondelta 100). */
    const fundedAccount = async (): Promise<void> => {
      await chain.debugFundReserves(L.id, TOKEN, 1000n);
      await chain.debugFundReserves(R.id, TOKEN, 1000n);
      const opened = await submit(L, { reserveToCollateral: [{ tokenId: TOKEN, receivingEntity: L.id, pairs: [{ entity: R.id, amount: 100n }] }] });
      if (opened !== "ok") throw new Error(`fundedAccount: ${opened}`);
    };

    return { L, R, acctKey, epochOf: currentEpoch, proofHash, coopHash, proofSig, coopSig, reserves, body, fundedAccount };
  };
  const pair = accountOf(party(`${label}-a`), party(`${label}-b`), label);

  return {
    chain, vm, domain, features, last, TOKEN, at, batchHash, sendRaw, submit, start, finalize, settle,
    accountOf, ...pair, encodeJBatch, createEmptyBatch,
  };
};
