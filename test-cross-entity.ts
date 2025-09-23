#!/usr/bin/env bun

// Skip demo
process.env.NO_DEMO = '1';

import { createTradingEnvironment } from './src/trading-simulation';
import { activateXLN } from './src/activate-bilateral-channels';
import { activateCrossEntityTrading } from './src/activate-cross-entity-trading';

async function test() {
  console.log('🧪 Testing Cross-Entity Trading Activation...\n');

  const env = await createTradingEnvironment();
  await activateXLN(env);

  console.log('\n🌉 Activating cross-entity trading...');
  activateCrossEntityTrading(env, 5000);

  console.log('✅ Cross-entity trading activated successfully!');
  console.log('The infrastructure exists. Now entities can discover each other.');
}

test().catch(console.error);