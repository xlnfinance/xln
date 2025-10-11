/**
 * Test scenario parser
 */

import { loadScenarioFromFile, validateScenario } from './loader.js';
import { safeStringify } from '../serialization-utils.js';

async function main() {
  console.log('🧪 Testing Scenario Parser\n');

  const scenarioPath = './scenarios/diamond-dybvig.scenario.txt';

  try {
    const parsed = await loadScenarioFromFile(scenarioPath);

    console.log('=== Validation Results ===\n');
    const isValid = validateScenario(parsed);

    if (!isValid) {
      process.exit(1);
    }

    console.log('\n=== Scenario Details ===\n');
    console.log(`Seed: "${parsed.scenario.seed}"`);
    console.log(`Events: ${parsed.scenario.events.length}`);
    console.log(`Repeat blocks: ${parsed.scenario.repeatBlocks.length}\n`);

    console.log('=== Event Timeline ===\n');
    for (const event of parsed.scenario.events) {
      console.log(`t=${event.timestamp}s: ${event.title || '(no title)'}`);
      if (event.description) {
        console.log(`  Description: ${event.description.substring(0, 80)}...`);
      }
      console.log(`  Actions: ${event.actions.length}`);
      for (const action of event.actions) {
        const entityPart = action.entityId ? `${action.entityId} ` : '';
        const paramsPart = action.params.map(p =>
          typeof p === 'object' ? safeStringify(p) : String(p)
        ).join(' ');
        console.log(`    - ${entityPart}${action.type} ${paramsPart}`);
      }
      if (event.viewState) {
        console.log(`  View: ${safeStringify(event.viewState)}`);
      }
      console.log('');
    }

    console.log('=== Repeat Blocks ===\n');
    for (const repeatBlock of parsed.scenario.repeatBlocks) {
      console.log(`Every ${repeatBlock.interval}s (starting at t=${repeatBlock.startTimestamp}s):`);
      for (const action of repeatBlock.actions) {
        const entityPart = action.entityId ? `${action.entityId} ` : '';
        const paramsPart = action.params.map(p =>
          typeof p === 'object' ? safeStringify(p) : String(p)
        ).join(' ');
        console.log(`  - ${entityPart}${action.type} ${paramsPart}`);
      }
      console.log('');
    }

    console.log('✅ Parser test completed successfully!');
  } catch (error) {
    console.error('❌ Parser test failed:', error);
    process.exit(1);
  }
}

main();
