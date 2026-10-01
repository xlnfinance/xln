// One party's seat on the rewrite's own shell (pure/host/shell): its Host core, a WAL and a journal that are real files,
// its key, and a chain port to the node over JSON-RPC. The harness only tells the seat what the party commands and
// reads what the chain holds afterwards: the Host, the disk, the signing and the sending are the rewrite's.
import { mkdirSync } from "node:fs";
import { emptyEntity, type Command, type EntityId } from "../../pure/entity/model.ts";
import { limits } from "../../pure/host/host.ts";
import { command, pump, start, type Boot, type Shell, type Station, type Turn } from "../../pure/host/shell/drive/drive.ts";
import { chainPort } from "../../pure/host/shell/evm/port.ts";
import { keyOf } from "../../pure/host/shell/link/link.ts";
import { fileDisk } from "../../pure/host/shell/node/file-disk.ts";
import { httpRpc } from "../../pure/host/shell/node/rpc.ts";
import { lazySigner } from "../../pure/host/shell/submit/signer.ts";
import { hexToBytes } from "../../pure/kernel/encoding/bytes.ts";
import type { Setup } from "../../pure/runtime/model.ts";
import { timestamp } from "../../pure/runtime/model.ts";
import { GAS, must, worldOf, type Chain, type Party } from "./chain.ts";

const SETTLE_POLLS = 40;
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Seat {
  private constructor(
    readonly party: Party, readonly entity: EntityId, readonly dir: string, private readonly shell: Shell,
    private station: Station,
  ) {}

  /** A seat over `dir`: the WAL and the journal are `wal.log` and `journal.log` there, read back if they are not empty. */
  static async open(chain: Chain, party: Party, entity: EntityId, setup: Setup, dir: string): Promise<Seat> {
    mkdirSync(dir, { recursive: true });
    const wal = must(await fileDisk(`${dir}/wal.log`), `${party.name}'s WAL`);
    const journal = must(await fileDisk(`${dir}/journal.log`), `${party.name}'s journal`);
    const key = must(keyOf(must(hexToBytes(party.key), "key bytes")), `${party.name}'s key`);
    const port = chainPort(httpRpc(chain.rpc), {
      depository: chain.manifest.contracts.depository.address, entity, chainId: chain.chainId, key,
      tokens: [chain.tokenId], from: BigInt(await chain.provider.getBlockNumber()),
    });
    const shell: Shell = {
      wal, io: { port, signer: lazySigner(entity, key), journal, gas: GAS },
      now: () => must(timestamp(BigInt(Date.now())), "stamp"),
    };
    const boot: Boot = { setup, genesis: emptyEntity(entity), limits: must(limits(32, 8), "limits"), where: { entity, deployment: chain.dep, world: worldOf(chain) } };
    const started = must(await start(shell, boot), `${party.name}'s start`);
    return new Seat(party, entity, dir, shell, started.station);
  }

  /** What the party commands: the Host takes it, makes its row durable, asks the chain, and the batch is sent and read back. */
  async tell(input: Command): Promise<Turn> {
    const asked = must(await command(this.shell, this.station, this.entity, input), `${this.party.name}'s command`);
    return this.settled(asked, SETTLE_POLLS);
  }

  private async settled(turn: Turn, polls: number): Promise<Turn> {
    const pumped = must(await pump(this.shell, turn), `${this.party.name}'s submit path`);
    this.station = pumped.station;
    if (pumped.station.submitter.jbatch.phase._tag !== "inflight") return pumped;
    if (polls === 0) throw new Error(`${this.party.name}: the batch was sent and the chain said nothing about it in ${SETTLE_POLLS * POLL_MS} ms`);
    await sleep(POLL_MS);
    return this.settled(pumped, polls - 1);
  }

  async close(): Promise<void> {
    must(await this.shell.wal.close(), "close WAL");
    must(await this.shell.io.journal.close(), "close journal");
  }
}
