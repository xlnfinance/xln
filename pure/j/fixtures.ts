// What the J tests share: the deployed Depository's ABI and lifecycle vectors turned into raw logs, a chain of blocks
// with hashes, and entity ids. Only tests import this.
import { readFileSync } from "node:fs";
import { Interface } from "ethers";
import { Depository__factory } from "../../contracts/typechain-types/factories/Depository.sol/Depository__factory.ts";
import { expect } from "bun:test";
import { unwrapOr, type Result } from "../kernel/core/result.ts";
import { address, bytes32, type Address, type Bytes32, type RawLog } from "./log.ts";
import type { Block } from "./watch.ts";

export const DEPOSITORY_ABI = new Interface(Depository__factory.abi);

/** Lowercase hex of a number, padded to `bytes` bytes. */
export const hexOf = (n: bigint, bytes = 32): string => `0x${n.toString(16).padStart(bytes * 2, "0")}`;

export const must = <T, E>(made: Result<T, E>): T =>
  unwrapOr(made, (fault) => expect.unreachable(`fixture: ${JSON.stringify(fault)}`));

export const entityOf = (n: bigint): Bytes32 => must(bytes32(hexOf(n)));

export const DEPOSITORY: Address = must(address(hexOf(0xde0n, 20)));

/** A block hash that names its height and the fork it is on, so two forks never share one. */
export const hashOf = (number: bigint, fork = 0n): Bytes32 => must(bytes32(hexOf(number + (fork << 128n))));

export const blockOf = (number: bigint, fork = 0n): Block =>
  ({ number, hash: hashOf(number, fork), parent: hashOf(number > 0n ? number - 1n : 0n, fork) });

/** The blocks `from + 1` to `to`, each on its parent, on one fork; the first's parent is block `from` of that fork. */
export const blocksBetween = (from: bigint, to: bigint, fork = 0n): readonly Block[] =>
  Array.from({ length: Number(to - from) }, (_, i) => blockOf(from + 1n + BigInt(i), fork));

type Values = Readonly<Record<string, unknown>>;

/** A log the Depository would emit: `event` with its arguments by name, at `block` and `index`, on `fork`. */
export const logOf = (event: string, args: Values, block: bigint, index: bigint, fork = 0n): RawLog => {
  const fragment = DEPOSITORY_ABI.getEvent(event) ?? expect.unreachable(`the Depository has no event ${event}`);
  const { data, topics } = DEPOSITORY_ABI.encodeEventLog(fragment, fragment.inputs.map((input) => args[input.name]));
  return {
    address: DEPOSITORY, block, index, blockHash: hashOf(block, fork), data: data.toLowerCase(),
    topics: topics.map((topic) => must(bytes32(topic.toLowerCase()))),
  };
};

type Phase = Readonly<{ events: readonly { name: string; args: Values; logIndex: number }[] }>;

const hasEvents = (value: unknown): value is Phase =>
  typeof value === "object" && value !== null && "events" in value && Array.isArray(value.events);

/**
 * The real Depository's lifecycle (contracts/vectors/lifecycle.json): one account through a deposit, a settlement, a
 * dispute and its end, as the events each batch emitted, in order.
 */
const LIFECYCLE = new URL("../../contracts/vectors/lifecycle.json", import.meta.url);

export const lifecyclePhases: Readonly<Record<string, Phase>> = Object.fromEntries(
  Object.entries<unknown>(JSON.parse(readFileSync(LIFECYCLE, "utf8")))
    .filter((entry): entry is [string, Phase] => hasEvents(entry[1])),
);
