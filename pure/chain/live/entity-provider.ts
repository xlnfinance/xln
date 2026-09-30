// Asks the deployed EntityProvider (the fork's bytecode, in BrowserVM) what it makes of a list of Hankos.
//
// Run as its own process: booting the contracts rig patches the typechain factories for the life of the process. It
// reads a JSON list of {hanko, digest} from stdin, writes {entityId, success} per case to stdout.
import { createAddressFromString } from "@ethereumjs/util";
import { ethers } from "ethers";
import { EntityProvider__factory } from "../../../contracts/typechain-types/index.ts";
import { boot } from "../../../contracts/test/vm/rig.ts";

type Case = { readonly hanko: string; readonly digest: string };
type Verdict = { readonly entityId: string; readonly success: boolean };

const provider = EntityProvider__factory.createInterface();
const rig = await boot("pure-hanko-live");
const { vm } = rig;
const entityProvider = createAddressFromString(rig.chain.addresses.entityProvider);

const ask = async ({ hanko, digest }: Case): Promise<Verdict> => {
  const data = provider.encodeFunctionData("verifyHankoSignature", [hanko, digest]);
  const result = await vm.runReadOnlyCall({
    to: entityProvider, caller: vm.deployerAddress, data: ethers.getBytes(data), gasLimit: 50_000_000n,
  });
  if (result.execResult.exceptionError) return { entityId: ethers.ZeroHash, success: false };
  const returned = ethers.hexlify(result.execResult.returnValue);
  const [entityId, success] = provider.decodeFunctionResult("verifyHankoSignature", returned);
  return { entityId, success };
};

const cases: readonly Case[] = JSON.parse(await Bun.stdin.text());
const verdicts = await cases.reduce<Promise<readonly Verdict[]>>(
  async (done, c) => [...(await done), await ask(c)], Promise.resolve([]));
// Awaited: exiting right after a large unflushed write truncates the list (16,000 cases cut it short).
await Bun.write(Bun.stdout, `\n@@VERDICTS@@${JSON.stringify(verdicts)}\n`);
process.exit(0);
