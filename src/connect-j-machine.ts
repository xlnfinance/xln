#!/usr/bin/env bun

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

// Load deployed contract addresses
const deployedPath = path.join(__dirname, '../contracts/deployed.json');
const deployed = JSON.parse(fs.readFileSync(deployedPath, 'utf-8'));

// Connect to local Anvil blockchain
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');

// Get deployer wallet (using Anvil's default account)
const wallet = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);

// Depository ABI (minimal interface for our needs)
const DEPOSITORY_ABI = [
  'function debugBulkFundEntities() public',
  'function reserves(bytes32, uint256) view returns (uint256)',
  'function processBatch(bytes32, tuple(tuple(bytes32,uint256,uint256)[] reserveToReserve, tuple(bytes32,bytes32,tuple(uint256,int256)[] diffs)[] settlements, tuple(uint256,uint256,bytes32)[] externalTokenToReserve, tuple(bytes32,uint256,uint256)[] reserveToExternalToken, tuple(bytes32,tuple(bytes32,uint256,uint256,uint256,bytes32)[] updates)[] cooperativeUpdates, tuple(uint256,bytes32,int256[],bytes)[] flashloans) batch) returns (bool)',
  'function reserveToReserve(bytes32 fromEntity, bytes32 toEntity, uint tokenId, uint amount) returns (bool)',
  'event ReserveTransferred(bytes32 indexed from, bytes32 indexed to, uint256 indexed tokenId, uint256 amount)'
];

async function connectJMachine() {
  console.log('🔗 Connecting J-Machine to blockchain...');
  console.log('📍 Blockchain: http://127.0.0.1:8545');
  console.log('📄 Depository:', deployed.contracts.Depository);

  // Connect to Depository contract
  const depository = new ethers.Contract(deployed.contracts.Depository, DEPOSITORY_ABI, wallet);

  // Check blockchain connection
  const blockNumber = await provider.getBlockNumber();
  console.log('✅ Connected to blockchain at block', blockNumber);

  // Fund test entities for demonstration
  console.log('\n💰 Funding test entities...');
  const tx = await depository.debugBulkFundEntities();
  const receipt = await tx.wait();
  console.log('✅ Entities funded in tx:', receipt.hash);

  // Check entity 1 balance
  const entity1 = ethers.zeroPadValue('0x01', 32);
  const tokenId1 = 1;
  const balance = await depository.reserves(entity1, tokenId1);
  console.log('💎 Entity 1 token 1 balance:', ethers.formatEther(balance));

  // Perform a test transfer between entities
  console.log('\n🔄 Testing bilateral transfer...');
  const entity2 = ethers.zeroPadValue('0x02', 32);
  const amount = ethers.parseEther('100');

  const transferTx = await depository.reserveToReserve(entity1, entity2, tokenId1, amount);
  const transferReceipt = await transferTx.wait();

  // Check for transfer event
  const transferEvents = transferReceipt.logs
    .map(log => {
      try {
        return depository.interface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (transferEvents.length > 0) {
    console.log('✅ Transfer successful!');
    console.log('📝 Events:', transferEvents.map(e => e?.name).join(', '));
  }

  // Check updated balances
  const balance1After = await depository.reserves(entity1, tokenId1);
  const balance2After = await depository.reserves(entity2, tokenId1);
  console.log('\n📊 Final balances:');
  console.log('  Entity 1:', ethers.formatEther(balance1After));
  console.log('  Entity 2:', ethers.formatEther(balance2After));

  console.log('\n🎯 J-Machine connected and operational!');
  console.log('✨ XLN can now process trustless value deposits and settlements');

  // Export connection for other scripts
  return { provider, depository, wallet };
}

// Run if called directly
if (import.meta.main) {
  connectJMachine().catch(console.error);
}

export { connectJMachine };