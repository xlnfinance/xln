// What the node tests share: two Entities with keys, a chain port that answers nothing and one that is slow, seats of
// listening ports and files, and a node over a seat. Only tests import this.
import { expect } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { verifyHankoSignature } from "../../../chain/hanko/hanko-verify.ts";
import { type EntityId, type EntityState, emptyEntity } from "../../../entity/model.ts";
import type { Check } from "../../../entity/signing/attest.ts";
import type { JAnswer } from "../../../j/batch/answer.ts";
import { err, ok, unwrapOr, type Result } from "../../../kernel/core/result.ts";
import { addressOf, signDigest } from "../../../kernel/crypto/signature.ts";
import { entityOf } from "../../../runtime/fixtures.ts";
import { setup as fixtureSetup, stamp } from "../../../runtime/fixtures.ts";
import { limits } from "../../host.ts";
import { DEPLOYED, GAS, TREASURY, WORLD } from "../fixtures.ts";
import { keyOf, MAX_LINE, type Key, type Peer } from "../link/link.ts";
import type { ChainPort, PortFault, RegistryRead } from "../submit/chain.ts";
import { lazySigner } from "../submit/signer.ts";
import type { WatchConfig } from "../watch/loop.ts";
import type { Disk } from "../disk/disk.ts";
import { type Config, type Daemon, type Look, startDaemon } from "./daemon.ts";
import { fileDisk } from "./file-disk.ts";
import { listenTcp, type Listener } from "./link/socket.ts";

export const ALICE = entityOf(1);
export const BOB = entityOf(2);
export const LOCAL = "127.0.0.1";

const keyFrom = (seed: number): Key =>
  unwrapOr(keyOf(Uint8Array.from({ length: 32 }, (_, i) => i + seed)), () => expect.unreachable("key"));

const KEYS = new Map([[ALICE, keyFrom(1)], [BOB, keyFrom(40)]]);
const keyOfEntity = (id: EntityId): Key => KEYS.get(id) ?? expect.unreachable("no key");

/**
 * Entities here are numbered, not lazy ids, so each one's board is taken as registered, and a signature is its peer's
 * when it speaks for the peer and the one signer it recovers to is the address of the key the peer holds
 * (R-SIGNED-HEADS-ON-THE-WIRE).
 */
const addressOfKey = (key: Key): string =>
  addressOf(signDigest(Uint8Array.from({ length: 32 }, () => 1), key.secret).publicKey).toLowerCase();

const bySigner: Check = (peer, head, sig) => {
  const verdict = verifyHankoSignature(sig, head, () => ok(true));
  return verdict.ok && verdict.value.entityId === peer && verdict.value.signers.length === 1
    && verdict.value.signers[0] === addressOfKey(keyOfEntity(peer));
};

/** The lag outlasts the depth the watch tests read at (2), as a node that reads the chain needs (clock_below_depth). */
const setup = {
  ...fixtureSetup, clock: { ...fixtureSetup.clock, lag: 3n, reserve: 3n, depth: 2n },
  anchor: { ...fixtureSetup.anchor, check: bySigner },
};

const NO_CHAIN: PortFault = { _tag: "port", call: "send", reason: "no chain in this test" };

const port: ChainPort = {
  nonce: () => Promise.resolve(ok(4n)),
  treasury: () => Promise.resolve(ok(new Map())),
  simulate: () => Promise.resolve(err(NO_CHAIN)),
  send: () => Promise.resolve(err(NO_CHAIN)),
  answer: () => Promise.resolve(err(NO_CHAIN)),
};

/** A chain that takes a batch and says nothing of it until it is asked a second time, as a chain does for a block. */
export const slowChain = (log: string): ChainPort => ({
  nonce: () => Promise.resolve(ok(4n)),
  treasury: () => Promise.resolve(ok(TREASURY)),
  simulate: () => Promise.resolve(ok({ _tag: "ok", applyGas: 100_000n })),
  send: () => Promise.resolve(ok(undefined)),
  answer: (batch) => {
    appendFileSync(log, "asked\n");
    const asked = readFileSync(log, "utf8").split("\n").length - 1;
    const landed: JAnswer = { _tag: "landed", nonce: batch.nonce, batchHash: batch.digest, skipped: [] };
    return Promise.resolve(ok(asked > 1 ? landed : undefined));
  },
});

export const until = async (check: () => Promise<boolean>, polls: number): Promise<boolean> => {
  if (await check()) return true;
  if (polls === 0) return false;
  return Bun.sleep(20).then(() => until(check, polls - 1));
};

export const must = <T, E>(r: Result<T, E>): T => (r.ok ? r.value : expect.unreachable(JSON.stringify(r.error)));

export type Seat = Readonly<{ entity: EntityId; dir: string; listener: Listener }>;

const peerOf = (seat: Seat): Peer =>
  ({ runtime: keyOfEntity(seat.entity).runtime, entities: [seat.entity], endpoint: `${LOCAL}:${seat.listener.port}` });

export const seatOf = async (entity: EntityId, dir: string, at: number): Promise<Seat> =>
  ({ entity, dir, listener: must(await listenTcp(LOCAL, at, MAX_LINE)) });

const nonce = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

const keep = (): boolean => false;

const NO_READ: RegistryRead | undefined = undefined;

export type Options = Readonly<{
  tickMs: number; lost?: Config["lost"]; chain?: ChainPort; wrap?: (wal: Disk) => Disk; watch?: WatchConfig;
  /** The Entity the node starts from, where a test wants one that holds more than the empty Entity. */
  genesis?: EntityState;
  /** The clock's lag, reserve and read depth in J heights, where a test wants others than the scene's. */
  lag?: bigint;
  reserve?: bigint;
  depth?: bigint;
  /** Whether the node decides on the registry's reading: it does when it may hold value, as such a node must. */
  registry?: boolean;
  /** The registry the node reads, where a test wants one that fails. */
  read?: RegistryRead;
}>;

/** A registry that shows no secret at any block. */
const SILENT: RegistryRead = () => Promise.resolve(ok(0n));

/** What a node for `seat` is started with, its files in the seat's directory. */
export const configOf = async (seat: Seat, other: Seat | undefined, options: Options): Promise<Config> => {
  const { tickMs, lost = keep, chain = port, wrap = (disk) => disk, watch, genesis } = options;
  const { lag = setup.clock.lag, reserve = setup.clock.reserve, depth = setup.clock.depth } = options;
  const { registry = watch?.value === true } = options;
  const wal = wrap(must(await fileDisk(`${seat.dir}/wal.log`)));
  const journal = must(await fileDisk(`${seat.dir}/journal.log`));
  const key = keyOfEntity(seat.entity);
  return {
    shell: {
      wal, io: { port: chain, signer: lazySigner(seat.entity, key), journal, gas: GAS },
      now: () => stamp(BigInt(Date.now())), registry: registry ? options.read ?? SILENT : NO_READ,
    },
    boot: {
      setup: { ...setup, registry, clock: { ...setup.clock, lag, reserve, depth } },
      genesis: genesis ?? emptyEntity(seat.entity),
      where: { entity: seat.entity, deployment: DEPLOYED, world: WORLD },
      limits: unwrapOr(limits(32, 8), () => expect.unreachable("limits")),
    },
    key, table: other === undefined ? [] : [peerOf(other)], tickMs, nonce, lost, watch,
  };
};

/** A node for `seat` that dials and answers `other` (if any), its files in the seat's directory. */
export const nodeOf = async (seat: Seat, other: Seat | undefined, options: Options): Promise<Daemon> =>
  must(await startDaemon(await configOf(seat, other, options), seat.listener));

export const fresh = (): string => mkdtempSync(`${tmpdir()}/daemon-`);

export const accountOf = (look: Look, self: EntityId, peer: EntityId) =>
  look.station.host.runtime.entities.get(self)?.accounts.get(peer);

const FIRST = 1;
export const SECOND = 2;

/** Both sides hold the Account at the same committed head, with no frame waiting. */
export const agree = async (a: Daemon, b: Daemon, used = FIRST): Promise<boolean> => {
  const [la, lb] = [accountOf(await a.look(), ALICE, BOB), accountOf(await b.look(), BOB, ALICE)];
  return la !== undefined && lb !== undefined && la.head === lb.head && la.pending === undefined
    && lb.pending === undefined && la.used >= used;
};

export const WAIT = 150;
export const QUICK = 40;
export const SLOW = 60_000;

export const connected = async (a: Daemon, b: Daemon): Promise<boolean> =>
  (await a.look()).linked.length === 1 && (await b.look()).linked.length === 1;

