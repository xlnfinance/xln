#!/usr/bin/env bun
/**
 * XLN CLI - Minimal REPL for testing J-Machine operations
 *
 * Usage:
 *   bun runtime/cli.ts                    # local anvil
 *   bun runtime/cli.ts remote             # xln.finance/rpc
 */

import * as readline from 'readline';
import type { JAdapter } from './jadapter';
import { createXlnJsonRpcProvider } from './jadapter';
import { ethers } from 'ethers';
import { createProviderScopedEntityId, normalizeEntityId } from './entity-id-utils';
import { createEmptyBatch, batchAddReserveToReserve, encodeJBatch } from './jurisdiction/batch';
import { loadCliJurisdiction, type CliJurisdiction } from './jurisdiction/cli-jurisdiction';

const REMOTE_RPC = process.env['XLN_CLI_REMOTE_RPC'] || 'https://xln.finance/rpc';
const LOCAL_RPC = process.env['XLN_CLI_LOCAL_RPC'] || 'http://localhost:8545';
const DEFAULT_DEV_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

type CliJAdapter = JAdapter & {
  reserveToReserve(
    from: string,
    to: string,
    tokenId: number,
    amount: bigint,
    options: { entityProvider?: string; hankoData: string; nonce: bigint },
  ): Promise<unknown[]>;
};

let jAdapter: CliJAdapter;
let activeJurisdiction: CliJurisdiction;

async function init(remote: boolean) {
  const requestedRpcUrl = remote ? REMOTE_RPC : LOCAL_RPC;
  activeJurisdiction = await loadCliJurisdiction({
    rpcUrl: requestedRpcUrl,
    remote,
    jurisdictionKey: process.env['XLN_CLI_JURISDICTION'],
    jurisdictionsUrl: process.env['XLN_CLI_JURISDICTIONS_URL'],
  });
  const rpcUrl = activeJurisdiction.rpcUrl;
  console.log(`Connecting to ${rpcUrl} (${activeJurisdiction.key})...`);

  // Create provider and signer directly for connecting to existing contracts
  const provider = createXlnJsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(
    process.env['XLN_CLI_PRIVATE_KEY'] || DEFAULT_DEV_PRIVATE_KEY,
    provider
  );

  // Connect to existing contracts
  const { Depository__factory, EntityProvider__factory } = await import('../jurisdictions/typechain-types/index.ts');

  type DepositoryRunner = Parameters<typeof Depository__factory.connect>[1];
  const contractRunner = signer as unknown as DepositoryRunner;
  const depository = Depository__factory.connect(activeJurisdiction.contracts.depository, contractRunner);
  const entityProvider = EntityProvider__factory.connect(activeJurisdiction.contracts.entityProvider, contractRunner);

  // Create minimal adapter object for queries
  jAdapter = {
    mode: 'rpc',
    chainId: activeJurisdiction.chainId,
    provider,
    signer,
    depository,
    entityProvider,
    addresses: activeJurisdiction.contracts,
    async getReserves(entityId: string, tokenId: number) {
      const entityAddress = createProviderScopedEntityId(activeJurisdiction.contracts.entityProvider, normalizeEntityId(entityId));
      return depository._reserves(entityAddress, tokenId);
    },
    async getEntityNonce(entityId: string) {
      const entityAddress = createProviderScopedEntityId(activeJurisdiction.contracts.entityProvider, normalizeEntityId(entityId));
      return depository.entityNonces(entityAddress);
    },
    async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint, options?: { entityProvider?: string; hankoData?: string; nonce?: bigint }) {
      if (!options?.hankoData || options.nonce === undefined) {
        throw new Error('reserveToReserve requires hankoData and nonce');
      }
      const providerAddr = options.entityProvider || activeJurisdiction.contracts.entityProvider;
      const fromAddr = createProviderScopedEntityId(providerAddr, normalizeEntityId(from));
      const toAddr = createProviderScopedEntityId(providerAddr, normalizeEntityId(to));
      console.log(`Submitting reserveToReserve from ${fromAddr} to ${toAddr}`);
      const batch = createEmptyBatch();
      batchAddReserveToReserve(
        { batch, jurisdiction: null, lastBroadcast: 0, broadcastCount: 0, failedAttempts: 0, status: 'empty' },
        toAddr,
        tokenId,
        amount,
      );
      const encodedBatch = encodeJBatch(batch);
      const tx = await depository.processBatch(encodedBatch, options.hankoData, options.nonce);
      await tx.wait();
      return [];
    },
  } as unknown as CliJAdapter;

  const block = await provider.getBlockNumber();
  console.log(`Connected. Block: ${block}`);
  console.log(`Jurisdiction: ${activeJurisdiction.name} (${activeJurisdiction.key})`);
  console.log(`Depository: ${activeJurisdiction.contracts.depository}`);
}

async function cmd(line: string) {
  const [command, ...args] = line.trim().split(/\s+/);

  switch (command) {
    case 'help':
      console.log(`
Commands:
  status                     - Show connection info
  reserves <entityId>        - Get reserves for entity
  r2r <from> <to> <amount> <nonce> <hankoData> [provider]   - Reserve to reserve transfer (Hanko)
  nonce <entityId>           - Get entity nonce
  help                       - Show this help
  exit                       - Exit CLI
`);
      break;

    case 'status':
      const block = await jAdapter.provider.getBlockNumber();
      console.log(`Block: ${block}`);
      console.log(`ChainId: ${jAdapter.chainId}`);
      console.log(`Jurisdiction: ${activeJurisdiction.name} (${activeJurisdiction.key})`);
      console.log(`Depository: ${jAdapter.addresses.depository}`);
      break;

    case 'reserves': {
      if (!args[0]) { console.log('Usage: reserves <entityId>'); break; }
      const entityId = args[0].startsWith('0x') ? args[0] : '0x' + args[0].padStart(64, '0');
      const reserves = await jAdapter.getReserves(entityId, 1); // tokenId 1 = USDC
      console.log(`Reserves: ${ethers.formatUnits(reserves, 18)} USDC`);
      break;
    }

    case 'r2r': {
      if (args.length < 5) { console.log('Usage: r2r <from> <to> <amount> <nonce> <hankoData> [provider]'); break; }
      const [from, to, amountStr, nonceStr, hankoData, providerAddr] = args;
      const fromId = from!.startsWith('0x') ? from! : '0x' + from!.padStart(64, '0');
      const toId = to!.startsWith('0x') ? to! : '0x' + to!.padStart(64, '0');
      const amount = ethers.parseUnits(amountStr!, 18);
      const nonce = BigInt(nonceStr!);
      const provider = providerAddr || activeJurisdiction.contracts.entityProvider;
      console.log(`R2R: ${fromId.slice(0,10)}... -> ${toId.slice(0,10)}... : ${amountStr} USDC`);
      const events = await jAdapter.reserveToReserve(fromId, toId, 1, amount, { entityProvider: provider, hankoData: hankoData!, nonce });
      console.log(`Done. Events: ${events.length}`);
      break;
    }

    case 'nonce': {
      if (!args[0]) { console.log('Usage: nonce <entityId>'); break; }
      const eid = args[0].startsWith('0x') ? args[0] : '0x' + args[0].padStart(64, '0');
      const nonce = await jAdapter.getEntityNonce(eid);
      console.log(`Nonce: ${nonce}`);
      break;
    }


    case 'exit':
    case 'quit':
      process.exit(0);

    default:
      if (command) console.log(`Unknown command: ${command}. Type 'help' for commands.`);
  }
}

async function main() {
  const remote = process.argv[2] === 'remote';
  await init(remote);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'xln> ',
  });

  rl.prompt();
  rl.on('line', async (line) => {
    try {
      await cmd(line);
    } catch (e: unknown) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    rl.prompt();
  });
}

if (import.meta.main) {
  main().catch(console.error);
}
