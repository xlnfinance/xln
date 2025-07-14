#!/usr/bin/env node

// Debug REPL with ES modules support
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import repl from 'repl';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 Loading XLN Environment...');

// Dynamic import to load your ES module
const { env, runDemo, main } = await import('./src/server.ts');

console.log('✅ Environment loaded!');
console.log(`📊 Replicas: ${env.replicas.size}`);
console.log(`🔄 Height: ${env.height}`);

// Create REPL with useful context
const replServer = repl.start({
  prompt: '🚀 xln> ',
  useColors: true,
  breakEvalOnSigint: true,
});

// Add helpful context
replServer.context.env = env;
replServer.context.xlnEnv = env;
replServer.context.runDemo = runDemo;
replServer.context.main = main;

// Helper functions for debugging
replServer.context.inspect = (obj, depth = 3) => {
  const util = require('util');
  return util.inspect(obj, { 
    depth, 
    colors: true, 
    showHidden: false,
    compact: false
  });
};

replServer.context.expandMap = (map) => {
  const result = {};
  map.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

replServer.context.showReplicas = () => {
  console.log('\n📊 All Replicas:');
  env.replicas.forEach((replica, key) => {
    console.log(`  ${key}:`);
    console.log(`    Messages: ${replica.state.messages.length}`);
    console.log(`    Proposals: ${replica.state.proposals.size}`);
    console.log(`    Mempool: ${replica.mempool.length}`);
    console.log(`    Is Proposer: ${replica.isProposer}`);
  });
};

replServer.context.showMessages = (entityId = 'chat') => {
  console.log(`\n💬 Messages for ${entityId}:`);
  env.replicas.forEach((replica, key) => {
    if (replica.entityId === entityId) {
      console.log(`  ${key}:`);
      replica.state.messages.forEach((msg, i) => {
        console.log(`    ${i + 1}. ${msg}`);
      });
    }
  });
};

// Welcome message
console.log('\n🎯 XLN Debug REPL Ready!');
console.log('Available commands:');
console.log('  env                 - Main environment object');
console.log('  showReplicas()      - Show all replicas status');
console.log('  showMessages()      - Show chat messages');
console.log('  inspect(obj, depth) - Deep inspect any object');
console.log('  expandMap(map)      - Convert Map to regular object');
console.log('');
console.log('Examples:');
console.log('  env.replicas.get("chat:alice")');
console.log('  inspect(env.replicas.get("chat:alice").state)');
console.log('  expandMap(env.replicas)');
console.log(''); 