#!/usr/bin/env node
/**
 * Extract and map 2019 business logic to current architecture
 * This script analyzes the 2019 codebase structure to identify
 * what needs to be ported to the modern J→E→A architecture
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the 2019 source file
const src2019Path = path.join(__dirname, '../../spec/xln/xln2019src.txt');
const content = fs.readFileSync(src2019Path, 'utf8');

// Parse out the key business logic sections
const sections = content.split('---').filter(s => s.trim());

const businessLogic = {
  channels: {
    setCreditLimit: [],
    requestCollateral: [],
    withdraw: [],
    cooperativeClose: [],
    dispute: [],
  },
  payments: {
    payChannel: [],
    routing: [],
    rebalancing: [],
  },
  reserves: {
    reserveToChannel: [],
    channelToReserve: [],
    onchainFaucet: [],
  },
  orderbook: {
    createOrder: [],
    matching: [],
  }
};

// Extract key patterns
sections.forEach(section => {
  const lines = section.split('\n');
  const filename = lines[0]?.trim();

  if (!filename) return;

  // Credit limits
  if (section.includes('setCreditLimit')) {
    businessLogic.channels.setCreditLimit.push({
      file: filename,
      pattern: 'ch.entries[assetId].credit_limit = credit_limit'
    });
  }

  // Collateral requests
  if (section.includes('requestCollateral')) {
    businessLogic.channels.requestCollateral.push({
      file: filename,
      pattern: 'entry.they_requested_deposit = diff'
    });
  }

  // Withdrawals
  if (section.includes('getWithdrawalSig')) {
    businessLogic.channels.withdraw.push({
      file: filename,
      pattern: 'hashAndSign(getWithdrawalProof(ch, pairs))'
    });
  }

  // Rebalancing
  if (filename.includes('rebalance') || section.includes('rebalance')) {
    businessLogic.payments.rebalancing.push({
      file: filename,
      key: 'Periodic rebalancing of channel insurance'
    });
  }

  // Orderbook
  if (section.includes('createOrder') || section.includes('Orderbook')) {
    businessLogic.orderbook.createOrder.push({
      file: filename,
      pattern: 'Orderbook.push(json.order)'
    });
  }
});

// Map to current architecture
const architectureMapping = {
  '2019 Concept': 'Current J→E→A Location',
  '----': '----',
  'Channel credit limits': 'Entity state + Account machine',
  'Channel withdrawals': 'AccountInput with withdrawal proof',
  'Reserve transfers': 'J-events (ReserveUpdated)',
  'Rebalancing': 'Entity periodic tasks + AccountInput',
  'Orderbook': 'Entity state.orderbook + lob_core.ts',
  'Dispute resolution': 'J-machine dispute events',
  'Payment routing': 'Entity gossip + pathfinding',
};

console.log('📊 2019 Business Logic Analysis\n');
console.log('================================\n');

// Output findings
Object.entries(businessLogic).forEach(([category, items]) => {
  console.log(`📁 ${category.toUpperCase()}`);
  Object.entries(items).forEach(([feature, occurrences]) => {
    if (occurrences.length > 0) {
      console.log(`  ✓ ${feature}: Found in ${occurrences.length} location(s)`);
      occurrences.slice(0, 2).forEach(occ => {
        console.log(`    - ${occ.file}`);
      });
    }
  });
  console.log();
});

console.log('🗺️  Architecture Mapping\n');
console.log('========================\n');
Object.entries(architectureMapping).forEach(([old, current]) => {
  console.log(`${old.padEnd(25)} → ${current}`);
});

console.log('\n📋 Priority Implementation Order:\n');
console.log('1. Credit limits (simple state update)');
console.log('2. Direct payments (already partially done)');
console.log('3. Withdrawal proofs (needs signature verification)');
console.log('4. Rebalancing (complex, needs periodic tasks)');
console.log('5. Orderbook integration (complex, needs matching engine)');

// Save mapping to file for reference
const mappingFile = path.join(__dirname, '2019-to-current-mapping.json');
fs.writeFileSync(mappingFile, JSON.stringify({
  businessLogic,
  architectureMapping,
  priorityOrder: [
    'credit_limits',
    'direct_payments',
    'withdrawal_proofs',
    'rebalancing',
    'orderbook'
  ]
}, null, 2));

console.log(`\n✅ Mapping saved to: ${mappingFile}`);