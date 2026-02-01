#!/usr/bin/env bun
/**
 * XLN CLI - Minimal REPL for testing J-Machine operations
 *
 * Usage:
 *   bun runtime/cli.ts                    # local anvil
 *   bun runtime/cli.ts remote             # xln.finance/rpc/arrakis
 */

import * as readline from 'readline';
import { createJAdapter, type JAdapter } from './jadapter';
import { ethers } from 'ethers';
import { createProviderScopedEntityId, normalizeEntityId } from './entity-id-utils';

const REMOTE_RPC = 'https://xln.finance/rpc/arrakis';
const LOCAL_RPC = 'http://127.0.0.1:8545';
const CHAIN_ID = 1337;

// Contract addresses from jurisdictions.json (deployed 2025-01-29)
const CONTRACTS = {
  account: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
  entityProvider: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
  depository: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  deltaTransformer: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
};

let jAdapter: JAdapter;

async function init(remote: boolean) {
  const rpcUrl = remote ? REMOTE_RPC : LOCAL_RPC;
  console.log(`Connecting to ${rpcUrl}...`);

  // Create provider and signer directly for connecting to existing contracts
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // default anvil key
    provider
  );

  // Connect to existing contracts
  const { Depository__factory, EntityProvider__factory, Account__factory } = await import('../jurisdictions/typechain-types');

  const depository = Depository__factory.connect(CONTRACTS.depository, signer);
  const entityProvider = EntityProvider__factory.connect(CONTRACTS.entityProvider, signer);

  // Create minimal adapter object for queries
  jAdapter = {
    mode: 'rpc',
    chainId: CHAIN_ID,
    provider,
    signer,
    depository,
    entityProvider,
    addresses: CONTRACTS,
    async getReserves(entityId: string, tokenId: number) {
      const entityAddress = createProviderScopedEntityId(CONTRACTS.entityProvider, normalizeEntityId(entityId));
      return depository._reserves(entityAddress, tokenId);
    },
    async getEntityNonce(entityId: string) {
      const entityAddress = createProviderScopedEntityId(CONTRACTS.entityProvider, normalizeEntityId(entityId));
      return depository.entityNonces(entityAddress);
    },
    async reserveToReserve(from: string, to: string, tokenId: number, amount: bigint, options?: { entityProvider?: string; hankoData?: string; nonce?: bigint }) {
      if (!options?.hankoData || options.nonce === undefined) {
        throw new Error('reserveToReserve requires hankoData and nonce');
      }
      const providerAddr = options.entityProvider || CONTRACTS.entityProvider;
      const fromAddr = createProviderScopedEntityId(providerAddr, normalizeEntityId(from));
      const toAddr = createProviderScopedEntityId(providerAddr, normalizeEntityId(to));
      const tx = await depository.reserveToReserve(fromAddr, toAddr, tokenId, amount, providerAddr, options.hankoData, options.nonce);
      await tx.wait();
      return [];
    },
    async registerNumberedEntity(boardHash: string) {
      const tx = await entityProvider.registerNumberedEntity(boardHash);
      const receipt = await tx.wait();
      return { entityNumber: 0, txHash: receipt?.hash || '' };
    },
  } as any;

  const block = await provider.getBlockNumber();
  console.log(`Connected. Block: ${block}`);
  console.log(`Depository: ${CONTRACTS.depository}`);
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
  register <name>            - Register new entity
  nonce <entityId>           - Get entity nonce
  help                       - Show this help
  exit                       - Exit CLI
`);
      break;

    case 'status':
      const block = await jAdapter.provider.getBlockNumber();
      console.log(`Block: ${block}`);
      console.log(`ChainId: ${jAdapter.chainId}`);
      console.log(`Depository: ${jAdapter.addresses.depository || CONTRACTS.depository}`);
      break;

    case 'reserves':
      if (!args[0]) { console.log('Usage: reserves <entityId>'); break; }
      const entityId = args[0].startsWith('0x') ? args[0] : '0x' + args[0].padStart(64, '0');
      const reserves = await jAdapter.getReserves(entityId, 1); // tokenId 1 = USDC
      console.log(`Reserves: ${ethers.formatUnits(reserves, 18)} USDC`);
      break;

    case 'r2r':
      if (args.length < 5) { console.log('Usage: r2r <from> <to> <amount> <nonce> <hankoData> [provider]'); break; }
      const [from, to, amountStr, nonceStr, hankoData, providerAddr] = args;
      const fromId = from!.startsWith('0x') ? from! : '0x' + from!.padStart(64, '0');
      const toId = to!.startsWith('0x') ? to! : '0x' + to!.padStart(64, '0');
      const amount = ethers.parseUnits(amountStr!, 18);
      const nonce = BigInt(nonceStr!);
      const provider = providerAddr || CONTRACTS.entityProvider;
      console.log(`R2R: ${fromId.slice(0,10)}... -> ${toId.slice(0,10)}... : ${amountStr} USDC`);
      const events = await jAdapter.reserveToReserve(fromId, toId, 1, amount, { entityProvider: provider, hankoData: hankoData!, nonce });
      console.log(`Done. Events: ${events.length}`);
      break;

    case 'register':
      if (!args[0]) { console.log('Usage: register <name>'); break; }
      const boardHash = ethers.keccak256(ethers.toUtf8Bytes(args[0]));
      const result = await jAdapter.registerNumberedEntity(boardHash);
      console.log(`Registered entity #${result.entityNumber}, tx: ${result.txHash}`);
      break;

    case 'nonce':
      if (!args[0]) { console.log('Usage: nonce <entityId>'); break; }
      const eid = args[0].startsWith('0x') ? args[0] : '0x' + args[0].padStart(64, '0');
      const nonce = await jAdapter.getEntityNonce(eid);
      console.log(`Nonce: ${nonce}`);
      break;


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
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
    rl.prompt();
  });
}

main().catch(console.error);
